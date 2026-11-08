import {boolean, check, integer, jsonb, pgTable, text, timestamp, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {organization} from "@/db/schema/03_organization";
import {agent} from "@/db/schema/08_agent";
import {forkStack} from "@/fork/db/schema/stack";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * W-TR (plan D-9): one data-only test-restore schedule per stack (default disabled). Ids, codes and a restore root only: never a path of the scratch copy,
 * URL, manifest or payload. `target_agent_id` is a volatile upstream reference (SET NULL; an enabled schedule requires it, so deleting the agent is refused until disabled).
 */
export const forkTestRestoreSchedule = pgTable("fork_test_restore_schedule", {
    stackId: uuid("stack_id").primaryKey().references(() => forkStack.id, {onDelete: "cascade"}),
    organizationId: uuid("organization_id").notNull().references(() => organization.id, {onDelete: "cascade"}),
    enabled: boolean("enabled").notNull().default(false),
    schedule: jsonb("schedule").notNull(),
    targetAgentId: uuid("target_agent_id").references(() => agent.id, {onDelete: "set null"}),
    restoreRoot: text("restore_root"),
    staleAfterDays: integer("stale_after_days").notNull().default(14),
    enabledBy: text("enabled_by"),
    enabledAt: ts("enabled_at"),
    pausedAt: ts("paused_at"),
    pauseReason: text("pause_reason"),
    lastScheduledAt: ts("last_scheduled_at"),
    lastOutcome: text("last_outcome"),
    lastReason: text("last_reason"),
    lastOutcomeAt: ts("last_outcome_at"),
    updatedBy: text("updated_by"),
    updatedAt: ts("updated_at").notNull(),
}, (t) => [
    check("fork_tr_schedule_stale_ck", sql`${t.staleAfterDays} BETWEEN 1 AND 90`),
    check("fork_tr_schedule_enabled_ck", sql`NOT ${t.enabled} OR (${t.enabledBy} IS NOT NULL AND ${t.enabledAt} IS NOT NULL AND ${t.targetAgentId} IS NOT NULL AND ${t.restoreRoot} IS NOT NULL)`),
    check("fork_tr_schedule_outcome_ck", sql`${t.lastOutcome} IS NULL OR ${t.lastOutcome} IN ('started','skipped','waiting')`),
    check("fork_tr_schedule_reason_ck", sql`(${t.lastReason} IS NULL OR ${t.lastReason} ~ '^[a-z_]{1,64}$') AND (${t.pauseReason} IS NULL OR ${t.pauseReason} ~ '^[a-z_]{1,64}$')`),
    check("fork_tr_schedule_root_ck", sql`${t.restoreRoot} IS NULL OR octet_length(${t.restoreRoot}) <= 1024`),
    check("fork_tr_schedule_size_ck", sql`octet_length(${t.schedule}::text) <= 4096`),
]);
