import {check, integer, jsonb, pgTable, text, timestamp, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {forkStack} from "@/fork/db/schema/stack";
import {inList, nullOrInList, OUTBOX_STATES, RUN_STATUSES} from "@/fork/db/enums";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/** ARCH-10: named lease for long-running work (a run spans minutes; a DB transaction cannot). Short critical sections use advisory xact locks (`@/fork/locks`). */
export const forkLock = pgTable("fork_lock", {
    name: text("name").primaryKey(),
    owner: text("owner").notNull(),
    acquiredAt: ts("acquired_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
});

/** ARCH-10: schedule state per stack — scheduler (W07/W12) and the §4.7 dead-man notification read it. */
export const forkScheduleState = pgTable("fork_schedule_state", {
    stackId: uuid("stack_id").primaryKey().references(() => forkStack.id, {onDelete: "cascade"}),
    lastScheduledAt: ts("last_scheduled_at"),
    lastRunStartedAt: ts("last_run_started_at"),
    lastRunFinishedAt: ts("last_run_finished_at"),
    lastRunStatus: text("last_run_status"),
    lastVerifiedRpAt: ts("last_verified_rp_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
    check("fork_schedule_state_status_ck", nullOrInList("last_run_status", RUN_STATUSES)),
    check("fork_schedule_state_failures_ck", sql`${t.consecutiveFailures} >= 0`),
]);

/**
 * Durable fork notification records (§4.7 bodies: state + link only, never names/ids/secrets). Delivery through
 * upstream notification channels is W13; until then rows stay `pending` (nothing claims "sent").
 * `dedupe_key` makes one notification per state change.
 */
export const forkNotificationOutbox = pgTable("fork_notification_outbox", {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    state: text("state").notNull().default("pending"),
    createdAt: ts("created_at").notNull().defaultNow(),
    deliveredAt: ts("delivered_at"),
}, () => [
    check("fork_notification_outbox_state_ck", inList("state", OUTBOX_STATES)),
]);
