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
 * LIVE W09 test (FORK_LAB=1, loopback lab only): the REAL discovery of the lab demo stack, read back through the W09 protection/configuration views.
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

describe.skipIf(!LAB)("W09 live: completeness + protection on REAL lab-discovered stacks", () => {
    beforeAll(async () => {
        expect(["127.0.0.1", "localhost"]).toContain(new globalThis.URL(URL_).hostname);
        for (let i = 0; i < 2 && !token; i++) {
            const r = await fetch(`${URL_}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({username: ADMIN_USER, password: ADMIN_PASS})});
            if (r.status === 429) { await new Promise((res) => setTimeout(res, (Number(r.headers.get("retry-after")) || 60) * 1000)); continue; }
            token = ((await r.json()) as {data?: {token?: string}}).data?.token ?? "";
        }
        if (!token) throw new Error("lab admin login failed");
        const old = await api("GET", "/api-keys?limit=200");
        for (const k of (old.json.data as unknown as {id: string; name: string}[]) ?? []) if (k.name?.startsWith("forklab-w09-")) await api("DELETE", `/api-keys/${k.id}`);
        const perms = [{permission: "environments:list"}, ...ENV_MINIMUM.map((permission) => ({permission, environmentId: "0"}))];
        const m = await api("POST", "/api-keys", {name: "forklab-w09-view", description: "W09 live test, lab only", permissions: perms});
        if (m.status !== 200 || !m.json.data?.key) throw new Error(`key mint failed (${m.status})`);
        keyId = m.json.data.id as string;
        w = await freshForkDb();
        org = await seedOrg(w.pool, "solo");
        kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w09l-kek-")), "fork-kek");
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

    const detail = async (project: string) => {
        const list = await loadStackList(w.db, org, parseStackListParams({q: project}));
        const item = list.items.find((i) => i.composeProject === project);
        expect(item, `listed: ${list.items.map((i) => i.composeProject).join(",")}`).toBeDefined();
        const d = (await loadStackDetail(w.db, org, item!.id))!;
        if (d.inventory.state !== "ok") throw new Error("inventory not ok");
        return d.inventory;
    };

    it("forklab-demo: real discovery ⇒ NOT complete; the gaps discovery can see are listed; nothing is claimed captured or protected", async () => {
        const inv = await detail("forklab-demo");
        expect(inv.protection.primary).toBe("unprotected");
        expect(inv.protection.complete).toBe(false);
        const items = inv.configuration.items;
        expect(items.every((i) => i.status !== "captured")).toBe(true);
        expect(items.some((i) => i.kind === "anonymous_volume" && i.status === "missing")).toBe(true); // postgres image VOLUME
        expect(items.filter((i) => i.kind === "bind").length).toBeGreaterThanOrEqual(3); // serve.sh, handle.sh, uploads
        expect(items.some((i) => i.kind === "volume" && i.name === "forklab-demo_pgdata" && i.status === "missing")).toBe(true);
        expect(items.some((i) => i.kind === "network" && i.name === "lab_proxy" && i.status === "external")).toBe(true);
        expect(items.some((i) => i.kind === "database" && i.name === "db" && i.status === "missing")).toBe(true);
        expect(items.some((i) => i.reason === "env_files_undetermined")).toBe(true); // tier 1: compose not read
        expect(items.some((i) => i.kind === "compose_file")).toBe(true);
        expect(inv.protection.counts.blockers).toBeGreaterThan(3);
    });

    it("forklab-gaps: local image, anonymous volume, external volume + network, privileged / host network / Docker socket, unreadable bind — all surfaced", async () => {
        const inv = await detail("forklab-gaps");
        const items = inv.configuration.items;
        // KNOWN LIMIT (found live in W09, W07 heuristic): this Docker (29, containerd image store) reports a repo digest even for a
        // locally built image, so tier-1 `built_locally` (= "no repo digest") is a false negative here. Only the compose `build:` key
        // (tier 2) or an agent `image inspect` (W10) is reliable. Pinned so a change is noticed; the validator rule itself is covered by fixtures.
        expect(items.find((i) => i.kind === "image")).toBeUndefined();
        expect(items.find((i) => i.kind === "anonymous_volume")).toMatchObject({status: "missing", reason: "anonymous_volume"});
        expect(items.find((i) => i.kind === "volume" && i.name === "lab_shared_media")).toMatchObject({status: "external", reason: "external_volume"});
        expect(items.find((i) => i.kind === "network" && i.name === "lab_proxy")).toMatchObject({status: "external"});
        const codes = inv.configuration.directives.map((d) => d.code);
        expect(codes).toEqual(expect.arrayContaining(["host_network", "docker_socket"]));
        // KNOWN LIMIT (found live in W09): the Arcane container LIST does not carry HostConfig.Privileged, so a privileged container is not
        // reported at tier 1 (the validator rule is covered by fixtures; an agent `inspect` probe, W10, closes it). Pinned so a change is noticed.
        expect(codes).not.toContain("privileged");
        // the chmod-000 bind and the removed env file are NOT detectable before the agent probe (W10): they show as 'not covered', never as captured
        const binds = items.filter((i) => i.kind === "bind");
        expect(binds.length).toBeGreaterThanOrEqual(2);
        expect(binds.every((b) => b.status === "missing" && b.reason === "not_covered")).toBe(true);
        expect(inv.protection.complete).toBe(false);
        expect(JSON.stringify(inv)).not.toMatch(/APP_MODE|container_id|provenance/);
    });
});
