import {and, desc, eq} from "drizzle-orm";
import type {ForkPrincipal} from "@/fork/acl";
import {expireQueuedTask} from "@/fork/agent-channel/tasks";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkRecoveryPoint} from "@/fork/db/schema/recovery";
import {forkRestoreOverride} from "@/fork/db/schema/restore-override";
import {forkRestoreRun, forkRestoreRunTask} from "@/fork/db/schema/restore-run";
import type {ForkDb} from "@/fork/db/handle";
import {enqueueForkNotification} from "@/fork/notify";
import {checkPolicyApproval} from "@/fork/policy/approval";
import {RULES_SHA256} from "@/fork/policy/rules";
import {done, fail, wait, type Handlers, type StepOutcome} from "@/fork/runs/engine";
import {workspaceOf} from "@/fork/restore-tasks/build";
import {enqueueRestoreTask, resolveManifest, type RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {latestRender, renderVerdict} from "@/fork/restore-tasks/render";
import type {PlanRow} from "@/fork/restore/service";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {checkDb, checkProbe, checkServices, checkStage, parseServices, type Check} from "./derive";
import type {RestoreRunDeps} from "./deps";
import {defaultManifestFetch, type ManifestBundle} from "./manifest";
import {MAX_EXPIRED_REENQUEUES, REASON_RE, STEP_TASK_TYPE, TRANSIENT_REFUSALS, type JournalStep, type RestoreStep} from "./vocab";

/**
 * Step handlers of the W18a orchestrator on the W12 engine. A handler is IDEMPOTENT: it derives "what to do" from the step journal
 * (`fork_restore_run_task`, written inside the enqueue transaction) and the task row, never from memory. One agent task per step at a time:
 * a task is enqueued only after the previous step finished (the agent runs one task at a time and tasks carry no dependency on each other).
 */
export type RunRow = typeof forkRestoreRun.$inferSelect;
export type RunCtx = {
    d: RestoreRunDeps; run: RunRow; plan: RestorePlanV1; planRow: PlanRow; principal: ForkPrincipal; now: Date;
    /** Per-tick memo of the signed manifest bytes (never persisted, never logged). */
    memo: {manifest?: ManifestBundle | null};
};

export const ACTIVE = ["running", "awaiting_approval"] as const;
export const MANIFEST_FETCH_ATTEMPTS = 30;

export type JournalRow = {
    runId: string; step: string; attempt: number; taskId: string | null; overrideRevision: number | null;
    task: {status: string; attempts: number; result: unknown; notAfter: Date} | null;
};

/** Every journal row of one step (newest attempt first) with its task row. */
export async function journalRows(db: ForkDb, runId: string, step: JournalStep): Promise<JournalRow[]> {
    const rows = await db.select({j: forkRestoreRunTask, t: {status: forkAgentTask.status, attempts: forkAgentTask.attempts, result: forkAgentTask.result, notAfter: forkAgentTask.notAfter}})
        .from(forkRestoreRunTask).leftJoin(forkAgentTask, eq(forkAgentTask.id, forkRestoreRunTask.taskId))
        .where(and(eq(forkRestoreRunTask.runId, runId), eq(forkRestoreRunTask.step, step))).orderBy(desc(forkRestoreRunTask.attempt));
    return rows.map((r) => ({runId, step, attempt: r.j.attempt, taskId: r.j.taskId, overrideRevision: r.j.overrideRevision, task: r.t && r.t.status ? r.t : null}));
}

/** Task deps for one enqueue: acts as the run's STARTER and writes the journal row in the enqueue transaction. */
export function taskDeps(ctx: Pick<RunCtx, "d" | "principal" | "now"> & {run: {id: string}}, j: {step: JournalStep; attempt: number; overrideRevision?: number | null}): RestoreTaskDeps {
    const {manifest: _m, principalOf: _p, maxRunMs: _x, owner: _o, ...channel} = ctx.d;
    return {
        ...channel, principal: ctx.principal, now: () => ctx.now,
        onTaskInserted: async (tx, t) => {
            await tx.insert(forkRestoreRunTask).values({runId: ctx.run.id, step: j.step, attempt: j.attempt, taskType: t.type, taskId: t.taskId, overrideRevision: j.overrideRevision ?? null, createdAt: ctx.now});
        },
    };
}

const refusalOutcome = (code: string): StepOutcome => ((TRANSIENT_REFUSALS as readonly string[]).includes(code) ? wait() : fail(REASON_RE.test(code) ? code : "internal_error"));
const agentReason = (result: unknown): string => {
    const r = (result as {reason?: unknown} | null)?.reason;
    return typeof r === "string" && REASON_RE.test(r) ? r : "execution_error";
};

async function manifestOf(ctx: RunCtx): Promise<ManifestBundle | null> {
    if (ctx.memo.manifest !== undefined) return ctx.memo.manifest;
    const [rp] = ctx.run.rpId ? await ctx.d.db.select({manifestRefs: forkRecoveryPoint.manifestRefs}).from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, ctx.run.rpId)) : [];
    if (!rp) { ctx.memo.manifest = null; return null; }
    const fetch = ctx.d.manifest ?? defaultManifestFetch(ctx.d.db);
    ctx.memo.manifest = await fetch({id: ctx.plan.rp.id, stackId: ctx.plan.rp.stack_id, manifestRefs: rp.manifestRefs});
    return ctx.memo.manifest;
}

