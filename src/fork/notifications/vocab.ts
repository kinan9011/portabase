/**
 * Closed vocabularies of the notification delivery (W13, §4.7). Pure data: the outbox `kind` values this release turns into a notification,
 * the closed error codes stored on a failed row (never a provider message — it can carry URLs/credentials) and the retry schedule.
 */
export const DELIVERABLE_KINDS = [
    "run.failed", "run.blocked", "run.incomplete", "run.skipped", "run.policy_paused",
    "stack.partial", "stack.no_good_backup", "kit.unverified", "kit.key_rotated",
    "fork.selfcheck.failed", "fork.selfcheck.recovered",
    "restore.finished", "restore.failed", "restore.needs_approval", // W18a
    "test_restore.failed", "test_restore.wipe_failed", "test_restore.skipped", "stack.test_restore_stale", // W-TR (plan D-13): fixed sentences, no reason text
    "quiesce.failed", "stack.quiesce_stopped", // W17b: the app could not be paused / restarted safely; containers still stopped ("Start now")
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];
export const isDeliverableKind = (k: string): k is DeliverableKind => (DELIVERABLE_KINDS as readonly string[]).includes(k);

/** Alert conditions this release evaluates itself (the others are produced by the run engine / self-check / W14). */
export const ALERT_KINDS = ["stack.partial", "stack.no_good_backup", "stack.quiesce_stopped", "stack.test_restore_stale"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const DELIVERY_ERROR_CODES = ["no_channel", "provider_error", "render_error"] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];

/** Existing upstream event kinds only (no enum edit, §4.7 / wave file): failures → error_backup, dead-man → error_backup_missing, recoveries → success_backup_recovered. */
export type NotifyEvent = "error_backup" | "error_backup_missing" | "success_backup_recovered";
export type NotifyLevel = "critical" | "warning" | "info";

export const MAX_ATTEMPTS = 6;
/** Backoff after the n-th failed attempt (1-based), minutes: 1, 5, 15, 60, 240. */
export const BACKOFF_MINUTES = [1, 5, 15, 60, 240] as const;
export const backoffMs = (attempts: number): number => BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1] * 60_000;
/** Rows with no default channel are rechecked this often and fail with `no_channel` after this age. */
export const NO_CHANNEL_RECHECK_MS = 10 * 60_000;
export const NO_CHANNEL_GIVE_UP_MS = 24 * 3_600_000;
export const CLAIM_LEASE_MS = 5 * 60_000;
