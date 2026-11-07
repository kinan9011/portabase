import {readFileSync} from "node:fs";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {ENV_MINIMUM} from "@/fork/arcane/endpoints";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import {syncConnection} from "@/fork/discovery/sync";
import {parseAllowlist} from "@/fork/net/guard";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";

/**
 * LIVE W07 test against the disposable lab (`dev/fork-lab`, loopback only). Skipped unless FORK_LAB=1:
 *   cd dev/fork-lab && docker compose --env-file .env.lab -f compose.arcane.yml up -d arcane
 *   docker compose -f demo-stack/compose.yml -f demo-stack/compose.override.yml up -d db web      # NOT seed.sh (rewrites tracked uploads/)
 *   FORK_LAB=1 FORK_TEST_DATABASE_URL=… pnpm test:fork discovery-live
 * The lab ADMIN login only mints/deletes scoped keys; every Arcane call of the sync is a GET through the real client + pinned transport.
 */
const LAB = process.env.FORK_LAB === "1";
const URL_ = process.env.ARCANE_URL ?? "http://127.0.0.1:13552";
const ADMIN_USER = process.env.LAB_ARCANE_ADMIN_USER ?? "arcane";
const ADMIN_PASS = process.env.LAB_ARCANE_ADMIN_PASSWORD ?? "arcane-admin";
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);

