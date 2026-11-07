import {z} from "zod";

/**
 * Fork feature flags — own file, upstream `src/env.mjs` is never edited.
 *
 * Parsing is strict and fail-closed: only the literal string `true`
 * (case-insensitive, trimmed) turns a flag on. Everything else, including
 * unset, `1`, `yes` or typos, is OFF.
 */
const flag = z
    .string()
    .optional()
    .transform((v) => v?.trim().toLowerCase() === "true");

const dumpPolicy = z
    .string()
    .optional()
    .transform((v) => {
        const p = v?.trim().toLowerCase();
        return p === "required" || p === "off" ? p : "auto";
    });

const auditDays = z
    .string()
    .optional()
    .transform((v) => {
        const n = Number(v?.trim());
        return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 400; // ADR-004 §7 default; audit.ts enforces the 90-day floor
    });

const discoveryMinutes = z
    .string()
    .optional()
    .transform((v) => {
        const n = Number(v?.trim());
        return Number.isInteger(n) && n >= 5 && n <= 1440 ? n : 15; // ADR-004 §7: 15 min default, min 5
    });

const schema = z.object({
    FORK_STACKS_ENABLED: flag,
    FORK_ARCANE_ENABLED: flag,
    /** Only meaningful if R3 opens (D22). */
    FORK_MIRRORS_ENABLED: flag,
    /** `auto` (prod upgrades) | `required` (always, fail closed) | `off` (explicit opt-out, logged). */
    FORK_MIGRATE_DUMP: dumpPolicy,
    /** pg_dump binary used by the pre-migration dump (default `pg_dump` from PATH). */
    FORK_PG_DUMP_BIN: z.string().optional().transform((v) => v?.trim() || "pg_dump"),
    /** Audit retention in days (default 400; values below 90 are raised to 90 by the purge, SEC-07). */
    FORK_AUDIT_RETENTION_DAYS: auditDays,
    /** Test seam only: fork-lane migration folder override. */
    FORK_MIGRATIONS_DIR: z.string().optional(),
    /**
     * W05/SEC-10: comma-separated IPs / CIDRs / host names an Arcane `base_url` may resolve to although the address is
     * loopback/private/link-local (default: empty = deny). Operator-only (env), never settable from the UI. Cloud metadata
     * addresses are never allowed whatever this says. See `net/guard.ts`.
     */
    FORK_ARCANE_NET_ALLOWLIST: z.string().optional().transform((v) => v?.trim() ?? ""),
    /** W07: how often the discovery cron syncs a connection (minutes, 5–1440, default 15; ±20 % jitter). Operator-only, like the allow-list. */
    FORK_DISCOVERY_INTERVAL_MINUTES: discoveryMinutes,
});

export type ForkEnv = z.infer<typeof schema>;

export function forkEnv(source: Record<string, string | undefined> = process.env): ForkEnv {
    return schema.parse({
        FORK_STACKS_ENABLED: source.FORK_STACKS_ENABLED,
        FORK_ARCANE_ENABLED: source.FORK_ARCANE_ENABLED,
        FORK_MIRRORS_ENABLED: source.FORK_MIRRORS_ENABLED,
        FORK_MIGRATE_DUMP: source.FORK_MIGRATE_DUMP,
        FORK_PG_DUMP_BIN: source.FORK_PG_DUMP_BIN,
        FORK_AUDIT_RETENTION_DAYS: source.FORK_AUDIT_RETENTION_DAYS,
        FORK_MIGRATIONS_DIR: source.FORK_MIGRATIONS_DIR,
        FORK_ARCANE_NET_ALLOWLIST: source.FORK_ARCANE_NET_ALLOWLIST,
        FORK_DISCOVERY_INTERVAL_MINUTES: source.FORK_DISCOVERY_INTERVAL_MINUTES,
    });
}

/** True when any fork feature flag is on. All flags off ⇒ the fork is invisible. */
export function anyForkFlagOn(source: Record<string, string | undefined> = process.env): boolean {
    const e = forkEnv(source);
    return e.FORK_STACKS_ENABLED || e.FORK_ARCANE_ENABLED || e.FORK_MIRRORS_ENABLED;
}
