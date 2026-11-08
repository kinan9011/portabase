import {eq, inArray} from "drizzle-orm";
import {forkStackRun, forkStackRunItem} from "@/fork/db/schema/runs";
import {finalizeRun, type FinalizeForced} from "@/fork/recovery-point/finalize";
import {acquireLease, releaseLease} from "@/fork/locks";
import {recordAudit} from "@/fork/audit";
import {cancelWaitingBackups} from "@/fork/upstream";
import {nowOf, ownerOf, type RunDeps} from "./deps";
import {advanceSteps, done, type StepRecord} from "./engine";
import {loadStackFacts} from "./reauth";
import {runHandlers, type StepCtx} from "./steps";
import {ACTIVE_RUN_STATES, TERMINAL_ITEM_STATES, type AnyRunStep, type ItemState} from "./vocab";

/**
 * Drives runs. One tick advances every ACTIVE run by as many steps as can complete; state is persisted after every step
 * (`engine.ts`), so a crash resumes. A per-run lease (`fork_lock`, owner = this process) keeps replicas / overlapping ticks off the
 * same run; it expires on its own if the process dies.
 */
const LEASE_MS = 15 * 60_000;
const leaseName = (runId: string) => `run:${runId}`;

export type TickOutcome = {runId: string; state: "advanced" | "done" | "failed" | "busy" | "gone"};

export async function tickRun(d: RunDeps, runId: string): Promise<TickOutcome> {
    const now = nowOf(d);
    if (!(await acquireLease(d.db, leaseName(runId), ownerOf(d), LEASE_MS, now))) return {runId, state: "busy"};
    try {
        const [run] = await d.db.select().from(forkStackRun).where(eq(forkStackRun.id, runId));
        if (!run || !(ACTIVE_RUN_STATES as readonly string[]).includes(run.state)) return {runId, state: "gone"};
        const facts = await loadStackFacts(d.db, run.stackId);
        if (!facts) return {runId, state: "gone"};
        const ctx: StepCtx = {d, runId, facts};
        const finalize = async (c: StepCtx) => {
            await d.db.update(forkStackRun).set({state: "finalizing", updatedAt: nowOf(d)}).where(eq(forkStackRun.id, runId));
            await finalizeRun(c.d, runId);
            return done();
        };
        const r = await advanceSteps<AnyRunStep, StepCtx>(run.steps as StepRecord<AnyRunStep>[], runHandlers(finalize), ctx, {
            now: () => nowOf(d),
            persist: async (steps) => { await d.db.update(forkStackRun).set({steps, updatedAt: nowOf(d)}).where(eq(forkStackRun.id, runId)); },
        });
        if (r.state === "failed") {
            // the engine itself failed (internal_error): still produce an honest `failed` RP listing what exists — never leave the run active forever
            await finalizeRun(d, runId, "internal_error");
            return {runId, state: "failed"};
        }
        return {runId, state: r.state === "done" ? "done" : "advanced"};
    } finally {
        await releaseLease(d.db, leaseName(runId), ownerOf(d));
    }
}

export async function activeRunIds(d: RunDeps): Promise<string[]> {
    const rows = await d.db.select({id: forkStackRun.id}).from(forkStackRun).where(inArray(forkStackRun.state, [...ACTIVE_RUN_STATES]));
    return rows.map((r) => r.id);
}

export async function tickAllRuns(d: RunDeps): Promise<{advanced: number; done: number; failed: number; busy: number}> {
    const out = {advanced: 0, done: 0, failed: 0, busy: 0};
    for (const id of await activeRunIds(d)) {
        try {
            const r = await tickRun(d, id);
            if (r.state === "advanced") out.advanced++; else if (r.state === "done") out.done++; else if (r.state === "failed") out.failed++; else if (r.state === "busy") out.busy++;
        } catch {
            out.failed++; // never aborts the other runs; the message is not logged here (it could come from anywhere)
        }
    }
    return out;
}

export type CancelResult = {ok: true; cancelledWaiting: number} | {ok: false; code: "not_found" | "not_active" | "busy"};

/**
 * Cancels an ACTIVE run: `waiting` member backups are cancelled upstream, everything not finished is marked cancelled, and the run
 * is finalised as `cancelled` with a `failed(run_cancelled)` RP listing what exists. An `ongoing` backup cannot be stopped upstream:
 * the agent finishes it and the retention orphan sweep removes it later. The CALLER authorised the actor; audit is written here.
 */
export async function cancelRun(d: RunDeps, runId: string, actor: {userId: string; organizationId: string}): Promise<CancelResult> {
    const now = nowOf(d);
    if (!(await acquireLease(d.db, leaseName(runId), ownerOf(d), LEASE_MS, now))) return {ok: false, code: "busy"};
    try {
        const [run] = await d.db.select().from(forkStackRun).where(eq(forkStackRun.id, runId));
        if (!run) return {ok: false, code: "not_found"};
        if (!(ACTIVE_RUN_STATES as readonly string[]).includes(run.state)) return {ok: false, code: "not_active"};
        const open = (await d.db.select().from(forkStackRunItem).where(eq(forkStackRunItem.runId, runId))).filter((i) => !TERMINAL_ITEM_STATES.includes(i.state as ItemState));
        const cancelled = await cancelWaitingBackups(d.db, open.flatMap((i) => (i.backupId ? [i.backupId] : [])), now);
        if (open.length > 0) await d.db.update(forkStackRunItem).set({state: "failed", reason: "cancelled", finishedAt: now}).where(inArray(forkStackRunItem.id, open.map((i) => i.id)));
        // W17b: a cancelled run must never keep the app stopped — signal the agent to start now (it restarts on its next poll; the result is reconciled later)
        if (run.quiesceTaskId && !run.quiesceReleaseAt) await d.db.update(forkStackRun).set({quiesceReleaseAt: now, quiesceReleaseReason: "cancelled"}).where(eq(forkStackRun.id, runId));
        await recordAudit(d.db, {organizationId: actor.organizationId, actorUserId: actor.userId, action: "fork.stack_run.cancel", resourceType: "stack_run", resourceId: runId, result: "success", details: {stackId: run.stackId, cancelledWaiting: cancelled.length, open: open.length}, now});
        await finalizeRun(d, runId, "cancelled" satisfies FinalizeForced);
        return {ok: true, cancelledWaiting: cancelled.length};
    } finally {
        await releaseLease(d.db, leaseName(runId), ownerOf(d));
    }
}
