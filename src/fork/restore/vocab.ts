/**
 * Restore planner vocabulary (W16, ADR-014). Pure constants, closed lists: the SQL CHECK constraints of `fork_restore_plan` and the
 * strict zod schemas both read from here (a unit test keeps them in sync). A new value in any list needs a new `PLAN_VERSION`
 * (readers accept only versions they know), so consumers (W16b / W17 / W18a / W20a) can rely on the vocabulary being closed.
 */
export const PLAN_VERSION = 1 as const;
export const PLANNER_RULESET = "w16.1";

export const RESTORE_PURPOSES = ["restore", "test_restore"] as const;
/** `mirror` is R3 only (D22) and arrives with a new plan version. */
export const RESTORE_MODES = ["selective", "new_stack", "existing_stack"] as const;
export const PLAN_OUTCOMES = ["ready", "blocked"] as const;

export const ACTION_KINDS = ["restore_compose_dir", "restore_volume", "restore_path", "restore_db_dump", "restore_sqlite_file", "stage_only", "create_network", "compose_up"] as const;
export const ACTION_OPS = ["create", "replace", "skip", "stage_only"] as const;
/** Order rank = index. W18a maps phases to steps (stage → restore.stage, data/db → restore.apply, start → compose.up). */
export const PHASES = ["stage", "data", "db", "start"] as const;
export const RISKS = ["safe", "needs_approval", "blocked"] as const;
/** v1 emits `restore` and `require_input` only. */
export const SECRET_CLASSES = ["restore", "regenerate", "redact", "disable", "require_input"] as const;

export const APPROVAL_KINDS = ["production_target", "destructive_replace"] as const;
export const APPROVAL_CAPABILITY = {production_target: "restore.production.approve", destructive_replace: "restore.execute"} as const;

export const PRECONDITION_STATES = ["met", "unmet", "deferred"] as const;
export const CHECKERS = ["dashboard", "agent", "orchestrator"] as const;

export const REASONS = [
    // plan-level blockers
    "manifest_unbound", "inventory_missing", "inventory_mismatch", "required_artifact_missing", "target_agent_archived", "target_not_enrolled",
    "target_channel_disabled", "target_revoked", "target_capability_missing", "compose_not_in_backup", "restore_root_required", "restore_root_rejected",
    "restore_root_outside_allowed_roots", "project_name_conflict", "existing_stack_not_on_target", "insufficient_disk", "arch_mismatch",
    "nothing_selected", "selection_unknown_key",
    // action / decision reasons
    "volume_exists", "volume_name_rejected", "path_rejected", "path_outside_allowed_roots", "allowed_roots_unknown", "path_in_use",
    "image_unpublished", "image_unpinned", "port_in_use", "shared_network_missing", "shared_network_reused", "network_name_conflict",
    "sqlite_placement_unresolved", "sqlite_mapping_rejected", "artifact_unmapped", "optional_artifact", "not_selected", "replaces_existing_data",
    "restic_payload_credential", "target_facts_stale", "no_target_inventory",
] as const;

export const REFUSALS = ["invalid_input", "not_found", "forbidden", "locked", "rate_limited", "rp_not_verified", "rp_purged",
    "test_restore_target_not_test", "personal_data_no_opt_in", "test_restore_mode_invalid", "hash_mismatch", "plan_tampered", "stale", "expired",
    "plan_blocked", "approval_not_required"] as const;

export const PRECONDITIONS = ["target_enrolled", "target_capability_restore", "target_capability_compose", "target_facts_fresh", "arch_compat",
    "free_disk", "restore_root_on_agent", "target_empty", "manifest_signature", "safety_snapshot"] as const;

/** Rule ids of `src/fork/policy/compose-deny.json` (a unit test asserts this list equals the JSON). */
export const DENY_RULE_IDS = ["privileged", "network_mode_host", "pid_host", "ipc_host", "devices", "cap_add", "docker_sock", "bind_outside_root"] as const;

export type RestorePurpose = (typeof RESTORE_PURPOSES)[number];
export type RestoreMode = (typeof RESTORE_MODES)[number];
export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type Reason = (typeof REASONS)[number];
export type Refusal = (typeof REFUSALS)[number];
