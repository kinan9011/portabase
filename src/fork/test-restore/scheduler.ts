import {and, asc, eq, inArray, isNotNull, isNull, or, sql} from "drizzle-orm";
import {actorIn, forkCan} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {forkRestoreRun} from "@/fork/db/schema/restore-run";
import {forkTestRestoreSchedule} from "@/fork/db/schema/test-restore";
import {enqueueForkNotification} from "@/fork/notify";
import {assertForkConfigAllowed} from "@/fork/mode";
import {nowOf, principalOfUser} from "@/fork/restore-run/deps";
import {ACTIVE} from "@/fork/restore-run/steps";
import {decideSlot} from "@/fork/runs/schedule-due";
import {ScheduleSchema} from "@/fork/schedule/schedule";
import type {TestRestoreDeps} from "./deps";
import {startTestRestore} from "./start";
import {CAPTURE_WINDOW_MS, REASON_OK} from "./vocab";

type Row = typeof forkTestRestoreSchedule.$inferSelect;

/** Plan D-9: a stuck wipe (or an unfinished one) blocks further test restores of the stack: fail closed, the scratch path is the same. */
async function blockers(d: TestRestoreDeps, stackId: string): Promise<{active: boolean; wipePending: boolean}> {
    const runs = await d.db.select({state: forkRestoreRun.state, wipe: forkRestoreRun.wipeState}).from(forkRestoreRun).where(and(eq(forkRestoreRun.stackId, stackId), eq(forkRestoreRun.purpose, "test_restore"),
        or(inArray(forkRestoreRun.state, [...ACTIVE]), isNull(forkRestoreRun.wipeState), inArray(forkRestoreRun.wipeState, ["running", "failed"]))));
    return {active: runs.some((r) => (ACTIVE as readonly string[]).includes(r.state)), wipePending: runs.some((r) => !(ACTIVE as readonly string[]).includes(r.state))};
}

export async function testRestoreSchedulerTick(d: TestRestoreDeps): Promise<{considered: number; started: number; skipped: number; waiting: number}> {
    const out = {considered: 0, started: 0, skipped: 0, waiting: 0};
    const now = nowOf(d);
    const rows = await d.db.select().from(forkTestRestoreSchedule).where(and(eq(forkTestRestoreSchedule.enabled, true), isNull(forkTestRestoreSchedule.pausedAt))).orderBy(asc(forkTestRestoreSchedule.stackId));
    for (const row of rows) {
        out.considered += 1;
        try {
            const r = await tickOne(d, row, now);
            if (r) out[r] += 1;
        } catch {
            // one stack's error never stops the others (the message is never read or logged)
        }
    }
    return out;
}

async function tickOne(d: TestRestoreDeps, row: Row, now: Date): Promise<"started" | "skipped" | "waiting" | null> {
    const record = (set: Partial<Row>) => d.db.update(forkTestRestoreSchedule).set({...set, updatedAt: now}).where(eq(forkTestRestoreSchedule.stackId, row.stackId));
    const sched = ScheduleSchema.safeParse(row.schedule);
    if (!sched.success || !row.enabledAt) {
        await record({lastOutcome: "skipped", lastReason: "invalid_config", lastOutcomeAt: now});
        return "skipped";
    }
    const from = new Date(Math.max(row.enabledAt.getTime(), row.lastScheduledAt?.getTime() ?? 0));
    const b = await blockers(d, row.stackId);
    const decision = decideSlot({schedule: sched.data, from, now, windowMs: CAPTURE_WINDOW_MS, activeRun: b.active || b.wipePending});
    if (decision.kind === "none") return null;
    const consume = async (kind: "started" | "skipped", reason: string | null, notify: boolean) => {
        await record({lastScheduledAt: decision.slot, lastOutcome: kind, lastReason: reason && REASON_OK.test(reason) ? reason : null, lastOutcomeAt: now});
        if (kind === "skipped" && notify) await enqueueForkNotification(d.db, {kind: "test_restore.skipped", dedupeKey: `test_restore_skip:${row.stackId}:${decision.slot.toISOString()}`, payload: {stackId: row.stackId, state: "skipped"}});
    };
    if (decision.kind === "skip") {
        await consume("skipped", decision.reason === "missed" ? "missed" : b.wipePending ? "wipe_pending" : "target_busy", true);
        return "skipped";
    }
    const unlocked = d.configAllowed ? await d.configAllowed() : await assertForkConfigAllowed().then(() => true, () => false);
    if (!unlocked) { await consume("skipped", "locked", true); return "skipped"; }
    // D-10 / D31: the enabler's CURRENT rights, every fire; no ambient service account
    const lookup = row.enabledBy ? await principalOfUser(d, row.enabledBy) : null;
    const org = actorIn(lookup?.kind === "ok" ? lookup.principal : null, row.organizationId);
    if (!lookup || lookup.kind !== "ok" || !forkCan(org, "restore.plan") || !forkCan(org, "restore.execute")) {
        await record({pausedAt: now, pauseReason: "reauth_failed", lastScheduledAt: decision.slot, lastOutcome: "skipped", lastReason: "reauth_failed", lastOutcomeAt: now});
        await recordAudit(d.db, {organizationId: row.organizationId, actorKind: "system", action: "fork.test_restore.paused", resourceType: "stack", resourceId: row.stackId, result: "failure", now, details: {reason: "reauth_failed"}});
        await enqueueForkNotification(d.db, {kind: "test_restore.skipped", dedupeKey: `test_restore_skip:${row.stackId}:${decision.slot.toISOString()}`, payload: {stackId: row.stackId, state: "skipped"}});
        return "skipped";
    }
    const res = await startTestRestore(d, {stackId: row.stackId, trigger: "schedule", scheduledFor: decision.slot, principal: lookup.principal});
    if (res.kind === "started") { await consume("started", null, false); return "started"; }
    if (res.kind === "skipped") { await consume("skipped", res.reason, true); return "skipped"; }
    // waiting: the slot stays eligible until the capture window ends (then `missed`)
    await record({lastOutcome: "waiting", lastReason: res.reason, lastOutcomeAt: now});
    return "waiting";
}
void isNotNull; void sql;
