/**
 * Mirror vocabulary (W22a, ADR-008/009/016, plan-W22a §3.2). Pure constants, closed lists: the SQL CHECK constraints of the
 * `fork_mirror*` tables, the strict zod schemas and the state machine all read from here. Nothing here may carry a value, a secret,
 * a URL or a path (ids, names, codes, numbers only).
 */
export const MIRROR_STATUSES = ["creating", "ready", "failed", "cancelled", "refreshing", "deleting", "deleted", "stopping", "stopped", "starting"] as const; // `refreshing` reserved (W24/W25); stopping|stopped|starting = W23 Part B
export const REVISION_STATES = ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting",
    "healthchecking", "ready", "blocked", "failed", "cancelled", "rolled_back"] as const; // rolled_back reserved (W24/W25), never set in W22a
export const ACTIVE_REVISION_STATES = ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting",
    "healthchecking"] as const;
export const TERMINAL_REVISION_STATES = ["ready", "blocked", "failed", "cancelled", "rolled_back"] as const;
/** Terminal states that end in a verified wipe of the runner copy (OD-W22a-5). `ready` keeps its data, `rolled_back` is W24/W25. */
export const WIPE_REVISION_STATES = ["blocked", "failed", "cancelled"] as const;

export const MIRROR_STEPS = ["verify_manifest", "probe", "stage", "apply", "render", "compile", "finalize", "restore_db", "up", "check", "isolation",
    "activate"] as const;
export const MIRROR_JOURNAL_STEPS = ["probe", "stage", "apply", "render", "finalize", "restore_db", "up", "check", "isolation", "wipe", "wipe_check", "stop"] as const;
export const STEP_TASK_TYPE = {
    probe: "mirror_probe", stage: "mirror_stage", apply: "mirror_apply", render: "mirror_render", finalize: "mirror_finalize", restore_db: "mirror_db",
    up: "mirror_up", check: "mirror_check", isolation: "runner_probe", wipe: "mirror_wipe", wipe_check: "mirror_probe", stop: "mirror_stop",
} as const;

export type MirrorStatus = (typeof MIRROR_STATUSES)[number];
export type RevisionState = (typeof REVISION_STATES)[number];
export type MirrorStep = (typeof MIRROR_STEPS)[number];
export type MirrorJournalStep = (typeof MIRROR_JOURNAL_STEPS)[number];

/** State shown while the step is the first unfinished one. W22a runs files → transform → DB (the DB restore needs the transformed project; D49). */
export const STEP_STATE: Record<MirrorStep, RevisionState> = {
    verify_manifest: "validating", probe: "validating", stage: "staging", apply: "restoring_files", render: "transforming", compile: "transforming",
    finalize: "transforming", restore_db: "restoring_db", up: "starting", check: "healthchecking", isolation: "healthchecking", activate: "healthchecking",
};

export const EVENT_KINDS = ["requested", "state_changed", "gate_passed", "gate_failed", "blocked", "failed", "cancel_requested", "cancelled", "ready",
    "wipe_started", "wipe_verified", "wipe_failed"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const GATES = ["expected_data", "db_health", "app_smoke", "isolation", "side_effects"] as const;
export type Gate = (typeof GATES)[number];

/** Dashboard-side terminal codes (closed). Agent codes are `MIRROR_AGENT_CODES` (agent-channel vocab) and the W17 codes. */
export const MIRROR_REASONS = ["plan_blocked", "compile_refused", "kept_secret_unconfirmed", "final_view_invalid", "limits_invalid", "service_not_running",
    "service_unhealthy", "smoke_failed", "expected_data_failed", "runner_not_isolated", "runner_ineligible", "probe_stale", "rp_not_verified", "reauth_failed",
    "run_timeout", "cancelled", "mirrors_disabled", "render_missing", "policy_refused", "manifest_unavailable", "agent_offline", "task_cancelled",
    "execution_error", "internal_error", "payload_too_large", "port_unavailable", "stage_mismatch", "plan_tampered", "hash_mismatch", "wipe_timeout",
    "wipe_incomplete", "db_restore_failed", "stop_incomplete"] as const;

export const LIMIT_DEFAULTS = {mem_bytes: 1073741824, pids: 512, nano_cpus: 1_000_000_000} as const; // OD-W22a-4
export const LIMIT_CAPS = {mem_bytes: 8589934592, pids: 4096, nano_cpus: 4_000_000_000} as const;
export const LIMIT_FLOORS = {mem_bytes: 33554432, pids: 16, nano_cpus: 100_000_000} as const;
export const PORT_RANGE = {min: 41000, max: 41999} as const; // OD-W22a-9
export const DEFAULT_MIRROR_ROOT = "/srv/portabase-mirrors"; // OD-W22a-6 (a test pins it equal to the env default)
export const RUNNER_PRECHECK_MAX_AGE_MS = 24 * 3600e3; // create refuses a runner not isolated within 24 h
export const WIPE_BUDGET_MS = 2 * 3600e3; // a wipe phase older than this is `wipe_timeout`
export const MAX_EXPIRED_REENQUEUES = 3;
export const LIFECYCLE_BUDGET_MS = 30 * 60_000; // W23: a stop / start operation older than this is `run_timeout`

export const keepConfirmPhrase = (svc: string, key: string): string => `KEEP ${svc}.${key}`;
export const PRIVACY_ACK = "I understand this mirror holds a copy of real production data"; // W22b shows the ADR-009 §4 banner; W22a checks the boolean

/** Plain sentences for refusals returned by the services (no values). */
export const REFUSAL_MESSAGES: Record<string, string> = {
    mirrors_disabled: "Test mirrors are not enabled on this installation.",
    privacy_ack_required: "Confirm that this mirror will hold a copy of real production data.",
    confirmation_mismatch: "A kept production secret was not confirmed by typing its exact phrase.",
    runner_ineligible: "This agent is not an eligible test-mirror runner.",
    runner_not_isolated: "The runner has no fresh passing isolation probe.",
    runner_busy: "This runner is already creating another mirror.",
    name_taken: "A mirror with this name already exists.",
    port_unavailable: "No free loopback port is left on this runner.",
    rp_not_verified: "Only a verified recovery point can be mirrored.",
    mirror_not_ready: "The mirror is not ready.",
    plan_blocked: "The restore plan for this mirror is blocked.",
    not_found: "Not found.",
    forbidden: "You do not have permission to do this.",
    invalid_input: "The request is invalid.",
    locked: "Configuration changes are locked.",
    rate_limited: "Too many requests. Try again shortly.",
    mirror_busy: "Stop creating it first (Cancel), or wait for the running action to finish.",
    mirror_state_invalid: "This action is not possible in the mirror's current state.",
};
