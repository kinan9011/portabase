import {bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {organization} from "@/db/schema/03_organization";
import {agent} from "@/db/schema/08_agent";
import {inList, nullOrInList} from "@/fork/db/enums";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkRecoveryPoint} from "@/fork/db/schema/recovery";
import {forkRestorePlan} from "@/fork/db/schema/restore";
import {forkStack} from "@/fork/db/schema/stack";
import {JOURNAL_STEPS, RESTORE_RUN_STATES, VERIFICATIONS} from "@/fork/restore-run/vocab";
import {RESTORE_RUN_PURPOSES} from "@/fork/restore/vocab";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * W18a (ADR-014 addendum): the durable restore orchestrator. One run = one W16 plan = one `restore_id` (`id` IS the restore id sent to the agent);
 * at most one ACTIVE run per target agent (the agent runs one task at a time). `steps` is the W12 step-engine state (persisted after every change).
 * Everything here is ids, hashes, codes, counts and service names: no path, URL, manifest, payload, override value or task result. `mode` excludes
 * `existing_stack` on purpose (DB-level guard for #145). `rp_id` / `target_agent_id` are volatile upstream references: SET NULL + denormalised (D32).
 */
export const forkRestoreRun = pgTable("fork_restore_run", {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organization.id, {onDelete: "cascade"}),
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "cascade"}),
    planId: uuid("plan_id").notNull().unique().references(() => forkRestorePlan.id, {onDelete: "cascade"}),
    planHash: text("plan_hash").notNull(),
    rpId: uuid("rp_id").references(() => forkRecoveryPoint.id, {onDelete: "set null"}),
    rpSequence: bigint("rp_sequence", {mode: "number"}).notNull(),
    targetAgentId: uuid("target_agent_id").references(() => agent.id, {onDelete: "set null"}),
    targetAgentName: text("target_agent_name").notNull(),
    purpose: text("purpose").notNull(),
    mode: text("mode").notNull(),
    state: text("state").notNull().default("running"),
    reason: text("reason"),
    failedStep: text("failed_step"),
    verification: text("verification"),
    steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
    confirmation: text("confirmation").notNull(),
    acceptMissingInputs: boolean("accept_missing_inputs").notNull().default(false),
    policyApproval: jsonb("policy_approval"),
    policyApprovalSha256: text("policy_approval_sha256"),
    policyApprovedBy: text("policy_approved_by"),
    policyApprovedAt: ts("policy_approved_at"),
    services: jsonb("services").notNull().default(sql`'[]'::jsonb`),
    /** W-TR: who started the run (`manual` = a person, `schedule` = the test-restore scheduler) and which slot it was for. */
    trigger: text("trigger").notNull().default("manual"),
    scheduledFor: ts("scheduled_for"),
    /** W-TR: `{checked, failed, not_supported}` of the engine integrity check (counts only). */
    integrity: jsonb("integrity"),
    /** W-TR verified wipe of the scratch copy (test restores only): NULL = not yet handled (or not a test restore). */
    wipeState: text("wipe_state"),
    wipeReason: text("wipe_reason"),
    wipeStartedAt: ts("wipe_started_at"),
    wipeFinishedAt: ts("wipe_finished_at"),
    wipeBy: text("wipe_by"),
    cancelRequestedAt: ts("cancel_requested_at"),
    cancelRequestedBy: text("cancel_requested_by"),
    startedBy: text("started_by").notNull(),
    createdAt: ts("created_at").notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    finishedAt: ts("finished_at"),
    updatedAt: ts("updated_at").notNull(),
}, (t) => [
    uniqueIndex("fork_restore_run_one_active_target_uq").on(t.targetAgentId).where(sql`state IN ('running','awaiting_approval') AND target_agent_id IS NOT NULL`),
    index("fork_restore_run_stack_created_idx").on(t.stackId, t.createdAt),
    check("fork_restore_run_state_ck", inList("state", RESTORE_RUN_STATES)),
    check("fork_restore_run_purpose_ck", inList("purpose", RESTORE_RUN_PURPOSES)),
    check("fork_restore_run_mode_ck", sql`${t.mode} IN ('new_stack','selective')`),
    check("fork_restore_run_verification_ck", nullOrInList("verification", VERIFICATIONS)),
    check("fork_restore_run_trigger_ck", sql`${t.trigger} IN ('manual','schedule')`),
    check("fork_restore_run_wipe_ck", sql`(${t.wipeState} IS NULL OR ${t.wipeState} IN ('running','verified','not_needed','failed')) AND (${t.wipeReason} IS NULL OR ${t.wipeReason} ~ '^[a-z_]{1,64}$')`),
    check("fork_restore_run_integrity_ck", sql`${t.integrity} IS NULL OR octet_length(${t.integrity}::text) <= 1024`),
    index("fork_restore_run_test_facet_idx").on(t.stackId, t.finishedAt).where(sql`purpose = 'test_restore' AND state = 'succeeded' AND verification = 'data_verified' AND wipe_state = 'verified'`),
    check("fork_restore_run_confirmation_ck", sql`${t.confirmation} IN ('typed','not_required')`),
    check("fork_restore_run_reason_ck", sql`${t.reason} IS NULL OR ${t.reason} ~ '^[a-z_]{1,64}$'`),
    check("fork_restore_run_hash_ck", sql`${t.planHash} ~ '^[0-9a-f]{64}$' AND (${t.policyApprovalSha256} IS NULL OR ${t.policyApprovalSha256} ~ '^[0-9a-f]{64}$')`),
    check("fork_restore_run_final_ck", sql`${t.state} IN ('running','awaiting_approval') OR ${t.finishedAt} IS NOT NULL`),
    check("fork_restore_run_failed_ck", sql`${t.state} NOT IN ('failed','incomplete') OR ${t.reason} IS NOT NULL`),
    check("fork_restore_run_size_ck", sql`octet_length(${t.steps}::text) <= 65536 AND octet_length(${t.services}::text) <= 65536 AND (${t.policyApproval} IS NULL OR octet_length(${t.policyApproval}::text) <= 262144)`),
]);

/** Step journal: one row per enqueued task, written IN the enqueue transaction (D-4), so a crash can neither lose nor duplicate a task. */
export const forkRestoreRunTask = pgTable("fork_restore_run_task", {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => forkRestoreRun.id, {onDelete: "cascade"}),
    step: text("step").notNull(),
    attempt: integer("attempt").notNull(),
    taskType: text("task_type").notNull(),
    taskId: uuid("task_id").unique().references(() => forkAgentTask.id, {onDelete: "set null"}),
    overrideRevision: integer("override_revision"),
    createdAt: ts("created_at").notNull(),
}, (t) => [
    unique("fork_restore_run_task_step_attempt_uq").on(t.runId, t.step, t.attempt),
    check("fork_restore_run_task_step_ck", inList("step", JOURNAL_STEPS)),
    check("fork_restore_run_task_attempt_ck", sql`${t.attempt} >= 1`),
]);
