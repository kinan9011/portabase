import {boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid} from "drizzle-orm/pg-core";
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
 * Durable fork notification records (§4.7: payload = stable codes + stack id, never names/paths/secrets; the body is rendered at delivery
 * from fixed sentences). Delivered through the upstream notification channel by `notifications/deliver.ts` (W13): `attempts` /
 * `next_attempt_at` / `claimed_until` / `last_error_code` drive retry + claim, `delivered_at` is set only after the upstream provider answered ok.
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
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    claimedUntil: ts("claimed_until"),
    /** Closed code from `notifications/vocab.ts` (`no_channel`, `provider_error`, …) — never a provider message (it can carry URLs/credentials). */
    lastErrorCode: text("last_error_code"),
}, (t) => [
    check("fork_notification_outbox_state_ck", inList("state", OUTBOX_STATES)),
    check("fork_notification_outbox_attempts_ck", sql`${t.attempts} >= 0`),
]);

/**
 * W13: per-stack alert episodes so a condition (drift to Partial, no good backup) notifies ONCE when it starts and re-arms when it clears.
 * `epoch` is part of the outbox dedupe key; `active` flips under the evaluator's per-stack lock.
 */
export const forkAlertState = pgTable("fork_alert_state", {
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "cascade"}),
    kind: text("kind").notNull(),
    active: boolean("active").notNull().default(false),
    epoch: integer("epoch").notNull().default(0),
    since: ts("since"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
    primaryKey({columns: [t.stackId, t.kind]}),
    check("fork_alert_state_epoch_ck", sql`${t.epoch} >= 0`),
]);
