import {and, asc, desc, eq, gte, inArray, isNull, lt, sql} from "drizzle-orm";
import {actorIn, forkCan, type ForkPrincipal} from "@/fork/acl";
import {cancelQueuedTask, expireQueuedTask} from "@/fork/agent-channel/tasks";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkMirror, forkMirrorEvent, forkMirrorRevision, forkMirrorTask} from "@/fork/db/schema/mirror";
import {forkRunner} from "@/fork/db/schema/runner";
import {acquireLease, releaseLease, withForkLock} from "@/fork/locks";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {loadPlanRow} from "@/fork/restore/service";
import {adminTargetCount, assertRunnerTarget, runnerIsolation, startRunnerProbe} from "@/fork/runner/service";
import {checkHealth, checkRouteSwitch, checkSmoke} from "./derive";
import {enabledOf, nowOf, ownerOf, principalOfUser, type MirrorDeps} from "./deps";
import {addEvent} from "./events";
import {enqueueMirrorTask, TRANSIENT_ENQUEUE_CODES} from "./enqueue";
import {MirrorCheckResult, MirrorRouteRemoveResult, MirrorStopResult, MirrorUpResult} from "./payload-schema";
import {transition} from "./machine";
import {MirrorPolicyV1} from "./policy";
import {agentReason, evaluateGates, journalRows, revisionOf, taskDeps, type JournalRow, type RevRow} from "./steps";
import {advanceMirrorWipe} from "./wipe";
import {ACTIVE_REVISION_STATES, KEEP_REVISIONS, LIFECYCLE_BUDGET_MS, MAX_EXPIRED_REENQUEUES, REVISION_MAX_AGE_DAYS, STEP_TASK_TYPE, type MirrorJournalStep, type MirrorStatus} from "./vocab";

/**
 * W23 mirror lifecycle tick (plan-W23 DD-6). `advanceMirrorDeletes`: for every mirror in `deleting`, run the verified wipe of its READY revision(s) (non-ready terminal revisions are handled by the
 * existing wipe phase), and only when EVERY revision's copy is verified gone (or never existed) mark the mirror `deleted` (name reusable, loopback port freed). A failed wipe leaves the mirror
 * `deleting` with the failure visible on its revision (Retry wipe is an explicit, audited action). Needs no principal: removing a production-data copy is always allowed.
 */
export type DeleteTick = {advanced: number; deleted: number; failed: number};
const DONE = ["verified", "not_needed"];

