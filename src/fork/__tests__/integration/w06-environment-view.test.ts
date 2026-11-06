import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {ENV_RATE_LIMIT, updateEnvironment, type EnvironmentOutcome} from "@/fork/arcane/environment-service";
import type {ServiceDeps} from "@/fork/arcane/connection-service";
import {loadIntegrationsView} from "@/fork/arcane/integrations-view";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {freshForkDb, seedAgent, seedConnection, seedEnvironment, seedOrg, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";

const USER = "00000000-0000-4000-8000-0000000000aa";
const P = (systemRole: string | null, ...m: [string, string][]): ForkPrincipal => ({userId: USER, systemRole, memberships: m.map(([organizationId, role]) => ({organizationId, role}))});
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);

let w: W04Db;
let org: string;
let other: string;
let conn: string;
let env: string;
const deps = (principal: ForkPrincipal | null, extra: Partial<ServiceDeps> = {}): ServiceDeps => ({db: w.db, principal, assertConfigAllowed: async () => {}, ...extra});
const admin = () => P("admin", [org, "owner"]);
const ok = (o: EnvironmentOutcome) => { if (!o.ok) throw new Error(`expected ok, got ${o.code}: ${o.message}`); return o; };
const envRow = async () => (await q("select enabled, host_role, agent_id, agent_name from fork_arcane_environment where id=$1", [env])).rows[0];
const audits = async () => (await q("select actor_user_id, result, redacted_details d from fork_audit_event where action='fork.arcane.environment.update' order by seq")).rows;

beforeAll(async () => {
    w = await freshForkDb();
    org = await seedOrg(w.pool, "solo");
    other = await seedOrg(w.pool, "foreign");
});
afterAll(async () => { await w.drop(); });
beforeEach(async () => {
    resetRateLimits();
    await q("delete from fork_arcane_connection");
    conn = await seedConnection(w.pool, org);
    env = await seedEnvironment(w.pool, conn);
});

describe("environment settings: role × action matrix (D21, SEC-11, SEC-12)", () => {
    it("system admin and superadmin can enable, map an agent and set the host role; default is disabled/production", async () => {
        expect(await envRow()).toMatchObject({enabled: false, host_role: "production", agent_id: null});
        const a = await seedAgent(w.pool, org, "vps-agent");
        for (const role of ["admin", "superadmin"]) {
            const r = ok(await updateEnvironment(deps(P(role, [org, "member"])), {environmentId: env, enabled: true, agentId: a, hostRole: "test"}));
            expect(r.changed.sort()).toEqual(["agent", "enabled", "hostRole"]);
            expect(r.environment).toMatchObject({enabled: true, hostRole: "test", agentId: a, agentName: "vps-agent"});
            ok(await updateEnvironment(deps(admin()), {environmentId: env, enabled: false, agentId: null, hostRole: "production"}));
        }
        expect(await envRow()).toMatchObject({enabled: false, host_role: "production", agent_id: null, agent_name: null});
    });
    it("org owner / admin / member / pending / no membership / no principal are refused on every field, nothing mutated, denial audited", async () => {
        const before = (await audits()).length;
        const who: [string, ForkPrincipal | null][] = [
            ["org owner", P("user", [org, "owner"])], ["org admin", P("user", [org, "admin"])], ["org member", P("user", [org, "member"])],
            ["pending", P("pending", [org, "member"])], ["no membership", P("user")], ["no principal", null],
        ];
        for (const [label, p] of who) {
            for (const input of [{enabled: true}, {hostRole: "test" as const}, {agentId: null}]) {
                const r = await updateEnvironment(deps(p), {environmentId: env, ...input});
                expect(r.ok, `${label} ${JSON.stringify(input)}`).toBe(false);
                expect(["forbidden", "not_found"]).toContain((r as {code: string}).code);
            }
        }
        expect(await envRow()).toMatchObject({enabled: false, host_role: "production", agent_id: null});
        expect((await audits()).length).toBeGreaterThan(before);
        expect((await audits()).slice(before).every((a) => a.result === "denied")).toBe(true);
    });
    it("no existence oracle: unknown id and an environment of another organization answer identically for a user without relation", async () => {
        const c2 = await seedConnection(w.pool, other, "arcane-b");
        const foreign = await seedEnvironment(w.pool, c2);
        const a = await updateEnvironment(deps(P("user", [org, "owner"])), {environmentId: foreign, enabled: true});
        const b = await updateEnvironment(deps(P("user", [org, "owner"])), {environmentId: randomUUID(), enabled: true});
        expect(a).toEqual({...b});
        expect((a as {code: string}).code).toBe("not_found");
    });
    it("malformed input refused (strict schema, empty change, bad role, junk id) before any DB access", async () => {
        for (const bad of [{environmentId: env}, {environmentId: "nope", enabled: true}, {environmentId: env, hostRole: "runner"}, {environmentId: env, enabled: true, extra: 1}, {environmentId: env, enabled: "yes"}]) {
            const r = await updateEnvironment(deps(admin()), bad);
            expect(r).toMatchObject({ok: false, code: "invalid_input"});
        }
        expect(await envRow()).toMatchObject({enabled: false});
    });
});

