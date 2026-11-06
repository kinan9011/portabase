import {cp, mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {runForkMigrations} from "@/fork/db/migrate";
import {MIGRATION_LEDGER} from "@/fork/db/migration-ledger";
import {applyUpstreamMigrations, createTestDb, type TestDb} from "@/fork/__tests__/db-helpers";

const N = MIGRATION_LEDGER.length; // W04 added 0001: counts follow the ledger instead of hard-coding
let t: TestDb;
beforeEach(async () => { t = await createTestDb(); });
afterEach(async () => { await t.drop(); });

const run = (extra: Parameters<typeof runForkMigrations>[0] = {}) =>
    runForkMigrations({databaseUrl: t.url, env: {NODE_ENV: "development"}, ...extra});
const exists = async (rel: string) => (await t.pool.query("select to_regclass($1) as t", [rel])).rows[0].t !== null;
const forkRows = async () => Number((await t.pool.query("select count(*) c from drizzle.__fork_migrations")).rows[0].c);
const upstreamSchemaSnapshot = async () =>
    (await t.pool.query(
        `select table_name, column_name, data_type, is_nullable from information_schema.columns
         where table_schema='public' and table_name not like 'fork\\_%' order by 1,2`,
    )).rows;

describe("fork migration lane — fresh DB + re-run", () => {
    it("fresh: applies after the REAL upstream migrations; re-run is idempotent", async () => {
        await applyUpstreamMigrations(t.pool);
        const first = await run();
        expect(first).toMatchObject({state: "applied", appliedNow: N, total: N});
        expect(await exists("public.fork_meta")).toBe(true);
        expect(await forkRows()).toBe(N);
        await t.pool.query("insert into fork_meta(key,value) values('k','v')");

        const second = await run();
        expect(second).toMatchObject({state: "applied", appliedNow: 0, total: N});
        expect(await forkRows()).toBe(N);
        expect((await t.pool.query("select value from fork_meta where key='k'")).rows).toEqual([{value: "v"}]);
    });

    it("uses its own bookkeeping table, separate from upstream's", async () => {
        await applyUpstreamMigrations(t.pool);
        await run();
        expect(await exists("drizzle.__fork_migrations")).toBe(true);
        expect(await exists("drizzle.__drizzle_migrations")).toBe(true);
        const up = Number((await t.pool.query("select count(*) c from drizzle.__drizzle_migrations")).rows[0].c);
        expect(up).toBeGreaterThan(90); // upstream rows untouched by the lane
    });

    it("creates no DDL on upstream tables (information_schema snapshot unchanged)", async () => {
        await applyUpstreamMigrations(t.pool);
        const before = await upstreamSchemaSnapshot();
        await run();
        expect(await upstreamSchemaSnapshot()).toEqual(before);
        expect(before.length).toBeGreaterThan(100);
    });

    it("two concurrent boots serialise on the advisory lock: both ok, one row", async () => {
        await applyUpstreamMigrations(t.pool);
        const [a, b] = await Promise.all([run(), run()]);
        expect([a.state, b.state]).toEqual(["applied", "applied"]);
        expect(a.appliedNow! + b.appliedNow!).toBe(N);
        expect(await forkRows()).toBe(N);
    });
});

describe("fork migration lane — gated on upstream migration success (ARCH-08)", () => {
    it("upstream never migrated → skipped, nothing created", async () => {
        const log = {info: vi.fn(), warn: vi.fn(), error: vi.fn()};
        const r = await run({log});
        expect(r.state).toBe("skipped-upstream-incomplete");
        expect(await exists("public.fork_meta")).toBe(false);
        expect(await exists("drizzle.__fork_migrations")).toBe(false);
        expect(log.error).toHaveBeenCalled();
    });

    it("upstream partially applied (last migration row missing) → skipped", async () => {
        await applyUpstreamMigrations(t.pool);
        await t.pool.query("delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)");
        const r = await run();
        expect(r.state).toBe("skipped-upstream-incomplete");
        expect(r.detail).toMatch(/^1\/\d+ upstream migrations not applied/);
        expect(await exists("public.fork_meta")).toBe(false);
    });

    it("recovers on the next boot once upstream is complete", async () => {
        expect((await run()).state).toBe("skipped-upstream-incomplete");
        await applyUpstreamMigrations(t.pool);
        expect(await run()).toMatchObject({state: "applied", appliedNow: N});
    });
});

describe("fork migration lane — pre-migration pg_dump, fail closed (ARCH-08, prod upgrades)", () => {
    // fork dir with migration 0000, then 0001 appended (an "upgrade")
    async function forkDirWithUpgrade() {
        const dir = await mkdtemp(path.join(os.tmpdir(), "w01-forkmig-"));
        await cp(path.join(process.cwd(), "src/fork/db/migrations"), dir, {recursive: true});
        const journalPath = path.join(dir, "meta/_journal.json");
        const base = JSON.parse(await readFile(journalPath, "utf8"));
        const append = async () => {
            const idx = base.entries.length;
            const tag = `${String(idx).padStart(4, "0")}_fork_probe`;
            base.entries.push({idx, version: "7", when: base.entries[idx - 1].when + 1000, tag, breakpoints: true});
            await writeFile(journalPath, JSON.stringify(base));
            await writeFile(path.join(dir, `${tag}.sql`), 'CREATE TABLE "fork_probe" ("id" text PRIMARY KEY NOT NULL);\n');
        };
        return {dir, append};
    }
    const prod = {NODE_ENV: "production"};

    it("first install in prod: no dump needed; upgrade in prod: dump is taken BEFORE applying", async () => {
        await applyUpstreamMigrations(t.pool);
        const {dir, append} = await forkDirWithUpgrade();
        const dump = vi.fn(async () => "/x/y.dump");
        expect(await run({env: prod, forkDir: dir, dump})).toMatchObject({state: "applied", appliedNow: N});
        expect(dump).not.toHaveBeenCalled();

        await append();
        const order: string[] = [];
        const dump2 = vi.fn(async () => { order.push((await exists("public.fork_probe")) ? "after" : "before"); return "/x/y.dump"; });
        expect(await run({env: prod, forkDir: dir, dump: dump2})).toMatchObject({state: "applied", appliedNow: 1});
        expect(order).toEqual(["before"]);
        expect(await exists("public.fork_probe")).toBe(true);
    });

    it("dump failure ⇒ blocked-no-dump, migration NOT applied (fail closed)", async () => {
        await applyUpstreamMigrations(t.pool);
        const {dir, append} = await forkDirWithUpgrade();
        await run({env: prod, forkDir: dir});
        await append();
        const r = await run({env: prod, forkDir: dir, dump: async () => { throw new Error("pg_dump failed: no space"); }});
        expect(r).toMatchObject({state: "blocked-no-dump", detail: "pg_dump failed: no space"});
        expect(await exists("public.fork_probe")).toBe(false);
        expect(await forkRows()).toBe(N);
    });

    it("policy off is an explicit, warned opt-out; dev never dumps under auto", async () => {
        await applyUpstreamMigrations(t.pool);
        const {dir, append} = await forkDirWithUpgrade();
        await run({env: prod, forkDir: dir});
        await append();
        const log = {info: vi.fn(), warn: vi.fn(), error: vi.fn()};
        const dump = vi.fn();
        expect(await run({env: {...prod, FORK_MIGRATE_DUMP: "off"}, forkDir: dir, dump, log})).toMatchObject({state: "applied"});
        expect(dump).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("WITHOUT a pre-migration dump"));
    });

    it("required policy dumps even on first install and in dev", async () => {
        await applyUpstreamMigrations(t.pool);
        const dump = vi.fn(async () => "/x/y.dump");
        await run({env: {NODE_ENV: "development", FORK_MIGRATE_DUMP: "required"}, dump});
        expect(dump).toHaveBeenCalledOnce();
    });

    it("REAL pg_dump: writes a 0600 custom-format (PGDMP) dump in a 0700 dir", async () => {
        await applyUpstreamMigrations(t.pool);
        const {dir, append} = await forkDirWithUpgrade();
        const priv = await mkdtemp(path.join(os.tmpdir(), "w01-priv-"));
        const env = {...prod, PRIVATE_PATH: priv, ...(process.env.FORK_PG_DUMP_BIN ? {FORK_PG_DUMP_BIN: process.env.FORK_PG_DUMP_BIN} : {})};
        await run({env, forkDir: dir});
        await append();
        const log = {info: vi.fn(), warn: vi.fn(), error: vi.fn()};
        const r = await run({env, forkDir: dir, log});
        expect(r, JSON.stringify(log.error.mock.calls)).toMatchObject({state: "applied", appliedNow: 1});
        const file = (log.info.mock.calls.find((c) => (c[0] as { file?: string }).file) ?? [])[0] as { file: string };
        const full = path.join(priv, "backups", "fork-predump", file.file);
        expect((await stat(full)).mode & 0o777).toBe(0o600);
        expect((await stat(path.dirname(full))).mode & 0o777).toBe(0o700);
        expect((await readFile(full)).subarray(0, 5).toString()).toBe("PGDMP");
    });
});
