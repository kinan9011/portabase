import {and, asc, eq, inArray, isNull, or} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import {forkMirrorRevision} from "@/fork/db/schema/mirror";
import {acquireLease, releaseLease} from "@/fork/locks";
import {loadPlanRow} from "@/fork/restore/service";
import {nowOf, ownerOf, type MirrorDeps} from "./deps";
import {addEvent} from "./events";
import {enqueueMirrorTask, TRANSIENT_ENQUEUE_CODES} from "./enqueue";
import {MirrorWipeResult} from "./payload-schema";
import {agentReason, journalRows, revisionOf, taskDeps, type JournalRow} from "./steps";
import {MAX_EXPIRED_REENQUEUES, WIPE_BUDGET_MS} from "./vocab";

/**
 * Verified wipe (ADR-009 §8, OD-W22a-5): a post-terminal phase of EVERY blocked / failed / cancelled revision. The runner copy is removed with `mirror_wipe` (workspace, volumes, networks and
 * containers of THIS revision id + this agent only; any leftover makes the task fail) and the wipe is only believed after an INDEPENDENT `mirror_probe` reports `workspace_state = absent` (the wipe
 * result alone is never trusted). Never touches the revision's `state` / `reason`. Needs no principal: removing a production-data copy is always allowed (flag off, config locked, starter demoted).
 */
const WIPE_STATES = ["blocked", "failed", "cancelled"] as const;
export type WipeStep = "advanced" | "waiting" | "verified" | "not_needed" | "failed" | "gone" | "busy";
const leaseName = (id: string) => `mirror-wipe:${id}`;
const REASON_RE = /^[a-z_]{1,64}$/;

export async function advanceMirrorWipe(d: MirrorDeps, revisionId: string): Promise<WipeStep> {
    const now = nowOf(d);
    if (!(await acquireLease(d.db, leaseName(revisionId), ownerOf(d), 15 * 60_000, now))) return "busy";
    try {
        return await advanceLocked(d, revisionId, now);
    } finally {
        await releaseLease(d.db, leaseName(revisionId), ownerOf(d));
    }
}

