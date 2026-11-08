import {and, asc, desc, eq, inArray} from "drizzle-orm";
import {actorIn, forkCan} from "@/fork/acl";
import {cancelQueuedTask} from "@/fork/agent-channel/tasks";
import {purgeRestoreOverrides} from "@/fork/config/service";
import {recordAudit} from "@/fork/audit";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkRestoreRun, forkRestoreRunTask} from "@/fork/db/schema/restore-run";
import {acquireLease, releaseLease, withForkLock} from "@/fork/locks";
import {enqueueForkNotification} from "@/fork/notify";
import {loadPlanRow} from "@/fork/restore/service";
import {advanceSteps, failRemaining, type StepRecord} from "@/fork/runs/engine";
import {needsCompose} from "./derive";
import {nowOf, ownerOf, principalOfUser, type RestoreRunDeps} from "./deps";
import {ACTIVE, handlers, type RunCtx, type RunRow} from "./steps";
import {REASON_RE, type RestoreStep, type RestoreRunState} from "./vocab";

/**
 * One orchestrator tick (W18a D-16): a per-run lease (a second replica / an overlapping tick sees `busy`; a crashed owner's lease expires by itself),
 * then — in this order — cancel, deadline, re-authorise the STARTER (D31), re-verify the plan row, advance the W12 steps. All progress is in the
 * database (`steps`, the step journal, the task rows): a restarted process resumes from there. Nothing here logs a message or a result.
 */
const LEASE_MS = 15 * 60_000;
export const leaseName = (runId: string) => `restore-run:${runId}`;

export type TickState = "advanced" | "done" | "failed" | "busy" | "gone";

export async function tickRestoreRun(d: RestoreRunDeps, runId: string): Promise<{runId: string; state: TickState}> {
    const now = nowOf(d);
    if (!(await acquireLease(d.db, leaseName(runId), ownerOf(d), LEASE_MS, now))) return {runId, state: "busy"};
    try {
        return {runId, state: await tickLocked(d, runId, now)};
    } finally {
        await releaseLease(d.db, leaseName(runId), ownerOf(d));
    }
}

/** In-flight task of the run (newest journal row whose task has not finished). */
async function inflight(d: RestoreRunDeps, runId: string): Promise<{taskId: string; status: string; attempts: number}[]> {
    const rows = await d.db.select({taskId: forkAgentTask.id, status: forkAgentTask.status, attempts: forkAgentTask.attempts})
        .from(forkRestoreRunTask).innerJoin(forkAgentTask, eq(forkAgentTask.id, forkRestoreRunTask.taskId))
        .where(and(eq(forkRestoreRunTask.runId, runId), inArray(forkAgentTask.status, ["queued", "leased", "running"]))).orderBy(desc(forkRestoreRunTask.createdAt));
    return rows;
}

/** Cancels every never-started task of the run. Returns true while ANY task is still in the agent's hands (or about to be). */
async function cancelOrWait(d: RestoreRunDeps, run: RunRow, now: Date): Promise<boolean> {
    let pending = false;
    for (const t of await inflight(d, run.id)) {
        if (t.status === "queued" && t.attempts === 0 && run.targetAgentId && (await cancelQueuedTask(d.db, {taskId: t.taskId, agentId: run.targetAgentId, now}))) continue;
        pending = true;
    }
    return pending;
}

