import {and, asc, eq, inArray, isNull, or} from "drizzle-orm";
import {actorIn, forkCan} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {forkRestoreRun} from "@/fork/db/schema/restore-run";
import {acquireLease, releaseLease} from "@/fork/locks";
import {enqueueForkNotification} from "@/fork/notify";
import {nowOf, ownerOf, principalOfUser} from "@/fork/restore-run/deps";
import {journalRows, taskDeps, type JournalRow, type RunRow} from "@/fork/restore-run/steps";
import {REASON_RE, TRANSIENT_REFUSALS} from "@/fork/restore-run/vocab";
import {workspaceOf} from "@/fork/restore-tasks/build";
import {enqueueRestoreTask} from "@/fork/restore-tasks/enqueue";
import {loadPlanRow} from "@/fork/restore/service";
import type {TestRestoreDeps} from "./deps";
import {MAX_WIPE_EXPIRED, WIPE_DEADLINE_MS} from "./vocab";

/**
 * Verified wipe (plan D-6): a post-terminal phase of EVERY test-restore run, whatever its outcome. The scratch copy is removed with `restore_cleanup` (workspace only: the agent
 * deletes it only when `owner.json` carries this restore id + this agent id) and the wipe is only believed after an INDEPENDENT `restore_probe` reports `workspace_state = absent`
 * (the cleanup result alone is never trusted: #156/#158). Never touches the run's `state` / `verification`.
 */
const TERMINAL = ["succeeded", "failed", "incomplete", "cancelled"] as const;
export type WipeStep = "advanced" | "waiting" | "verified" | "not_needed" | "failed" | "gone" | "busy";
const leaseName = (runId: string) => `test-restore-wipe:${runId}`;
const agentReason = (result: unknown): string => {
    const r = (result as {reason?: unknown} | null)?.reason;
    return typeof r === "string" && REASON_RE.test(r) ? r : "execution_error";
};

export async function advanceWipe(d: TestRestoreDeps, runId: string): Promise<WipeStep> {
    const now = nowOf(d);
    if (!(await acquireLease(d.db, leaseName(runId), ownerOf(d), 15 * 60_000, now))) return "busy";
    try {
        return await advanceLocked(d, runId, now);
    } finally {
        await releaseLease(d.db, leaseName(runId), ownerOf(d));
    }
}

