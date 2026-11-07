import {boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {backup} from "@/db/schema/07_database";
import {forkStack, forkStackSource} from "@/fork/db/schema/stack";
import {inList, nullOrInList} from "@/fork/db/enums";
import {ITEM_STATES, REFRESH_OUTCOMES, RUN_REASONS, RUN_STATES, RUN_TRIGGERS, SKIP_REASONS} from "@/fork/runs/vocab";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * One grouped backup run of a stack (W12). Durable step engine state lives in `steps` (ARCH-13): a crash resumes from this row.
 * Overlap is DB-enforced: at most ONE active run per stack (partial unique index) and one row per scheduled slot, so a double trigger
 * (two clicks, two replicas, a retried tick) can only ever produce a single run. Fork → fork FKs cascade within the stack; the
 * RecoveryPoint keeps `run_id` SET NULL (an RP outlives its run row, D32).
 */
export const forkStackRun = pgTable("fork_stack_run", {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "cascade"}),
    trigger: text("trigger").notNull(),
    state: text("state").notNull().default("starting"),
    /** The cron slot a scheduled run answers (ARCH-17); NULL for manual runs. */
    scheduledFor: ts("scheduled_for"),
    skipReason: text("skip_reason"),
    /** User id (text, like `activated_by`) of a manual trigger; NULL for the scheduler. */
    triggeredBy: text("triggered_by"),
    inventoryVersion: integer("inventory_version"),
    inventoryRefresh: text("inventory_refresh"),
    validatorBlocked: boolean("validator_blocked").notNull().default(false),
    /** Engine state: ordered steps with status/attempts/timestamps/code. */
    steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
    /** Plain code (`RUN_REASONS`), never an upstream error text. */
    reason: text("reason"),
    startedAt: ts("started_at").notNull().defaultNow(),
    deadlineAt: ts("deadline_at"),
    finishedAt: ts("finished_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
    uniqueIndex("fork_stack_run_one_active_uq").on(t.stackId).where(sql`state IN ('starting','running','finalizing')`),
    unique("fork_stack_run_slot_uq").on(t.stackId, t.scheduledFor),
    index("fork_stack_run_stack_started_idx").on(t.stackId, t.startedAt),
    check("fork_stack_run_trigger_ck", inList("trigger", RUN_TRIGGERS)),
    check("fork_stack_run_state_ck", inList("state", RUN_STATES)),
    check("fork_stack_run_skip_reason_ck", nullOrInList("skip_reason", SKIP_REASONS)),
    check("fork_stack_run_reason_ck", nullOrInList("reason", RUN_REASONS)),
    check("fork_stack_run_refresh_ck", nullOrInList("inventory_refresh", REFRESH_OUTCOMES)),
    check("fork_stack_run_skipped_ck", sql`${t.state} <> 'skipped' OR ${t.skipReason} IS NOT NULL`),
]);

/**
 * One member source of a run. `backup_id` → upstream `backups` is ON DELETE SET NULL (D32): upstream cleanup may soft/hard delete
 * the row; the facts a recovery needs are denormalised on the RP artifact, not here.
 */
export const forkStackRunItem = pgTable("fork_stack_run_item", {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => forkStackRun.id, {onDelete: "cascade"}),
    stackSourceId: uuid("stack_source_id").references(() => forkStackSource.id, {onDelete: "set null"}),
    backupId: uuid("backup_id").references(() => backup.id, {onDelete: "set null"}),
    sourceName: text("source_name").notNull(),
    dbms: text("dbms").notNull(),
    required: boolean("required").notNull().default(true),
    state: text("state").notNull().default("queued"),
    reason: text("reason"),
    queuedAt: ts("queued_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    /** Last moment the tracker saw evidence the agent was working (status change, storage row, size, `updated_at`). Drives the stall timeout. */
    lastProgressAt: ts("last_progress_at"),
    /** Hash step output keyed by upstream `backup_storage.id`: `{sha256, bytes}` computed by the dashboard (the agent reports none). Resumable: a computed entry is never recomputed. */
    checksums: jsonb("checksums").notNull().default(sql`'{}'::jsonb`),
}, (t) => [
    index("fork_stack_run_item_run_idx").on(t.runId),
    index("fork_stack_run_item_backup_idx").on(t.backupId),
    check("fork_stack_run_item_state_ck", inList("state", ITEM_STATES)),
    check("fork_stack_run_item_reason_ck", nullOrInList("reason", RUN_REASONS)),
]);