export async function advanceMirrorDeletes(d: MirrorDeps): Promise<DeleteTick> {
    const out: DeleteTick = {advanced: 0, deleted: 0, failed: 0};
    const mirrors = await d.db.select().from(forkMirror).where(eq(forkMirror.status, "deleting")).orderBy(asc(forkMirror.updatedAt)).limit(50);
    for (const m of mirrors) {
        try {
            // W24 (DD-4): the private route is detached and removed BEFORE any READY revision is wiped (a network with the forwarder attached cannot be removed)
            if (m.routePort !== null) {
                const rr = await removeRoute(d, m);
                if (rr === "wait") { out.advanced += 1; continue; }
                if (rr === "failed") { out.failed += 1; continue; }
            }
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

/**
 * `mirror_route {remove}` for a deleting mirror (journal of its NEWEST revision, rows of THIS delete only). A safety step: no principal, allowed locked / flag off. An agent `failed` result is final for this
 * delete request (mirror-scoped `failed` event `route_incomplete`; the READY wipes do not start); a new Delete click re-requests (see `deleteMirror`).
 */
async function removeRoute(d: MirrorDeps, m: typeof forkMirror.$inferSelect): Promise<"wait" | "done" | "failed"> {
    const now = nowOf(d);
    const op = await opOf(d.db, m.id, "deleting");
    const [rev] = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.mirrorId, m.id)).orderBy(desc(forkMirrorRevision.seq)).limit(1);
    const pol = MirrorPolicyV1.safeParse(m.policy);
    const loaded = rev?.planId ? await loadPlanRow(d, rev.planId, rev.planHash) : null;
    const c: OpCtx | null = op && rev ? {d, m, rev, active: null, opAt: op.at, actorUserId: null, now, late: false} : null;
    const failedEvent = async (code: string) => {
        const [known] = c ? await d.db.select({id: forkMirrorEvent.id}).from(forkMirrorEvent).where(and(eq(forkMirrorEvent.mirrorId, m.id), eq(forkMirrorEvent.kind, "failed"), gte(forkMirrorEvent.at, c.opAt), sql`${forkMirrorEvent.details}->>'scope' = 'mirror'`)).limit(1) : [];
        if (!known) await addEvent(d.db, {mirrorId: m.id, revisionId: null, kind: "failed", at: now, code, details: {scope: "mirror", phase: "delete", step: "route"}});
    };
    if (!c || !loaded?.ok || !pol.success) { await failedEvent("internal_error"); return "failed"; }
    const o = await opTask(c, "route", routeEnqueue(c, loaded.plan, c.rev, "remove", null, pol.data));
    if (o.kind === "wait") return "wait";
    if (o.kind === "fail") { await failedEvent("route_incomplete"); return "failed"; }
    if (!MirrorRouteRemoveResult.safeParse(o.result).success) { await failedEvent("route_incomplete"); return "failed"; }
    await d.db.update(forkMirror).set({routePort: null, routeRevisionId: null, updatedAt: now}).where(eq(forkMirror.id, m.id));
    await recordAudit(d.db, {organizationId: m.organizationId, actorKind: "system", action: "fork.mirror.route", resourceType: "mirror", resourceId: m.id, result: "success", now, details: {phase: "removed", revisionId: c.rev.id}});
    return "done";
}

// ---- stop / start (W23 Part B, DD-9) -----------------------------------------------------------------------------------------------------
export type LifecycleEvent = "stop_requested" | "stop_done" | "stop_failed" | "start_requested" | "start_done" | "start_aborted" | "start_failed"
    | "refresh_requested" | "refresh_done" | "refresh_failed" | "refresh_broken" | "rollback_requested" | "rollback_done" | "rollback_failed" | "rollback_broken";
const TABLE: Record<LifecycleEvent, {from: readonly MirrorStatus[]; to: MirrorStatus}> = {
    stop_requested: {from: ["ready", "failed"], to: "stopping"},
    stop_done: {from: ["stopping"], to: "stopped"},
    stop_failed: {from: ["stopping"], to: "failed"},
    start_requested: {from: ["stopped"], to: "starting"},
    start_done: {from: ["starting"], to: "ready"},
    start_aborted: {from: ["starting"], to: "stopped"}, // nothing started, or the cleanup stop was verified
    start_failed: {from: ["starting"], to: "failed"}, // the cleanup stop itself failed: containers may still run
    // W24 (DD-2 / DD-5 / DD-9): the per-mirror lock IS this status; the active revision keeps serving in every one of them
    refresh_requested: {from: ["ready"], to: "refreshing"},
    refresh_done: {from: ["refreshing"], to: "ready"},
    refresh_failed: {from: ["refreshing"], to: "ready"}, // the new revision failed / was refused: the active one is untouched
    refresh_broken: {from: ["refreshing"], to: "failed"}, // the route could not be restored to the active revision: access may be broken
    rollback_requested: {from: ["ready"], to: "rolling_back"},
    rollback_done: {from: ["rolling_back"], to: "ready"},
    rollback_failed: {from: ["rolling_back"], to: "ready"},
    rollback_broken: {from: ["rolling_back"], to: "failed"},
};
const FAILURE_EVENTS: readonly LifecycleEvent[] = ["stop_failed", "start_failed", "refresh_failed", "refresh_broken", "rollback_failed", "rollback_broken"];
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

/**
 * `late` = the operation is older than `LIFECYCLE_BUDGET_MS`: no new task is enqueued and a task still in the agent's hands ends it `run_timeout` (an offline agent is still reported `agent_offline` first).
 * `rev` = the revision the operation acts on (stop / start: the active one; refresh: the new one; rollback: the target); `active` = the mirror's active revision.
 */
type OpCtx = {d: MirrorDeps; m: typeof forkMirror.$inferSelect; rev: RevRow; active: RevRow | null; opAt: Date; actorUserId: string | null; now: Date; late: boolean};

/** The journal rows of THIS operation (created at or after its start), the next attempt number over ALL rows of the step, and the task outcome like the creation's `taskStep`. */
async function opTask(c: OpCtx, step: MirrorJournalStep, enqueue: (attempt: number) => Promise<{ok: true} | {ok: false; code: string}>): Promise<Outcome> {
    const all = await journalRows(c.d.db, c.rev.id, step);
    const rows = all.filter((r) => r.createdAt.getTime() >= c.opAt.getTime());
    const last: JournalRow | undefined = rows[0];
    if (last?.task?.status === "queued" && last.task.attempts === 0 && last.taskId && c.rev.runnerAgentId && last.task.notAfter.getTime() < c.now.getTime()
        && (await expireQueuedTask(c.d.db, {taskId: last.taskId, agentId: c.rev.runnerAgentId, now: c.now}))) last.task.status = "expired";
    const go = async (): Promise<Outcome> => {
        if (c.late) return failOf("run_timeout");
        const r = await enqueue((all[0]?.attempt ?? 0) + 1);
        return r.ok ? WAIT : refusalOf(r.code);
    };
    if (!last) return go();
    if (!last.task) return failOf("internal_error");
    switch (last.task.status) {
        case "queued": case "leased": case "running": return c.late ? failOf("run_timeout") : WAIT;
        case "succeeded": return {kind: "ok", result: last.task.result, taskId: last.taskId};
        case "failed": case "rejected": return failOf(agentReason(last.task.result));
        case "expired": return rows.filter((r) => r.task?.status === "expired").length >= MAX_EXPIRED_REENQUEUES ? failOf("agent_offline") : go();
        case "cancelled": return failOf("task_cancelled");
        default: return failOf("internal_error");
    }
}

/**
 * One locked, audited status move (`where status = from`); optionally patches the acted-on revision's service list (what the runner reported). `extra` runs INSIDE the same transaction after the
 * move succeeded (failure notes, retirement, route pointer). `op_revision_id` is cleared whenever the mirror leaves refreshing / rolling_back.
 */
async function moveMirror(c: OpCtx, from: MirrorStatus, ev: LifecycleEvent, o: {code?: string | null; services?: {service: string; state: string; health?: string}[]; action: "stop" | "start" | "refresh" | "rollback"; phase: string;
    revisionId?: string; extra?: (tx: ForkDb) => Promise<void>}): Promise<boolean> {
    const to = nextMirrorStatus(from, ev);
    const failed = FAILURE_EVENTS.includes(ev);
    const keepsOp = to === "refreshing" || to === "rolling_back";
    return withForkLock(c.d.db, `mirror:${c.m.id}`, async (tx) => {
        const rows = await tx.update(forkMirror).set({status: to, ...(keepsOp ? {} : {opRevisionId: null}), updatedAt: c.now}).where(and(eq(forkMirror.id, c.m.id), eq(forkMirror.status, from))).returning({id: forkMirror.id});
        if (rows.length !== 1) return false;
        if (o.services) await tx.update(forkMirrorRevision).set({services: o.services, updatedAt: c.now}).where(eq(forkMirrorRevision.id, c.rev.id));
        if (o.extra) await o.extra(tx);
        await addEvent(tx, {mirrorId: c.m.id, revisionId: null, kind: "state_changed", at: c.now, fromState: from, toState: to, code: o.code ?? null, details: {scope: "mirror"}});
        await recordAudit(tx, {organizationId: c.m.organizationId, actorKind: "system", action: `fork.mirror.${o.action}`, resourceType: "mirror", resourceId: c.m.id, result: failed || (ev === "start_aborted" && o.code) ? "failure" : "success", now: c.now,
            details: {phase: o.phase, revisionId: o.revisionId ?? c.rev.id, ...(o.code ? {reason: o.code} : {})}});
        return true;
    });
}

const stopEnqueue = (c: OpCtx, plan: RestorePlanV1) => (attempt: number) =>
    enqueueMirrorTask(taskDeps(c.d, {principal: null, now: c.now, revisionId: c.rev.id, step: "stop", attempt}), {revision: revisionOf(c.rev), plan, step: "stop", attempt});

type Loaded = Extract<Awaited<ReturnType<typeof loadPlanRow>>, {ok: true}>;
async function opContext(d: MirrorDeps, m: typeof forkMirror.$inferSelect, status: MirrorStatus, now: Date, revisionId?: string | null): Promise<{c: OpCtx; plan: Loaded} | {error: string; c: OpCtx}> {
    const op = await opOf(d.db, m.id, status);
    const target = revisionId === undefined ? m.activeRevisionId : revisionId;
    const [rev] = target ? await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, target)) : [];
    const [active] = m.activeRevisionId ? await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, m.activeRevisionId)) : [];
    const base: OpCtx = {d, m, rev: rev as RevRow, active: (active as RevRow | undefined) ?? null, opAt: op?.at ?? now, actorUserId: op?.actorUserId ?? null, now, late: op ? now.getTime() - op.at.getTime() > LIFECYCLE_BUDGET_MS : false};
    if (!op || !rev || !rev.planId) return {error: "internal_error", c: base};
    const loaded = await loadPlanRow(d, rev.planId, rev.planHash);
    if (!loaded.ok) return {error: "plan_tampered", c: base};
    return {c: base, plan: loaded};
}