async function tickLocked(d: RestoreRunDeps, runId: string, now: Date): Promise<TickState> {
    const [run] = await d.db.select().from(forkRestoreRun).where(eq(forkRestoreRun.id, runId));
    if (!run || !(ACTIVE as readonly string[]).includes(run.state)) return "gone";
    const steps = run.steps as StepRecord<RestoreStep>[];

    // 1. cancel requested: a never-started task is cancelled; one the agent may be executing is waited for (its truthful outcome), then the run ends `cancelled`
    if (run.cancelRequestedAt) {
        if (await cancelOrWait(d, run, now)) return "advanced";
        await finalize(d, run, "cancelled", {reason: "cancelled", steps: failRemaining(steps, "cancelled", now)});
        return "failed";
    }
    // 2. deadline
    if (now.getTime() > run.deadlineAt.getTime()) {
        await cancelOrWait(d, run, now);
        await finalize(d, run, "failed", {reason: "run_timeout", failedStep: firstOpen(steps), steps: failRemaining(steps, "run_timeout", now)});
        return "failed";
    }
    // 3. D31: the starter's CURRENT rights, every tick
    const lookup = await principalOfUser(d, run.startedBy);
    if (lookup.kind !== "ok" || !forkCan(actorIn(lookup.principal, run.organizationId), "restore.execute")) {
        await finalize(d, run, "failed", {reason: "reauth_failed", failedStep: firstOpen(steps), steps: failRemaining(steps, "reauth_failed", now)});
        return "failed";
    }
    // 4. the plan row must still be untampered and hash-identical (no freshness here: every enqueue re-checks that)
    const loaded = await loadPlanRow(d, run.planId, run.planHash);
    if (!loaded.ok) {
        await finalize(d, run, "failed", {reason: safeReason(loaded.code), failedStep: firstOpen(steps), steps: failRemaining(steps, loaded.code, now)});
        return "failed";
    }
    // 5. advance
    const ctx: RunCtx = {d, run, plan: loaded.plan, planRow: loaded.row, principal: lookup.principal, now, memo: {}};
    const r = await advanceSteps<RestoreStep, RunCtx>(steps, handlers(ctx), ctx, {
        now: () => now,
        persist: async (s) => { await d.db.update(forkRestoreRun).set({steps: s, updatedAt: now}).where(and(eq(forkRestoreRun.id, run.id), inArray(forkRestoreRun.state, [...ACTIVE]))); },
    });
    if (r.state === "running") return "advanced";
    if (r.state === "done") {
        await finalize(d, ctx.run, "succeeded", {verification: needsCompose(loaded.plan) ? "started" : ctx.run.purpose === "test_restore" ? "data_verified" : "data_only", steps: r.steps});
        return "done";
    }
    const code = safeReason(r.code ?? "internal_error");
    // later steps never ran: failed without a code (the failing step carries it)
    const closed = r.steps.map((s) => (s.status === "pending" || s.status === "running" ? {...s, status: "failed" as const, finishedAt: now.toISOString()} : s));
    await finalize(d, ctx.run, code === "service_not_running" ? "incomplete" : "failed", {reason: code, failedStep: r.failedStep, steps: closed});
    return "failed";
}

const safeReason = (c: string): string => (REASON_RE.test(c) ? c : "internal_error");
const firstOpen = (steps: readonly StepRecord<RestoreStep>[]): string | undefined => steps.find((s) => s.status !== "done")?.name;

type Terminal = Exclude<RestoreRunState, "running" | "awaiting_approval">;
export async function finalize(d: RestoreRunDeps, run: RunRow, state: Terminal, o: {reason?: string; failedStep?: string; verification?: string; steps: StepRecord<RestoreStep>[]}): Promise<void> {
    const now = nowOf(d);
    await withForkLock(d.db, `restore-run:${run.id}`, async (tx) => {
        const rows = await tx.update(forkRestoreRun).set({state, reason: o.reason ?? null, failedStep: o.failedStep ?? null, verification: o.verification ?? null, steps: o.steps, finishedAt: now, updatedAt: now})
            .where(and(eq(forkRestoreRun.id, run.id), inArray(forkRestoreRun.state, [...ACTIVE]))).returning({id: forkRestoreRun.id});
        if (rows.length !== 1) return; // already finalised (idempotent)
        await recordAudit(tx, {
            organizationId: run.organizationId, actorKind: "system", action: "fork.restore_run.finish", resourceType: "restore_run", resourceId: run.id,
            result: state === "failed" || state === "incomplete" ? "failure" : "success", now,
            details: {runId: run.id, planHash: run.planHash, state, reason: o.reason ?? null, failedStep: o.failedStep ?? null, verification: o.verification ?? null,
                durationSeconds: Math.max(0, Math.round((now.getTime() - run.createdAt.getTime()) / 1000))},
        });
        // W-TR notifies test-restore outcomes itself (fixed sentences, plan D-13): the generic restore messages are for restores a person asked for
        if (state !== "cancelled" && run.purpose !== "test_restore") {
            await enqueueForkNotification(tx, {kind: state === "succeeded" ? "restore.finished" : "restore.failed", dedupeKey: `restore:${run.id}:${state}`, payload: {stackId: run.stackId, state}});
        }
    });
    await purgeRestoreOverrides(d.db, run.planId, "terminal", now, null); // W16b: the overrides die with the restore
}

/** Every active run, oldest first; one run's failure never stops the next (messages are never read or logged). */
export async function tickAllRestoreRuns(d: RestoreRunDeps): Promise<{advanced: number; done: number; failed: number; busy: number}> {
    const out = {advanced: 0, done: 0, failed: 0, busy: 0};
    const ids = await d.db.select({id: forkRestoreRun.id}).from(forkRestoreRun).where(inArray(forkRestoreRun.state, [...ACTIVE])).orderBy(asc(forkRestoreRun.createdAt));
    for (const {id} of ids) {
        try {
            const r = await tickRestoreRun(d, id);
            if (r.state === "advanced") out.advanced += 1;
            else if (r.state === "done") out.done += 1;
            else if (r.state === "failed") out.failed += 1;
            else if (r.state === "busy") out.busy += 1;
        } catch {
            // isolated: the next tick retries (the engine counts handler errors itself); the message is never read
        }
    }
    return out;
}
