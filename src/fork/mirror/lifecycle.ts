import {and, asc, desc, eq, gte, inArray, sql} from "drizzle-orm";
import {actorIn, forkCan} from "@/fork/acl";
import {expireQueuedTask} from "@/fork/agent-channel/tasks";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkMirror, forkMirrorEvent, forkMirrorRevision, forkMirrorTask} from "@/fork/db/schema/mirror";
import {forkRunner} from "@/fork/db/schema/runner";
import {acquireLease, releaseLease, withForkLock} from "@/fork/locks";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {loadPlanRow} from "@/fork/restore/service";
import {adminTargetCount, assertRunnerTarget, runnerIsolation, startRunnerProbe} from "@/fork/runner/service";
import {checkHealth, checkSmoke} from "./derive";
import {enabledOf, nowOf, ownerOf, principalOfUser, type MirrorDeps} from "./deps";
import {addEvent} from "./events";
import {enqueueMirrorTask, TRANSIENT_ENQUEUE_CODES} from "./enqueue";
import {MirrorCheckResult, MirrorStopResult, MirrorUpResult} from "./payload-schema";
import {MirrorPolicyV1} from "./policy";
import {agentReason, journalRows, revisionOf, taskDeps, type JournalRow, type RevRow} from "./steps";
import {advanceMirrorWipe} from "./wipe";
import {ACTIVE_REVISION_STATES, LIFECYCLE_BUDGET_MS, MAX_EXPIRED_REENQUEUES, STEP_TASK_TYPE, type MirrorJournalStep, type MirrorStatus} from "./vocab";

/**
 * W23 mirror lifecycle tick (plan-W23 DD-6). `advanceMirrorDeletes`: for every mirror in `deleting`, run the verified wipe of its READY revision(s) (non-ready terminal revisions are handled by the
 * existing wipe phase), and only when EVERY revision's copy is verified gone (or never existed) mark the mirror `deleted` (name reusable, loopback port freed). A failed wipe leaves the mirror
 * `deleting` with the failure visible on its revision (Retry wipe is an explicit, audited action). Needs no principal: removing a production-data copy is always allowed.
 */
export type DeleteTick = {advanced: number; deleted: number; failed: number};
const DONE = ["verified", "not_needed"];

export async function advanceMirrorDeletes(d: MirrorDeps): Promise<DeleteTick> {
    const out: DeleteTick = {advanced: 0, deleted: 0, failed: 0};
    const mirrors = await d.db.select({id: forkMirror.id, organizationId: forkMirror.organizationId}).from(forkMirror).where(eq(forkMirror.status, "deleting")).orderBy(asc(forkMirror.updatedAt)).limit(50);
    for (const m of mirrors) {
        try {
            const load = () => d.db.select({id: forkMirrorRevision.id, state: forkMirrorRevision.state, wipeState: forkMirrorRevision.wipeState}).from(forkMirrorRevision).where(eq(forkMirrorRevision.mirrorId, m.id));
            for (const r of await load()) if (r.state === "ready" && (r.wipeState === null || r.wipeState === "running")) await advanceMirrorWipe(d, r.id);
            const revs = await load();
            if (revs.some((r) => (ACTIVE_REVISION_STATES as readonly string[]).includes(r.state))) { out.advanced += 1; continue; }
            if (revs.some((r) => r.wipeState === "failed")) { out.failed += 1; continue; }
            if (!revs.every((r) => r.wipeState !== null && DONE.includes(r.wipeState))) { out.advanced += 1; continue; }
            const now = nowOf(d);
            const done = await withForkLock(d.db, `mirror:${m.id}`, async (tx) => {
                const rows = await tx.update(forkMirror).set({status: "deleted", deletedAt: now, updatedAt: now}).where(and(eq(forkMirror.id, m.id), eq(forkMirror.status, "deleting"))).returning({id: forkMirror.id});
                if (rows.length !== 1) return false;
                await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "state_changed", at: now, fromState: "deleting", toState: "deleted", details: {scope: "mirror"}});
                await recordAudit(tx, {organizationId: m.organizationId, actorKind: "system", action: "fork.mirror.delete", resourceType: "mirror", resourceId: m.id, result: "success", now, details: {phase: "done", revisions: revs.length}});
                return true;
            });
            if (done) out.deleted += 1;
        } catch {
            // isolated: the next tick retries (the message is never read or logged)
        }
    }
    return out;
}

