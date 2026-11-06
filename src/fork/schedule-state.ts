import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {forkScheduleState} from "@/fork/db/schema/ops";

/** ARCH-10: per-stack schedule state, read by the scheduler (W07/W12) and the §4.7 dead-man notification. */
export type SchedulePatch = Partial<{
    lastScheduledAt: Date;
    lastRunStartedAt: Date;
    lastRunFinishedAt: Date;
    lastRunStatus: "running" | "success" | "partial" | "failed";
    lastVerifiedRpAt: Date;
}>;

/** Upsert; `consecutive_failures` is derived from the status (failed ⇒ +1, success ⇒ reset, others unchanged) so callers cannot desync it. */
export async function touchScheduleState(db: ForkDb, stackId: string, patch: SchedulePatch): Promise<void> {
    const failures =
        patch.lastRunStatus === "failed" ? sql`${forkScheduleState.consecutiveFailures} + 1` : patch.lastRunStatus === "success" ? sql`0` : sql`${forkScheduleState.consecutiveFailures}`;
    const values = {stackId, ...patch, consecutiveFailures: patch.lastRunStatus === "failed" ? 1 : 0, updatedAt: new Date()};
    await db.insert(forkScheduleState).values(values).onConflictDoUpdate({
        target: forkScheduleState.stackId,
        set: {...patch, consecutiveFailures: failures, updatedAt: new Date()},
    });
}
