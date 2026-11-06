import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {disconnect, rotateKey, saveConnection, testConnection, type ServiceDeps} from "@/fork/arcane/connection-service";
import {ENV_MINIMUM} from "@/fork/arcane/endpoints";
import {readConnectionApiKey} from "@/fork/db/dto";
import {parseAllowlist} from "@/fork/net/guard";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";

/** LIVE (FORK_LAB=1): save → test → rotate → disconnect through the connection service against the lab Arcane, with a real Postgres + KEK. Lab only. */
const LAB = process.env.FORK_LAB === "1";
const URL_ = process.env.ARCANE_URL ?? "http://127.0.0.1:13552";
const PERMS = [{permission: "environments:list"}, ...ENV_MINIMUM.map((permission) => ({permission, environmentId: "0"}))];

describe.skipIf(!LAB)("arcane-live — connection use-cases against the lab", () => {
    let w: W04Db, org: string, token = "";
    const minted: string[] = [];
    const api = async (method: string, p: string, body?: unknown) => {
        const r = await fetch(`${URL_}/api${p}`, {method, headers: {"content-type": "application/json", authorization: `Bearer ${token}`}, body: body ? JSON.stringify(body) : undefined});
        return (await r.json().catch(() => ({}))) as {data?: {id?: string; key?: string}};
    };
    const mint = async (name: string) => {
        const r = await api("POST", "/api-keys", {name: `forklab-w05-${name}`, description: "W05 live connection test, lab only", permissions: PERMS});
        minted.push(r.data!.id!);
        return r.data!.key!;
    };
    beforeAll(async () => {
        expect(["127.0.0.1", "localhost"]).toContain(new URL(URL_).hostname);
        w = await freshForkDb();
        org = await seedOrg(w.pool, "solo");
        for (let i = 0; i < 2 && !token; i++) {
            const r = await fetch(`${URL_}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({username: process.env.LAB_ARCANE_ADMIN_USER ?? "arcane", password: process.env.LAB_ARCANE_ADMIN_PASSWORD ?? "arcane-admin"})});
            if (r.status === 429) { await new Promise((res) => setTimeout(res, (Number(r.headers.get("retry-after")) || 60) * 1000)); continue; }
            token = ((await r.json()) as {data?: {token?: string}}).data?.token ?? "";
        }
        if (!token) throw new Error("lab admin login failed");
    }, 150_000);
    afterAll(async () => { for (const id of minted) await api("DELETE", `/api-keys/${id}`).catch(() => undefined); await w?.drop(); });

    it("save → test → rotate → disconnect", async () => {
        const d: ServiceDeps = {db: w.db, principal: {userId: "00000000-0000-4000-8000-0000000000cc", systemRole: "admin", memberships: [{organizationId: org, role: "owner"}]},
            kekDir: path.join(await mkdtemp(path.join(os.tmpdir(), "w05-live-kek-")), "fork-kek"), allowlist: parseAllowlist("127.0.0.1"), assertConfigAllowed: async () => {}};
        const key1 = await mint("conn-1");
        const saved = await saveConnection(d, {name: "lab", baseUrl: URL_, apiKey: key1});
        expect(saved).toMatchObject({ok: true, connection: {healthStatus: "healthy", pinnedApiVersion: "2.17.3"}});
        const id = (saved as {connection: {id: string}}).connection.id;
        expect((await q(w, "select external_id, name from fork_arcane_environment")).rows.map((r) => r.external_id)).toEqual(["0"]);
        expect(await testConnection(d, {connectionId: id})).toMatchObject({ok: true, verification: {state: "healthy", environments: [{externalId: "0", reachable: true}]}});
        const key2 = await mint("conn-2");
        expect(await rotateKey(d, {connectionId: id, apiKey: key2})).toMatchObject({ok: true, connection: {healthStatus: "healthy"}});
        expect(await readConnectionApiKey(w.db, org, id, d.kekDir)).toBe(key2);
        expect(JSON.stringify((await q(w, "select * from fork_arcane_connection")).rows) + JSON.stringify((await q(w, "select redacted_details from fork_audit_event")).rows)).not.toMatch(new RegExp(`${key1}|${key2}`));
        expect(await disconnect(d, {connectionId: id})).toMatchObject({ok: true});
        expect((await q(w, "select count(*)::int c from fork_arcane_connection")).rows[0].c).toBe(0);
    }, 60_000);
});
const q = (w: W04Db, s: string) => w.pool.query(s);
