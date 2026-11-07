import type {RpDowngradeReason} from "@/fork/recovery/status";
import type {RunReason} from "@/fork/runs/vocab";

/**
 * What a finished run becomes (W12 finaliser decision, D43/D39/D32/EU-04). PURE and exhaustive: the single place that decides the
 * RecoveryPoint status. It can only ever return `pending_verification`, `incomplete` or `failed` — the type has no `verified`
 * (D43: only the W14 verify job promotes), and `pending_verification` requires EVERY one of: ≥ 1 queued member, every required
 * artifact present with FK facts, every archive artifact encrypted AND checksummed (restic: a full snapshot id), and a complete
 * validator report.
 */
export type ArtifactInput = {
    /** false when the member's upstream backup / storage row is missing (a required channel got no row) */
    hasBackupFk: boolean;
    hasStorageFk: boolean;
    /** upstream `backup_storage.status` of that channel row; `none` = the channel got no row at all */
    storageStatus: "success" | "failed" | "pending" | "none";
    /** upstream backup engine of the row; `archive` = a single object, `restic` = a snapshot */
    archive: "archive" | "restic" | "other";
    encrypted: boolean;
    /** SHA-256 of the stored object computed by the dashboard (archive); null = not computed / unreadable */
    ciphertextSha256: string | null;
    /** restic snapshot id (64 hex) or null */
    snapshotId: string | null;
};

export type RunFacts = {
    cancelled: boolean;
    /** the engine failed (internal_error): never claims success */
    errored?: boolean;
    /** any item ended as agent_did_not_start / agent_made_no_progress / run_timeout */
    timedOut: boolean;
    /** the code of the first timed-out item (agent_did_not_start | agent_made_no_progress | run_timeout) */
    timeoutReason?: RunReason;
    queuedMembers: number;
    validatorComplete: boolean;
    encryptionOn: boolean;
    artifacts: readonly ArtifactInput[];
};

export type RpDecision =
    | {status: "pending_verification"; reason: null; runState: "succeeded"; runReason: null}
    | {status: "incomplete"; reason: RpDowngradeReason; runState: "incomplete"; runReason: RunReason | null}
    | {status: "failed"; reason: RpDowngradeReason; runState: "failed" | "cancelled"; runReason: RunReason};

const HEX64 = /^[0-9a-f]{64}$/;
export const artifactPresent = (a: ArtifactInput): boolean => a.storageStatus === "success" && a.hasBackupFk && a.hasStorageFk;
/** "Checksum present" (wave): an archive needs the computed ciphertext SHA-256; a restic artifact is identified by its snapshot id. */
export const artifactHasChecksum = (a: ArtifactInput): boolean =>
    a.archive === "restic" ? a.snapshotId !== null && HEX64.test(a.snapshotId) : a.ciphertextSha256 !== null && HEX64.test(a.ciphertextSha256);
/** D39: restic repositories are always encrypted; an archive is encrypted only if the agent produced `.enc` AND encryption is on. */
export const artifactEncrypted = (a: ArtifactInput, encryptionOn: boolean): boolean => a.archive === "restic" ? true : encryptionOn && a.encrypted;

export function decideRecoveryPoint(f: RunFacts): RpDecision {
    if (f.errored) return {status: "failed", reason: "run_error", runState: "failed", runReason: "internal_error"};
    if (f.cancelled) return {status: "failed", reason: "run_cancelled", runState: "cancelled", runReason: "cancelled"};
    if (f.timedOut) return {status: "failed", reason: "member_timeout", runState: "failed", runReason: f.timeoutReason ?? "agent_did_not_start"};
    if (f.queuedMembers === 0) return {status: "failed", reason: "run_not_started", runState: "failed", runReason: "nothing_queued"};
    const present = f.artifacts.filter(artifactPresent).length;
    if (present === 0) return {status: "failed", reason: "member_failed", runState: "failed", runReason: "member_failed"};
    if (present < f.artifacts.length) return {status: "incomplete", reason: "member_failed", runState: "incomplete", runReason: "member_failed"};
    if (f.artifacts.some((a) => !artifactEncrypted(a, f.encryptionOn))) return {status: "incomplete", reason: "unencrypted", runState: "incomplete", runReason: null};
    if (f.artifacts.some((a) => !artifactHasChecksum(a))) return {status: "incomplete", reason: "checksum_unavailable", runState: "incomplete", runReason: null};
    if (!f.validatorComplete) return {status: "incomplete", reason: "validator_blocked", runState: "incomplete", runReason: null};
    return {status: "pending_verification", reason: null, runState: "succeeded", runReason: null};
}

/** crash_consistent_files | engine_dump | mixed | unknown from the dbms of the captured members (sqlite/DB engines are dumps). */
export function consistencyOf(dbms: readonly string[]): "crash_consistent_files" | "engine_dump" | "mixed" | "unknown" {
    if (dbms.length === 0) return "unknown";
    const files = dbms.filter((d) => d === "files" || d === "docker-volume").length;
    if (files === 0) return "engine_dump";
    return files === dbms.length ? "crash_consistent_files" : "mixed";
}
