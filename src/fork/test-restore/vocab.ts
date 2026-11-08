import type {Schedule} from "@/fork/schedule/schedule";

/**
 * W-TR vocabulary (plan §4 D4). PURE (no Date / env / DB): imported by the schema checks, services, UI copy and tests.
 * A test restore never claims the app was started: the only thing it can prove is "the data was read back, engine-checked and the scratch copy wiped".
 */
export const SKIP_REASONS = ["no_verified_rp", "personal_data_no_opt_in", "test_restore_target_not_test", "not_enrolled", "agent_disabled", "capability_missing", "plan_blocked", "locked",
    "reauth_failed", "wipe_pending", "missed", "target_busy", "invalid_config", "internal_error", "not_configured", "overlap"] as const;
export const WIPE_STATES = ["running", "verified", "not_needed", "failed"] as const;
/** Terminal wipe outcomes that mean "the scratch copy is gone or never existed" (a schedule may start the next run). */
export const WIPE_CLEAR = ["verified", "not_needed"] as const;
export const WIPE_REASONS = ["agent_offline", "wipe_unverified", "wipe_timeout", "reauth_failed", "task_cancelled", "execution_error", "internal_error",
    // agent codes a cleanup / probe may fail with
    "path_not_allowed", "symlink_escape", "root_not_shared", "workspace_not_owned", "host_role_mismatch", "docker_unavailable", "deadline_exceeded", "restore_failed", "payload_invalid"] as const;
export const TR_REFUSALS = ["forbidden", "invalid_input", "locked", "rate_limited", "not_found", "target_not_test", "not_enrolled", "capability_missing", "not_configured", "wipe_pending",
    "personal_data_no_opt_in", "no_verified_rp", "plan_blocked", "target_busy", "not_failed", "internal_error", "invalid_root"] as const;
export const CAPTURE_WINDOW_MS = 6 * 3_600_000;
export const WIPE_DEADLINE_MS = 24 * 3_600_000;
export const MAX_WIPE_EXPIRED = 3;
export const DEFAULT_STALE_DAYS = 14;
/** OD-WTR-2: weekly, Sunday 03:30 UTC (away from the 02:00 backup default). */
export const DEFAULT_TR_SCHEDULE: Schedule = {preset: "weekly", timezone: "UTC", minute: 30, hour: 3, weekday: 0, monthday: 1};
export const DAY_MS = 86_400_000;
/** D-11: the scratch project of a test restore, distinct from any wizard restore of the same stack. Lowercase, no dot, ≤ 64 chars. */
export const testRestoreProject = (composeProject: string): string => `${composeProject.slice(0, 50)}-test-restore`;
export const REASON_OK = /^[a-z_]{1,64}$/;

export type SkipReason = (typeof SKIP_REASONS)[number];
export type WipeState = (typeof WIPE_STATES)[number];
export type TrRefusal = (typeof TR_REFUSALS)[number];