async function advanceLocked(d: MirrorDeps, revisionId: string, now: Date): Promise<WipeStep> {
    const [rev] = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, revisionId));
    if (!rev || !(WIPE_STATES as readonly string[]).includes(rev.state)) return "gone";
    if (rev.wipeState !== null && rev.wipeState !== "running") return "gone";
    const audit = (result: "success" | "failure", details: Record<string, unknown>) => recordAudit(d.db, {organizationId: rev.organizationId, actorKind: "system", action: "fork.mirror.wipe", resourceType: "mirror", resourceId: rev.mirrorId, result, now, details: {revisionId: rev.id, ...details}});

    const fail = async (reason: string): Promise<WipeStep> => {
        const code = REASON_RE.test(reason) ? reason : "internal_error";
        const rows = await d.db.update(forkMirrorRevision).set({wipeState: "failed", wipeReason: code, wipeFinishedAt: now, updatedAt: now})
            .where(and(eq(forkMirrorRevision.id, rev.id), or(isNull(forkMirrorRevision.wipeState), eq(forkMirrorRevision.wipeState, "running")))).returning({id: forkMirrorRevision.id});
        if (rows.length === 1) {
            await addEvent(d.db, {mirrorId: rev.mirrorId, revisionId: rev.id, kind: "wipe_failed", at: now, code});
            await audit("failure", {reason: code});
        }
        return "failed";
    };

    // 1. nothing was ever written (no stage task) ⇒ nothing to wipe
    const stageRows = await journalRows(d.db, rev.id, "stage");
    if (rev.wipeState === null && stageRows.length === 0) {
        await d.db.update(forkMirrorRevision).set({wipeState: "not_needed", wipeFinishedAt: now, updatedAt: now}).where(and(eq(forkMirrorRevision.id, rev.id), isNull(forkMirrorRevision.wipeState)));
        await audit("success", {state: "not_needed"});
        return "not_needed";
    }
    // 2. deadline: counted from the arming (a never-armed wipe counts from the end of the creation)
    const startedAt = rev.wipeStartedAt ?? rev.finishedAt ?? rev.createdAt;
    if (now.getTime() > startedAt.getTime() + WIPE_BUDGET_MS) return fail("wipe_timeout");

    if (!rev.planId) return fail("internal_error");
    const loaded = await loadPlanRow(d, rev.planId, rev.planHash);
    if (!loaded.ok) return fail("internal_error");
    const enqueue = async (step: "wipe" | "wipe_check", prior: JournalRow[]): Promise<"ok" | "wait" | string> => {
        const attempt = Math.max(0, ...prior.map((r) => r.attempt)) + 1;
        const res = await enqueueMirrorTask(taskDeps(d, {principal: null, now, revisionId: rev.id, step, attempt}), {revision: revisionOf(rev), plan: loaded.plan, step, attempt});
        if (res.ok) return "ok";
        return TRANSIENT_ENQUEUE_CODES.includes(res.code) ? "wait" : res.code;
    };

    // 3. arm: a NULL state ALWAYS starts a NEW wipe attempt (a re-armed wipe never inherits an older failure)
    const allWipe = await journalRows(d.db, rev.id, "wipe");
    if (rev.wipeState === null) {
        const r = await enqueue("wipe", allWipe);
        if (r === "wait") return "waiting";
        if (r !== "ok") return fail(r);
        await d.db.update(forkMirrorRevision).set({wipeState: "running", wipeReason: null, wipeStartedAt: now, wipeFinishedAt: null, updatedAt: now}).where(eq(forkMirrorRevision.id, rev.id));
        await addEvent(d.db, {mirrorId: rev.mirrorId, revisionId: rev.id, kind: "wipe_started", at: now});
        return "advanced";
    }

    // 4. running: only rows of THIS arming count
    const since = rev.wipeStartedAt as Date;
    const mine = (rows: JournalRow[]) => rows.filter((r) => r.createdAt.getTime() >= since.getTime());
    const wipes = mine(allWipe);
    const lastWipe = wipes[0];
    if (!lastWipe || !lastWipe.task) return fail("internal_error");
    const expired = (rows: JournalRow[]) => rows.filter((r) => r.task?.status === "expired").length;
    switch (lastWipe.task.status) {
        case "queued": case "leased": case "running": return "waiting";
        case "failed": case "rejected": return fail(agentReason(lastWipe.task.result) === "execution_error" ? "wipe_incomplete" : agentReason(lastWipe.task.result));
        case "cancelled": return fail("task_cancelled");
        case "expired": {
            if (expired(wipes) >= MAX_EXPIRED_REENQUEUES) return fail("agent_offline");
            const r = await enqueue("wipe", allWipe);
            return r === "ok" || r === "wait" ? "waiting" : fail(r);
        }
        case "succeeded": break;
        default: return fail("internal_error");
    }
    if (!MirrorWipeResult.safeParse(lastWipe.task.result).success) return fail("wipe_incomplete"); // any leftover (remaining ≠ 0) or a malformed result is never believed
    // 5. the independent probe of the same workspace
    const allChecks = await journalRows(d.db, rev.id, "wipe_check");
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
            if (expired(checks) >= MAX_EXPIRED_REENQUEUES) return fail("agent_offline");
            const r = await enqueue("wipe_check", allChecks);
            return r === "ok" || r === "wait" ? "waiting" : fail(r);
        }
        case "succeeded": break;
        default: return fail("internal_error");
    }
    const state = (lastCheck.task.result as {workspace_state?: unknown} | null)?.workspace_state;
    if (state !== "absent") return fail("wipe_incomplete");
    const rows = await d.db.update(forkMirrorRevision).set({wipeState: "verified", wipeReason: null, wipeFinishedAt: now, updatedAt: now})
        .where(and(eq(forkMirrorRevision.id, rev.id), eq(forkMirrorRevision.wipeState, "running"))).returning({id: forkMirrorRevision.id});
    if (rows.length === 1) {
        await addEvent(d.db, {mirrorId: rev.mirrorId, revisionId: rev.id, kind: "wipe_verified", at: now});
        await audit("success", {workspaceState: "absent", wipeTaskId: lastWipe.taskId, probeTaskId: lastCheck.taskId});
    }
    return "verified";
}

/** Every terminal non-ready revision whose wipe is not finished, oldest first; one revision's failure never stops the next. */
export async function advanceMirrorWipes(d: MirrorDeps): Promise<{advanced: number; verified: number; failed: number}> {
    const out = {advanced: 0, verified: 0, failed: 0};
    const ids = await d.db.select({id: forkMirrorRevision.id}).from(forkMirrorRevision).where(and(
        inArray(forkMirrorRevision.state, [...WIPE_STATES]), or(isNull(forkMirrorRevision.wipeState), eq(forkMirrorRevision.wipeState, "running")),
    )).orderBy(asc(forkMirrorRevision.createdAt)).limit(100);
    for (const {id} of ids) {
        try {
            const r = await advanceMirrorWipe(d, id);
            if (r === "advanced" || r === "waiting") out.advanced += 1;
            else if (r === "verified" || r === "not_needed") out.verified += 1;
            else if (r === "failed") out.failed += 1;
        } catch {
            // isolated: the next tick retries (the message is never read or logged)
        }
    }
    return out;
}
