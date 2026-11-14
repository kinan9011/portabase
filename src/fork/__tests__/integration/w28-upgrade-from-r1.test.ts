import {randomUUID} from "node:crypto";
import {cp, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {recordAudit, verifyAuditChain} from "@/fork/audit";
import {runForkMigrations} from "@/fork/db/migrate";
import {MIGRATION_LEDGER} from "@/fork/db/migration-ledger";
import type {ForkDb} from "@/fork/db/handle";
import {decryptWith, encryptWith, getOrCreateKeyring, type ForkSecretAad, type Keyring} from "@/fork/kek";
import {contentHash} from "@/fork/inventory/schema";
import {loadStackDetail} from "@/fork/stacks/queries";
import {applyUpstreamMigrations, createTestDb, type TestDb} from "@/fork/__tests__/db-helpers";
import {richInventory} from "@/fork/__tests__/w08-fixtures";
import {seedAgent, seedBackup, seedChannel, seedEnvironment, seedOrg, seedProject, seedRp, seedArtifact, seedStack} from "@/fork/__tests__/w04-helpers";

/**
 * W28 — upgrade from the R1 build (git tag fork/w14b-done = 09729ac7, the build the pilot runs) to the current tree.
 * R1 = upstream journal up to 0093_daffy_satana + fork migrations 0000..0008_manifest_kit; the merged tree adds the upstream
 * 0094 (data-only) and fork migrations 0009..0016 (ALTERs on fork_stack, fork_recovery_point, fork_stack_policy, fork_stack_run).
 * Drives the REAL lane code against the REAL migration directories (the R1 dirs are journal-truncated copies of today's dirs;
 * fork migrations 0000..0008 are byte-identical on the tag, see the W28 plan). No literal past dates are compared with the clock.
 */
const R1_UPSTREAM_HEAD = "0093_daffy_satana";
const R1_FORK_HEAD = "0008_manifest_kit";
const R1_FORK_COUNT = 9;
const ARCANE_CANARY = "canary-arcane-key-W28";
const REAL_UP = path.join(process.cwd(), "src/db/migrations");
const REAL_FORK = path.join(process.cwd(), "src/fork/db/migrations");
const N = MIGRATION_LEDGER.length;

type Journal = {entries: {idx: number; when: number; tag: string}[]};

/** Copies a migrations dir and truncates its journal after `headTag` (throws when the tag is absent: guards silent renumbering). */
async function snapshotDir(src: string, headTag: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "w28-mig-"));
    await cp(src, dir, {recursive: true});
    const jp = path.join(dir, "meta/_journal.json");
    const j = JSON.parse(await readFile(jp, "utf8")) as Journal;
    const at = j.entries.findIndex((e) => e.tag === headTag);
    if (at < 0) throw new Error(`journal has no entry ${headTag}`);
    j.entries = j.entries.slice(0, at + 1);
    await writeFile(jp, JSON.stringify(j));
    return dir;
}

type TableSnap = {columns: string[]; rows: string[]};
const hashRow = (o: Record<string, unknown>, cols: string[]) => createHash("sha256").update(JSON.stringify(cols.map((c) => [c, o[c] ?? null]))).digest("hex");

