import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {registerActivePolicyProbe, registerSelfCheck, setLaneStatus} from "@/fork/mode";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {startFakeArcane, type FakeArcane} from "@/fork/__tests__/fake-arcane";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";

/**
 * The REAL exported server actions (next-safe-action + userAction + getForkPrincipal + the D21 gate) against Postgres 17 and a
 * fake Arcane. Only the session (`currentUser`) and the app DB handle are replaced.
 */
const h = vi.hoisted(() => ({user: null as null | Record<string, unknown>, db: null as unknown}));
vi.mock("@/lib/auth/current-user", () => ({currentUser: async () => h.user}));
vi.mock("@/fork/db/handle", async (orig) => ({...(await orig<typeof import("@/fork/db/handle")>()), appDb: async () => h.db}));

let w: W04Db;
let org: string;
let fake: FakeArcane;
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);
const setUser = (role: string | null, orgRole: string | null, banned = false) => {
    h.user = role ? {id: "00000000-0000-4000-8000-0000000000bb", role, banned} : null;
    return orgRole;
};

beforeAll(async () => {
    w = await freshForkDb();
    h.db = w.db;
    org = await seedOrg(w.pool, "solo");
    process.env.PRIVATE_PATH = await mkdtemp(path.join(os.tmpdir(), "w05-act-"));
});
afterAll(async () => { await w.drop(); delete process.env.PRIVATE_PATH; });
beforeEach(async () => {
    resetRateLimits();
    fake = await startFakeArcane();
    await q("delete from fork_arcane_connection");
    process.env.FORK_STACKS_ENABLED = "true";
    process.env.FORK_ARCANE_NET_ALLOWLIST = "127.0.0.1";
    registerActivePolicyProbe(async () => 0);
    registerSelfCheck(async () => ({ok: true}));
    setLaneStatus({state: "applied"});
});
afterEach(async () => { await fake.close(); });

async function asUser(role: string | null, orgRole: string | null, banned = false) {
    setUser(role, orgRole, banned);
    if (role && orgRole) {
        await q("delete from member where user_id=$1", [h.user!.id]);
        await q(`insert into "user" (id, name, email, email_verified, role) values ($1,'u',$2,true,$3) on conflict (id) do update set role=excluded.role`, [h.user!.id, `${h.user!.id}@t.test`, role]).catch(() => undefined);
        await q("insert into member (organization_id, user_id, role) values ($1,$2,$3)", [org, h.user!.id, orgRole]).catch(() => undefined);
    }
}

describe("real server actions", () => {
    it("system admin: save → test → rotate → disconnect through the exported actions; results carry no key", async () => {
        const {saveArcaneConnectionAction, testArcaneConnectionAction, rotateArcaneKeyAction, disconnectArcaneAction} = await import("@/fork/actions/arcane-connection.action");
        await asUser("admin", "owner");
        const saved = await saveArcaneConnectionAction({name: "arcane", baseUrl: fake.url, apiKey: fake.state.validKey});
        expect(saved?.data).toMatchObject({ok: true, connection: {name: "arcane", healthStatus: "healthy"}});
        const id = (saved?.data as {connection: {id: string}}).connection.id;
        expect(JSON.stringify(saved)).not.toContain(fake.state.validKey);
        expect((await testArcaneConnectionAction({connectionId: id}))?.data).toMatchObject({ok: true});
        fake.state.validKey = "arc_FAKEPFX1_ROTATEDROTATEDROTATED";
        const rot = await rotateArcaneKeyAction({connectionId: id, apiKey: fake.state.validKey});
        expect(rot?.data).toMatchObject({ok: true});
        expect(JSON.stringify(rot)).not.toContain("ROTATEDROTATED");
        expect((await disconnectArcaneAction({connectionId: id}))?.data).toMatchObject({ok: true, connection: null});
        const actions = (await q("select action, result from fork_audit_event where action like 'fork.arcane.connection.%' order by seq")).rows.map((r) => `${r.action}:${r.result}`);
        expect(actions).toEqual([
            "fork.arcane.connection.save:success", "fork.arcane.connection.test:success", "fork.arcane.connection.rotate_key:success", "fork.arcane.connection.disconnect:success",
        ]);
    });

    it("non-system-admin (org owner) is refused server-side by every action", async () => {
        const a = await import("@/fork/actions/arcane-connection.action");
        await asUser("admin", "owner");
        const id = ((await a.saveArcaneConnectionAction({name: "arcane", baseUrl: fake.url, apiKey: fake.state.validKey}))?.data as {connection: {id: string}}).connection.id;
        await asUser("user", "owner");
        expect((await a.saveArcaneConnectionAction({name: "two", baseUrl: fake.url, apiKey: fake.state.validKey}))?.data).toMatchObject({ok: false, code: "forbidden"});
        expect((await a.testArcaneConnectionAction({connectionId: id}))?.data).toMatchObject({ok: false, code: "forbidden"});
        expect((await a.rotateArcaneKeyAction({connectionId: id, apiKey: fake.state.validKey}))?.data).toMatchObject({ok: false, code: "forbidden"});
        expect((await a.disconnectArcaneAction({connectionId: id}))?.data).toMatchObject({ok: false, code: "forbidden"});
        expect(Number((await q("select count(*) c from fork_arcane_connection")).rows[0].c)).toBe(1);
    });

    it("signed-out, pending and banned sessions never reach the service (userAction)", async () => {
        const a = await import("@/fork/actions/arcane-connection.action");
        for (const [role, banned] of [[null, false], ["pending", false], ["admin", true]] as const) {
            await asUser(role, null, banned);
            const r = await a.testArcaneConnectionAction({connectionId: "11111111-1111-4111-8111-111111111111"});
            expect(r?.serverError, `${role}/${banned}`).toBeTruthy();
            expect(r?.data).toBeUndefined();
        }
    });

    it("invalid input is rejected by the schema (strict object, uuid) before any use-case runs", async () => {
        const a = await import("@/fork/actions/arcane-connection.action");
        await asUser("admin", "owner");
        const r = await a.testArcaneConnectionAction({connectionId: "nope"} as never);
        expect(r?.validationErrors).toBeTruthy();
        const r2 = await a.saveArcaneConnectionAction({name: "x", baseUrl: fake.url, apiKey: "short"});
        expect(r2?.validationErrors).toBeTruthy();
        expect(JSON.stringify(r2)).not.toContain("short\"");
    });

    it("locked fork (self-check red with an activated policy) ⇒ the real gate refuses", async () => {
        const a = await import("@/fork/actions/arcane-connection.action");
        await asUser("admin", "owner");
        registerActivePolicyProbe(async () => 1);
        registerSelfCheck(async () => ({ok: false, failed: "org-count"}));
        const r = await a.saveArcaneConnectionAction({name: "arcane", baseUrl: fake.url, apiKey: fake.state.validKey});
        expect(r?.data).toMatchObject({ok: false, code: "locked"});
        expect(fake.requests).toHaveLength(0);
    });

    it("operator allow-list is read from FORK_ARCANE_NET_ALLOWLIST at call time: empty ⇒ loopback refused", async () => {
        const a = await import("@/fork/actions/arcane-connection.action");
        await asUser("admin", "owner");
        process.env.FORK_ARCANE_NET_ALLOWLIST = "";
        const r = await a.saveArcaneConnectionAction({name: "arcane", baseUrl: fake.url, apiKey: fake.state.validKey});
        expect(r?.data).toMatchObject({ok: false, errorClass: "blocked_url"});
        expect(fake.requests).toHaveLength(0);
    });
});