describe("environment settings: gates", () => {
    it("self-check red / flags off → refused `locked`, audited, nothing mutated", async () => {
        const {ForkLockedError} = await import("@/fork/mode");
        const r = await updateEnvironment(deps(admin(), {assertConfigAllowed: async () => { throw new ForkLockedError("locked", "self-check-failed"); }}), {environmentId: env, enabled: true});
        expect(r).toMatchObject({ok: false, code: "locked"});
        expect((await envRow()).enabled).toBe(false);
        expect((await audits()).at(-1)?.d).toMatchObject({reason: "locked:self-check-failed"});
    });
    it("rate limited after the per-minute limit", async () => {
        let last: EnvironmentOutcome | undefined;
        for (let i = 0; i <= ENV_RATE_LIMIT.limit; i++) last = await updateEnvironment(deps(admin()), {environmentId: env, enabled: i % 2 === 0});
        expect(last).toMatchObject({ok: false, code: "rate_limited"});
    });
    it("agent of another organization, an org-bound agent via organization_agents elsewhere, an archived and an unknown agent cannot be mapped (D21)", async () => {
        const foreign = await seedAgent(w.pool, other, "foreign-agent");
        const viaLink = await seedAgent(w.pool, null, "linked-elsewhere");
        await q("insert into organization_agents (organization_id, agent_id) values ($1,$2)", [other, viaLink]);
        const archived = await seedAgent(w.pool, org, "archived");
        await q("update agents set is_archived = true where id=$1", [archived]);
        for (const id of [foreign, viaLink, archived, randomUUID()]) {
            expect(await updateEnvironment(deps(admin()), {environmentId: env, agentId: id}), id).toMatchObject({ok: false, code: "invalid_input"});
        }
        expect((await envRow()).agent_id).toBeNull();
        const free = await seedAgent(w.pool, null, "unbound");
        ok(await updateEnvironment(deps(admin()), {environmentId: env, agentId: free}));
    });
    it("audit row records from/to and the actor; a no-op change is audited as noop and changes nothing", async () => {
        ok(await updateEnvironment(deps(admin()), {environmentId: env, hostRole: "test"}));
        const r = ok(await updateEnvironment(deps(admin()), {environmentId: env, hostRole: "test"}));
        expect(r.changed).toEqual([]);
        const [first, second] = (await audits()).slice(-2);
        expect(first).toMatchObject({actor_user_id: USER, result: "success", d: {changed: ["hostRole"], from: {hostRole: "production"}, to: {hostRole: "test"}}});
        expect(second.d).toMatchObject({noop: true});
    });
});

describe("integrations read model", () => {
    it("empty instance: no connection, no environments; candidate agents = unbound or this org only, live only", async () => {
        await q("delete from fork_arcane_connection");
        await q("delete from agents");
        const mine = await seedAgent(w.pool, org, "mine");
        const unbound = await seedAgent(w.pool, null, "unbound");
        await seedAgent(w.pool, other, "foreign");
        const gone = await seedAgent(w.pool, org, "deleted");
        await q("update agents set deleted_at = now() where id=$1", [gone]);
        const v = await loadIntegrationsView(w.db, org);
        expect(v.connection).toBeNull();
        expect(v.environments).toEqual([]);
        expect(v.agents.map((a) => a.id).sort()).toEqual([mine, unbound].sort());
        expect(v.agents.every((a) => a.status === "offline")).toBe(true);
    });
    it("connection + environments: serialisable, agent status from the upstream util, no key material anywhere (canary)", async () => {
        const {insertConnectionWithSecret} = await import("@/fork/db/dto");
        await q("delete from fork_arcane_connection");
        const canary = "arc_CANARYPFX_CANARYCANARYCANARYCANARY";
        const {mkdtemp} = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
        const kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w06-kek-")), "fork-kek");
        const c = await insertConnectionWithSecret(w.db, {organizationId: org, name: "arcane", baseUrl: "https://arcane.example", apiKey: canary}, kekDir);
        const a = await seedAgent(w.pool, org, "live-agent");
        await q("update agents set last_contact = now() where id=$1", [a]);
        const e1 = await seedEnvironment(w.pool, c.id, a, "live-agent", "0");
        await seedEnvironment(w.pool, c.id, null, null, "1");
        await seedConnection(w.pool, org, "second");
        const v = await loadIntegrationsView(w.db, org);
        expect(v.connection).toMatchObject({id: c.id, name: "arcane", keyStored: true});
        expect(v.additionalConnections).toBe(1);
        expect(v.environments).toHaveLength(2);
        expect(v.environments.find((e) => e.id === e1)).toMatchObject({agentStatus: "online", agentName: "live-agent"});
        expect(v.environments.find((e) => e.id !== e1)?.agentStatus).toBeNull();
        const json = JSON.stringify(v);
        expect(JSON.parse(json)).toEqual(v); // survives the RSC boundary unchanged (no Date, no undefined)
        expect(json).not.toContain(canary);
        expect(json).not.toMatch(/apiKey|api_key|apiKeyEnc|"ct"|"iv"|"tag"/);
        void seedStack;
    });
});