/** `mirror_route` enqueue for `target` (the revision whose header the task carries): `switch` is a forward step (principal), `remove` a safety step (none). */
const routeEnqueue = (c: OpCtx, plan: RestorePlanV1, target: RevRow, action: "switch" | "remove", principal: ForkPrincipal | null, pol: MirrorPolicyV1) => (attempt: number) =>
    enqueueMirrorTask(taskDeps(c.d, {principal: action === "remove" ? null : principal, now: c.now, revisionId: target.id, step: "route", attempt}),
        {revision: revisionOf(target), plan, step: "route", attempt, route: {action, mirrorId: c.m.id, routePort: c.m.routePort ?? 0, service: pol.access.service, target: pol.access.target, httpPath: pol.http_path}});
/** A route problem is reported as `route_failed` when the app did not answer through it; every other agent code keeps its own closed name. */
const routeCode = (code: string): string => (code === "route_smoke_failed" ? "route_failed" : code);

export async function advanceStopping(d: MirrorDeps, m: typeof forkMirror.$inferSelect, now: Date): Promise<"advanced" | "stopped" | "failed"> {
    const ctx = await opContext(d, m, "stopping", now);
    if ("error" in ctx) { await moveMirror(ctx.c, "stopping", "stop_failed", {code: ctx.error, action: "stop", phase: "failed"}); return "failed"; }
    const {c, plan} = ctx;
    const o = await opTask(c, "stop", stopEnqueue(c, plan.plan));
    if (o.kind === "wait") return "advanced";
    if (o.kind === "fail") { await moveMirror(c, "stopping", "stop_failed", {code: o.code, action: "stop", phase: "failed"}); return "failed"; }
    const r = MirrorStopResult.safeParse(o.result);
    if (!r.success) { await moveMirror(c, "stopping", "stop_failed", {code: "execution_error", action: "stop", phase: "failed"}); return "failed"; }
    await moveMirror(c, "stopping", "stop_done", {services: r.data.services.map((x) => ({service: x.service, state: x.state})), action: "stop", phase: "done"});
    return "stopped";
}

type Regate = {kind: "wait"} | {kind: "fail"; code: string; upRan: boolean} | {kind: "ok"; services: {service: string; state: string; health: string}[]};
/**
 * The re-gate shared by Start (active revision) and Rollback (target revision), on `c.rev`: flag, requester D31, runner, an isolation probe of THIS operation (before anything runs),
 * `mirror_up`, `mirror_check` (health + app smoke). `upRan` tells the caller whether containers may exist (⇒ a cleanup `stop` is needed). The creation's READY evidence
 * (`probe_task_id`, `gates`, `readied_at`) is never touched.
 */
