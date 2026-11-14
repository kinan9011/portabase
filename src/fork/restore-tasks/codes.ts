/**
 * Closed failure / rejection codes of the restore-class agent tasks (ADR-007 A13). ONE list: `agent-channel/tasks.ts::REASONS` is built from it, the
 * cross-language vectors carry it, and the agent's `restore::Code` enum is asserted equal to it. A code the dashboard does not know makes the result
 * POST fail with 400, so a new agent code always starts here. W17-ii appends its own block (compose / policy / db codes).
 */
import {QUIESCE_AGENT_CODES} from "@/fork/quiesce/vocab";

export const RESTORE_REASONS = [
    "path_not_allowed", "symlink_escape", "root_not_shared", "workspace_not_owned", "mode_unsupported", "host_role_mismatch", "approval_missing",
    "manifest_invalid", "manifest_unknown_kid", "manifest_signature", "manifest_mismatch", "artifact_unavailable", "checksum_mismatch", "archive_invalid",
    "dump_format_mismatch", "volume_exists", "volume_not_owned", "disk_full", "docker_unavailable", "deadline_exceeded", "restore_failed",
    // W17-ii (ADR-007 A14) — order is part of the contract (the agent's `Code::RESTORE` is compared index by index)
    "compose_unavailable", "override_invalid", "raw_refused", "render_failed", "render_too_large", "policy_refused", "approval_invalid",
    "container_conflict", "protected_container", "network_exists", "volume_not_in_compose", "db_restore_failed", "compose_failed",
    // W17b (ADR-007 A15): quiesce refusal / failure codes, appended in the agent's `Code` order (`QUIESCE_AGENT_CODES`)
    ...QUIESCE_AGENT_CODES,
    // W-TR (ADR-007 A16): data-only test-restore integrity check — appended at the END, same order as the agent's `Code` enum
    "integrity_failed", "engine_unavailable",
] as const;
/**
 * W22a (plan-W22a §3.3): codes only the mirror engine returns. Appended AFTER `RESTORE_REASONS`, same order as the agent's `Code` enum (vectors carry the list).
 * Without them in `REASONS` a mirror result would 400 and the agent would re-report forever (plan-W21 §10 lesson).
 */
export const MIRROR_AGENT_CODES = ["seed_invalid", "source_changed", "apply_failed", "limits_invalid", "final_view_mismatch", "credential_reset_failed", "credential_reset_unsupported",
    "smoke_failed_internal", "mirror_disabled"] as const;
export type RestoreReason = (typeof RESTORE_REASONS)[number];