async function snapshotAll(pool: TestDb["pool"]): Promise<Record<string, TableSnap>> {
    const tabs = (await pool.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")).rows.map((r) => r.table_name as string);
    const out: Record<string, TableSnap> = {};
    for (const t of tabs) {
        const cols = (await pool.query("select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by column_name", [t])).rows.map((r) => r.column_name as string);
        const rows = (await pool.query(`select to_jsonb(x) j from "${t}" x`)).rows.map((r) => hashRow(r.j as Record<string, unknown>, cols));
        out[t] = {columns: cols, rows: rows.sort()};
    }
    return out;
}
/** Re-hashes the CURRENT rows of a table projected onto the columns it had at R1. */
async function projected(pool: TestDb["pool"], table: string, cols: string[]): Promise<string[]> {
    const rows = (await pool.query(`select to_jsonb(x) j from "${table}" x`)).rows.map((r) => hashRow(r.j as Record<string, unknown>, cols));
    return rows.sort();
}

let t: TestDb;
let ring: Keyring;
let ringDir: string;
let r1Up: string;
let r1Fork: string;
beforeEach(async () => {
    t = await createTestDb();
    ringDir = await mkdtemp(path.join(os.tmpdir(), "w28-kek-"));
    ring = await getOrCreateKeyring(ringDir);
    r1Up = await snapshotDir(REAL_UP, R1_UPSTREAM_HEAD);
    r1Fork = await snapshotDir(REAL_FORK, R1_FORK_HEAD);
});
afterEach(async () => {
    await t.drop();
    await Promise.all([r1Up, r1Fork, ringDir].map((d) => rm(d, {recursive: true, force: true})));
});

const dev = {NODE_ENV: "development"};
const prod = {NODE_ENV: "production", FORK_MIGRATE_DUMP: "required"};
const forkRows = async () => Number((await t.pool.query("select count(*) c from drizzle.__fork_migrations")).rows[0].c);
const upRows = async () => Number((await t.pool.query("select count(*) c from drizzle.__drizzle_migrations")).rows[0].c);
const exists = async (rel: string) => (await t.pool.query("select to_regclass($1) as t", [rel])).rows[0].t !== null;

/** Builds an R1-shaped database and returns the ids needed by the assertions. */
async function buildR1() {
    await applyUpstreamMigrations(t.pool, r1Up);
    const lane = await runForkMigrations({databaseUrl: t.url, upstreamDir: r1Up, forkDir: r1Fork, env: dev});
    expect(lane).toMatchObject({state: "applied", appliedNow: R1_FORK_COUNT, total: R1_FORK_COUNT});
    expect(await forkRows()).toBe(R1_FORK_COUNT);

    const p = t.pool;
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const org = await seedOrg(p, "w28-org");
    const project = await seedProject(p, org, "w28-project");
    const agent = await seedAgent(p, org, "w28-agent");
    const channel = await seedChannel(p, org, "w28-chan");
    const bk = await seedBackup(p, agent, channel);
    await p.query("insert into databases (name, dbms, agent_id, project_id) values ('w28-vol','docker-volume',$1,$2)", [agent, project]);

    const connId = randomUUID();
    const aad: ForkSecretAad = {table: "fork_arcane_connection", rowId: connId, column: "api_key_enc"};
    await p.query("insert into fork_arcane_connection (id, organization_id, name, base_url, api_key_enc, pinned_api_version, created_at) values ($1,$2,'arcane','https://arcane.w28.invalid',$3,'v2.17.3',$4)",
        [connId, org, JSON.stringify(encryptWith(ring, ARCANE_CANARY, aad)), ago(48)]);
    const env = await seedEnvironment(p, connId, agent, "w28-agent");
    const stack = await seedStack(p, org, env, "w28demo", project, "w28-project");
    const inv = richInventory({project: "w28demo"});
    await p.query("insert into fork_stack_inventory (stack_id, version, content_hash, inventory, discovered_at) values ($1,1,$2,$3,$4)", [stack, contentHash(inv), JSON.stringify(inv), ago(24)]);
    await p.query("update fork_stack set protection_state='active', runtime_state='running' where id=$1", [stack]);
    await p.query("insert into fork_stack_policy (stack_id, activated_at, activated_by, activation, schedule, consistency_profile, materialize_state) values ($1,$2,'w28-user','{\"by\":\"w28\"}','{\"cron\":\"0 2 * * *\"}','dump','ready')", [stack, ago(23)]);
    const hash = "a".repeat(64);
    const src = (await p.query("insert into fork_stack_source (stack_id, role, resource_key, status, database_id, dbms, member_name, desired_hash) values ($1,'db','db:pg','active',$2,'postgresql','pg',$3) returning id", [stack, bk.databaseId, hash])).rows[0].id as string;
    const run = (await p.query("insert into fork_stack_run (stack_id, trigger, state, started_at, finished_at) values ($1,'schedule','succeeded',$2,$3) returning id", [stack, ago(2), ago(1)])).rows[0].id as string;
    await p.query("insert into fork_stack_run_item (run_id, stack_source_id, backup_id, source_name, dbms, state, finished_at) values ($1,$2,$3,'pg','postgresql','succeeded',$4)", [run, src, bk.backupId, ago(1)]);
    const rp = await seedRp(p, stack, {status: "verified", seq: 1, required: 2});
    await p.query("update fork_recovery_point set run_id=$2 where id=$1", [rp, run]);
    await seedArtifact(p, rp, {backupId: bk.backupId, backupStorageId: bk.backupStorageId, channelId: channel});
    await seedArtifact(p, rp, {backupId: bk.backupId, backupStorageId: bk.backupStorageId, channelId: channel});
    await p.query("insert into fork_kit (fingerprint, signing_kid, kek_kids, types, status, issued_by, verified_at, verified_type, issued_at) values ($1,'abcdef012345','{k1}','{postgresql}','verified','w28-user',$2,'paper',$3)", [hash, ago(5), ago(6)]);
    await p.query("insert into fork_trust_anchor (kid, public_key_pem, fingerprint) values ('abcdef012345','-----BEGIN PUBLIC KEY-----\nw28\n-----END PUBLIC KEY-----',$1)", [hash]);
    await p.query("insert into fork_alert_state (stack_id, kind, active, epoch, since) values ($1,'stale',true,1,$2)", [stack, ago(3)]);
    await p.query("insert into fork_schedule_state (stack_id, last_scheduled_at, last_run_status, last_verified_rp_at) values ($1,$2,'success',$3)", [stack, ago(2), ago(1)]);

    const db = drizzle({client: p}) as unknown as ForkDb;
    for (let i = 0; i < 3; i++) await recordAudit(db, {organizationId: org, actorUserId: "w28-user", action: "fork.w28.seed", resourceType: "stack", resourceId: `r${i}`, result: "success", details: {i}, now: ago(10 - i)});
    return {db, org, stack, rp, connId, aad};
}

describe("W28: upgrade from the R1 build (fork/w14b-done) to the merged tree", () => {
    it("gates on the new upstream migration, dumps first, applies the R2 lane and preserves every R1 row", async () => {
        const w = await buildR1();
        expect(await upRows()).toBe(94);
        expect(await verifyAuditChain(w.db)).toEqual({ok: true, checked: 3});
        const before = await snapshotAll(t.pool);
        expect(Object.keys(before)).not.toContain("fork_restore_run");

        // 4. real dirs, upstream 0094 not yet applied => the fork lane must not run, must not dump
        const dump = vi.fn(async () => "/x/w28.dump");
        const gated = await runForkMigrations({databaseUrl: t.url, env: prod, dump});
        expect(gated.state).toBe("skipped-upstream-incomplete");
        expect(gated.detail).toMatch(/^1\/\d+ upstream migrations not applied$/);
        expect(dump).not.toHaveBeenCalled();
        expect(await forkRows()).toBe(R1_FORK_COUNT);

        // 5. upgrade: upstream first, then the lane; the dump happens BEFORE any new ledger row
        await applyUpstreamMigrations(t.pool);
        expect(await upRows()).toBeGreaterThanOrEqual(95);
        const order: number[] = [];
        const dump2 = vi.fn(async () => { order.push(await forkRows()); return "/x/w28.dump"; });
        const up = await runForkMigrations({databaseUrl: t.url, env: prod, dump: dump2});
        expect(up).toMatchObject({state: "applied", appliedNow: N - R1_FORK_COUNT, total: N});
        expect(dump2).toHaveBeenCalledTimes(1);
        expect(order).toEqual([R1_FORK_COUNT]);
        expect(await forkRows()).toBe(N);
        expect(N).toBe(19); // W22a added 0018_mirror (was 18)

        // 6. preservation: R1 columns of every R1 row byte-identical, counts equal
        for (const [table, s] of Object.entries(before)) {
            if (!table.startsWith("fork_") && !["organization", "projects", "agents", "databases", "backups", "backup_storage", "storage_channel"].includes(table)) continue;
            expect(await projected(t.pool, table, s.columns), `table ${table}`).toEqual(s.rows);
        }
        const afterAll = await snapshotAll(t.pool);
        for (const [table, s] of Object.entries(before)) {
            if (table === "apikey") continue; // upstream 0094 is a data-only UPDATE on apikey
            expect(afterAll[table].rows.length, `row count ${table}`).toBe(s.rows.length);
        }

        // new columns hold their declared defaults / NULL
        const stackRow = (await t.pool.query("select contains_personal_data, test_restore_opt_in_at, test_restore_opt_in_by from fork_stack where id=$1", [w.stack])).rows[0];
        expect(stackRow).toEqual({contains_personal_data: null, test_restore_opt_in_at: null, test_restore_opt_in_by: null});
        const pol = (await t.pool.query("select quiesce_enabled, quiesce_services, quiesce_max_stop_seconds, quiesce_enabled_by, quiesce_enabled_at from fork_stack_policy where stack_id=$1", [w.stack])).rows[0];
        expect(pol).toEqual({quiesce_enabled: false, quiesce_services: [], quiesce_max_stop_seconds: 600, quiesce_enabled_by: null, quiesce_enabled_at: null});
        const run = (await t.pool.query("select quiesce_state, quiesce_reason, quiesce_task_id, quiesce_start_task_id, quiesce_stopped_at, quiesce_release_at, quiesce_release_reason, quiesce_result from fork_stack_run")).rows[0];
        expect(Object.values(run).every((v) => v === null)).toBe(true);
        // new R2 tables exist and are empty
        for (const tbl of ["fork_agent_enrollment", "fork_agent_hash_report", "fork_agent_task", "fork_restore_plan", "fork_compose_render", "fork_restore_override", "fork_restore_run", "fork_restore_run_task", "fork_test_restore_schedule"]) {
            expect(await exists(`public.${tbl}`), tbl).toBe(true);
            expect(Number((await t.pool.query(`select count(*) c from ${tbl}`)).rows[0].c), tbl).toBe(0);
        }
        // re-run is a no-op
        expect(await runForkMigrations({databaseUrl: t.url, env: prod, dump: dump2})).toMatchObject({state: "applied", appliedNow: 0, total: N});
        expect(dump2).toHaveBeenCalledTimes(1);
    });

    it("app-level reads on the upgraded database: KEK secret decrypts, audit chain verifies, stack + recovery point load", async () => {
        const w = await buildR1();
        await applyUpstreamMigrations(t.pool);
        const lane = await runForkMigrations({databaseUrl: t.url, env: {NODE_ENV: "production", FORK_MIGRATE_DUMP: "off"}});
        expect(lane).toMatchObject({state: "applied", total: N});

        const row = (await t.pool.query("select api_key_enc from fork_arcane_connection where id=$1", [w.connId])).rows[0];
        expect(decryptWith(ring, row.api_key_enc, w.aad)).toBe(ARCANE_CANARY);
        expect(() => decryptWith(ring, row.api_key_enc, {...w.aad, column: "other"})).toThrow(); // wrong AAD

        expect(await verifyAuditChain(w.db)).toEqual({ok: true, checked: 3});
        const audit = (await t.pool.query("select to_jsonb(e)::text t from fork_audit_event e")).rows.map((r) => r.t).join("\n");
        expect(audit).not.toContain(ARCANE_CANARY); // the secret exists only decrypted, in process

        const detail = await loadStackDetail(w.db, w.org, w.stack, {now: new Date()});
        expect(detail).toMatchObject({id: w.stack, composeProject: "w28demo"});
        expect(detail!.inventory.state).toBe("ok");
        expect((await t.pool.query("select status from fork_recovery_point where id=$1", [w.rp])).rows[0].status).toBe("verified");
    });
});
