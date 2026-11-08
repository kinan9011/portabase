/**
 * W18a restore orchestrator vocabulary. PURE (no Date / env / DB / crypto): imported by the schema, the derivation and the read model.
 * Honest terminal states only: nothing here may claim a restore was "tested" (D36 / D-7); `verification` says what was actually observed.
 */
export const RESTORE_RUN_STATES = ["running", "awaiting_approval", "succeeded", "incomplete", "failed", "cancelled"] as const;
export const ACTIVE_RESTORE_RUN_STATES = ["running", "awaiting_approval"] as const;
export const RESTORE_STEPS = ["verify_manifest", "probe", "stage", "apply", "render", "restore_db", "compose_up", "check_services"] as const;
/** Steps that enqueue an agent task (+ the explicit `cleanup` request). Journal rows only exist for these. */
export const JOURNAL_STEPS = ["probe", "stage", "apply", "render", "restore_db", "compose_up", "cleanup"] as const;
export const STEP_TASK_TYPE = {
    probe: "restore_probe", stage: "restore_stage", apply: "restore_apply", render: "compose_render", restore_db: "restore_db", compose_up: "compose_up", cleanup: "restore_cleanup",
} as const;
/** What the run observed: `started` = every rendered service reported running right after `compose up`; `data_only` = a plan without compose. */
export const VERIFICATIONS = ["started", "data_only"] as const;
export const ORCH_REASONS = ["manifest_unavailable", "reauth_failed", "agent_offline", "root_missing", "root_not_shared", "insufficient_disk",
    "compose_unavailable", "rules_mismatch", "workspace_not_owned", "probe_invalid", "stage_mismatch", "db_restore_failed", "service_not_running",
    "task_cancelled", "execution_error", "run_timeout", "cancelled", "internal_error"] as const;
/** Enqueue refusals that only mean "not now": the step waits (bounded by the run deadline). Every other refusal is permanent. */
export const TRANSIENT_REFUSALS = ["rate_limited", "locked", "signing_unavailable", "artifact_unavailable"] as const;
export const MAX_EXPIRED_REENQUEUES = 3;
export const REASON_RE = /^[a-z_]{1,64}$/;
export const restoreConfirmPhrase = (project: string) => `RESTORE ${project}`;

export type RestoreRunState = (typeof RESTORE_RUN_STATES)[number];
export type RestoreStep = (typeof RESTORE_STEPS)[number];
export type JournalStep = (typeof JOURNAL_STEPS)[number];
export type Verification = (typeof VERIFICATIONS)[number];
