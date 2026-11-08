import {and, eq} from "drizzle-orm";
import {cancelQueuedTask, expireQueuedTask} from "@/fork/agent-channel/tasks";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkStackRun} from "@/fork/db/schema/runs";
import {cfgOf, nowOf} from "@/fork/runs/deps";
import {done, wait, type StepOutcome} from "@/fork/runs/engine";
import type {StepCtx} from "@/fork/runs/steps";
import {recordAudit} from "@/fork/audit";
import {enqueueQuiesceTask} from "./enqueue";
import {notifyQuiesce, reconcileQuiesce} from "./reconcile";
import {loadQuiesceDecision} from "./service";
import {START_TIMEOUT_S} from "./vocab";

/**
 * The two quiesce run steps (D5). The dashboard only enqueues the composite task, observes it and signals "capture done"; stop / deadline / restart belong to the
 * agent (D29), so NOTHING here is a watchdog: a dashboard that dies mid-window changes nothing about when the containers come back.
 * Both handlers are idempotent (the engine may re-run them after a crash): the task id is bound to the run in the SAME transaction that signs the task.
 */
const loadRun = async (c: StepCtx) => (await c.d.db.select().from(forkStackRun).where(eq(forkStackRun.id, c.runId)))[0];

async function skip(c: StepCtx, reason: string | null) {
    await c.d.db.update(forkStackRun).set({quiesceState: reason ? "skipped" : null, quiesceReason: reason as never, updatedAt: nowOf(c.d)}).where(eq(forkStackRun.id, c.runId));
    if (reason && reason !== "flag_off") await notifyQuiesce(c.d.db, c.facts.stackId, c.runId, "skipped", reason);
}

export async function quiesceStop(c: StepCtx): Promise<StepOutcome> {
    const now = nowOf(c.d);
    const cfg = cfgOf(c.d);
    const run = await loadRun(c);
    if (!run.quiesceTaskId) {
        if (run.quiesceState !== null && run.quiesceState !== "skipped") return done(); // decided before a crash
        const {decision, loaded} = await loadQuiesceDecision(c.d, c.facts.stackId); // inventory was just refreshed: decide again
        if (!decision.use || !loaded?.policy || !loaded.agentId || !loaded.project) { await skip(c, decision.use ? "plan_blocked" : decision.reason); return done(); }
        if (!c.d.channel) { await skip(c, "capability_missing"); return done(); }
        const enabledBy = loaded.policy.enabledBy as string;
        const r = await enqueueQuiesceTask({db: c.d.db, keys: c.d.channel.keys, serverUrl: c.d.channel.serverUrl, env: c.d.channel.env, kekDir: c.d.channel.kekDir, now: c.d.now},
            {runId: c.runId, stackId: c.facts.stackId, orgId: c.facts.organizationId, agentId: loaded.agentId, actorUserId: enabledBy, project: loaded.project, plan: decision.plan, maxStopSeconds: loaded.policy.maxStopSeconds,
                onInserted: async (tx, taskId) => { await tx.update(forkStackRun).set({quiesceTaskId: taskId, quiesceState: "requested", quiesceReason: null, updatedAt: now}).where(eq(forkStackRun.id, c.runId)); }});
        if (!r.ok) { await skip(c, r.code === "capability_missing" ? "capability_missing" : r.code === "not_enrolled" || r.code === "agent_disabled" ? "agent_unenrolled" : "plan_blocked"); return done(); }
        return wait();
    }
    const outcome = await reconcileQuiesce(c.d.db, c.runId, now);
    const cur = await loadRun(c);
    if (cur.quiesceState === "stopped") return done();
    if (outcome !== "pending" && cur.quiesceState !== "requested") return done(); // refused / failed / finished before the window ever opened
    const [t] = await c.d.db.select({status: forkAgentTask.status, createdAt: forkAgentTask.createdAt, agentId: forkAgentTask.agentId}).from(forkAgentTask).where(eq(forkAgentTask.id, cur.quiesceTaskId as string));
    if (t?.status === "queued" && t.agentId && now.getTime() - t.createdAt.getTime() > cfg.waitTimeoutMs) {
        const args = {taskId: cur.quiesceTaskId as string, agentId: t.agentId, now};
        const took = (await cancelQueuedTask(c.d.db, args)) || (await expireQueuedTask(c.d.db, args));
        if (took) {
            await c.d.db.update(forkStackRun).set({quiesceState: "not_started", quiesceReason: "agent_did_not_start", updatedAt: now}).where(eq(forkStackRun.id, c.runId));
            await notifyQuiesce(c.d.db, c.facts.stackId, c.runId, "not_started", "agent_did_not_start");
            return done();
        }
    }
    if (cur.deadlineAt && now.getTime() > cur.deadlineAt.getTime() && !cur.quiesceReleaseAt) {
        // the run's own deadline: never keep the app stopped for a run that is out of time (the agent restarts on its next poll)
        await c.d.db.update(forkStackRun).set({quiesceReleaseAt: now, quiesceReleaseReason: "cancelled", updatedAt: now}).where(eq(forkStackRun.id, c.runId));
        return done();
    }
    return wait();
}

export async function quiesceRelease(c: StepCtx): Promise<StepOutcome> {
    const now = nowOf(c.d);
    const run = await loadRun(c);
    if (!run.quiesceTaskId || (run.quiesceState !== "requested" && run.quiesceState !== "stopped")) {
        if (run.quiesceTaskId) await reconcileQuiesce(c.d.db, c.runId, now); // e.g. a refusal that arrived late
        return done();
    }
    if (!run.quiesceReleaseAt) {
        await c.d.db.update(forkStackRun).set({quiesceReleaseAt: now, quiesceReleaseReason: "capture_done", updatedAt: now}).where(and(eq(forkStackRun.id, c.runId)));
        await recordAudit(c.d.db, {organizationId: c.facts.organizationId, actorKind: "system", action: "fork.quiesce.release", resourceType: "stack_run", resourceId: c.runId, result: "success", details: {runId: c.runId, stackId: c.facts.stackId, reason: "capture_done"}, now});
    }
    const r = await reconcileQuiesce(c.d.db, c.runId, now);
    if (r !== "pending") return done();
    const releaseAt = (run.quiesceReleaseAt ?? now).getTime();
    const targets = Math.max(1, Array.isArray((run.quiesceResult as {containers_reported?: unknown[]} | null)?.containers_reported) ? ((run.quiesceResult as {containers_reported: unknown[]}).containers_reported.length) : 1);
    if (now.getTime() > releaseAt + targets * START_TIMEOUT_S * 1000 + 120_000) {
        // the agent never reported a terminal result: honest "unconfirmed" (never `verified`); a late result / Start now can still clear it
        await c.d.db.update(forkStackRun).set({quiesceState: "unconfirmed", updatedAt: now}).where(eq(forkStackRun.id, c.runId));
        await notifyQuiesce(c.d.db, c.facts.stackId, c.runId, "unconfirmed", null);
        return done();
    }
    return wait();
}
