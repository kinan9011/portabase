import {sql, type SQL} from "drizzle-orm";
import {RP_DOWNGRADE_REASONS, RP_STATUSES, ARTIFACT_PRESENCE} from "@/fork/recovery/status";

/**
 * Value sets mirrored as SQL CHECK constraints (text + CHECK, never pgEnum: forward-migratable, no dependency on
 * upstream enums — ADR-004 §5). `__tests__/unit/schema-enums.test.ts` keeps TS ↔ SQL in sync.
 */
export const HOST_ROLES = ["production", "test"] as const; // D44; `runner` is added in R3 (W21) only
export type HostRole = (typeof HOST_ROLES)[number];
export const HEALTH_STATUSES = ["unknown", "healthy", "degraded", "unreachable", "auth_failed"] as const;
export const SYNC_STATUSES = ["ok", "partial", "error"] as const;
export const RUNTIME_STATES = ["running", "partial", "stopped", "absent", "unknown"] as const;
export const PROTECTION_STATES = ["unprotected", "configured", "active", "paused"] as const;
export const AUDIT_RESULTS = ["success", "denied", "failure"] as const;
export const AUDIT_ACTOR_KINDS = ["user", "system"] as const;
export const RUN_STATUSES = ["running", "success", "partial", "failed"] as const;
export const OUTBOX_STATES = ["pending", "delivered", "failed"] as const;
export const CONSISTENCY_LEVELS = ["crash_consistent_files", "engine_dump", "mixed", "unknown"] as const;
export const DUMP_FORMATS = ["pg_custom", "pg_directory"] as const;
/** W10: what a materialized member source covers, how it got there, and its lifecycle (text + CHECK, ADR-004 §5). */
export const SOURCE_ROLES = ["compose", "env", "bind", "volume", "db"] as const;
export const SOURCE_ORIGINS = ["discovered", "manual"] as const;
/** planned = decided but no upstream row yet (docker-access gate); canary = first docker-volume source awaiting its first contact. */
export const SOURCE_STATUSES = ["planned", "canary", "active", "drifted", "orphaned", "blocked"] as const;
export const SOURCE_PROBES = ["readable", "unreadable"] as const;
export const MATERIALIZE_STATES = ["none", "ready", "inventory_changed", "blocked"] as const;
export const ARCHIVE_KINDS =["restic_snapshot", "archive_enc", "archive_plain"] as const;

export {RP_STATUSES, RP_DOWNGRADE_REASONS, ARTIFACT_PRESENCE};

/** `col IN ('a','b')` (values are compile-time constants; quotes escaped defensively). */
export const inList = (col: string, values: readonly string[]): SQL =>
    sql.raw(`"${col}" IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`);
export const nullOrInList = (col: string, values: readonly string[]): SQL =>
    sql.raw(`"${col}" IS NULL OR "${col}" IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`);