async function regate(c: OpCtx, plan: Loaded, principalOut: {principal?: ForkPrincipal}): Promise<Regate> {
    const {d, m} = c;
    const agentId = c.rev.runnerAgentId;
    if (!agentId) return {kind: "fail", code: "runner_ineligible", upRan: false};
    const upRows = (await journalRows(d.db, c.rev.id, "up")).filter((r) => r.createdAt.getTime() >= c.opAt.getTime());
    const upRan = upRows.length > 0;
    if (!enabledOf(d)) return {kind: "fail", code: "mirrors_disabled", upRan};
    // D31: the requester's CURRENT right on this mirror, every tick
    const lookup = c.actorUserId ? await principalOfUser(d, c.actorUserId) : null;
    if (!lookup || lookup.kind !== "ok" || !forkCan(actorIn(lookup.principal, m.organizationId), "mirrors.manage")) return {kind: "fail", code: "reauth_failed", upRan};
    const principal = lookup.principal;
    principalOut.principal = principal;
    if (!(await assertRunnerTarget(d.db, agentId)).ok) return {kind: "fail", code: "runner_ineligible", upRan};

    // 1. isolation: a probe of THIS operation, evaluated after the operation started
    if (!upRan) {
        const o = await opTask(c, "isolation", async (attempt) => {
            if ((await adminTargetCount(d.db, agentId)) < 1) return {ok: false, code: "runner_not_isolated"};
            const r = await startRunnerProbe({...d, mirrorsEnabled: () => true} as never, {
                agentId, agentName: m.runnerAgentName, actorUserId: principal.userId, organizationId: m.organizationId, trigger: "mirror",
                onInserted: async (tx, taskId) => { await tx.insert(forkMirrorTask).values({revisionId: c.rev.id, step: "isolation", attempt, taskType: STEP_TASK_TYPE.isolation, taskId, createdAt: c.now}); },
            });
            if (r.ok) return {ok: true};
            return r.code === "probe_in_progress" || r.code === "signing_unavailable" ? {ok: false, code: "locked"} : {ok: false, code: r.code};
        });
        if (o.kind === "wait") return o;
        if (o.kind === "fail") return {kind: "fail", code: o.code === "execution_error" ? "runner_not_isolated" : o.code, upRan: false};
        const iso = await runnerIsolation(d.db, agentId, {now: c.now, maxAgeMs: Math.max(0, c.now.getTime() - c.opAt.getTime()) + 60_000, serverUrl: d.serverUrl()});
        const [fr] = await d.db.select({taskId: forkRunner.lastProbeTaskId}).from(forkRunner).where(eq(forkRunner.agentId, agentId));
        if (iso.state === "isolated") {
            if (fr?.taskId !== o.taskId || iso.probedAt.getTime() < c.opAt.getTime() - 1000) return {kind: "fail", code: "probe_stale", upRan: false};
        } else if (iso.state === "not_isolated") return {kind: "fail", code: "runner_not_isolated", upRan: false};
        else if (iso.reason === "probe_pending") return c.late ? {kind: "fail", code: "run_timeout", upRan: false} : WAIT;
        else return {kind: "fail", code: "probe_stale", upRan: false};
    }

    // 2. up
    const up = await opTask(c, "up", async (attempt) => enqueueMirrorTask(taskDeps(d, {principal, now: c.now, revisionId: c.rev.id, step: "up", attempt}),
        {revision: revisionOf(c.rev), plan: plan.plan, step: "up", attempt, finalSha256: c.rev.finalViewSha256 ?? undefined}));
    if (up.kind === "wait") return up;
    if (up.kind === "fail") return {kind: "fail", code: up.code, upRan: true};
    if (!MirrorUpResult.safeParse(up.result).success) return {kind: "fail", code: "execution_error", upRan: true};

    // 3. check: container health + app smoke (NOT the data: unchanged on the runner volumes)
    const pol = MirrorPolicyV1.safeParse(m.policy);
    if (!pol.success) return {kind: "fail", code: "internal_error", upRan: true};
    const expected = (Array.isArray(c.rev.services) ? (c.rev.services as {service?: unknown}[]) : []).map((x) => x.service).filter((x): x is string => typeof x === "string");
    const chk = await opTask(c, "check", async (attempt) => enqueueMirrorTask(taskDeps(d, {principal, now: c.now, revisionId: c.rev.id, step: "check", attempt}),
        {revision: revisionOf(c.rev), plan: plan.plan, step: "check", attempt, finalSha256: c.rev.finalViewSha256 ?? undefined, policy: pol.data}));
    if (chk.kind === "wait") return chk;
    if (chk.kind === "fail") return {kind: "fail", code: chk.code, upRan: true};
    const parsed = MirrorCheckResult.safeParse(chk.result);
    const health = checkHealth(chk.result, expected);
    if (!health.ok) return {kind: "fail", code: health.code, upRan: true};
    const smoke = checkSmoke(chk.result, pol.data);
    if (!smoke.ok) return {kind: "fail", code: smoke.code, upRan: true};
    if (!parsed.success) return {kind: "fail", code: "execution_error", upRan: true};
    return {kind: "ok", services: parsed.data.services.map((s) => ({service: s.service, state: s.state, health: s.health}))};
}

/** The failure code of a running op survives ticks as ONE mirror-scoped `failed` event (written the first time the cleanup starts). */
async function knownFailure(c: OpCtx, code: string, phase: string): Promise<string> {
    const [known] = await c.d.db.select({code: forkMirrorEvent.code}).from(forkMirrorEvent).where(and(eq(forkMirrorEvent.mirrorId, c.m.id), eq(forkMirrorEvent.kind, "failed"), gte(forkMirrorEvent.at, c.opAt), sql`${forkMirrorEvent.details}->>'scope' = 'mirror'`)).orderBy(desc(forkMirrorEvent.at)).limit(1);
    if (!known) await addEvent(c.d.db, {mirrorId: c.m.id, revisionId: null, kind: "failed", at: c.now, code, details: {scope: "mirror", phase}});
    return known?.code ?? code;
}

/**
 * Start = re-gate on the active revision. Any failure once `up` may have run is followed by a cleanup `stop`; only a verified stop returns the mirror to `stopped`, a failed one leaves it
 * `failed` ("containers may still run"). The failure code survives ticks as a mirror-scoped `failed` event.
 */
export async function advanceStarting(d: MirrorDeps, m: typeof forkMirror.$inferSelect, now: Date): Promise<"advanced" | "ready" | "stopped" | "failed"> {
    const ctx = await opContext(d, m, "starting", now);
    if ("error" in ctx) { await moveMirror(ctx.c, "starting", "start_failed", {code: ctx.error, action: "start", phase: "failed"}); return "failed"; }
    const {c, plan} = ctx;
    const agentId = c.rev.runnerAgentId;
    if (!agentId) { await moveMirror(c, "starting", "start_aborted", {code: "runner_ineligible", action: "start", phase: "aborted"}); return "stopped"; }

    const cleanup = async (code: string): Promise<"advanced" | "stopped" | "failed"> => {
        const why = await knownFailure(c, code, "start");
        const o = await opTask(c, "stop", stopEnqueue(c, plan.plan));
        if (o.kind === "wait") return "advanced";
        if (o.kind === "fail" || !MirrorStopResult.safeParse(o.result).success) { await moveMirror(c, "starting", "start_failed", {code: o.kind === "fail" ? o.code : "execution_error", action: "start", phase: "failed"}); return "failed"; }
        await moveMirror(c, "starting", "start_aborted", {code: why, action: "start", phase: "aborted"});
        return "stopped";
    };
    // a cleanup stop of this operation exists: finish it (the recorded failure code is the reason)
    const stops = (await journalRows(d.db, c.rev.id, "stop")).filter((r) => r.createdAt.getTime() >= c.opAt.getTime());
    if (stops.length > 0) return cleanup("internal_error");

    const g = await regate(c, plan, {});
    if (g.kind === "wait") return "advanced";
    if (g.kind === "fail") {
        if (g.upRan) return cleanup(g.code);
        await moveMirror(c, "starting", "start_aborted", {code: g.code, action: "start", phase: "aborted"});
        return "stopped";
    }
    const ok = await moveMirror(c, "starting", "start_done", {services: g.services, action: "start", phase: "done"});
    return ok ? "ready" : "advanced";
}

