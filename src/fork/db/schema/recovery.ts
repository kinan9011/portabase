import {bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {backup} from "@/db/schema/07_database";
import {backupStorage} from "@/db/schema/14_storage-backup";
import {forkStack, forkStackSource} from "@/fork/db/schema/stack";
import {forkStackRun} from "@/fork/db/schema/runs";
import {
    ARCHIVE_KINDS, ARTIFACT_PRESENCE, CONSISTENCY_LEVELS, DUMP_FORMATS, inList, nullOrInList, RP_DOWNGRADE_REASONS, RP_STATUSES,
} from "@/fork/db/enums";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * RecoveryPoint (ADR-004 §5). W04 owns the shape + D43 status enum + D32 FK policy; the finaliser/verify job that
 * write it are W12/W14. `stack_id` is RESTRICT: removing a stack needs the explicit, audited "forget stack" action that
 * first marks RPs `failed:stack_removed` or exports them. `run_id` has no FK until the run table exists (W12).
 */
export const forkRecoveryPoint = pgTable("fork_recovery_point", {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "restrict"}),
    stackName: text("stack_name").notNull(),
    runId: uuid("run_id").references(() => forkStackRun.id, {onDelete: "set null"}),
    sequence: bigint("sequence", {mode: "number"}).notNull(),
    inventoryVersion: integer("inventory_version"),
    inventoryHash: text("inventory_hash"),
    status: text("status").notNull().default("incomplete"),
    downgradeReason: text("downgrade_reason"),
    consistencyLevel: text("consistency_level").notNull().default("unknown"),
    requiredArtifactCount: integer("required_artifact_count").notNull().default(0),
    presentArtifactCount: integer("present_artifact_count").notNull().default(0),
    totalSizeBytes: bigint("total_size_bytes", {mode: "number"}),
    manifestSha256: text("manifest_sha256"),
    manifestSigKid: text("manifest_sig_kid"),
    manifestRefs: jsonb("manifest_refs").notNull().default(sql`'[]'::jsonb`),
    createdAt: ts("created_at").notNull().defaultNow(),
    finalizedAt: ts("finalized_at"),
    verifiedAt: ts("verified_at"),
    verifyReport: jsonb("verify_report"),
    retentionBucket: jsonb("retention_bucket"),
    expiresAt: ts("expires_at"),
    purgedAt: ts("purged_at"),
}, (t) => [
    unique("fork_recovery_point_stack_seq_uq").on(t.stackId, t.sequence),
    // W12: one RP per run (the finaliser is idempotent).
    unique("fork_recovery_point_run_uq").on(t.runId),
    index("fork_recovery_point_stack_status_idx").on(t.stackId, t.status),
    check("fork_recovery_point_status_ck", inList("status", RP_STATUSES)),
    check("fork_recovery_point_reason_ck", nullOrInList("downgrade_reason", RP_DOWNGRADE_REASONS)),
    check("fork_recovery_point_consistency_ck", inList("consistency_level", CONSISTENCY_LEVELS)),
    check("fork_recovery_point_counts_ck", sql`${t.requiredArtifactCount} >= 0 AND ${t.presentArtifactCount} >= 0`),
    // D43: only a verified RP carries verified_at; a verified RP has no downgrade reason; a failed RP always says why.
    check("fork_recovery_point_verified_ck", sql`${t.status} <> 'verified' OR (${t.verifiedAt} IS NOT NULL AND ${t.downgradeReason} IS NULL)`),
    check("fork_recovery_point_failed_ck", sql`${t.status} <> 'failed' OR ${t.downgradeReason} IS NOT NULL`),
]);

/**
 * One artifact per (member run, storage channel). FKs to volatile upstream tables are SET NULL (D32); every fact a
 * recovery needs is denormalised. `engine` is text (not the upstream pgEnum). `stack_source_id`/`channel_id` carry no
 * FK (`fork_stack_source` arrives in W10; channels are copied ids only — ADR-004 §2).
 */
export const forkRecoveryPointArtifact = pgTable("fork_recovery_point_artifact", {
    id: uuid("id").primaryKey().defaultRandom(),
    rpId: uuid("rp_id").notNull().references(() => forkRecoveryPoint.id, {onDelete: "cascade"}),
    stackSourceId: uuid("stack_source_id").references(() => forkStackSource.id, {onDelete: "set null"}),
    backupId: uuid("backup_id").references(() => backup.id, {onDelete: "set null"}),
    backupStorageId: uuid("backup_storage_id").references(() => backupStorage.id, {onDelete: "set null"}),
    sourceName: text("source_name").notNull(),
    engine: text("engine").notNull(),
    dumpFormat: text("dump_format"),
    archiveKind: text("archive_kind").notNull(),
    archiveFormatVersion: integer("archive_format_version"),
    encrypted: boolean("encrypted").notNull(),
    channelId: uuid("channel_id"),
    channelKind: text("channel_kind"),
    pathOrSnapshotId: text("path_or_snapshot_id"),
    generatedId: text("generated_id"),
    sizeBytes: bigint("size_bytes", {mode: "number"}),
    ciphertextSha256: text("ciphertext_sha256"),
    plaintextSha256: text("plaintext_sha256"),
    plaintextSize: bigint("plaintext_size", {mode: "number"}),
    required: boolean("required").notNull().default(true),
    presence: text("presence").notNull().default("unknown"),
}, (t) => [
    index("fork_rp_artifact_rp_idx").on(t.rpId),
    index("fork_rp_artifact_backup_idx").on(t.backupId),
    check("fork_rp_artifact_dump_format_ck", nullOrInList("dump_format", DUMP_FORMATS)),
    check("fork_rp_artifact_archive_kind_ck", inList("archive_kind", ARCHIVE_KINDS)),
    check("fork_rp_artifact_presence_ck", inList("presence", ARTIFACT_PRESENCE)),
]);
