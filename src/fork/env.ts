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

const tickSeconds = z
    .string()
    .optional()
    .transform((v) => {
        const n = Number(v?.trim());
        return Number.isInteger(n) && n >= 5 && n <= 3600 ? n : 60; // W10 drift/probe job period; D30 "within one tick"
    });

/** Mirror of the agent's `HEARTBEAT_EVERY` (portabase-agent `src/fork/exec.rs:8` is the source of truth; W27a F-03). The lease floor is derived from it. */
export const FORK_AGENT_HEARTBEAT_SECONDS = 20;

/** Integer env value within [min, max], else the default (fail closed to the documented default, never to 0). */
const intRange = (min: number, max: number, dflt: number) =>
    z.string().optional().transform((v) => {
        const n = Number(v?.trim());
        return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
    });

/** Like `intRange` but a blank value is the default, never 0 (W18a: 0 switches the orchestrator job off, so it must be spelled out). */
const intRangeExplicit = (min: number, max: number, dflt: number) =>
    z.string().optional().transform((v) => {
        const t = v?.trim() ?? "";
        const n = Number(t);
        return t !== "" && Number.isInteger(n) && n >= min && n <= max ? n : dflt;
    });

/** W22a: the absolute root every mirror workspace lives under (OD-W22a-6). Canonical, at least two segments, not a system path; anything else falls back to the default (fail closed). */
export const DEFAULT_MIRROR_ROOT = "/srv/portabase-mirrors";
const SYSTEM_TOP = new Set(["etc", "usr", "bin", "sbin", "lib", "lib32", "lib64", "proc", "sys", "dev", "boot", "run", "root", "home", "tmp"]);
const mirrorRoot = z.string().optional().transform((v) => {
    const t = v?.trim() ?? "";
    const ok = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(t) && !t.split("/").some((s) => s === "." || s === "..") && !SYSTEM_TOP.has(t.split("/")[1] as string);
    return ok ? t : DEFAULT_MIRROR_ROOT;
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
    /** W10: period of the materializer drift/probe job in seconds (5–3600, default 60). Operator-only. */
    FORK_MATERIALIZE_TICK_SECONDS: tickSeconds,
    /** W12 stack runs (operator-only). Tick period of the run job (scheduler + tracker + finaliser + retention). */
    FORK_RUN_TICK_SECONDS: intRange(2, 300, 15),
    /** W12 mandatory stuck timeouts: a `waiting` member backup the agent never picked up; an `ongoing` one with no progress; a hard cap per run. */
    FORK_RUN_WAIT_TIMEOUT_SECONDS: intRange(10, 86_400, 600),
    FORK_RUN_STALL_TIMEOUT_SECONDS: intRange(10, 86_400, 1800),
    FORK_RUN_MAX_SECONDS: intRange(60, 604_800, 21_600),
    /** ARCH-17: a due slot may start up to this long after the slot (waiting for capacity), then it is a missed slot. */
    FORK_RUN_CAPTURE_WINDOW_MINUTES: intRange(1, 1440, 60),
    /** §13 A12: the agent has unlimited parallelism; the fork caps concurrent runs per host agent and per organization. */
    FORK_RUN_MAX_PER_AGENT: intRange(1, 20, 1),
    FORK_RUN_MAX_PER_ORG: intRange(1, 50, 3),
    /** Dashboard-side ciphertext hashing of an archive artifact: refuse objects above this size (MiB) / take longer than this (s). */
    FORK_RUN_HASH_MAX_MIB: intRange(1, 1_048_576, 51_200),
    FORK_RUN_HASH_TIMEOUT_SECONDS: intRange(10, 86_400, 3600),
    /** W13 notifications (operator-only): delivery tick; how often alert conditions (drift to Partial, no good backup) are evaluated; dead-man floor in hours. */
    FORK_NOTIFY_TICK_SECONDS: intRange(5, 3600, 60),
    FORK_NOTIFY_EVAL_MINUTES: intRange(1, 1440, 5),
    FORK_DEADMAN_MIN_HOURS: intRange(1, 720, 12),
    /** W14 verify job (operator-only): tick period; plaintext cap per archive (MiB, the decompressed cap is 4×); per-object download timeout (minutes); attempts before an unreadable RP is `failed`. */
    FORK_VERIFY_TICK_SECONDS: intRange(5, 3600, 60),
    FORK_VERIFY_MAX_MIB: intRange(1, 1_048_576, 20_480),
    FORK_VERIFY_DOWNLOAD_TIMEOUT_MINUTES: intRange(1, 1440, 120),
    FORK_VERIFY_MAX_ATTEMPTS: intRange(1, 20, 5),
    /** W14 kit: hours an active-policy stack may run with an unverified kit before the §4.7 `kit.unverified` notification; how often the kit watch recomputes the live key fingerprint (minutes). */
    FORK_KIT_UNVERIFIED_HOURS: intRange(1, 720, 24),
    FORK_KIT_WATCH_MINUTES: intRange(1, 1440, 60),
    /**
     * W15 agent channel (ADR-007 D5): the ONLY http exemption. Honoured only together with a loopback host (`localhost`, `*.localhost`, 127/8, `::1`) — the fork lab.
     * There is deliberately NO per-agent / LAN override (ADR-007 §http). Operator-only.
     */
    FORK_ALLOW_INSECURE_LOOPBACK: flag,
    /** W17b (D9a): dashboard-side switch of the opt-in quiesce. Config-plane: NOT part of `anyForkFlagOn` (parity). Default off. */
    FORK_QUIESCE_ENABLED: flag,
    /** W15: how long a task may wait to be started (minutes, 1–60, default 10, ADR-007 D3) and how long one lease lasts without a heartbeat (seconds, 45–600, default 60; floor raised from 15 in W27a/F-03). */
    FORK_AGENT_TASK_TTL_MINUTES: intRange(1, 60, 10),
    // ≥ 2 × the agent heartbeat (20 s, FORK_AGENT_HEARTBEAT_SECONDS) + 5 s: a lease shorter than ~45 s lapses between two heartbeats of a long task (re-queue / `lease_lost`).
    FORK_AGENT_LEASE_SECONDS: intRange(2 * FORK_AGENT_HEARTBEAT_SECONDS + 5, 600, 60),
    /** W16: restore plan lifetime (hours); a plan older than this is `expired` and must be re-planned. */
    FORK_RESTORE_PLAN_TTL_HOURS: intRange(1, 168, 24),
    /** W18a: hard cap of one restore run (hours, 1..48) and the orchestrator tick period (seconds, 1..300; `0` = the job never ticks: LIVE LAB ONLY). */
    FORK_RESTORE_RUN_MAX_HOURS: intRange(1, 48, 12),
    FORK_RESTORE_TICK_SECONDS: intRangeExplicit(0, 300, 10),
    /** W-TR: scheduler + verified-wipe tick (seconds; `0` = this process never ticks: LIVE LAB ONLY) and the default decay age of the test-restore facet (days). */
    FORK_TEST_RESTORE_TICK_SECONDS: intRangeExplicit(0, 300, 60),
    /** W22a: mirror root on the runner (must equal the agent's `FORK_MIRROR_ROOT`), hard cap of one mirror creation (hours, 1..24) and the orchestrator tick period (seconds, 0..300; `0` = never ticks: LIVE LAB ONLY). */
    FORK_MIRROR_ROOT: mirrorRoot,
    FORK_MIRROR_MAX_HOURS: intRange(1, 24, 4),
    FORK_MIRROR_TICK_SECONDS: intRangeExplicit(0, 300, 10),
    FORK_TEST_RESTORE_STALE_DAYS: intRange(1, 90, 14),
    FORK_MIRROR_START_STALE_DAYS: intRange(1, 90, 14), // W23, ADR-016: "App start-tested" turns "Out of date" after this many days
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
        FORK_MATERIALIZE_TICK_SECONDS: source.FORK_MATERIALIZE_TICK_SECONDS,
        FORK_RUN_TICK_SECONDS: source.FORK_RUN_TICK_SECONDS,
        FORK_RUN_WAIT_TIMEOUT_SECONDS: source.FORK_RUN_WAIT_TIMEOUT_SECONDS,
        FORK_RUN_STALL_TIMEOUT_SECONDS: source.FORK_RUN_STALL_TIMEOUT_SECONDS,
        FORK_RUN_MAX_SECONDS: source.FORK_RUN_MAX_SECONDS,
        FORK_RUN_CAPTURE_WINDOW_MINUTES: source.FORK_RUN_CAPTURE_WINDOW_MINUTES,
        FORK_RUN_MAX_PER_AGENT: source.FORK_RUN_MAX_PER_AGENT,
        FORK_RUN_MAX_PER_ORG: source.FORK_RUN_MAX_PER_ORG,
        FORK_RUN_HASH_MAX_MIB: source.FORK_RUN_HASH_MAX_MIB,
        FORK_RUN_HASH_TIMEOUT_SECONDS: source.FORK_RUN_HASH_TIMEOUT_SECONDS,
        FORK_NOTIFY_TICK_SECONDS: source.FORK_NOTIFY_TICK_SECONDS,
        FORK_NOTIFY_EVAL_MINUTES: source.FORK_NOTIFY_EVAL_MINUTES,
        FORK_DEADMAN_MIN_HOURS: source.FORK_DEADMAN_MIN_HOURS,
        FORK_VERIFY_TICK_SECONDS: source.FORK_VERIFY_TICK_SECONDS,
        FORK_VERIFY_MAX_MIB: source.FORK_VERIFY_MAX_MIB,
        FORK_VERIFY_DOWNLOAD_TIMEOUT_MINUTES: source.FORK_VERIFY_DOWNLOAD_TIMEOUT_MINUTES,
        FORK_VERIFY_MAX_ATTEMPTS: source.FORK_VERIFY_MAX_ATTEMPTS,
        FORK_KIT_UNVERIFIED_HOURS: source.FORK_KIT_UNVERIFIED_HOURS,
        FORK_KIT_WATCH_MINUTES: source.FORK_KIT_WATCH_MINUTES,
        FORK_ALLOW_INSECURE_LOOPBACK: source.FORK_ALLOW_INSECURE_LOOPBACK,
        FORK_QUIESCE_ENABLED: source.FORK_QUIESCE_ENABLED,
        FORK_AGENT_TASK_TTL_MINUTES: source.FORK_AGENT_TASK_TTL_MINUTES,
        FORK_AGENT_LEASE_SECONDS: source.FORK_AGENT_LEASE_SECONDS,
        FORK_RESTORE_PLAN_TTL_HOURS: source.FORK_RESTORE_PLAN_TTL_HOURS,
        FORK_RESTORE_RUN_MAX_HOURS: source.FORK_RESTORE_RUN_MAX_HOURS,
        FORK_RESTORE_TICK_SECONDS: source.FORK_RESTORE_TICK_SECONDS,
        FORK_TEST_RESTORE_TICK_SECONDS: source.FORK_TEST_RESTORE_TICK_SECONDS,
        FORK_MIRROR_ROOT: source.FORK_MIRROR_ROOT,
        FORK_MIRROR_MAX_HOURS: source.FORK_MIRROR_MAX_HOURS,
        FORK_MIRROR_TICK_SECONDS: source.FORK_MIRROR_TICK_SECONDS,
        FORK_TEST_RESTORE_STALE_DAYS: source.FORK_TEST_RESTORE_STALE_DAYS,
        FORK_MIRROR_START_STALE_DAYS: source.FORK_MIRROR_START_STALE_DAYS,
    });
}

/** True when any fork feature flag is on. All flags off ⇒ the fork is invisible. */
export function anyForkFlagOn(source: Record<string, string | undefined> = process.env): boolean {
    const e = forkEnv(source);
    return e.FORK_STACKS_ENABLED || e.FORK_ARCANE_ENABLED || e.FORK_MIRRORS_ENABLED;
}