type TaskStepOpts = {
    step: Exclude<JournalStep, "cleanup">;
    /** Input of the enqueue (the manifest bundle is passed when `manifest: true`). */
    input: (manifest: ManifestBundle | null) => unknown;
    manifest: boolean;
    check?: (result: unknown, last: JournalRow) => Promise<Check | StepOutcome> | Check | StepOutcome;
    /** A succeeded task that is no longer what the run needs (render of an older override revision) is replaced by a new attempt. */
    replaceWhen?: (last: JournalRow) => boolean;
    overrideRevision?: () => Promise<number>;
};

const isOutcome = (x: Check | StepOutcome): x is StepOutcome => "kind" in x;

async function taskStep(ctx: RunCtx, o: TaskStepOpts): Promise<StepOutcome> {
    const rows = await journalRows(ctx.d.db, ctx.run.id, o.step);
    const last = rows[0];
    // an OFFLINE agent never polls, so nothing else would ever expire its never-started task: do it here (the budget below then ends in `agent_offline`)
    if (last?.task?.status === "queued" && last.task.attempts === 0 && last.taskId && last.task.notAfter.getTime() < ctx.now.getTime()
        && (await expireQueuedTask(ctx.d.db, {taskId: last.taskId, agentId: ctx.plan.target.agent_id, now: ctx.now}))) last.task.status = "expired";
    const enqueue = async (): Promise<StepOutcome> => {
        let m: ManifestBundle | null = null;
        if (o.manifest) {
            m = await manifestOf(ctx);
            if (!m) return wait(); // storage unreachable right now: retry next tick (bounded by the run deadline)
        }
        const res = await enqueueRestoreTask(taskDeps(ctx, {step: o.step, attempt: (last?.attempt ?? 0) + 1, overrideRevision: o.overrideRevision ? await o.overrideRevision() : null}), o.input(m));
        return res.ok ? wait() : refusalOutcome(res.code);
    };
    if (!last) return enqueue();
    if (!last.task) return fail("internal_error"); // the task row is gone (agent deleted): nothing to wait for
    switch (last.task.status) {
        case "queued": case "leased": case "running": return wait();
        case "succeeded": {
            if (o.replaceWhen?.(last)) return enqueue();
            const c = o.check ? await o.check(last.task.result, last) : ({ok: true} as Check);
            if (isOutcome(c)) return c;
            return c.ok ? done() : fail(c.code);
        }
        case "failed": case "rejected": return fail(agentReason(last.task.result));
        case "expired": {
            // the agent never started it (offline): a fresh task, up to the budget
            const expired = rows.filter((r) => r.task?.status === "expired").length;
            return expired >= MAX_EXPIRED_REENQUEUES ? fail("agent_offline") : enqueue();
        }
        case "cancelled": return fail("task_cancelled");
        default: return fail("internal_error");
    }
}

const contextOf = (plan: RestorePlanV1) => ({stack_id: plan.rp.stack_id, rp_id: plan.rp.id, target_agent_id: plan.target.agent_id});
const hasMemo = (m: ManifestBundle | null): m is ManifestBundle => m !== null;

async function overrideRevision(db: ForkDb, planId: string): Promise<number> {
    const [r] = await db.select({revision: forkRestoreOverride.revision}).from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, planId));
    return r?.revision ?? 0;
}

async function setRunState(ctx: RunCtx, from: "running" | "awaiting_approval", to: "running" | "awaiting_approval", extra: Partial<typeof forkRestoreRun.$inferInsert> = {}): Promise<void> {
    await ctx.d.db.update(forkRestoreRun).set({state: to, updatedAt: ctx.now, ...extra}).where(and(eq(forkRestoreRun.id, ctx.run.id), eq(forkRestoreRun.state, from)));
    ctx.run = {...ctx.run, state: to, ...(extra as Partial<RunRow>)};
}

