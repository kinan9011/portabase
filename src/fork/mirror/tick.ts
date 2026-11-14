import {and, asc, desc, eq, inArray} from "drizzle-orm";
import {actorIn, forkCan} from "@/fork/acl";
import {cancelQueuedTask} from "@/fork/agent-channel/tasks";
import {recordAudit} from "@/fork/audit";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkMirror, forkMirrorRevision, forkMirrorTask} from "@/fork/db/schema/mirror";
import {acquireLease, releaseLease, withForkLock} from "@/fork/locks";
import {loadPlanRow} from "@/fork/restore/service";
import {assertRunnerTarget} from "@/fork/runner/service";
import {advanceSteps, failRemaining, type StepRecord} from "@/fork/runs/engine";
import {nowOf, ownerOf, principalOfUser, type MirrorDeps} from "./deps";
import {addEvent} from "./events";
import {MirrorPolicyV1} from "./policy";
import {stateOf, transition} from "./machine";
import {advanceMirrorDeletes, type DeleteTick} from "./lifecycle";
import {advanceMirrorWipes} from "./wipe";
import {evaluateGates, handlers, type MirrorRow, type RevCtx, type RevRow} from "./steps";
import {ACTIVE_REVISION_STATES, type MirrorStep, type RevisionState} from "./vocab";

/**
 * One orchestrator tick (W22a, plan A7): a per-revision lease, then — in this order — cancel, deadline, re-authorise the STARTER (D31), re-verify the plan row and the runner,
 * advance the W12 steps. All progress is in the database; a restarted process resumes from there. Nothing here logs a message or a result. The flag (`FORK_MIRRORS_ENABLED`)
 * is checked inside every forward handler: with the flag off no new task is enqueued, but the deadline, the cancel and the wipe phase still run (removing data is always allowed).
 */
const LEASE_MS = 15 * 60_000;
export const leaseName = (revisionId: string) => `mirror-rev:${revisionId}`;
const REASON_RE = /^[a-z_]{1,64}$/;
/** Failures that mean "the input can never succeed without an operator change" ⇒ `blocked` (everything else that goes wrong at run time is `failed`). */
export const BLOCKING_REASONS: readonly string[] = ["compile_refused", "kept_secret_unconfirmed", "plan_blocked", "policy_refused"];
export type TickState = "advanced" | "done" | "failed" | "busy" | "gone";

export async function tickMirrorRevision(d: MirrorDeps, revisionId: string): Promise<{revisionId: string; state: TickState}> {
    const now = nowOf(d);
    if (!(await acquireLease(d.db, leaseName(revisionId), ownerOf(d), LEASE_MS, now))) return {revisionId, state: "busy"};
    try {
        return {revisionId, state: await tickLocked(d, revisionId, now)};
    } finally {
        await releaseLease(d.db, leaseName(revisionId), ownerOf(d));
    }
}

async function inflight(d: MirrorDeps, revisionId: string) {
    return d.db.select({taskId: forkAgentTask.id, status: forkAgentTask.status, attempts: forkAgentTask.attempts})
        .from(forkMirrorTask).innerJoin(forkAgentTask, eq(forkAgentTask.id, forkMirrorTask.taskId))
        .where(and(eq(forkMirrorTask.revisionId, revisionId), inArray(forkAgentTask.status, ["queued", "leased", "running"]))).orderBy(desc(forkMirrorTask.createdAt));
}

/** Cancels every never-started task of the revision. Returns true while ANY task is still in the agent's hands (or about to be). */
async function cancelOrWait(d: MirrorDeps, rev: RevRow, now: Date): Promise<boolean> {
    let pending = false;
    for (const t of await inflight(d, rev.id)) {
        if (t.status === "queued" && t.attempts === 0 && rev.runnerAgentId && (await cancelQueuedTask(d.db, {taskId: t.taskId, agentId: rev.runnerAgentId, now}))) continue;
        pending = true;
    }
    return pending;
}

const safeReason = (c: string): string => (REASON_RE.test(c) ? c : "internal_error");
const firstOpen = (steps: readonly StepRecord<MirrorStep>[]): string | undefined => steps.find((s) => s.status !== "done")?.name;