// ---- refresh (W24, DD-5) -----------------------------------------------------------------------------------------------------------------
const loadRev = async (d: MirrorDeps, id: string | null): Promise<RevRow | null> => {
    if (!id) return null;
    const [r] = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, id));
    return (r as RevRow | undefined) ?? null;
};

/** Retire a kept READY revision (wiped by the wipe phase afterwards). The guard never touches the mirror's ACTIVE revision. */
async function retire(tx: ForkDb, c: OpCtx, revisionId: string, code: string, details: Record<string, unknown> = {}): Promise<boolean> {
    const rows = await tx.update(forkMirrorRevision).set({retiredAt: c.now, updatedAt: c.now})
        .where(and(eq(forkMirrorRevision.id, revisionId), eq(forkMirrorRevision.state, "ready"), isNull(forkMirrorRevision.retiredAt), sql`${forkMirrorRevision.id} <> (select active_revision_id from fork_mirror where id = ${c.m.id})`)).returning({id: forkMirrorRevision.id});
    if (rows.length !== 1) return false;
    await addEvent(tx, {mirrorId: c.m.id, revisionId, kind: "retired", at: c.now, code, details});
    return true;
}

/** The switch commit: ONE locked transaction; the only place (with `commitRollback`) that moves `active_revision_id`. */
async function commitRefreshSwitch(c: OpCtx, next: RevRow, old: RevRow): Promise<boolean> {
    return withForkLock(c.d.db, `mirror:${c.m.id}`, async (tx) => {
        const [cur] = await tx.select().from(forkMirror).where(eq(forkMirror.id, c.m.id));
        if (!cur || cur.status !== "refreshing" || cur.activeRevisionId !== old.id || cur.opRevisionId !== next.id) return false;
        const [nr] = await tx.select({state: forkMirrorRevision.state, activatedAt: forkMirrorRevision.activatedAt, retiredAt: forkMirrorRevision.retiredAt}).from(forkMirrorRevision).where(eq(forkMirrorRevision.id, next.id));
        if (!nr || nr.state !== "ready" || nr.activatedAt !== null || nr.retiredAt !== null) return false;
        await tx.update(forkMirror).set({activeRevisionId: next.id, routeRevisionId: next.id, updatedAt: c.now}).where(eq(forkMirror.id, c.m.id));
        await tx.update(forkMirrorRevision).set({activatedAt: c.now, updatedAt: c.now}).where(eq(forkMirrorRevision.id, next.id));
        await addEvent(tx, {mirrorId: c.m.id, revisionId: next.id, kind: "activated", at: c.now, details: {fromRevisionId: old.id}});
        await recordAudit(tx, {organizationId: c.m.organizationId, actorKind: "system", action: "fork.mirror.refresh", resourceType: "mirror", resourceId: c.m.id, result: "success", now: c.now,
            details: {phase: "switched", revisionId: next.id, fromRevisionId: old.id}});
        return true;
    });
}

/**
 * Refresh op: the NEW revision is built by the unchanged W22a pipeline (the revision tick); this op (a) waits for it, (b) ends the op if it failed (the active revision was never touched),
 * (c) once READY: re-gates, switches the private route (`mirror_route`, smoke through the forwarder), commits the pointer, then (d) stops the previous revision (retained for rollback).
 * A route failure re-asserts the route to the ACTIVE revision; only if that also fails is the mirror `failed` (honest: access may be broken).
 */
