import {bigint, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {organization} from "@/db/schema/03_organization";
import {agent} from "@/db/schema/08_agent";
import {inList, nullOrInList} from "@/fork/db/enums";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkRecoveryPoint} from "@/fork/db/schema/recovery";
import {forkRestorePlan} from "@/fork/db/schema/restore";
import {forkStack} from "@/fork/db/schema/stack";
import {ACTIVE_REVISION_STATES, EVENT_KINDS, MIRROR_JOURNAL_STEPS, MIRROR_STATUSES, PORT_RANGE, REVISION_STATES} from "@/fork/mirror/vocab";

const ts = (name: string) => timestamp(name, {withTimezone: true});
const CODE = sql.raw("'^[a-z_]{1,64}$'"); // inlined literals: a CHECK cannot take bind parameters
const HEX64 = sql.raw("'^[0-9a-f]{64}$'");
const activeList = ACTIVE_REVISION_STATES.map((s) => `'${s}'`).join(",");

/**
 * W22a (ADR-008/009/016): test mirrors. Everything here is ids, names, codes, hashes, counts, port numbers and VALUE-FREE specs: no env value, no secret,
 * no URL, no host IP, no task result. `runner_agent_id` is a volatile upstream reference (SET NULL, D32) with the agent name denormalised.
 * `fork_mirror` = one row per mirror (a name that survives refreshes); `fork_mirror_revision` = one creation attempt / generation (`id` IS the restore id
 * sent to the runner: workspace owner id and owner labels); `fork_mirror_event` = timeline for W23 (audit stays the security record);
 * `fork_mirror_task` = step journal (one row per enqueued task, written IN the enqueue transaction).
 */
export const forkMirror = pgTable("fork_mirror", {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organization.id, {onDelete: "cascade"}),
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "cascade"}),
    runnerAgentId: uuid("runner_agent_id").references(() => agent.id, {onDelete: "set null"}),
    runnerAgentName: text("runner_agent_name").notNull(),
    name: text("name").notNull(),
    policy: jsonb("policy").notNull(),
    status: text("status").notNull().default("creating"),
    activeRevisionId: uuid("active_revision_id").references((): AnyPgColumn => forkMirrorRevision.id, {onDelete: "set null"}),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    deletedAt: ts("deleted_at"),
}, (t) => [
    uniqueIndex("fork_mirror_org_name_uq").on(t.organizationId, t.name).where(sql`deleted_at IS NULL`),
    index("fork_mirror_stack_idx").on(t.stackId, t.createdAt),
    check("fork_mirror_name_ck", sql`${t.name} ~ '^[a-z0-9][a-z0-9-]{0,39}$'`),
    check("fork_mirror_status_ck", inList("status", MIRROR_STATUSES)),
    check("fork_mirror_policy_size_ck", sql`octet_length(${t.policy}::text) <= 16384`),
]);