async function tickLocked(d: MirrorDeps, revisionId: string, now: Date): Promise<TickState> {
    const [rev] = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, revisionId));
    if (!rev || !(ACTIVE_REVISION_STATES as readonly string[]).includes(rev.state)) return "gone";
    const steps = rev.steps as StepRecord<MirrorStep>[];

    // 1. cancel requested: a never-started task is cancelled; one the runner may be executing is waited for (its truthful outcome), then the revision ends `cancelled`
    if (rev.cancelRequestedAt) {
        if (await cancelOrWait(d, rev, now)) return "advanced";
        await finalizeRevision(d, rev, "cancelled", {reason: "cancelled", steps: failRemaining(steps, "cancelled", now)});
        return "failed";
    }
    // 2. deadline
    if (now.getTime() > rev.deadlineAt.getTime()) {
        await cancelOrWait(d, rev, now);
        await finalizeRevision(d, rev, "failed", {reason: "run_timeout", failedStep: firstOpen(steps), steps: failRemaining(steps, "run_timeout", now)});
        return "failed";
    }
    // 3. D31: the starter's CURRENT rights, every tick
    const lookup = await principalOfUser(d, rev.startedBy);
    if (lookup.kind !== "ok" || !forkCan(actorIn(lookup.principal, rev.organizationId), "mirrors.manage")) {
        await finalizeRevision(d, rev, "failed", {reason: "reauth_failed", failedStep: firstOpen(steps), steps: failRemaining(steps, "reauth_failed", now)});
        return "failed";
    }
    // 4. the plan row must still be untampered and hash-identical (no freshness: a mirror plan is single-use and never re-planned mid-run)
    if (!rev.planId) { await finalizeRevision(d, rev, "failed", {reason: "plan_tampered", failedStep: firstOpen(steps), steps: failRemaining(steps, "plan_tampered", now)}); return "failed"; }
    const loaded = await loadPlanRow(d, rev.planId, rev.planHash);
    if (!loaded.ok) {
        const reason = loaded.code === "plan_tampered" || loaded.code === "hash_mismatch" ? loaded.code : "plan_tampered";
        await finalizeRevision(d, rev, "failed", {reason, failedStep: firstOpen(steps), steps: failRemaining(steps, reason, now)});
        return "failed";
    }
    // 5. the runner must still be a designated, attested runner (the starter has no say over that)
    if (!rev.runnerAgentId || !(await assertRunnerTarget(d.db, rev.runnerAgentId)).ok) {
        await finalizeRevision(d, rev, "blocked", {reason: "runner_ineligible", failedStep: firstOpen(steps), steps: failRemaining(steps, "runner_ineligible", now)});
        return "failed";
    }
    const [mirror] = await d.db.select().from(forkMirror).where(eq(forkMirror.id, rev.mirrorId));
    const pol = mirror ? MirrorPolicyV1.safeParse(mirror.policy) : null;
    if (!mirror || !pol?.success) { await finalizeRevision(d, rev, "failed", {reason: "internal_error", failedStep: firstOpen(steps), steps: failRemaining(steps, "internal_error", now)}); return "failed"; }

    // 6. advance
    const ctx: RevCtx = {d, rev, mirror: mirror as MirrorRow, plan: loaded.plan, planRow: loaded.row, policy: pol.data, principal: lookup.principal, now, memo: {}};
    let shown: RevisionState = rev.state as RevisionState;
    const r = await advanceSteps<MirrorStep, RevCtx>(steps, handlers(ctx), ctx, {
        now: () => now,
        persist: async (s) => {
            const next = transition(shown, stateOf(s));
            const rows = await d.db.update(forkMirrorRevision).set({steps: s, state: next, updatedAt: now}).where(and(eq(forkMirrorRevision.id, rev.id), inArray(forkMirrorRevision.state, [...ACTIVE_REVISION_STATES]))).returning({id: forkMirrorRevision.id});
            if (rows.length === 1 && next !== shown) { await addEvent(d.db, {mirrorId: rev.mirrorId, revisionId: rev.id, kind: "state_changed", at: now, fromState: shown, toState: next}); shown = next; }
        },
    });
    if (r.state === "running") return "advanced";
    if (r.state === "done") {
        const ok = await activateRevision(d, ctx.rev, r.steps, now);
        return ok ? "done" : "failed";
    }
    const code = safeReason(r.code ?? "internal_error");
    // later steps never ran: failed without a code (the failing step carries it)
    const closed = r.steps.map((s) => (s.status === "pending" || s.status === "running" ? {...s, status: "failed" as const, finishedAt: now.toISOString()} : s));
    await finalizeRevision(d, ctx.rev, BLOCKING_REASONS.includes(code) ? "blocked" : "failed", {reason: code, failedStep: r.failedStep, steps: closed});
    return "failed";
}

