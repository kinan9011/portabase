import {bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {agent} from "@/db/schema/08_agent";
import {backup} from "@/db/schema/07_database";
import {inList} from "@/fork/db/enums";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/** ADR-007 D7 (W15). Terminal statuses carry `finished_at`; `leased`/`running` carry a lease. */
export const AGENT_TASK_STATUSES = ["queued", "leased", "running", "succeeded", "failed", "rejected", "expired", "cancelled"] as const;
export const AGENT_TASK_TERMINAL = ["succeeded", "failed", "rejected", "expired", "cancelled"] as const;

/**
 * Per-agent fork-channel enrolment (ADR-007 D2/D3/D4). One row per enrolled agent (FK `agents` SET NULL like every fork→upstream FK, D32:
 * an agent deleted upstream leaves an orphan row whose credential matches no live agent id, i.e. it can never authenticate).
 * Secrets: the credential exists ONLY as `SHA-256(secret)` (hex); the agent task key only as a fork-KEK envelope (AAD `fork_agent_enrollment|<id>|task_key_enc`).
 * `enroll_id` is the enrolment generation: it is signed into every envelope and bound into the agent's persisted replay state, so a dashboard
 * database rollback (lower `seq`) is detected by the agent and cured by re-enrolling (new generation).
 */
export const forkAgentEnrollment = pgTable("fork_agent_enrollment", {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => agent.id, {onDelete: "set null"}).unique(),
    enrollId: uuid("enroll_id").notNull().defaultRandom(),
    credentialHash: text("credential_hash").notNull(),
    /** Rotation overlap (D2): the previous hash stays valid until `prev_valid_until` or the first request with the new credential. */
    prevCredentialHash: text("prev_credential_hash"),
    prevValidUntil: ts("prev_valid_until"),
    /**
     * Signed `rotate_credential` overlap slot (W15b, ADR-007 A12): the NEW hash is valid next to the current one until the agent proves it (first
     * use ⇒ promoted), the task fails/is never delivered (⇒ cleared) or `pending_valid_until` passes. All three are set or null together.
     */
    pendingCredentialHash: text("pending_credential_hash"),
    pendingTaskId: uuid("pending_task_id"),
    pendingValidUntil: ts("pending_valid_until"),
    taskKeyEnc: jsonb("task_key_enc").notNull(),
    pinnedKids: text("pinned_kids").array().notNull().default(sql`'{}'::text[]`),
    pinFingerprint: text("pin_fingerprint").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    revokedAt: ts("revoked_at"),
    channelVersion: integer("channel_version").notNull().default(1),
    capabilities: text("capabilities").array().notNull().default(sql`'{}'::text[]`),
    capabilitiesSeenAt: ts("capabilities_seen_at"),
    lastSeenAt: ts("last_seen_at"),
    /** Next per-agent task sequence number (strictly increasing, assigned under the row lock at enqueue). */
    nextSeq: integer("next_seq").notNull().default(1),
    enrolledBy: text("enrolled_by").notNull(),
    enrolledAt: ts("enrolled_at").notNull().defaultNow(),
}, (t) => [
    check("fork_agent_enrollment_hash_ck", sql`${t.credentialHash} ~ '^[0-9a-f]{64}$'`),
    check("fork_agent_enrollment_prev_ck", sql`(${t.prevCredentialHash} IS NULL) = (${t.prevValidUntil} IS NULL)`),
    check("fork_agent_enrollment_pending_ck", sql`(${t.pendingCredentialHash} IS NULL) = (${t.pendingTaskId} IS NULL) AND (${t.pendingTaskId} IS NULL) = (${t.pendingValidUntil} IS NULL)`),
    check("fork_agent_enrollment_pending_hash_ck", sql`${t.pendingCredentialHash} IS NULL OR ${t.pendingCredentialHash} ~ '^[0-9a-f]{64}$'`),
    check("fork_agent_enrollment_seq_ck", sql`${t.nextSeq} >= 1`),
]);

/**
 * The task queue (ADR-007 D7). `envelope_text` is the EXACT signed byte string (text, not jsonb: jsonb would reorder keys); the agent verifies the
 * signature over those bytes. `payload_enc` = base64(nonce‖ct‖tag) under the agent's task key; it is purged (NULL) once the task is final (SEC-08).
 * `result` is data only (≤ 64 KiB, redacted, non-secret) and never triggers anything on the dashboard.
 */
export const forkAgentTask = pgTable("fork_agent_task", {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => agent.id, {onDelete: "set null"}),
    agentName: text("agent_name").notNull(),
    enrollId: uuid("enroll_id").notNull(),
    type: text("type").notNull(),
    requires: text("requires").array().notNull().default(sql`'{}'::text[]`),
    seq: integer("seq").notNull(),
    envelopeText: text("envelope_text").notNull(),
    signature: text("signature").notNull(),
    kid: text("kid").notNull(),
    payloadEnc: text("payload_enc"),
    payloadSha256: text("payload_sha256").notNull(),
    targetAgentId: uuid("target_agent_id"),
    status: text("status").notNull().default("queued"),
    leaseId: uuid("lease_id"),
    leaseUntil: ts("lease_until"),
    attempts: integer("attempts").notNull().default(0),
    result: jsonb("result"),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    notAfter: ts("not_after").notNull(),
    finishedAt: ts("finished_at"),
}, (t) => [
    unique("fork_agent_task_enroll_seq_uq").on(t.enrollId, t.seq),
    index("fork_agent_task_agent_status_idx").on(t.agentId, t.status, t.seq),
    check("fork_agent_task_status_ck", inList("status", AGENT_TASK_STATUSES)),
    check("fork_agent_task_lease_ck", sql`${t.status} NOT IN ('leased', 'running') OR (${t.leaseId} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL)`),
    check("fork_agent_task_final_ck", sql`${t.status} NOT IN ('succeeded', 'failed', 'rejected', 'expired', 'cancelled') OR ${t.finishedAt} IS NOT NULL`),
    check("fork_agent_task_result_ck", sql`${t.result} IS NULL OR octet_length(${t.result}::text) <= 65536`),
    check("fork_agent_task_hash_ck", sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
]);

/**
 * D45: what the agent computed over the PLAINTEXT archive (SHA-256 + size, before encryption), reported through the channel.
 * A cross-check input for the W14 verify job only — never a verdict by itself. First report wins (the unique key), a different later value is
 * ignored (and audited), so a compromised agent cannot rewrite what it said when the backup ran.
 */
export const forkAgentHashReport = pgTable("fork_agent_hash_report", {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK SET NULL like every fork→upstream FK (D32): a purged backup leaves an inert orphan report. */
    backupId: uuid("backup_id").references(() => backup.id, {onDelete: "set null"}),
    agentId: uuid("agent_id").references(() => agent.id, {onDelete: "set null"}),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", {mode: "number"}).notNull(),
    reportedAt: ts("reported_at").notNull().defaultNow(),
}, (t) => [
    unique("fork_agent_hash_report_backup_uq").on(t.backupId),
    check("fork_agent_hash_report_sha_ck", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("fork_agent_hash_report_size_ck", sql`${t.sizeBytes} >= 0`),
]);
