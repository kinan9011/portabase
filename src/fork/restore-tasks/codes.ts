/**
 * Closed failure / rejection codes of the restore-class agent tasks (ADR-007 A13). ONE list: `agent-channel/tasks.ts::REASONS` is built from it, the
 * cross-language vectors carry it, and the agent's `restore::Code` enum is asserted equal to it. A code the dashboard does not know makes the result
 * POST fail with 400, so a new agent code always starts here. W17-ii appends its own block (compose / policy / db codes).
 */
export const RESTORE_REASONS = [
    "path_not_allowed", "symlink_escape", "root_not_shared", "workspace_not_owned", "mode_unsupported", "host_role_mismatch", "approval_missing",
    "manifest_invalid", "manifest_unknown_kid", "manifest_signature", "manifest_mismatch", "artifact_unavailable", "checksum_mismatch", "archive_invalid",
    "dump_format_mismatch", "volume_exists", "volume_not_owned", "disk_full", "docker_unavailable", "deadline_exceeded", "restore_failed",
] as const;
export type RestoreReason = (typeof RESTORE_REASONS)[number];