let w: W04Db;
let token = "";
let keyId = "";
let key = "";
let conn = "";
const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${URL_}/api${p}`, {method, headers: {"content-type": "application/json", authorization: `Bearer ${token}`}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, json: (await r.json().catch(() => ({}))) as {data?: {id?: string; key?: string}}};
};

describe.skipIf(!LAB)("W07 live: discovery sync of the lab demo stack", () => {
    beforeAll(async () => {
        expect(["127.0.0.1", "localhost"]).toContain(new globalThis.URL(URL_).hostname); // lab only, never a real Arcane
        for (let i = 0; i < 2 && !token; i++) {
            const r = await fetch(`${URL_}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({username: ADMIN_USER, password: ADMIN_PASS})});
            if (r.status === 429) { await new Promise((res) => setTimeout(res, (Number(r.headers.get("retry-after")) || 60) * 1000)); continue; }
            token = ((await r.json()) as {data?: {token?: string}}).data?.token ?? "";
        }
        if (!token) throw new Error("lab admin login failed (lab Arcane up? default admin unchanged?)");
        const old = await api("GET", "/api-keys?limit=200");
        for (const k of (old.json.data as unknown as {id: string; name: string}[]) ?? []) if (k.name?.startsWith("forklab-w07-")) await api("DELETE", `/api-keys/${k.id}`);
        const perms = [{permission: "environments:list"}, ...ENV_MINIMUM.map((permission) => ({permission, environmentId: "0"}))];
        const m = await api("POST", "/api-keys", {name: "forklab-w07-sync", description: "W07 live test, lab only", permissions: perms});
        if (m.status !== 200 || !m.json.data?.key) throw new Error(`key mint failed (${m.status})`);
        keyId = m.json.data.id as string;
        key = m.json.data.key;
        w = await freshForkDb();
        const org = await seedOrg(w.pool, "solo");
        const kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w07l-kek-")), "fork-kek");
        conn = (await insertConnectionWithSecret(w.db, {organizationId: org, name: "lab-arcane", baseUrl: URL_, apiKey: key}, kekDir)).id;
        await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled) values ($1,'0','local',true)", [conn]);
        (globalThis as {__w07kek?: string}).__w07kek = kekDir;
    }, 180_000);
    afterAll(async () => {
        if (keyId) await api("DELETE", `/api-keys/${keyId}`).catch(() => undefined);
        await w?.drop();
    });
    const deps = () => ({db: w.db, kekDir: (globalThis as {__w07kek?: string}).__w07kek, allowlist: parseAllowlist("127.0.0.1")});

    it("the demo stack is discovered with the expected services, volumes, binds, networks; shared lab_proxy is flagged", async () => {
        const r = await syncConnection(deps(), conn, "manual", {userId: null});
        expect(r.kind).toBe("ran");
        if (r.kind !== "ran") return;
        expect(r.run.status, JSON.stringify(r.run.environments)).toBe("ok");
        const rows = (await q("select s.compose_project, s.runtime_state, i.version, i.inventory inv from fork_stack s join fork_stack_inventory i on i.stack_id = s.id order by 1")).rows;
        const demo = rows.find((x) => x.compose_project === "forklab-demo");
        expect(demo, `discovered: ${rows.map((x) => x.compose_project).join(",")}`).toBeDefined();
        expect(demo).toMatchObject({runtime_state: "running", version: 1});
        const inv = demo.inv;
        expect(inv.services.map((s: {name: string; state: string}) => `${s.name}:${s.state}`)).toEqual(["db:running", "web:running"]);
        expect(inv.services.find((s: {name: string}) => s.name === "db")).toMatchObject({database_hint: {engine: "postgresql", basis: "image"}, image: {pinned: true}});
        expect(inv.services.find((s: {name: string}) => s.name === "web").ports).toContainEqual({target: 8080, published: 18080, protocol: "tcp"});
        const named = inv.mounts.filter((m: {kind: string}) => m.kind === "named_volume").map((m: {volume_name: string}) => m.volume_name).sort();
        expect(named).toEqual(["forklab-demo_appdata", "forklab-demo_pgdata"]);
        const binds = inv.mounts.filter((m: {kind: string}) => m.kind === "bind").map((m: {host_path_hint: string; rw: boolean}) => `${path.basename(m.host_path_hint)}:${m.rw}`).sort();
        expect(binds).toEqual(["handle.sh:false", "serve.sh:false", "uploads:false"]);
        expect(inv.mounts.some((m: {kind: string}) => m.kind === "anonymous_volume")).toBe(true);
        expect(inv.warnings.map((x: {code: string}) => x.code)).toEqual(expect.arrayContaining(["anonymous-volume-not-backed-up", "network-shared-external", "bind-mount-host-path"]));
        expect(inv.networks.find((n: {name: string}) => n.name === "forklab-demo_internal")).toMatchObject({classification: "stack_owned", external: false, members: ["db", "web"]});
        expect(inv.networks.find((n: {name: string}) => n.name === "lab_proxy")).toMatchObject({classification: "shared_external", external: true, members: ["web"]});
        expect(inv.external_dependencies).toContainEqual({kind: "network", name: "lab_proxy", note_key: "network-external-shared"});
        expect(inv.source).toMatchObject({arcane_version: "2.17.3", environment_id: "0"});
        expect(inv.stack).toMatchObject({compose_read: "none", display_name: "forklab-demo"});
        expect(r.run.totals.found).toBeGreaterThanOrEqual(1);
    }, 120_000);

    it("a second sync creates no new version", async () => {
        const r = await syncConnection(deps(), conn, "manual", {userId: null});
        expect(r.kind).toBe("ran");
        expect((await q("select count(*)::int c, max(version) v from fork_stack_inventory i join fork_stack s on s.id=i.stack_id where s.compose_project='forklab-demo'")).rows[0]).toEqual({c: 1, v: 1});
    }, 60_000);

    it("canary: the lab stack.env VALUES (read at test time, never printed) appear nowhere in the fork DB, audit or the Arcane key", async () => {
        const values = readFileSync(path.join(process.cwd(), "dev/fork-lab/demo-stack/stack.env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => l.slice(l.indexOf("=") + 1).trim()).filter((v) => v.length >= 8); // 4-char values (db/user names such as "demo") collide with legitimate words like the stack name; the secrets are 27+ chars
        expect(values.length).toBeGreaterThanOrEqual(2);
        const tables = (await q("select table_name t from information_schema.tables where table_schema='public' and table_name like 'fork\\_%'")).rows.map((r) => r.t as string);
        let dump = "";
        for (const t of tables) dump += (await q(`select coalesce(string_agg(row_to_json(x)::text, E'\\n'), '') s from "${t}" x`)).rows[0].s;
        expect(dump.length).toBeGreaterThan(1000);
        const leaked = values.filter((v) => dump.includes(v));
        expect(leaked.length, "stack.env values found in the fork database").toBe(0);
        expect(dump.includes(key)).toBe(false);
    }, 60_000);
});
