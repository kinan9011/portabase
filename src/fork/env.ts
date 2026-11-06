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

const schema = z.object({
    FORK_STACKS_ENABLED: flag,
    FORK_ARCANE_ENABLED: flag,
    /** Only meaningful if R3 opens (D22). */
    FORK_MIRRORS_ENABLED: flag,
    /** `auto` (prod upgrades) | `required` (always, fail closed) | `off` (explicit opt-out, logged). */
    FORK_MIGRATE_DUMP: dumpPolicy,
    /** pg_dump binary used by the pre-migration dump (default `pg_dump` from PATH). */
    FORK_PG_DUMP_BIN: z.string().optional().transform((v) => v?.trim() || "pg_dump"),
    /** Test seam only: fork-lane migration folder override. */
    FORK_MIGRATIONS_DIR: z.string().optional(),
});

export type ForkEnv = z.infer<typeof schema>;

export function forkEnv(source: Record<string, string | undefined> = process.env): ForkEnv {
    return schema.parse({
        FORK_STACKS_ENABLED: source.FORK_STACKS_ENABLED,
        FORK_ARCANE_ENABLED: source.FORK_ARCANE_ENABLED,
        FORK_MIRRORS_ENABLED: source.FORK_MIRRORS_ENABLED,
        FORK_MIGRATE_DUMP: source.FORK_MIGRATE_DUMP,
        FORK_PG_DUMP_BIN: source.FORK_PG_DUMP_BIN,
        FORK_MIGRATIONS_DIR: source.FORK_MIGRATIONS_DIR,
    });
}

/** True when any fork feature flag is on. All flags off ⇒ the fork is invisible. */
export function anyForkFlagOn(source: Record<string, string | undefined> = process.env): boolean {
    const e = forkEnv(source);
    return e.FORK_STACKS_ENABLED || e.FORK_ARCANE_ENABLED || e.FORK_MIRRORS_ENABLED;
}
