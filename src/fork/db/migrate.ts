import {readFile} from "node:fs/promises";
import path from "node:path";
import {Pool} from "pg";
import {drizzle} from "drizzle-orm/node-postgres";
import {migrate} from "drizzle-orm/node-postgres/migrator";
import {forkEnv} from "@/fork/env";
import type {LaneStatus} from "@/fork/mode";
import {preMigrationDump} from "@/fork/db/predump";

/**
 * Fork migration lane runner (ADR-003, plan v2.2 ARCH-08).
 *  - runs in dev AND prod, called from `init()` right after upstream `makeMigration()` (hook P02);
 *  - GATED on upstream success: upstream's `makeMigration()` swallows errors and is skipped in dev
 *    (drizzle-kit migrates there), so the gate is observed state: every `when` of upstream's
 *    `_journal.json` must exist in `drizzle.__drizzle_migrations.created_at`;
 *  - own bookkeeping table `drizzle.__fork_migrations`; only fork-owned objects are created;
 *  - serialised across concurrent boots with a session advisory lock;
 *  - pre-migration pg_dump (prod upgrades) fails closed;
 *  - never throws: a failed lane is reported as status, the mode machine turns it into "locked".
 */
export type Journal = { entries: { idx: number; when: number; tag: string }[] };

const UPSTREAM_JOURNAL = path.join(process.cwd(), "src/db/migrations/meta/_journal.json");
const FORK_MIGRATIONS = path.join(process.cwd(), "src/fork/db/migrations");
const LOCK_NAME = "portabase-fork-migrations";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export async function readJournal(dir: string): Promise<Journal> {
    return JSON.parse(await readFile(path.join(dir, "meta/_journal.json"), "utf8")) as Journal;
}

async function appliedCreatedAt(client: Queryable, table: string): Promise<number[]> {
    const exists = await client.query(`select to_regclass('drizzle.${table}') as t`);
    if (!exists.rows[0]?.t) return [];
    const r = await client.query(`select created_at from drizzle.${table}`);
    return r.rows.map((x) => Number(x.created_at));
}

/** Upstream is "applied" iff every upstream journal entry has a row in drizzle's own table. */
export async function upstreamMigrationsApplied(client: Queryable, upstreamDir = path.dirname(path.dirname(UPSTREAM_JOURNAL))) {
    const journal = await readJournal(upstreamDir);
    const applied = new Set(await appliedCreatedAt(client, "__drizzle_migrations"));
    const missing = journal.entries.filter((e) => !applied.has(e.when));
    return {ok: missing.length === 0, missing: missing.length, total: journal.entries.length};
}

export type LaneOptions = {
    databaseUrl?: string;
    env?: Record<string, string | undefined>;
    upstreamDir?: string;
    forkDir?: string;
    privatePath?: string;
    log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
    dump?: typeof preMigrationDump;
};

const noop = () => undefined;

export async function runForkMigrations(o: LaneOptions = {}): Promise<LaneStatus> {
    const log = o.log ?? {info: noop, warn: noop, error: noop};
    const env = forkEnv(o.env ?? process.env);
    const src = o.env ?? process.env;
    const databaseUrl = o.databaseUrl ?? src.DATABASE_URL;
    if (!databaseUrl) return {state: "failed", detail: "DATABASE_URL is not set"};
    const forkDir = o.forkDir ?? env.FORK_MIGRATIONS_DIR ?? FORK_MIGRATIONS;
    const upstreamDir = o.upstreamDir ?? path.dirname(path.dirname(UPSTREAM_JOURNAL));

    const pool = new Pool({connectionString: databaseUrl, options: "-c TimeZone=UTC0", max: 1});
    const client = await pool.connect().catch(() => null);
    if (!client) {
        await pool.end().catch(noop);
        return {state: "failed", detail: "cannot connect to database"};
    }
    let locked = false;
    try {
        const gate = await upstreamMigrationsApplied(client, upstreamDir);
        if (!gate.ok) {
            log.error({missing: gate.missing, total: gate.total}, "Fork migrations skipped: upstream migrations are not fully applied");
            return {state: "skipped-upstream-incomplete", detail: `${gate.missing}/${gate.total} upstream migrations not applied`};
        }

        await client.query("select pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
        locked = true;

        const journal = await readJournal(forkDir);
        const applied = await appliedCreatedAt(client, "__fork_migrations");
        const last = applied.length ? Math.max(...applied) : -Infinity;
        const pending = journal.entries.filter((e) => e.when > last).length;
        const status = {appliedNow: pending, total: journal.entries.length};

        if (pending > 0) {
            const isProd = (src.NODE_ENV ?? "") === "production";
            const upgrade = applied.length > 0;
            const wantDump = env.FORK_MIGRATE_DUMP === "required" || (env.FORK_MIGRATE_DUMP === "auto" && isProd && upgrade);
            if (wantDump) {
                try {
                    const dir = path.join(o.privatePath ?? src.PRIVATE_PATH ?? path.join(process.cwd(), "private"), "backups", "fork-predump");
                    const file = await (o.dump ?? preMigrationDump)({databaseUrl, dir, bin: env.FORK_PG_DUMP_BIN});
                    log.info({file: path.basename(file)}, "Pre-migration pg_dump written");
                } catch (e) {
                    const detail = e instanceof Error ? e.message : String(e);
                    log.error({detail}, "Fork migrations NOT applied: pre-migration pg_dump failed (fail closed)");
                    return {state: "blocked-no-dump", ...status, detail};
                }
            } else if (env.FORK_MIGRATE_DUMP === "off" || (isProd && upgrade)) {
                log.warn({policy: env.FORK_MIGRATE_DUMP}, "Applying fork migrations WITHOUT a pre-migration dump");
            }
            await migrate(drizzle({client: client as unknown as Pool}), {
                migrationsFolder: forkDir,
                migrationsTable: "__fork_migrations",
                migrationsSchema: "drizzle",
            });
            log.info(status, "Fork migrations applied");
        }
        return {state: "applied", ...status};
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        log.error({detail}, "Fork migrations failed");
        return {state: "failed", detail};
    } finally {
        if (locked) await client.query("select pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(noop);
        client.release();
        await pool.end().catch(noop);
    }
}
