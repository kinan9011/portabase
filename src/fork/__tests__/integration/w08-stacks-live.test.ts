import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {ENV_MINIMUM} from "@/fork/arcane/endpoints";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import {syncConnection} from "@/fork/discovery/sync";
import {parseAllowlist} from "@/fork/net/guard";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {DEFAULT_PARAMS, parseStackListParams} from "@/fork/stacks/params";
import {loadStackDetail, loadStackList} from "@/fork/stacks/queries";

/**
 * LIVE W08 test (FORK_LAB=1, loopback lab only): the REAL discovery of the lab demo stack, read back through the W08 DTO loaders.
 * Lab recipe: see w07-discovery-live.test.ts (lab Arcane + demo `db web`, NOT seed.sh; a `lab_proxy` docker network must exist).
 */
const LAB = process.env.FORK_LAB === "1";
const URL_ = process.env.ARCANE_URL ?? "http://127.0.0.1:13552";
const ADMIN_USER = process.env.LAB_ARCANE_ADMIN_USER ?? "arcane";
const ADMIN_PASS = process.env.LAB_ARCANE_ADMIN_PASSWORD ?? "arcane-admin";

let w: W04Db; let token = ""; let keyId = ""; let org = ""; let kekDir = ""; let conn = "";
const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${URL_}/api${p}`, {method, headers: {"content-type": "application/json", authorization: `Bearer ${token}`}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, json: (await r.json().catch(() => ({}))) as {data?: {id?: string; key?: string}}};
};

describe.skipIf(!LAB)("W08 live: the Resources view matches the lab-discovered demo stack", () => {
    beforeAll(async () => {
        expect(["127.0.0.1", "localhost"]).toContain(new globalThis.URL(URL_).hostname);
        for (let i = 0; i < 2 && !token; i++) {
            const r = await fetch(`${URL_}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({username: ADMIN_USER, password: ADMIN_PASS})});
            if (r.status === 429) { await new Promise((res) => setTimeout(res, (Number(r.headers.get("retry-after")) || 60) * 1000)); continue; }
            token = ((await r.json()) as {data?: {token?: string}}).data?.token ?? "";
        }
        if (!token) throw new Error("lab admin login failed");
        const old = await api("GET", "/api-keys?limit=200");
        for (const k of (old.json.data as unknown as {id: string; name: string}[]) ?? []) if (k.name?.startsWith("forklab-w08-")) await api("DELETE", `/api-keys/${k.id}`);
        const perms = [{permission: "environments:list"}, ...ENV_MINIMUM.map((permission) => ({permission, environmentId: "0"}))];
        const m = await api("POST", "/api-keys", {name: "forklab-w08-view", description: "W08 live test, lab only", permissions: perms});
        if (m.status !== 200 || !m.json.data?.key) throw new Error(`key mint failed (${m.status})`);
        keyId = m.json.data.id as string;
        w = await freshForkDb();
        org = await seedOrg(w.pool, "solo");
        kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w08l-kek-")), "fork-kek");
        conn = (await insertConnectionWithSecret(w.db, {organizationId: org, name: "lab-arcane", baseUrl: URL_, apiKey: m.json.data.key}, kekDir)).id;
        await w.pool.query("insert into fork_arcane_environment (connection_id, external_id, name, enabled) values ($1,'0','local',true)", [conn]);
        const r = await syncConnection({db: w.db, kekDir, allowlist: parseAllowlist("127.0.0.1")}, conn, "manual", {userId: null});
        expect(r.kind).toBe("ran");
        if (r.kind === "ran") expect(r.run.status, JSON.stringify(r.run.environments)).toBe("ok");
    }, 240_000);
    afterAll(async () => {
        if (keyId) await api("DELETE", `/api-keys/${keyId}`).catch(() => undefined);
        await w?.drop();
    });

    it("list: the lab demo stack is there, running, unprotected, with the expected resource counts and a shared flag", async () => {
        const list = await loadStackList(w.db, org, parseStackListParams({q: "forklab-demo"}));
        const demo = list.items.find((i) => i.composeProject === "forklab-demo");
        expect(demo, `listed: ${list.items.map((i) => i.composeProject).join(",")}`).toBeDefined();
        expect(demo).toMatchObject({runtime: "running", protection: "unprotected", environmentName: "local", staleSince: null});
        // databases: 2 on purpose: the demo `web` service runs the same postgres image as a tool (psql), and the image-name heuristic is only a HINT (labelled as such in the UI)
        expect(demo!.inventory!.counts).toMatchObject({services: 2, volumes: 2, networks: 2, databases: 2});
        expect(demo!.inventory!.counts.binds).toBeGreaterThanOrEqual(1);
        expect(demo!.inventory!.counts.shared).toBeGreaterThanOrEqual(1);
        expect((await loadStackList(w.db, org, DEFAULT_PARAMS)).setup).toEqual({connected: true, enabledEnvironments: 1});
    });
    it("details: services db/web, named volumes pgdata/appdata, bind mounts, anonymous volume, stack-owned internal network, lab_proxy shared", async () => {
        const list = await loadStackList(w.db, org, parseStackListParams({q: "forklab-demo"}));
        const d = (await loadStackDetail(w.db, org, list.items.find((i) => i.composeProject === "forklab-demo")!.id))!;
        expect(d.inventory.state).toBe("ok");
        if (d.inventory.state !== "ok") return;
        const v = d.inventory.view;
        expect(v.services.map((s) => `${s.name}:${s.state}`).sort()).toEqual(["db:running", "web:running"]);
        expect(v.volumes.map((x) => x.name).sort()).toEqual(["forklab-demo_appdata", "forklab-demo_pgdata"]);
        expect(v.anonymousVolumes.length).toBe(1);
        expect(v.binds.map((b) => b.destination).length).toBeGreaterThanOrEqual(1);
        expect(v.binds.every((b) => b.rw === false)).toBe(true);
        expect(v.networks.find((n) => n.name === "forklab-demo_internal")).toMatchObject({classification: "stack_owned", members: ["db", "web"]});
        expect(v.networks.find((n) => n.name === "lab_proxy")).toMatchObject({classification: "shared_external", external: true});
        expect(v.shared.map((s) => s.name)).toContain("lab_proxy");
        expect(v.databases).toEqual([{service: "db", engine: "postgresql", basis: "image"}, {service: "web", engine: "postgresql", basis: "image"}]); // hint from the image name, see above
        expect(v.warnings.map((x) => x.code)).toEqual(expect.arrayContaining(["anonymous-volume-not-backed-up", "network-shared-external"]));
        // nothing secret in the DTO
        expect(JSON.stringify(d)).not.toMatch(/POSTGRES_PASSWORD|DB_PASSWORD|password|secret|token/i);
    });
});