async function advanceLocked(d: TestRestoreDeps, runId: string, now: Date): Promise<WipeStep> {
    const [run] = await d.db.select().from(forkRestoreRun).where(eq(forkRestoreRun.id, runId));
    if (!run || run.purpose !== "test_restore" || !(TERMINAL as readonly string[]).includes(run.state)) return "gone";
    if (run.wipeState !== null && run.wipeState !== "running") return "gone";
    // D-13: a failed test restore is reported once (a cancel is an operator action: audit only)
    if (run.state === "failed" || run.state === "incomplete") await enqueueForkNotification(d.db, {kind: "test_restore.failed", dedupeKey: `test_restore:${run.id}:failed`, payload: {stackId: run.stackId, state: "failed"}});

    const fail = async (reason: string): Promise<WipeStep> => {
        const code = REASON_RE.test(reason) ? reason : "internal_error";
        const rows = await d.db.update(forkRestoreRun).set({wipeState: "failed", wipeReason: code, wipeFinishedAt: now, updatedAt: now})
            .where(and(eq(forkRestoreRun.id, run.id), or(isNull(forkRestoreRun.wipeState), eq(forkRestoreRun.wipeState, "running")))).returning({id: forkRestoreRun.id});
        if (rows.length === 1) {
            await enqueueForkNotification(d.db, {kind: "test_restore.wipe_failed", dedupeKey: `test_restore:${run.id}:wipe_failed`, payload: {stackId: run.stackId, state: "wipe_failed"}});
            await recordAudit(d.db, {organizationId: run.organizationId, actorKind: "system", action: "fork.test_restore.wipe", resourceType: "restore_run", resourceId: run.id, result: "failure", now, details: {runId: run.id, reason: code}});
        }
        return "failed";
    };

    // 1. nothing was ever written (no stage task) ⇒ nothing to wipe
    const stageRows = await journalRows(d.db, run.id, "stage");
    if (run.wipeState === null && stageRows.length === 0) {
        await d.db.update(forkRestoreRun).set({wipeState: "not_needed", wipeFinishedAt: now, updatedAt: now}).where(and(eq(forkRestoreRun.id, run.id), isNull(forkRestoreRun.wipeState)));
        await recordAudit(d.db, {organizationId: run.organizationId, actorKind: "system", action: "fork.test_restore.wipe", resourceType: "restore_run", resourceId: run.id, result: "success", now, details: {runId: run.id, state: "not_needed"}});
        return "not_needed";
    }

    // 2. deadlines: 24 h per arming (a never-armed wipe counts from the end of the run)
    const startedAt = run.wipeStartedAt ?? run.finishedAt ?? run.createdAt;
    if (now.getTime() > startedAt.getTime() + WIPE_DEADLINE_MS) return fail("wipe_timeout");

    // 3. D31: the wipe acts as a person who still holds restore.execute (the "Wipe now" admin, else the starter); no service account
    const lookup = await principalOfUser(d, run.wipeBy ?? run.startedBy);
    if (lookup.kind !== "ok" || !forkCan(actorIn(lookup.principal, run.organizationId), "restore.execute")) return fail("reauth_failed");
    const loaded = await loadPlanRow(d, run.planId, run.planHash);
    if (!loaded.ok) return fail("internal_error");
    const ctx = {d, run, principal: lookup.principal, now};
    const enqueue = async (step: "wipe" | "wipe_check", prior: JournalRow[]): Promise<"ok" | "wait" | string> => {
        const attempt = Math.max(0, ...prior.map((r) => r.attempt)) + 1;
        const input = step === "wipe"
            ? {type: "restore_cleanup", planId: run.planId, planHash: run.planHash, restoreId: run.id, cleanup: {workspace: true, volumes: false, networks: false, containers: false}}
            : {type: "restore_probe", agentId: loaded.plan.target.agent_id, workspace: workspaceOf(loaded.plan)};
        const res = await enqueueRestoreTask(taskDeps(ctx, {step, attempt}), input);
        if (res.ok) return "ok";
        return (TRANSIENT_REFUSALS as readonly string[]).includes(res.code) ? "wait" : res.code;
    };

    // 4. arm: a NULL state ALWAYS starts a NEW wipe attempt (a re-armed wipe never inherits an older failure)
    const allWipe = await journalRows(d.db, run.id, "wipe");
    if (run.wipeState === null) {
        const r = await enqueue("wipe", allWipe);
        if (r === "wait") return "waiting";
        if (r !== "ok") return fail(r);
        await d.db.update(forkRestoreRun).set({wipeState: "running", wipeReason: null, wipeStartedAt: now, wipeFinishedAt: null, updatedAt: now}).where(eq(forkRestoreRun.id, run.id));
        return "advanced";
    }

    // 5. running: only rows of THIS arming count
    const since = run.wipeStartedAt as Date;
    const mine = (rows: JournalRow[]) => rows.filter((r) => r.createdAt.getTime() >= since.getTime());
    const wipes = mine(allWipe);
    const lastWipe = wipes[0];
    if (!lastWipe) return fail("internal_error");
    if (!lastWipe.task) return fail("internal_error");
    const expired = (rows: JournalRow[]) => rows.filter((r) => r.task?.status === "expired").length;
    switch (lastWipe.task.status) {
        case "queued": case "leased": case "running": return "waiting";
        case "failed": case "rejected": return fail(agentReason(lastWipe.task.result));
        case "cancelled": return fail("task_cancelled");
        case "expired": {
            if (expired(wipes) >= MAX_WIPE_EXPIRED) return fail("agent_offline");
            const r = await enqueue("wipe", allWipe);
            return r === "ok" || r === "wait" ? "waiting" : fail(r);
        }
        case "succeeded": break;
        default: return fail("internal_error");
    }
    // 6. the independent probe of the same workspace
    const allChecks = await journalRows(d.db, run.id, "wipe_check");
    const checks = mine(allChecks).filter((r) => r.createdAt.getTime() >= lastWipe.createdAt.getTime());
    const lastCheck = checks[0];
    if (!lastCheck) {
        const r = await enqueue("wipe_check", allChecks);
        return r === "ok" || r === "wait" ? "waiting" : fail(r);
    }
    if (!lastCheck.task) return fail("internal_error");
    switch (lastCheck.task.status) {
        case "queued": case "leased": case "running": return "waiting";
        case "failed": case "rejected": return fail(agentReason(lastCheck.task.result));
        case "cancelled": return fail("task_cancelled");
        case "expired": {
            if (expired(checks) >= MAX_WIPE_EXPIRED) return fail("agent_offline");
            const r = await enqueue("wipe_check", allChecks);
            return r === "ok" || r === "wait" ? "waiting" : fail(r);
        }
        case "succeeded": break;
        default: return fail("internal_error");
    }
    const state = (lastCheck.task.result as {workspace_state?: unknown} | null)?.workspace_state;
    if (state !== "absent") return fail("wipe_unverified");
    const removed = (lastWipe.task.result as {removed?: {workspace?: unknown}} | null)?.removed?.workspace === true;
    const rows = await d.db.update(forkRestoreRun).set({wipeState: "verified", wipeReason: null, wipeFinishedAt: now, updatedAt: now})
        .where(and(eq(forkRestoreRun.id, run.id), eq(forkRestoreRun.wipeState, "running"))).returning({id: forkRestoreRun.id});
    if (rows.length === 1) {
        await recordAudit(d.db, {organizationId: run.organizationId, actorKind: "system", action: "fork.test_restore.wipe", resourceType: "restore_run", resourceId: run.id, result: "success", now,
            details: {runId: run.id, removedWorkspace: removed, workspaceState: "absent", cleanupTaskId: lastWipe.taskId, probeTaskId: lastCheck.taskId}});
    }
    return "verified";
}

/** Every terminal test restore whose wipe is not finished, oldest first; one run's failure never stops the next. */
export async function advanceTestRestoreWipes(d: TestRestoreDeps): Promise<{advanced: number; verified: number; failed: number}> {
    const out = {advanced: 0, verified: 0, failed: 0};
    const ids = await d.db.select({id: forkRestoreRun.id}).from(forkRestoreRun).where(and(
        eq(forkRestoreRun.purpose, "test_restore"), inArray(forkRestoreRun.state, [...TERMINAL]), or(isNull(forkRestoreRun.wipeState), eq(forkRestoreRun.wipeState, "running")),
    )).orderBy(asc(forkRestoreRun.createdAt)).limit(100);
    for (const {id} of ids) {
        try {
            const r = await advanceWipe(d, id);
            if (r === "advanced" || r === "waiting") out.advanced += 1;
            else if (r === "verified" || r === "not_needed") out.verified += 1;
            else if (r === "failed") out.failed += 1;
        } catch {
            // isolated: the next tick retries (the message is never read or logged)
        }
    }
    return out;
}
export type {RunRow};