type Terminal = "blocked" | "failed" | "cancelled";
/** Ends an ACTIVE revision (idempotent): state through `transition()`, mirror status, event, audit. The runner copy is wiped by the wipe phase afterwards (OD-W22a-5). */
export async function finalizeRevision(d: MirrorDeps, rev: RevRow, state: Terminal, o: {reason: string; failedStep?: string; steps: StepRecord<MirrorStep>[]; wipeState?: "not_needed"}): Promise<void> {
    const now = nowOf(d);
    await withForkLock(d.db, `mirror:${rev.mirrorId}`, async (tx) => {
        const [cur] = await tx.select({state: forkMirrorRevision.state}).from(forkMirrorRevision).where(eq(forkMirrorRevision.id, rev.id));
        if (!cur || !(ACTIVE_REVISION_STATES as readonly string[]).includes(cur.state)) return; // already finalised (idempotent)
        const next = transition(cur.state as RevisionState, state);
        await tx.update(forkMirrorRevision).set({
            state: next, reason: o.reason, failedStep: o.failedStep ?? null, steps: o.steps, finishedAt: now, updatedAt: now,
            durationSeconds: Math.max(0, Math.round((now.getTime() - rev.createdAt.getTime()) / 1000)), ...(o.wipeState ? {wipeState: o.wipeState, wipeFinishedAt: now} : {}),
        }).where(eq(forkMirrorRevision.id, rev.id));
        // the mirror shows the outcome only while it has no READY revision of its own
        const [m] = await tx.select({active: forkMirror.activeRevisionId}).from(forkMirror).where(eq(forkMirror.id, rev.mirrorId));
        if (m && m.active === null) await tx.update(forkMirror).set({status: state === "cancelled" ? "cancelled" : "failed", updatedAt: now}).where(eq(forkMirror.id, rev.mirrorId));
        await addEvent(tx, {mirrorId: rev.mirrorId, revisionId: rev.id, kind: state === "cancelled" ? "cancelled" : state === "blocked" ? "blocked" : "failed", at: now, fromState: cur.state, toState: next, code: o.reason});
        await recordAudit(tx, {
            organizationId: rev.organizationId, actorKind: "system", action: "fork.mirror.finish", resourceType: "mirror", resourceId: rev.mirrorId, result: state === "cancelled" ? "success" : "failure", now,
            details: {revisionId: rev.id, planHash: rev.planHash, state: next, reason: o.reason, failedStep: o.failedStep ?? null, durationSeconds: Math.max(0, Math.round((now.getTime() - rev.createdAt.getTime()) / 1000))},
        });
    });
}

/**
 * READY (ADR-016): in ONE locked transaction re-check all five gates, move the revision to `ready` through the machine and set the mirror's `active_revision_id`. THIS ROW IS the
 * "app start-tested" fact (rp, revision, readied_at, duration): never set by `up` exit 0, `starting` health, a skipped probe or lab-only state.
 */
export async function activateRevision(d: MirrorDeps, rev: RevRow, steps: StepRecord<MirrorStep>[], now: Date): Promise<boolean> {
    const out = await withForkLock(d.db, `mirror:${rev.mirrorId}`, async (tx): Promise<{ok: true} | {ok: false; code: string}> => {
        const [cur] = await tx.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, rev.id));
        if (!cur || !(ACTIVE_REVISION_STATES as readonly string[]).includes(cur.state)) return {ok: false, code: "internal_error"};
        const g = await evaluateGates(tx, d, cur, now);
        if (!g.ok) return g;
        const next = transition(cur.state as RevisionState, "ready");
        const duration = Math.max(0, Math.round((now.getTime() - cur.createdAt.getTime()) / 1000));
        await tx.update(forkMirrorRevision).set({state: next, steps, readiedAt: now, activatedAt: now, finishedAt: now, durationSeconds: duration, updatedAt: now}).where(eq(forkMirrorRevision.id, rev.id));
        await tx.update(forkMirror).set({status: "ready", activeRevisionId: rev.id, updatedAt: now}).where(eq(forkMirror.id, rev.mirrorId));
        await addEvent(tx, {mirrorId: rev.mirrorId, revisionId: rev.id, kind: "ready", at: now, fromState: cur.state, toState: next});
        await recordAudit(tx, {organizationId: rev.organizationId, actorKind: "system", action: "fork.mirror.ready", resourceType: "mirror", resourceId: rev.mirrorId, result: "success", now,
            details: {revisionId: rev.id, specSha256: cur.specSha256, finalViewSha256: cur.finalViewSha256, rpSequence: cur.rpSequence, durationSeconds: duration}});
        return {ok: true};
    });
    if (out.ok) return true;
    const closed = steps.map((s) => (s.name === "activate" ? {...s, status: "failed" as const, code: out.code} : s));
    await finalizeRevision(d, rev, "failed", {reason: safeReason(out.code), failedStep: "activate", steps: closed});
    return false;
}

/** Every active revision, oldest first, then the wipe phase of every terminal one; one revision's failure never stops the next (messages are never read or logged). */
export async function tickAllMirrors(d: MirrorDeps): Promise<{advanced: number; done: number; failed: number; busy: number; wipes: {advanced: number; verified: number; failed: number}; deletes: DeleteTick}> {
    const out = {advanced: 0, done: 0, failed: 0, busy: 0, wipes: {advanced: 0, verified: 0, failed: 0}, deletes: {advanced: 0, deleted: 0, failed: 0}};
    const ids = await d.db.select({id: forkMirrorRevision.id}).from(forkMirrorRevision).where(inArray(forkMirrorRevision.state, [...ACTIVE_REVISION_STATES])).orderBy(asc(forkMirrorRevision.createdAt));
    for (const {id} of ids) {
        try {
            const r = await tickMirrorRevision(d, id);
            if (r.state === "advanced") out.advanced += 1;
            else if (r.state === "done") out.done += 1;
            else if (r.state === "failed") out.failed += 1;
            else if (r.state === "busy") out.busy += 1;
        } catch {
            // isolated: the next tick retries (the engine counts handler errors itself); the message is never read
        }
    }
    out.wipes = await advanceMirrorWipes(d);
    out.deletes = await advanceMirrorDeletes(d); // W23: after the wipes, so a deleting mirror's non-ready revisions are already advanced
    return out;
}
