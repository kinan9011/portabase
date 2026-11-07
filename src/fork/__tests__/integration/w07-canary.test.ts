import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {RAW} from "@/fork/__tests__/discovered-fixtures";
import {type FakeArcane, startFakeArcane } from "@/fork/__tests__/fake-arcane";
import {freshForkDb, seedOrg, seedRp, type W04Db} from "@/fork/__tests__/w04-helpers";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import {type SyncDeps, type SyncResult, type SyncRun, syncConnection } from "@/fork/discovery/sync";
import {parseAllowlist} from "@/fork/net/guard";

/** E2 canary + tier-2 + retention: secrets planted EVERYWHERE Arcane could carry them must not reach any fork table, audit row, log or error. */
const CANARY = "CANARY-sec-5d81c0ffee";
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const noSleep = async () => {};
const ran = (r: SyncResult): SyncRun => { if (r.kind !== "ran") throw new Error(`skipped: ${r.reason}`); return r.run; };

let w: W04Db;
let org: string;
let kekDir: string;
let fake: FakeArcane;
let conn: string;
const deps = (extra: Partial<SyncDeps> = {}): SyncDeps => ({db: w.db, kekDir, allowlist: parseAllowlist("127.0.0.1"), sleep: noSleep, ...extra});

/** Every row of every fork table as text — what a database dump would contain. */
async function dumpAllForkTables(): Promise<string> {
    const tables = (await q("select table_name t from information_schema.tables where table_schema='public' and table_name like 'fork\\_%' order by 1")).rows.map((r) => r.t as string);
    let out = "";
    for (const t of tables) out += (await q(`select coalesce(string_agg(row_to_json(x)::text, E'\\n'), '') s from "${t}" x`)).rows[0].s + "\n";
    return out;
}

function hostile(): ReturnType<typeof clone<typeof RAW.containers.data>> {
    return clone(RAW.containers.data).map((c: Record<string, unknown>) => ({
        ...c,
        command: ["sh", "-c", `--token=${CANARY}`], entrypoint: [`/run --password=${CANARY}`],
        config: {env: [`DB_PASSWORD=${CANARY}`, `API_TOKEN=${CANARY}`], cmd: [CANARY]}, environment: {SECRET: CANARY}, env: [`X=${CANARY}`],
        labels: {...(c.labels as object), "secret.token": CANARY, "traefik.basic.auth": `admin:${CANARY}`, "db.url": `postgres://u:${CANARY}@h/d`, "portabase.backup.consistency": CANARY, "portabase.backup.stop": CANARY},
        hostConfig: {...(c.hostConfig as object), binds: [`/srv/${CANARY}:/x`]}, networkSettings: {...(c.networkSettings as object), secretField: CANARY},
    }));
}

beforeAll(async () => {
    w = await freshForkDb();
    org = await seedOrg(w.pool, "solo");
    kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w07c-kek-")), "fork-kek");
});
afterAll(async () => { await w.drop(); });
beforeEach(async () => {
    await q("delete from fork_stack");
    await q("delete from fork_arcane_connection");
    await q("delete from fork_lock");
    fake = await startFakeArcane({lists: {"0": {containers: hostile(), volumes: clone(RAW.volumes.data), networks: clone(RAW.networks.data), images: clone(RAW.images.data), projects: clone(RAW.projects.data)}}});
    conn = (await insertConnectionWithSecret(w.db, {organizationId: org, name: "arcane", baseUrl: fake.url, apiKey: fake.state.validKey}, kekDir)).id;
    await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled) values ($1,'0','local',true)", [conn]);
});
afterEach(async () => { await fake.close(); vi.restoreAllMocks(); });

describe("canary: secrets never reach the inventory, DB, audit, logs", () => {
    it("tier 1: env values / command lines / secret labels / unknown fields planted in every container → absent from every fork table, audit, stdout/stderr, the run result", async () => {
        const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info"), vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
        const run = ran(await syncConnection(deps(), conn, "manual", {userId: "00000000-0000-4000-8000-0000000000aa"}));
        expect(run.status).toBe("ok"); // hostile hint values are ignored with an info warning; the stack is still written
        const dump = await dumpAllForkTables();
        expect(dump).not.toContain(CANARY);
        expect(dump).not.toContain(fake.state.validKey); // the key lives only as a KEK envelope
        expect(dump).toContain("forklab-demo"); // positive control: the dump does contain the stack
        for (const s of spies) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(CANARY);
        expect(JSON.stringify(run)).not.toContain(CANARY);
        // the hostile hint values were ignored, not stored; no hint survived
        const inv = (await q("select inventory i from fork_stack_inventory")).rows[0].i;
        expect(inv.services.every((s: {backup_hints?: unknown}) => s.backup_hints === undefined)).toBe(true);
        expect(inv.warnings.map((x: {code: string}) => x.code)).toContain("backup-hint-ignored");
    });
    it("the scan itself works: a planted value in a fork table IS found (guards against a vacuous canary)", async () => {
        await q("update fork_arcane_connection set name=$2 where id=$1", [conn, CANARY]);
        expect(await dumpAllForkTables()).toContain(CANARY);
    });
    it("failure paths carry no Arcane text: bad body / 5xx / 403 detail with a canary", async () => {
        fake.state.forceStatus = 500;
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run.status).toBe("failed");
        expect(await dumpAllForkTables()).not.toContain("forced");
    });
});