export async function advanceRefreshing(d: MirrorDeps, m: typeof forkMirror.$inferSelect, now: Date): Promise<"advanced" | "refreshed" | "failed"> {
    const next = await loadRev(d, m.opRevisionId);
    const ctx = await opContext(d, m, "refreshing", now, m.opRevisionId);
    if (!next || "error" in ctx) {
        // no op revision / op event / plan: the active revision was never touched ⇒ back to ready with the code (an op start event is missing only on a broken row)
        const c = ctx.c;
        await moveMirror({...c, rev: (next ?? c.active ?? c.rev) as RevRow}, "refreshing", "refresh_failed", {code: "error" in ctx ? ctx.error : "internal_error", action: "refresh", phase: "failed", revisionId: next?.id});
        return "failed";
    }
    const {c, plan} = ctx;
    const pol = MirrorPolicyV1.safeParse(m.policy);
    const failRefresh = async (code: string, o: {retire: boolean; routeToActive?: boolean}): Promise<"failed"> => {
        await moveMirror(c, "refreshing", "refresh_failed", {code, action: "refresh", phase: "failed",
            extra: async (tx) => {
                await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "failed", at: now, code, details: {scope: "mirror", phase: "refresh"}});
                if (o.retire) await retire(tx, c, next.id, code === "route_failed" || code.startsWith("route_") ? "route_failed" : code);
                if (o.routeToActive && c.active) await tx.update(forkMirror).set({routeRevisionId: c.active.id}).where(eq(forkMirror.id, m.id));
            }});
        return "failed";
    };

    // (a)/(b) the new revision
    if ((ACTIVE_REVISION_STATES as readonly string[]).includes(next.state)) return "advanced"; // the revision tick drives it
    if (next.state === "blocked" || next.state === "failed" || next.state === "cancelled" || next.state === "rolled_back") return failRefresh(next.reason ?? (next.state === "cancelled" ? "cancelled" : "internal_error"), {retire: false});
    if (!c.active || !pol.success) return failRefresh("internal_error", {retire: true});

    // (d) already committed: stop the previous revision
    if (m.activeRevisionId === next.id) return stopPrevious(c, next);

    // (c) switch phase: the budget counts from the moment the new revision became READY (the build has its own deadline)
    const cs: OpCtx = {...c, late: next.readiedAt ? now.getTime() - next.readiedAt.getTime() > LIFECYCLE_BUDGET_MS : false};
    if (next.activatedAt !== null) return failRefresh("internal_error", {retire: false});
    if (!enabledOf(d)) return "advanced"; // forward step: waits (the build deadline and the wipe still run)
    const routeRows = (await journalRows(d.db, next.id, "route")).filter((r) => r.createdAt.getTime() >= c.opAt.getTime());
    const activeLoaded = await loadPlanRow(d, c.active.planId ?? "", c.active.planHash);

    /** The route was put back on the ACTIVE revision (route truth comes from the runner, never assumed); `principal` null ⇒ the requester is gone and the re-assert is refused ⇒ `refresh_broken`. */
    const reassert = async (problem: string, principal: ForkPrincipal | null): Promise<"advanced" | "failed"> => {
        if (!activeLoaded.ok || !principal) return brokenRefresh();
        const ca: OpCtx = {...cs, rev: c.active as RevRow};
        const ra = await opTask(ca, "route", routeEnqueue(ca, activeLoaded.plan, c.active as RevRow, "switch", principal, pol.data));
        if (ra.kind === "wait") return "advanced";
        if (ra.kind === "ok" && checkRouteSwitch(ra.result, m.routePort, pol.data).ok) return failRefresh(problem, {retire: true, routeToActive: true});
        return brokenRefresh();
    };
    const brokenRefresh = async (): Promise<"failed"> => {
        await moveMirror(c, "refreshing", "refresh_broken", {code: "route_failed", action: "refresh", phase: "failed",
            extra: async (tx) => {
                await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "failed", at: now, code: "route_failed", details: {scope: "mirror", phase: "refresh"}});
                await retire(tx, c, next.id, "route_failed");
            }});
        return "failed";
    };
    /** A pre-switch check failed. If a route task of this op exists it is cancelled when it never started; one in the agent's hands is awaited; one that ran means the route may have moved ⇒ re-assert. */
    const preFail = async (code: string, principal: ForkPrincipal | null): Promise<"advanced" | "failed"> => {
        if (routeRows.length === 0) return failRefresh(code, {retire: true});
        let inHands = false;
        for (const r of routeRows) {
            if (!r.task || !["queued", "leased", "running"].includes(r.task.status)) continue;
            if (r.task.status === "queued" && r.task.attempts === 0 && r.taskId && next.runnerAgentId && (await cancelQueuedTask(d.db, {taskId: r.taskId, agentId: next.runnerAgentId, now}))) continue;
            inHands = true;
        }
        if (inHands) return "advanced";
        const started = routeRows.some((r) => r.task && (r.task.attempts > 0 || ["succeeded", "failed", "rejected"].includes(r.task.status)));
        return started ? reassert(code, principal) : failRefresh(code, {retire: true});
    };

    const lookup = c.actorUserId ? await principalOfUser(d, c.actorUserId) : null;
    const principal = lookup && lookup.kind === "ok" ? lookup.principal : null;
    if (!principal || !forkCan(actorIn(principal, m.organizationId), "mirrors.manage")) return preFail("reauth_failed", null);
    if (!next.runnerAgentId || !(await assertRunnerTarget(d.db, next.runnerAgentId)).ok) return preFail("runner_ineligible", principal);
    if (routeRows.length === 0) { // the gates are the READY facts: re-checked once, right before the first route task
        const gates = await evaluateGates(d.db, d, next, now);
        if (!gates.ok) return failRefresh(gates.code, {retire: true});
    }

    const sw = await opTask({...cs, rev: next}, "route", routeEnqueue(cs, plan.plan, next, "switch", principal, pol.data));
    if (sw.kind === "wait") return "advanced";
    let routeProblem: string | null = null;
    if (sw.kind === "fail") routeProblem = routeCode(sw.code);
    else { const chk = checkRouteSwitch(sw.result, m.routePort, pol.data); if (!chk.ok) routeProblem = routeCode(chk.code); }
    if (routeProblem === null) {
        await commitRefreshSwitch(c, next, c.active); // false ⇒ the mirror moved under us: the next tick re-evaluates; true ⇒ the next tick stops the previous revision (each phase restartable)
        return "advanced";
    }
    return reassert(routeProblem, principal);
}

/** After the pointer moved: stop the previous revision (it stays READY, stopped, as the rollback target). A failed stop retires it (the wipe removes its containers) and is recorded, but the refresh is done. */
async function stopPrevious(c: OpCtx, next: RevRow): Promise<"advanced" | "refreshed"> {
    const {d, m} = c;
    const [ev] = await d.db.select({details: forkMirrorEvent.details}).from(forkMirrorEvent).where(and(eq(forkMirrorEvent.revisionId, next.id), eq(forkMirrorEvent.kind, "activated"))).orderBy(desc(forkMirrorEvent.at)).limit(1);
    const fromId = (ev?.details as {fromRevisionId?: unknown} | undefined)?.fromRevisionId;
    const old = typeof fromId === "string" ? await loadRev(d, fromId) : null;
    const finish = async (cOld: OpCtx, o: {services?: {service: string; state: string}[]; stopFailed?: string}) => {
        await moveMirror(cOld, "refreshing", "refresh_done", {services: o.services, action: "refresh", phase: "done", revisionId: next.id,
            extra: async (tx) => {
                if (o.stopFailed) {
                    await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "failed", at: c.now, code: o.stopFailed, details: {scope: "mirror", phase: "refresh_stop"}});
                    if (old) await retire(tx, c, old.id, o.stopFailed);
                }
            }});
        return "refreshed" as const;
    };
    if (!old || old.state !== "ready" || !old.planId) return finish(c, {});
    const lp = await loadPlanRow(d, old.planId, old.planHash);
    const cOld: OpCtx = {...c, rev: old, late: false};
    if (!lp.ok) return finish(cOld, {stopFailed: "internal_error"});
    const o = await opTask(cOld, "stop", stopEnqueue(cOld, lp.plan));
    if (o.kind === "wait") return "advanced";
    const r = o.kind === "ok" ? MirrorStopResult.safeParse(o.result) : null;
    if (o.kind === "fail" || !r?.success) return finish(cOld, {stopFailed: "stop_incomplete"});
    return finish(cOld, {services: r.data.services.map((x) => ({service: x.service, state: x.state}))});
}

