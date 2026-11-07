/** Closed vocabularies of the materializer's persisted state (W10). Pure data: shared by the DB layer (CHECK constraints) and the browser DTO (no db import in `completeness/`). */
export const SOURCE_ROLES = ["compose", "env", "bind", "volume", "db"] as const;
export const SOURCE_ORIGINS = ["discovered", "manual"] as const;
/** planned = decided but no upstream row yet (docker-access gate); canary = first docker-volume source awaiting its first contact. */
export const SOURCE_STATUSES = ["planned", "canary", "active", "drifted", "orphaned", "blocked"] as const;
export const SOURCE_PROBES = ["readable", "unreadable"] as const;
/** Why a member source is `drifted` / `orphaned` / `blocked` (the sentence lives in labels.ts). */
export const SOURCE_DRIFT_REASONS = ["source_removed", "source_moved", "agent_changed", "type_changed", "method_changed", "unsafe_volume", "config_changed", "channel_changed", "not_in_plan", "agent_poll_failing"] as const;
export const MATERIALIZE_STATES = ["none", "ready", "inventory_changed", "blocked"] as const;
