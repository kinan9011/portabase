import {cp, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {runForkMigrations} from "@/fork/db/migrate";
import {insertConnectionWithSecret, listConnectionDtos, readConnectionApiKey} from "@/fork/db/dto";
import {applyUpstreamMigrations, createTestDb} from "@/fork/__tests__/db-helpers";
import {freshForkDb, seedConnection, seedEnvironment, seedOrg, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";

const CANARY = "arc_canary_SECRET_w04_0123456789";

describe("W04 migration 0001 — E1 applies on upstream head + previous fork head, idempotent, fork-only", () => {
    it("0000 first (previous fork head) then 0001 applies; re-run is a no-op; upstream tables are untouched", async () => {
        const t = await createTestDb();
        const tmp = await mkdtemp(path.join(os.tmpdir(), "w04-lane-"));
        try {
            await applyUpstreamMigrations(t.pool);
            const upstream = async () => (await t.pool.query(`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name not like 'fork\\_%' order by 1,2`)).rows;
            const before = await upstream();

            // "previous fork head": only 0000 present
            const src = path.join(process.cwd(), "src/fork/db/migrations");
            await cp(src, tmp, {recursive: true});
            const jp = path.join(tmp, "meta/_journal.json");
            const j = JSON.parse(await readFile(jp, "utf8"));
            j.entries = j.entries.filter((e: {idx: number}) => e.idx === 0);
            await writeFile(jp, JSON.stringify(j));
            await rm(path.join(tmp, "0001_fork_schema_v1.sql"));
            const first = await runForkMigrations({databaseUrl: t.url, env: {NODE_ENV: "development"}, forkDir: tmp});
            expect(first).toMatchObject({state: "applied", appliedNow: 1, total: 1});
            expect((await t.pool.query("select to_regclass('public.fork_stack') t")).rows[0].t).toBeNull();

            const second = await runForkMigrations({databaseUrl: t.url, env: {NODE_ENV: "development"}});
            expect(second).toMatchObject({state: "applied", appliedNow: 1, total: 2});
            const third = await runForkMigrations({databaseUrl: t.url, env: {NODE_ENV: "development"}});
            expect(third).toMatchObject({state: "applied", appliedNow: 0, total: 2});
            expect(Number((await t.pool.query("select count(*) c from drizzle.__fork_migrations")).rows[0].c)).toBe(2);

            for (const tbl of ["fork_arcane_connection", "fork_arcane_environment", "fork_stack", "fork_stack_inventory", "fork_stack_policy", "fork_audit_event", "fork_lock", "fork_schedule_state", "fork_notification_outbox", "fork_recovery_point", "fork_recovery_point_artifact"])
                expect((await t.pool.query("select to_regclass($1) t", [`public.${tbl}`])).rows[0].t, tbl).not.toBeNull();
            expect(await upstream()).toEqual(before); // no DDL on upstream tables
        } finally {
            await t.drop();
            await rm(tmp, {recursive: true, force: true});
        }
    });
});

describe("W04 constraints (real Postgres)", () => {
    let w: W04Db, org: string;
    beforeAll(async () => { w = await freshForkDb(); org = await seedOrg(w.pool); });
    afterAll(async () => { await w.drop(); });
    const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

    it("E6 SEC-11/D44: new environments default to `production`; `runner` and junk are rejected by CHECK", async () => {
        const conn = await seedConnection(w.pool, org, "c-hostrole");
        const env = await seedEnvironment(w.pool, conn);
        expect((await w.pool.query("select host_role from fork_arcane_environment where id=$1", [env])).rows[0].host_role).toBe("production");
        await w.pool.query("update fork_arcane_environment set host_role='test' where id=$1", [env]);
        await rejects(w.pool.query("update fork_arcane_environment set host_role='runner' where id=$1", [env]), /fork_arcane_environment_host_role_ck/);
        await rejects(w.pool.query("update fork_arcane_environment set host_role='' where id=$1", [env]), /host_role_ck/);
    });

    it("E7 D43: RP status enum enforced in the DB; verified needs verified_at and no reason; failed needs a reason", async () => {
        const conn = await seedConnection(w.pool, org, "c-rp");
        const stack = await seedStack(w.pool, org, await seedEnvironment(w.pool, conn, null, null, "rp"), "rp-stack");
        for (const ok of ["incomplete", "pending_verification"]) {
            await w.pool.query("insert into fork_recovery_point (stack_id, stack_name, sequence, status) values ($1,'s',$2,$3)", [stack, Math.floor(Math.random() * 1e9), ok]);
        }
        await seedRp(w.pool, stack, {status: "verified", seq: 900});
        await rejects(w.pool.query("insert into fork_recovery_point (stack_id, stack_name, sequence, status) values ($1,'s',901,'restore_tested')", [stack]), /fork_recovery_point_status_ck/);
        await rejects(w.pool.query("insert into fork_recovery_point (stack_id, stack_name, sequence, status) values ($1,'s',902,'verified')", [stack]), /fork_recovery_point_verified_ck/);
        await rejects(w.pool.query("insert into fork_recovery_point (stack_id, stack_name, sequence, status, verified_at, downgrade_reason) values ($1,'s',903,'verified',now(),'fk_null')", [stack]), /fork_recovery_point_verified_ck/);
        await rejects(w.pool.query("insert into fork_recovery_point (stack_id, stack_name, sequence, status) values ($1,'s',904,'failed')", [stack]), /fork_recovery_point_failed_ck/);
        await w.pool.query("insert into fork_recovery_point (stack_id, stack_name, sequence, status, downgrade_reason) values ($1,'s',905,'failed','verify_failed')", [stack]);
        await rejects(w.pool.query("insert into fork_recovery_point (stack_id, stack_name, sequence) values ($1,'s',900)", [stack]), /fork_recovery_point_stack_seq_uq/); // monotonic-per-stack uniqueness
    });

    it("compose_project charset is enforced (safe for file names / HKDF info)", async () => {
        await rejects(w.pool.query("insert into fork_stack (organization_id, environment_name, compose_project, display_name) values ($1,'e','../etc','x')", [org]), /fork_stack_compose_project_ck/);
    });

    it("inventory: (stack, version) unique, version ≥ 1, 64-hex content hash", async () => {
        const stack = await seedStack(w.pool, org, null, "inv-stack");
        const ins = (v: number, h = "a".repeat(64)) => w.pool.query("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,$2,$3,'{}')", [stack, v, h]);
        await ins(1);
        await rejects(ins(1), /fork_stack_inventory_stack_version_uq/);
        await rejects(ins(0), /fork_stack_inventory_version_ck/);
        await rejects(ins(2, "xyz"), /fork_stack_inventory_hash_ck/);
    });

    it("D23: API key stored as KEK envelope only — canary absent from the row; DTO has no key; round trip works; copying the ciphertext to another row fails", async () => {
        const kek = await mkdtemp(path.join(os.tmpdir(), "w04-kekdir-"));
        const a = await insertConnectionWithSecret(w.db, {organizationId: org, name: "arcane-a", baseUrl: "https://a.lab", apiKey: CANARY}, kek);
        const b = await insertConnectionWithSecret(w.db, {organizationId: org, name: "arcane-b", baseUrl: "https://b.lab", apiKey: "other-key-value"}, kek);
        const raw = (await w.pool.query("select api_key_enc::text t, to_jsonb(c)::text whole from fork_arcane_connection c where id=$1", [a.id])).rows[0];
        expect(raw.whole).not.toContain(CANARY);
        const env = (await w.pool.query("select api_key_enc e from fork_arcane_connection where id=$1", [a.id])).rows[0].e;
        expect(Object.keys(env).sort()).toEqual(["ct", "iv", "kid", "tag"]);
        const dtos = await listConnectionDtos(w.db, org);
        expect(JSON.stringify(dtos)).not.toMatch(/apiKeyEnc|api_key_enc|ct"|tag"/);
        expect(await readConnectionApiKey(w.db, org, a.id, kek)).toBe(CANARY);
        // org scoping on the reader
        await expect(readConnectionApiKey(w.db, await seedOrg(w.pool), a.id, kek)).rejects.toThrow(/not found/);
        // swap a's ciphertext into b's row ⇒ AAD (row id) mismatch
        await w.pool.query("update fork_arcane_connection set api_key_enc = (select api_key_enc from fork_arcane_connection where id=$1) where id=$2", [a.id, b.id]);
        await expect(readConnectionApiKey(w.db, org, b.id, kek)).rejects.toThrow();
        await rm(kek, {recursive: true, force: true});
    });
});
