import {z} from "zod";

/**
 * RecoveryPoint status model (D43, ADR-004 §5). `restore-tested` is a facet, never a status in v1.
 * Pure module: the SQL CHECK constraints in the fork migration mirror these constants (a test keeps them in sync).
 */
export const RP_STATUSES = ["incomplete", "pending_verification", "verified", "failed"] as const;
export type RpStatus = (typeof RP_STATUSES)[number];
export const RpStatusSchema = z.enum(RP_STATUSES);

/** D32 downgrade + failure reasons (ADR-004 §5). */
export const RP_DOWNGRADE_REASONS = [
    "fk_null",
    "artifact_missing",
    "count_mismatch",
    "retention_partial",
    "stack_removed",
    "verify_failed",
    "plaintext_hash_mismatch",
    // W12 finaliser (migration 0006):
    "validator_blocked", // EU-04: the validator found gaps; everything readable was captured
    "member_failed", // at least one required member did not produce its artifacts
    "member_timeout", // stuck timeout: the agent never started / never progressed
    "unencrypted", // D39: an archive artifact is not encrypted
    "checksum_unavailable", // the dashboard could not compute the ciphertext checksum
    "run_cancelled",
    "run_not_started", // nothing could be queued
    "run_error", // the run engine itself failed repeatedly (internal_error); partial artifacts are still listed
] as const;
export type RpDowngradeReason = (typeof RP_DOWNGRADE_REASONS)[number];

export const ARTIFACT_PRESENCE = ["present", "missing", "unknown"] as const;
export type ArtifactPresence = (typeof ARTIFACT_PRESENCE)[number];

/**
 * One-way transitions except downgrades (ADR-004 §5):
 *   pending_verification → verified | failed        (W14 verify job ONLY)
 *   verified → incomplete                           (coherence job / retention)
 *   incomplete → failed                             (age)
 *   (finaliser, W12) incomplete | pending_verification are the only initial states; a complete run starts pending_verification.
 */
const TRANSITIONS: Record<RpStatus, readonly RpStatus[]> = {
    incomplete: ["failed"],
    pending_verification: ["verified", "failed", "incomplete"],
    verified: ["incomplete"],
    failed: [],
};

export function canTransition(from: RpStatus, to: RpStatus): boolean {
    return TRANSITIONS[from].includes(to);
}

export type ArtifactFacts = {backupId: string | null; backupStorageId: string | null; presence: ArtifactPresence; required: boolean};

/**
 * D32 downgrade rule, in the order the reasons are reported:
 * a NULL FK, a `presence ≠ present` artifact or `count(present) ≠ required_artifact_count` downgrades the RP.
 * Returns null when the RP is coherent. NEVER returns a verified/ok value — it only says why not.
 */
export function deriveDowngrade(requiredArtifactCount: number, artifacts: readonly ArtifactFacts[]): RpDowngradeReason | null {
    const req = artifacts.filter((a) => a.required);
    if (req.some((a) => a.backupId === null || a.backupStorageId === null)) return "fk_null";
    if (req.some((a) => a.presence !== "present")) return "artifact_missing";
    const present = req.filter((a) => a.presence === "present").length;
    if (present !== requiredArtifactCount) return "count_mismatch";
    return null;
}