export const forkMirrorRevision = pgTable("fork_mirror_revision", {
    id: uuid("id").primaryKey().defaultRandom(),
    mirrorId: uuid("mirror_id").notNull().references(() => forkMirror.id, {onDelete: "cascade"}),
    organizationId: uuid("organization_id").notNull().references(() => organization.id, {onDelete: "cascade"}),
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "cascade"}),
    seq: integer("seq").notNull(),
    rpId: uuid("rp_id").references(() => forkRecoveryPoint.id, {onDelete: "set null"}),
    rpSequence: bigint("rp_sequence", {mode: "number"}).notNull(),
    planId: uuid("plan_id").references(() => forkRestorePlan.id, {onDelete: "set null"}),
    planHash: text("plan_hash").notNull(),
    runnerAgentId: uuid("runner_agent_id").references(() => agent.id, {onDelete: "set null"}),
    project: text("project").notNull(),
    workspace: text("workspace").notNull(),
    hostPort: integer("host_port").notNull(),
    state: text("state").notNull().default("requested"),
    reason: text("reason"),
    failedStep: text("failed_step"),
    steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
    refusals: jsonb("refusals"),
    spec: jsonb("spec"),
    specSha256: text("spec_sha256"),
    sourceViewSha256: text("source_view_sha256"),
    finalViewSha256: text("final_view_sha256"),
    services: jsonb("services").notNull().default(sql`'[]'::jsonb`),
    gates: jsonb("gates").notNull().default(sql`'{}'::jsonb`),
    probeTaskId: uuid("probe_task_id").references(() => forkAgentTask.id, {onDelete: "set null"}),
    startedBy: text("started_by").notNull(),
    createdAt: ts("created_at").notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    readiedAt: ts("readied_at"),
    activatedAt: ts("activated_at"),
    finishedAt: ts("finished_at"),
    durationSeconds: integer("duration_seconds"),
    cancelRequestedAt: ts("cancel_requested_at"),
    cancelRequestedBy: text("cancel_requested_by"),
    wipeState: text("wipe_state"),
    wipeReason: text("wipe_reason"),
    wipeStartedAt: ts("wipe_started_at"),
    wipeFinishedAt: ts("wipe_finished_at"),
    updatedAt: ts("updated_at").notNull(),
}, (t) => [
    unique("fork_mirror_revision_seq_uq").on(t.mirrorId, t.seq),
    uniqueIndex("fork_mirror_revision_one_active_runner_uq").on(t.runnerAgentId).where(sql`state IN (${sql.raw(activeList)}) AND runner_agent_id IS NOT NULL`),
    // the loopback port stays reserved while the copy may still exist on the runner (no verified / not-needed wipe yet)
    uniqueIndex("fork_mirror_revision_port_runner_uq").on(t.runnerAgentId, t.hostPort).where(sql`runner_agent_id IS NOT NULL AND coalesce(wipe_state, '') NOT IN ('verified','not_needed')`),
    index("fork_mirror_revision_start_tested_idx").on(t.stackId, t.readiedAt).where(sql`state = 'ready' AND readied_at IS NOT NULL`),
    index("fork_mirror_revision_mirror_idx").on(t.mirrorId, t.seq),
    check("fork_mirror_revision_seq_ck", sql`${t.seq} >= 1`),
    check("fork_mirror_revision_state_ck", inList("state", REVISION_STATES)),
    check("fork_mirror_revision_project_ck", sql`${t.project} ~ '^pbm-[a-z0-9][a-z0-9-]{0,58}$'`),
    check("fork_mirror_revision_workspace_ck", sql`octet_length(${t.workspace}) <= 1024`),
    check("fork_mirror_revision_port_ck", sql`${t.hostPort} BETWEEN ${sql.raw(String(PORT_RANGE.min))} AND ${sql.raw(String(PORT_RANGE.max))}`),
    check("fork_mirror_revision_reason_ck", sql`(${t.reason} IS NULL OR ${t.reason} ~ ${CODE}) AND (${t.wipeReason} IS NULL OR ${t.wipeReason} ~ ${CODE})`),
    check("fork_mirror_revision_hash_ck", sql`${t.planHash} ~ ${HEX64} AND (${t.specSha256} IS NULL OR ${t.specSha256} ~ ${HEX64}) AND (${t.sourceViewSha256} IS NULL OR ${t.sourceViewSha256} ~ ${HEX64}) AND (${t.finalViewSha256} IS NULL OR ${t.finalViewSha256} ~ ${HEX64})`),
    check("fork_mirror_revision_wipe_ck", nullOrInList("wipe_state", ["running", "verified", "not_needed", "failed"])),
    check("fork_mirror_revision_final_ck", sql`state IN (${sql.raw(activeList)}) OR ${t.finishedAt} IS NOT NULL`),
    check("fork_mirror_revision_failed_ck", sql`${t.state} NOT IN ('failed','blocked') OR ${t.reason} IS NOT NULL`),
    check("fork_mirror_revision_ready_ck", sql`${t.state} <> 'ready' OR (${t.readiedAt} IS NOT NULL AND ${t.finalViewSha256} IS NOT NULL AND ${t.specSha256} IS NOT NULL AND ${t.probeTaskId} IS NOT NULL)`),
    check("fork_mirror_revision_size_ck", sql`octet_length(${t.steps}::text) <= 65536 AND octet_length(${t.services}::text) <= 65536 AND octet_length(${t.gates}::text) <= 4096 AND (${t.refusals} IS NULL OR octet_length(${t.refusals}::text) <= 8192) AND (${t.spec} IS NULL OR octet_length(${t.spec}::text) <= 524288)`),
]);

export const forkMirrorEvent = pgTable("fork_mirror_event", {
    id: uuid("id").primaryKey().defaultRandom(),
    mirrorId: uuid("mirror_id").notNull().references(() => forkMirror.id, {onDelete: "cascade"}),
    revisionId: uuid("revision_id").references(() => forkMirrorRevision.id, {onDelete: "cascade"}),
    kind: text("kind").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    code: text("code"),
    actorKind: text("actor_kind").notNull(),
    actorUserId: text("actor_user_id"),
    at: ts("at").notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
}, (t) => [
    index("fork_mirror_event_mirror_at_idx").on(t.mirrorId, t.at),
    check("fork_mirror_event_kind_ck", inList("kind", EVENT_KINDS)),
    check("fork_mirror_event_actor_ck", sql`${t.actorKind} IN ('user','system')`),
    check("fork_mirror_event_code_ck", sql`${t.code} IS NULL OR ${t.code} ~ ${CODE}`),
    check("fork_mirror_event_details_ck", sql`octet_length(${t.details}::text) <= 4096`),
]);

/** Step journal: one row per enqueued task, written IN the enqueue transaction, so a crash can neither lose nor duplicate a task. */
export const forkMirrorTask = pgTable("fork_mirror_task", {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id").notNull().references(() => forkMirrorRevision.id, {onDelete: "cascade"}),
    step: text("step").notNull(),
    attempt: integer("attempt").notNull(),
    taskType: text("task_type").notNull(),
    taskId: uuid("task_id").unique().references(() => forkAgentTask.id, {onDelete: "set null"}),
    createdAt: ts("created_at").notNull(),
}, (t) => [
    unique("fork_mirror_task_step_attempt_uq").on(t.revisionId, t.step, t.attempt),
    check("fork_mirror_task_step_ck", inList("step", MIRROR_JOURNAL_STEPS)),
    check("fork_mirror_task_attempt_ck", sql`${t.attempt} >= 1`),
]);