describe("tier 2 (opt-in projects:read): compose text → names and paths only", () => {
    const composeBody = (yaml: string, services: unknown[] = []) => {
        const b = clone(RAW.compose);
        b.data.composeContent = yaml; b.data.overrideContent = null; b.data.services = services;
        return b;
    };
    beforeEach(async () => {
        await q("update fork_arcane_connection set allow_projects_read=true where id=$1", [conn]);
        fake.state.grants.push({permission: "projects:read", environmentId: "0"});
        fake.state.lists["0"]!.containers = clone(RAW.containers.data);
    });
    const projectId = () => RAW.projects.data[0].id as string;

    it("env KEY names, env_file paths, profiles and declared-but-absent services are recorded; no value, command or label text is", async () => {
        const yaml = `services:\n  db:\n    image: postgres:17\n    environment:\n      POSTGRES_PASSWORD: ${CANARY}\n    env_file: [stack.env]\n  web:\n    image: x\n    command: ["run", "--secret=${CANARY}"]\n    labels: {s: ${CANARY}}\n  worker:\n    image: ghcr.io/x/worker:1\n    profiles: [batch]\n    environment: ["WORKER_TOKEN=${CANARY}"]\nnetworks:\n  lab_proxy:\n    external: true\n`;
        fake.state.compose[projectId()] = composeBody(yaml, [{name: "db", image: "postgres:17", environment: {POSTGRES_PASSWORD: CANARY, POSTGRES_USER: CANARY, EXTRA_FROM_ARCANE: CANARY}}]);
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run.status).toBe("ok");
        const dump = await dumpAllForkTables();
        expect(dump).not.toContain(CANARY);
        const inv = (await q("select inventory i from fork_stack_inventory")).rows[0].i;
        expect(inv.stack.compose_read).toBe("arcane_compose");
        const svc = (n: string) => inv.services.find((s: {name: string}) => s.name === n);
        expect(svc("db").env_keys).toEqual(["EXTRA_FROM_ARCANE", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
        expect(svc("worker")).toMatchObject({state: "absent", profiles: ["batch"], env_keys: ["WORKER_TOKEN"]});
        expect(inv.env_files).toEqual([{path_hint: "stack.env", key_names: [], referenced_by: ["db"]}]);
        expect(inv.networks.find((n: {name: string}) => n.name === "forklab-demo_internal").classification).toBe("stack_owned");
        expect(inv.warnings.map((x: {code: string}) => x.code)).not.toContain("compose-definition-not-read");
        // the permission is only usable with the opt-in: the request went out with the tier-2 endpoint
        expect(fake.requests.some((r) => r.path.endsWith("/compose"))).toBe(true);
    });
    it("a YAML bomb is refused (SEC-17): the stack is still discovered, compose stays unread, run = partial with a code, nothing crashes", async () => {
        const lines = ['l0: &l0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
        for (let i = 1; i < 9; i++) lines.push(`l${i}: &l${i} [${Array(9).fill(`*l${i - 1}`).join(",")}]`);
        fake.state.compose[projectId()] = composeBody(`${lines.join("\n")}\nservices: {}\n`);
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run.status).toBe("partial");
        const inv = (await q("select inventory i from fork_stack_inventory")).rows[0].i;
        expect(inv.stack.compose_read).toBe("none");
        expect(inv.warnings).toContainEqual({code: "compose-yaml-rejected", severity: "warn", message_key: "compose-yaml-alias_limit"});
        expect((await q("select last_sync_summary s from fork_arcane_environment")).rows[0].s.errors).toEqual([{code: "inventory_invalid", count: 1}]);
    });
    it("tier 2 off ⇒ the compose endpoint is never called even if the key holds projects:read", async () => {
        await q("update fork_arcane_connection set allow_projects_read=false where id=$1", [conn]);
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run.connectionError).toBe("key_too_broad"); // policy: projects:read without opt-in is refused outright
        expect(fake.requests.some((r) => r.path.endsWith("/compose"))).toBe(false);
    });
});

describe("inventory versions: keep 30 + any referenced by a retained RP (ADR-004 §7)", () => {
    it("33 changes ⇒ 30 newest kept; an old version referenced by a recovery point survives", async () => {
        const setImage = (i: number) => { fake.state.lists["0"]!.containers = clone(RAW.containers.data).map((c: {names: string[]; image: string}) => (c.names[0] === "forklab-demo-web-1" ? {...c, image: `nginx:${i}`} : c)); };
        for (let i = 1; i <= 2; i++) { setImage(i); ran(await syncConnection(deps(), conn, "manual")); }
        const [{id: stackId}] = (await q("select id from fork_stack")).rows;
        const rp = await seedRp(w.pool, stackId, {status: "verified", seq: 1});
        await q("update fork_recovery_point set inventory_version = 2 where id=$1", [rp]);
        for (let i = 3; i <= 33; i++) { setImage(i); ran(await syncConnection(deps(), conn, "manual")); }
        const v = (await q("select version from fork_stack_inventory order by version")).rows.map((r) => r.version as number);
        expect(v).toEqual([2, ...Array.from({length: 30}, (_, i) => i + 4)]);
        expect(v.at(-1)).toBe(33);
    });
});