// ---- stop / start (W23 Part B, DD-9) -----------------------------------------------------------------------------------------------------
export type LifecycleEvent = "stop_requested" | "stop_done" | "stop_failed" | "start_requested" | "start_done" | "start_aborted" | "start_failed";
const TABLE: Record<LifecycleEvent, {from: readonly MirrorStatus[]; to: MirrorStatus}> = {
    stop_requested: {from: ["ready", "failed"], to: "stopping"},
    stop_done: {from: ["stopping"], to: "stopped"},
    stop_failed: {from: ["stopping"], to: "failed"},
    start_requested: {from: ["stopped"], to: "starting"},
    start_done: {from: ["starting"], to: "ready"},
    start_aborted: {from: ["starting"], to: "stopped"}, // nothing started, or the cleanup stop was verified
    start_failed: {from: ["starting"], to: "failed"}, // the cleanup stop itself failed: containers may still run
};
/** The only legal status moves of stop / start (pure; an illegal pair is a programming error). */
export function nextMirrorStatus(from: MirrorStatus, ev: LifecycleEvent): MirrorStatus {
    const t = TABLE[ev];
    if (!t.from.includes(from)) throw new Error(`illegal mirror status move ${from} -> ${ev}`);
    return t.to;
}

/** When the running operation started and who asked: the newest mirror-scoped `state_changed` event INTO the current status. */
export async function opOf(db: ForkDb, mirrorId: string, status: MirrorStatus): Promise<{at: Date; actorUserId: string | null} | null> {
    const [r] = await db.select({at: forkMirrorEvent.at, actor: forkMirrorEvent.actorUserId}).from(forkMirrorEvent)
        .where(and(eq(forkMirrorEvent.mirrorId, mirrorId), eq(forkMirrorEvent.kind, "state_changed"), eq(forkMirrorEvent.toState, status), sql`${forkMirrorEvent.details}->>'scope' = 'mirror'`))
        .orderBy(desc(forkMirrorEvent.at)).limit(1);
    return r ? {at: r.at, actorUserId: r.actor} : null;
}

const REASON_RE = /^[a-z_]{1,64}$/;
const safe = (c: string): string => (REASON_RE.test(c) ? c : "internal_error");
type Wait = {kind: "wait"};
type Fail = {kind: "fail"; code: string};
type Ok = {kind: "ok"; result: unknown; taskId: string | null};
type Outcome = Wait | Fail | Ok;
const WAIT: Wait = {kind: "wait"};
const failOf = (code: string): Fail => ({kind: "fail", code: safe(code)});
const refusalOf = (code: string): Wait | Fail => (TRANSIENT_ENQUEUE_CODES.includes(code) ? WAIT : failOf(code === "forbidden" ? "reauth_failed" : code));

type OpCtx = {d: MirrorDeps; m: typeof forkMirror.$inferSelect; rev: RevRow; opAt: Date; actorUserId: string | null; now: Date};

/** The journal rows of THIS operation (created at or after its start), the next attempt number over ALL rows of the step, and the task outcome like the creation's `taskStep`. */
async function opTask(c: OpCtx, step: MirrorJournalStep, enqueue: (attempt: number) => Promise<{ok: true} | {ok: false; code: string}>): Promise<Outcome> {
    const all = await journalRows(c.d.db, c.rev.id, step);
    const rows = all.filter((r) => r.createdAt.getTime() >= c.opAt.getTime());
    const last: JournalRow | undefined = rows[0];
    if (last?.task?.status === "queued" && last.task.attempts === 0 && last.taskId && c.rev.runnerAgentId && last.task.notAfter.getTime() < c.now.getTime()
        && (await expireQueuedTask(c.d.db, {taskId: last.taskId, agentId: c.rev.runnerAgentId, now: c.now}))) last.task.status = "expired";
    const go = async (): Promise<Outcome> => {
        const r = await enqueue((all[0]?.attempt ?? 0) + 1);
        return r.ok ? WAIT : refusalOf(r.code);
    };
    if (!last) return go();
    if (!last.task) return failOf("internal_error");
    switch (last.task.status) {
        case "queued": case "leased": case "running": return WAIT;
        case "succeeded": return {kind: "ok", result: last.task.result, taskId: last.taskId};
        case "failed": case "rejected": return failOf(agentReason(last.task.result));
        case "expired": return rows.filter((r) => r.task?.status === "expired").length >= MAX_EXPIRED_REENQUEUES ? failOf("agent_offline") : go();
        case "cancelled": return failOf("task_cancelled");
        default: return failOf("internal_error");
    }
}