// ---- rollback (W24, DD-9) ----------------------------------------------------------------------------------------------------------------
/** The rollback commit: the target becomes active, the previous active revision `ready → rolled_back` (wiped afterwards), the mirror `ready` again. One locked transaction. */
async function commitRollback(c: OpCtx, target: RevRow, previous: RevRow, services: {service: string; state: string; health?: string}[]): Promise<boolean> {
    const to = nextMirrorStatus("rolling_back", "rollback_done");
    return withForkLock(c.d.db, `mirror:${c.m.id}`, async (tx) => {
        const [cur] = await tx.select().from(forkMirror).where(eq(forkMirror.id, c.m.id));
        if (!cur || cur.status !== "rolling_back" || cur.activeRevisionId !== previous.id || cur.opRevisionId !== target.id) return false;
        const [tr] = await tx.select({state: forkMirrorRevision.state, retiredAt: forkMirrorRevision.retiredAt, wipeState: forkMirrorRevision.wipeState}).from(forkMirrorRevision).where(eq(forkMirrorRevision.id, target.id));
        if (!tr || tr.state !== "ready" || tr.retiredAt !== null || tr.wipeState !== null) return false;
        const [pr] = await tx.select({state: forkMirrorRevision.state}).from(forkMirrorRevision).where(eq(forkMirrorRevision.id, previous.id));
        if (!pr || pr.state !== "ready") return false;
        await tx.update(forkMirror).set({status: to, activeRevisionId: target.id, routeRevisionId: target.id, opRevisionId: null, updatedAt: c.now}).where(eq(forkMirror.id, c.m.id));
        await tx.update(forkMirrorRevision).set({activatedAt: c.now, services, updatedAt: c.now}).where(eq(forkMirrorRevision.id, target.id));
        const next = transition("ready", "rolled_back");
        await tx.update(forkMirrorRevision).set({state: next, updatedAt: c.now}).where(eq(forkMirrorRevision.id, previous.id));
        await addEvent(tx, {mirrorId: c.m.id, revisionId: previous.id, kind: "rolled_back", at: c.now, fromState: "ready", toState: next, details: {toRevisionId: target.id}});
        await addEvent(tx, {mirrorId: c.m.id, revisionId: target.id, kind: "activated", at: c.now, details: {fromRevisionId: previous.id}});
        await addEvent(tx, {mirrorId: c.m.id, revisionId: null, kind: "state_changed", at: c.now, fromState: "rolling_back", toState: to, details: {scope: "mirror"}});
        await recordAudit(tx, {organizationId: c.m.organizationId, actorKind: "system", action: "fork.mirror.rollback", resourceType: "mirror", resourceId: c.m.id, result: "success", now: c.now,
            details: {phase: "done", revisionId: target.id, fromRevisionId: previous.id}});
        return true;
    });
}

/**
 * Rollback op on the TARGET revision (an earlier READY, retained, stopped one): re-gate (own isolation probe -> up -> health + app smoke), switch the route, commit. Failure before the commit
 * re-asserts the route to the current active revision, stops the target again and returns the mirror to `ready` (the active revision was never touched).
 */
export async function advanceRollingBack(d: MirrorDeps, m: typeof forkMirror.$inferSelect, now: Date): Promise<"advanced" | "rolled_back" | "failed"> {
    const ctx = await opContext(d, m, "rolling_back", now, m.opRevisionId);
    if ("error" in ctx || !ctx.c.active) { await moveMirror({...ctx.c, rev: (ctx.c.rev ?? ctx.c.active) as RevRow}, "rolling_back", "rollback_failed", {code: "error" in ctx ? ctx.error : "internal_error", action: "rollback", phase: "failed"}); return "failed"; }
    const {c, plan} = ctx;
    const active = c.active as RevRow;
    const pol = MirrorPolicyV1.safeParse(m.policy);
    if (!pol.success) { await moveMirror(c, "rolling_back", "rollback_failed", {code: "internal_error", action: "rollback", phase: "failed"}); return "failed"; }

    // cleanup: re-assert the route to the active revision (once the switch may have changed it), stop the target again, back to `ready`
    const cleanup = async (code: string, o: {route: boolean; ran: boolean}, principal?: ForkPrincipal): Promise<"advanced" | "failed"> => {
        const why = await knownFailure(c, code, "rollback");
        if (o.route && principal) {
            const lp = await loadPlanRow(d, active.planId ?? "", active.planHash);
            const ca: OpCtx = {...c, rev: active};
            if (!lp.ok) { await moveMirror(c, "rolling_back", "rollback_broken", {code: "route_failed", action: "rollback", phase: "failed"}); return "failed"; }
            const ra = await opTask(ca, "route", routeEnqueue(ca, lp.plan, active, "switch", principal, pol.data));
            if (ra.kind === "wait") return "advanced";
            if (!(ra.kind === "ok" && checkRouteSwitch(ra.result, m.routePort, pol.data).ok)) { await moveMirror(c, "rolling_back", "rollback_broken", {code: "route_failed", action: "rollback", phase: "failed"}); return "failed"; }
        }
        if (o.ran) {
            const st = await opTask(c, "stop", stopEnqueue(c, plan.plan));
            if (st.kind === "wait") return "advanced";
            if (st.kind === "fail" || !MirrorStopResult.safeParse(st.result).success) { await moveMirror(c, "rolling_back", "rollback_broken", {code: st.kind === "fail" ? st.code : "stop_incomplete", action: "rollback", phase: "failed"}); return "failed"; }
        }
        await moveMirror(c, "rolling_back", "rollback_failed", {code: why, action: "rollback", phase: "failed",
            extra: async (tx) => { if (o.route) await tx.update(forkMirror).set({routeRevisionId: active.id}).where(eq(forkMirror.id, m.id)); }});
        return "failed";
    };
    // a cleanup of this operation is already under way: finish it
    const own = async (step: MirrorJournalStep) => (await journalRows(d.db, c.rev.id, step)).filter((r) => r.createdAt.getTime() >= c.opAt.getTime());
    const routeRows = await own("route");
    const stopRows = await own("stop");
    const lookup0 = c.actorUserId ? await principalOfUser(d, c.actorUserId) : null;
    const principal0 = lookup0 && lookup0.kind === "ok" ? lookup0.principal : undefined;
    if (stopRows.length > 0) return cleanup("internal_error", {route: routeRows.length > 0, ran: true}, principal0);

    const pr: {principal?: ForkPrincipal} = {};
    const g = await regate(c, plan, pr);
    if (g.kind === "wait") return "advanced";
    if (g.kind === "fail") return cleanup(g.code, {route: false, ran: g.upRan});
    const principal = pr.principal as ForkPrincipal;

    const sw = await opTask(c, "route", routeEnqueue(c, plan.plan, c.rev, "switch", principal, pol.data));
    if (sw.kind === "wait") return "advanced";
    if (sw.kind === "fail") return cleanup(routeCode(sw.code), {route: true, ran: true}, principal);
    const chk = checkRouteSwitch(sw.result, m.routePort, pol.data);
    if (!chk.ok) return cleanup(routeCode(chk.code), {route: true, ran: true}, principal);
    if (!(await commitRollback(c, c.rev, active, g.services))) return "advanced";
    return "rolled_back";
}