/** The policy gate of the `render` step (W20a D-6/D-7): fresh verdict of the render the operator is looking at, never a stored one. */
async function renderGate(ctx: RunCtx, last: JournalRow): Promise<StepOutcome> {
    const {d, run, plan} = ctx;
    const row = await latestRender(d.db, {restoreId: run.id, agentId: plan.target.agent_id});
    if (!row || row.taskId !== last.taskId) return fail("render_missing");
    let ws: string;
    try { ws = workspaceOf(plan); } catch { return fail("invalid_input"); }
    const verdict = renderVerdict(row, ws);
    if (verdict.hard.length > 0) return fail("policy_refused");
    const clearToken = async () => {
        if (run.policyApproval === null && run.policyApprovalSha256 === null) return;
        await d.db.update(forkRestoreRun).set({policyApproval: null, policyApprovalSha256: null, policyApprovedBy: null, policyApprovedAt: null, updatedAt: ctx.now}).where(eq(forkRestoreRun.id, run.id));
        ctx.run = {...ctx.run, policyApproval: null, policyApprovalSha256: null, policyApprovedBy: null, policyApprovedAt: null};
    };
    if (verdict.verdict === "allow") {
        await clearToken(); // an "allow" compose takes NO token (enqueue refuses an over-broad one)
        if (run.state === "awaiting_approval") await setRunState(ctx, "awaiting_approval", "running");
        return done();
    }
    if (run.policyApproval !== null) {
        const chk = checkPolicyApproval({verdict, token: run.policyApproval, context: contextOf(plan)});
        if (chk.ok) {
            if (run.state === "awaiting_approval") await setRunState(ctx, "awaiting_approval", "running");
            return done();
        }
        await clearToken(); // stale: the compose, the rules or the context changed since it was approved
    }
    if (run.state === "running") await setRunState(ctx, "running", "awaiting_approval");
    await enqueueForkNotification(d.db, {kind: "restore.needs_approval", dedupeKey: `restore:${run.id}:approval:${row.renderedSha256}`, payload: {stackId: run.stackId}});
    return wait();
}

export function handlers(ctx: RunCtx): Handlers<RestoreStep, RunCtx> {
    const {run, plan} = ctx;
    const header = {planId: run.planId, planHash: run.planHash, restoreId: run.id};
    const withManifest = (m: ManifestBundle | null) => ({manifest: {json: (m as ManifestBundle).json, sigB64: (m as ManifestBundle).sigB64}});
    return {
        verify_manifest: async (c) => {
            const m = await manifestOf(c);
            if (!hasMemo(m)) {
                const attempts = (c.run.steps as {name: string; attempts: number}[]).find((s) => s.name === "verify_manifest")?.attempts ?? 0;
                return attempts >= MANIFEST_FETCH_ATTEMPTS ? fail("manifest_unavailable") : wait();
            }
            const r = await resolveManifest({...c.d, principal: c.principal}, c.plan, m);
            return "code" in r ? fail(r.code) : done();
        },
        probe: (c) => taskStep(c, {
            step: "probe", manifest: false,
            input: () => ({type: STEP_TASK_TYPE.probe, agentId: plan.target.agent_id, workspace: workspaceOf(plan)}),
            check: (result) => checkProbe(result, c.plan, RULES_SHA256),
        }),
        stage: (c) => taskStep(c, {step: "stage", manifest: true, input: (m) => ({type: STEP_TASK_TYPE.stage, ...header, ...withManifest(m)}), check: (result) => checkStage(result, c.plan)}),
        apply: (c) => taskStep(c, {step: "apply", manifest: true, input: (m) => ({type: STEP_TASK_TYPE.apply, ...header, ...withManifest(m)})}),
        render: async (c) => {
            const rev = await overrideRevision(c.d.db, c.run.planId);
            return taskStep(c, {
                step: "render", manifest: true, overrideRevision: async () => rev,
                input: (m) => ({type: STEP_TASK_TYPE.render, ...header, ...withManifest(m), overrides: undefined}),
                replaceWhen: (last) => (last.overrideRevision ?? 0) !== rev,
                check: (_result, last) => renderGate(c, last),
            });
        },
        restore_db: (c) => taskStep(c, {
            step: "restore_db", manifest: true,
            input: (m) => ({type: STEP_TASK_TYPE.restore_db, ...header, ...withManifest(m), approval: c.run.policyApproval ?? null, overrides: undefined}),
            check: (result) => checkDb(result),
        }),
        compose_up: (c) => taskStep(c, {
            step: "compose_up", manifest: true,
            input: (m) => ({type: STEP_TASK_TYPE.compose_up, ...header, ...withManifest(m), approval: c.run.policyApproval ?? null, overrides: undefined}),
            check: async (result) => {
                const services = parseServices(result);
                if (!services) return fail("execution_error");
                await c.d.db.update(forkRestoreRun).set({services, updatedAt: c.now}).where(eq(forkRestoreRun.id, c.run.id));
                c.run = {...c.run, services};
                return {ok: true};
            },
        }),
        check_services: async (c) => {
            const row = await latestRender(c.d.db, {restoreId: c.run.id, agentId: c.plan.target.agent_id});
            if (!row) return fail("render_missing");
            const chk = checkServices(row.policyView, parseServices({services: c.run.services}) ?? []);
            return chk.ok ? done() : fail(chk.code);
        },
    };
}