/** One locked, audited status move (`where status = from`); optionally patches the active revision's service list (what the runner reported). */
async function moveMirror(c: OpCtx, from: MirrorStatus, ev: LifecycleEvent, o: {code?: string | null; services?: {service: string; state: string; health?: string}[]; action: "stop" | "start"; phase: string}): Promise<boolean> {
    const to = nextMirrorStatus(from, ev);
    const failed = ev === "stop_failed" || ev === "start_failed";
    return withForkLock(c.d.db, `mirror:${c.m.id}`, async (tx) => {
        const rows = await tx.update(forkMirror).set({status: to, updatedAt: c.now}).where(and(eq(forkMirror.id, c.m.id), eq(forkMirror.status, from))).returning({id: forkMirror.id});
        if (rows.length !== 1) return false;
        if (o.services) await tx.update(forkMirrorRevision).set({services: o.services, updatedAt: c.now}).where(eq(forkMirrorRevision.id, c.rev.id));
        await addEvent(tx, {mirrorId: c.m.id, revisionId: null, kind: "state_changed", at: c.now, fromState: from, toState: to, code: o.code ?? null, details: {scope: "mirror"}});
        await recordAudit(tx, {organizationId: c.m.organizationId, actorKind: "system", action: `fork.mirror.${o.action}`, resourceType: "mirror", resourceId: c.m.id, result: failed || (ev === "start_aborted" && o.code) ? "failure" : "success", now: c.now,
            details: {phase: o.phase, revisionId: c.rev.id, ...(o.code ? {reason: o.code} : {})}});
        return true;
    });
}

const stopEnqueue = (c: OpCtx, plan: RestorePlanV1) => (attempt: number) =>
    enqueueMirrorTask(taskDeps(c.d, {principal: null, now: c.now, revisionId: c.rev.id, step: "stop", attempt}), {revision: revisionOf(c.rev), plan, step: "stop", attempt});

type Loaded = Extract<Awaited<ReturnType<typeof loadPlanRow>>, {ok: true}>;
async function opContext(d: MirrorDeps, m: typeof forkMirror.$inferSelect, status: MirrorStatus, now: Date): Promise<{c: OpCtx; plan: Loaded} | {error: string; c: OpCtx}> {
    const op = await opOf(d.db, m.id, status);
    const [rev] = m.activeRevisionId ? await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, m.activeRevisionId)) : [];
    const base = {d, m, rev: rev as RevRow, opAt: op?.at ?? now, actorUserId: op?.actorUserId ?? null, now};
    if (!op || !rev || !rev.planId) return {error: "internal_error", c: base};
    const loaded = await loadPlanRow(d, rev.planId, rev.planHash);
    if (!loaded.ok) return {error: "plan_tampered", c: base};
    return {c: base, plan: loaded};
}

export async function advanceStopping(d: MirrorDeps, m: typeof forkMirror.$inferSelect, now: Date): Promise<"advanced" | "stopped" | "failed"> {
    const ctx = await opContext(d, m, "stopping", now);
    if ("error" in ctx) { await moveMirror(ctx.c, "stopping", "stop_failed", {code: ctx.error, action: "stop", phase: "failed"}); return "failed"; }
    const {c, plan} = ctx;
    if (now.getTime() - c.opAt.getTime() > LIFECYCLE_BUDGET_MS) { await moveMirror(c, "stopping", "stop_failed", {code: "run_timeout", action: "stop", phase: "failed"}); return "failed"; }
    const o = await opTask(c, "stop", stopEnqueue(c, plan.plan));
    if (o.kind === "wait") return "advanced";
    if (o.kind === "fail") { await moveMirror(c, "stopping", "stop_failed", {code: o.code, action: "stop", phase: "failed"}); return "failed"; }
    const r = MirrorStopResult.safeParse(o.result);
    if (!r.success) { await moveMirror(c, "stopping", "stop_failed", {code: "execution_error", action: "stop", phase: "failed"}); return "failed"; }
    await moveMirror(c, "stopping", "stop_done", {services: r.data.services.map((x) => ({service: x.service, state: x.state})), action: "stop", phase: "done"});
    return "stopped";
}