// ---- retention (W24, DD-6 / ADR-009 §8) ----------------------------------------------------------------------------------------------------
/**
 * At most `KEEP_REVISIONS` kept READY revisions per mirror (the active one counts) and no non-active kept revision older than `REVISION_MAX_AGE_DAYS`: the oldest non-active ones are RETIRED (the verified
 * wipe then removes their runner copy). Never during a mirror op, never the ACTIVE revision (SQL guard), only owned data (the wipe is label-scoped). An over-age ACTIVE revision is only flagged by the view.
 */
export async function advanceMirrorRetention(d: MirrorDeps): Promise<{retired: number}> {
    const out = {retired: 0};
    const now = nowOf(d);
    const mirrors = await d.db.select().from(forkMirror).where(and(inArray(forkMirror.status, ["ready", "stopped", "failed"]), isNull(forkMirror.deletedAt))).limit(200);
    const cutoff = new Date(now.getTime() - REVISION_MAX_AGE_DAYS * 86_400_000);
    for (const m of mirrors) {
        try {
            const kept = (await d.db.select().from(forkMirrorRevision).where(and(eq(forkMirrorRevision.mirrorId, m.id), eq(forkMirrorRevision.state, "ready"), isNull(forkMirrorRevision.retiredAt),
                sql`coalesce(${forkMirrorRevision.wipeState}, '') NOT IN ('verified','not_needed')`)).orderBy(asc(forkMirrorRevision.seq))) as RevRow[];
            const others = kept.filter((r) => r.id !== m.activeRevisionId);
            const victims = new Map<string, "superseded" | "max_age">();
            for (const r of others) if (r.readiedAt && r.readiedAt.getTime() < cutoff.getTime()) victims.set(r.id, "max_age");
            let count = kept.length - victims.size;
            for (const r of others) {
                if (count <= KEEP_REVISIONS) break;
                if (victims.has(r.id)) continue;
                victims.set(r.id, "superseded");
                count -= 1;
            }
            for (const [id, why] of victims) {
                const ok = await withForkLock(d.db, `mirror:${m.id}`, async (tx) => {
                    const [cur] = await tx.select({status: forkMirror.status}).from(forkMirror).where(eq(forkMirror.id, m.id));
                    if (!cur || !["ready", "stopped", "failed"].includes(cur.status)) return false;
                    const c: OpCtx = {d, m, rev: kept.find((r) => r.id === id) as RevRow, active: null, opAt: now, actorUserId: null, now, late: false};
                    if (!(await retire(tx, c, id, why))) return false;
                    await recordAudit(tx, {organizationId: m.organizationId, actorKind: "system", action: "fork.mirror.retention", resourceType: "mirror", resourceId: m.id, result: "success", now, details: {revisionId: id, reason: why}});
                    return true;
                });
                if (ok) out.retired += 1;
            }
        } catch {
            // isolated: the next tick retries (the message is never read or logged)
        }
    }
    return out;
}

export type OpTick = {advanced: number; stopped: number; ready: number; failed: number; refreshed: number; rolledBack: number};
export async function advanceMirrorLifecycles(d: MirrorDeps): Promise<OpTick> {
    const out: OpTick = {advanced: 0, stopped: 0, ready: 0, failed: 0, refreshed: 0, rolledBack: 0};
    const mirrors = await d.db.select().from(forkMirror).where(inArray(forkMirror.status, ["stopping", "starting", "refreshing", "rolling_back"])).orderBy(asc(forkMirror.updatedAt)).limit(50);
    for (const m of mirrors) {
        const lease = `mirror-op:${m.id}`;
        const now = nowOf(d);
        if (!(await acquireLease(d.db, lease, ownerOf(d), 15 * 60_000, now))) continue;
        try {
            const r = m.status === "stopping" ? await advanceStopping(d, m, now) : m.status === "starting" ? await advanceStarting(d, m, now)
                : m.status === "refreshing" ? await advanceRefreshing(d, m, now) : await advanceRollingBack(d, m, now);
            if (r === "advanced") out.advanced += 1;
            else if (r === "failed") out.failed += 1;
            else if (r === "ready") out.ready += 1;
            else if (r === "refreshed") out.refreshed += 1;
            else if (r === "rolled_back") out.rolledBack += 1;
            else out.stopped += 1;
        } catch {
            // isolated: the next tick retries (the message is never read or logged)
        } finally {
            await releaseLease(d.db, lease, ownerOf(d));
        }
    }
    return out;
}
