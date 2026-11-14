/** W21 runner constants (ADR-008). */
export const RUNNER_PROBE_DEFAULT_MAX_AGE_MS = 24 * 3600e3;
export const DNS_CANARY = "example.com";
export const MAX_ADMIN_TARGETS = 24;
export const MAX_TARGETS = 32;
export const PROBE_TIMEOUT_MS = 1500;
export const TARGET_CLASSES = ["dashboard", "arcane", "database", "smtp", "webhook", "storage", "dns", "custom"] as const;
export type TargetClass = (typeof TARGET_CLASSES)[number];
/** Classes an admin may pick (`dashboard` and `arcane` are derived automatically). */
export const ADMIN_TARGET_CLASSES = ["database", "smtp", "webhook", "storage", "dns", "custom"] as const;
export const REFUSAL_CODES = ["forbidden", "locked", "mirrors_disabled", "rate_limited", "invalid_input", "step_up_failed", "no_password", "not_found", "not_enrolled", "agent_disabled", "agent_mapped_to_environment", "agent_has_databases", "already_designated", "not_a_runner", "not_attested", "probe_in_progress", "target_invalid", "too_many_targets", "signing_unavailable", "insecure_transport", "invalid_url"] as const;
export type RunnerRefusalCode = (typeof REFUSAL_CODES)[number];
export const PROBE_TASK_TTL_MS = 10 * 60_000;