/**
 * Start = isolation probe (this operation's own, before anything runs) -> `mirror_up` -> `mirror_check` (health + app smoke). The creation's READY evidence (`probe_task_id`, `gates`,
 * `readied_at`) is never touched, so the start-tested fact stays the creation's. Any failure once `up` may have run is followed by a cleanup `stop`; only a verified stop returns the mirror
 * to `stopped`, a failed one leaves it `failed` ("containers may still run"). The failure code survives ticks as a mirror-scoped `failed` event.
 */
export async function advanceStarting(d: MirrorDeps, m: typeof forkMirror.$inferSelect, now: Date): Promise<"advanced" | "ready" | "stopped" | "failed"> {
    const ctx = await opContext(d, m, "starting", now);
    if ("error" in ctx) { await moveMirror(ctx.c, "starting", "start_failed", {code: ctx.error, action: "start", phase: "failed"}); return "failed"; }
    const {c, plan} = ctx;
    const agentId = c.rev.runnerAgentId;
    if (!agentId) { await moveMirror(c, "starting", "start_aborted", {code: "runner_ineligible", action: "start", phase: "aborted"}); return "stopped"; }

    const cleanup = async (code: string): Promise<"advanced" | "stopped" | "failed"> => {
        const [known] = await d.db.select({code: forkMirrorEvent.code}).from(forkMirrorEvent).where(and(eq(forkMirrorEvent.mirrorId, m.id), eq(forkMirrorEvent.kind, "failed"), gte(forkMirrorEvent.at, c.opAt), sql`${forkMirrorEvent.details}->>'scope' = 'mirror'`)).orderBy(desc(forkMirrorEvent.at)).limit(1);
        if (!known) await addEvent(d.db, {mirrorId: m.id, revisionId: null, kind: "failed", at: now, code, details: {scope: "mirror", phase: "start"}});
        const why = known?.code ?? code;
        const o = await opTask(c, "stop", stopEnqueue(c, plan.plan));
        if (o.kind === "wait") return "advanced";
        if (o.kind === "fail" || !MirrorStopResult.safeParse(o.result).success) { await moveMirror(c, "starting", "start_failed", {code: o.kind === "fail" ? o.code : "execution_error", action: "start", phase: "failed"}); return "failed"; }
        await moveMirror(c, "starting", "start_aborted", {code: why, action: "start", phase: "aborted"});
        return "stopped";
    };
    // a cleanup stop of this operation exists: finish it (the recorded failure code is the reason)
    const stops = (await journalRows(d.db, c.rev.id, "stop")).filter((r) => r.createdAt.getTime() >= c.opAt.getTime());
    if (stops.length > 0) return cleanup("internal_error");

    const upRows = (await journalRows(d.db, c.rev.id, "up")).filter((r) => r.createdAt.getTime() >= c.opAt.getTime());
    const abort = async (code: string) => { await moveMirror(c, "starting", "start_aborted", {code, action: "start", phase: "aborted"}); return "stopped" as const; };
    if (now.getTime() - c.opAt.getTime() > LIFECYCLE_BUDGET_MS) return upRows.length === 0 ? abort("run_timeout") : cleanup("run_timeout");
    if (!enabledOf(d)) return upRows.length === 0 ? abort("mirrors_disabled") : cleanup("mirrors_disabled");

    // D31: the requester's CURRENT right on this mirror, every tick
    const lookup = c.actorUserId ? await principalOfUser(d, c.actorUserId) : null;
    if (!lookup || lookup.kind !== "ok" || !forkCan(actorIn(lookup.principal, m.organizationId), "mirrors.manage")) return upRows.length === 0 ? abort("reauth_failed") : cleanup("reauth_failed");
    const principal = lookup.principal;
    if (!(await assertRunnerTarget(d.db, agentId)).ok) return upRows.length === 0 ? abort("runner_ineligible") : cleanup("runner_ineligible");

    // 1. isolation: a probe of THIS operation, evaluated after the operation started
    if (upRows.length === 0) {
        const o = await opTask(c, "isolation", async (attempt) => {
            if ((await adminTargetCount(d.db, agentId)) < 1) return {ok: false, code: "runner_not_isolated"};
            const r = await startRunnerProbe({...d, mirrorsEnabled: () => true} as never, {
                agentId, agentName: m.runnerAgentName, actorUserId: principal.userId, organizationId: m.organizationId, trigger: "mirror",
                onInserted: async (tx, taskId) => { await tx.insert(forkMirrorTask).values({revisionId: c.rev.id, step: "isolation", attempt, taskType: STEP_TASK_TYPE.isolation, taskId, createdAt: now}); },
            });
            if (r.ok) return {ok: true};
            return r.code === "probe_in_progress" || r.code === "signing_unavailable" ? {ok: false, code: "locked"} : {ok: false, code: r.code};
        });
        if (o.kind === "wait") return "advanced";
        if (o.kind === "fail") return abort(o.code === "execution_error" ? "runner_not_isolated" : o.code);
        const iso = await runnerIsolation(d.db, agentId, {now, maxAgeMs: Math.max(0, now.getTime() - c.opAt.getTime()) + 60_000, serverUrl: d.serverUrl()});
        const [fr] = await d.db.select({taskId: forkRunner.lastProbeTaskId}).from(forkRunner).where(eq(forkRunner.agentId, agentId));
        if (iso.state === "isolated") {
            if (fr?.taskId !== o.taskId || iso.probedAt.getTime() < c.opAt.getTime() - 1000) return abort("probe_stale");
        } else if (iso.state === "not_isolated") return abort("runner_not_isolated");
        else if (iso.reason === "probe_pending") return "advanced";
        else return abort("probe_stale");
    }

    // 2. up
    const up = await opTask(c, "up", async (attempt) => enqueueMirrorTask(taskDeps(d, {principal, now, revisionId: c.rev.id, step: "up", attempt}),
        {revision: revisionOf(c.rev), plan: plan.plan, step: "up", attempt, finalSha256: c.rev.finalViewSha256 ?? undefined}));
    if (up.kind === "wait") return "advanced";
    if (up.kind === "fail") return cleanup(up.code);
    const upRes = MirrorUpResult.safeParse(up.result);
    if (!upRes.success) return cleanup("execution_error");

    // 3. check: container health + app smoke (NOT the data: unchanged on the runner volumes)
    const pol = MirrorPolicyV1.safeParse(m.policy);
    if (!pol.success) return cleanup("internal_error");
    const expected = (Array.isArray(c.rev.services) ? (c.rev.services as {service?: unknown}[]) : []).map((x) => x.service).filter((x): x is string => typeof x === "string");
    const chk = await opTask(c, "check", async (attempt) => enqueueMirrorTask(taskDeps(d, {principal, now, revisionId: c.rev.id, step: "check", attempt}),
        {revision: revisionOf(c.rev), plan: plan.plan, step: "check", attempt, finalSha256: c.rev.finalViewSha256 ?? undefined, policy: pol.data}));
    if (chk.kind === "wait") return "advanced";
    if (chk.kind === "fail") return cleanup(chk.code);
    const parsed = MirrorCheckResult.safeParse(chk.result);
    const health = checkHealth(chk.result, expected);
    if (!health.ok) return cleanup(health.code);
    const smoke = checkSmoke(chk.result, pol.data);
    if (!smoke.ok) return cleanup(smoke.code);
    if (!parsed.success) return cleanup("execution_error");
    const ok = await moveMirror(c, "starting", "start_done", {services: parsed.data.services.map((s) => ({service: s.service, state: s.state, health: s.health})), action: "start", phase: "done"});
    return ok ? "ready" : "advanced";
}

export type OpTick = {advanced: number; stopped: number; ready: number; failed: number};
export async function advanceMirrorLifecycles(d: MirrorDeps): Promise<OpTick> {
    const out: OpTick = {advanced: 0, stopped: 0, ready: 0, failed: 0};
    const mirrors = await d.db.select().from(forkMirror).where(inArray(forkMirror.status, ["stopping", "starting"])).orderBy(asc(forkMirror.updatedAt)).limit(50);
    for (const m of mirrors) {
        const lease = `mirror-op:${m.id}`;
        const now = nowOf(d);
        if (!(await acquireLease(d.db, lease, ownerOf(d), 15 * 60_000, now))) continue;
        try {
            const r = m.status === "stopping" ? await advanceStopping(d, m, now) : await advanceStarting(d, m, now);
            if (r === "advanced") out.advanced += 1;
            else if (r === "failed") out.failed += 1;
            else if (r === "ready") out.ready += 1;
            else out.stopped += 1;
        } catch {
            // isolated: the next tick retries (the message is never read or logged)
        } finally {
            await releaseLease(d.db, lease, ownerOf(d));
        }
    }
    return out;
}
