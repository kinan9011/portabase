/**
 * W17b closed vocabularies for the composite quiesce task (ADR-007 A15, D29). Pure: no imports. The agent mirrors the codes (`QUIESCE_AGENT_CODES`
 * is appended to `RESTORE_REASONS` in the SAME order as the agent's `Code` enum); the DB CHECK lists are generated from these constants.
 */
/** Run members that must be copied INSIDE the stop window (D2). Everything else (engine dumps incl. the online `sqlite` backup) runs before the stop. */
export const WINDOW_DBMS = ["files", "docker-volume"] as const;
export const isWindowDbms = (d: string): boolean => (WINDOW_DBMS as readonly string[]).includes(d);

export const QUIESCE_TASK_TYPES = ["quiesce", "quiesce_start"] as const;
export type QuiesceTaskType = (typeof QUIESCE_TASK_TYPES)[number];
export const QUIESCE_CAPABILITY = "quiesce.v1";

export const QUIESCE_STATES = ["skipped", "requested", "stopped", "not_started", "refused", "stop_failed", "restarted", "restart_failed", "unconfirmed"] as const;
export type QuiesceState = (typeof QUIESCE_STATES)[number];

export const QUIESCE_SKIP_REASONS = ["flag_off", "locked", "capability_missing", "agent_unenrolled", "plan_blocked", "enabler_lost", "restore_busy"] as const;
export type QuiesceSkipReason = (typeof QUIESCE_SKIP_REASONS)[number];

/** Appended to `RESTORE_REASONS` (end, same order as the agent's `Code`): the agent's refusal / failure codes. */
export const QUIESCE_AGENT_CODES = [
    "not_in_project", "protected_in_project", "container_changed", "replica_not_listed", "container_unstable", "restore_owned",
    "quiesce_pending", "journal_unavailable", "stop_failed", "restart_unverified", "quiesce_interrupted",
] as const;

export const QUIESCE_REASONS = [
    ...QUIESCE_SKIP_REASONS, ...QUIESCE_AGENT_CODES,
    "protected_container", "docker_unavailable", "deadline_exceeded", "payload_invalid",
    "capability_missing_at_lease", "execution_error", "lease_lost", "expired", "agent_did_not_start",
] as const;
export type QuiesceReason = (typeof QUIESCE_REASONS)[number];

export const RELEASE_REASONS = ["capture_done", "start_now", "cancelled"] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export const PLAN_BLOCKERS = ["no_services", "service_unknown", "no_container_id", "dependency_cycle", "writer_not_stopped", "manager_in_stack", "too_many", "no_window_members"] as const;
export type PlanBlockerCode = (typeof PLAN_BLOCKERS)[number];

/** Who ended the window, as the agent reports it. */
export const RELEASED_BY = ["dashboard", "lost_dashboard", "deadline", "window_broken", "stop_failed", "replay"] as const;
export const CONTAINER_OUTCOMES = ["verified", "unhealthy", "still_starting", "not_running", "replaced", "not_running_before"] as const;

export const MAX_STOP_CHOICES_S = [300, 600, 900, 1800, 3600] as const;
export const DEFAULT_MAX_STOP_S = 600;
export const STOP_TIMEOUT_CAP_S = 120;
export const START_TIMEOUT_S = 180;
export const ALERT_GRACE_MS = 10 * 60_000;
export const MAX_TARGETS = 32;

/** Run steps of a run that uses quiesce (plain runs keep `RUN_STEPS`, byte-identical). Defined here (pure) and re-exported by `runs/vocab`. */
export const QUIESCE_RUN_STEPS = ["refresh_inventory", "validate", "trigger", "track", "quiesce_stop", "trigger_window", "track_window", "quiesce_release", "hash", "finalize"] as const;
