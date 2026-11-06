import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {disconnect, rotateKey, saveConnection, testConnection, type Outcome, type ServiceDeps} from "@/fork/arcane/connection-service";
import {readConnectionApiKey} from "@/fork/db/dto";
import {registerActivePolicyProbe, registerSelfCheck, setLaneStatus} from "@/fork/mode";
import {parseAllowlist} from "@/fork/net/guard";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {MIN_PERMS, startFakeArcane, type FakeArcane} from "@/fork/__tests__/fake-arcane";
import {freshForkDb, seedOrg, seedStack, seedRp, type W04Db} from "@/fork/__tests__/w04-helpers";

const USER = "00000000-0000-4000-8000-0000000000aa";
const P = (systemRole: string | null, ...m: [string, string][]): ForkPrincipal => ({userId: USER, systemRole, memberships: m.map(([organizationId, role]) => ({organizationId, role}))});
const noSleep = async () => {};
const q = (w: W04Db, s: string, p: unknown[] = []) => w.pool.query(s, p);

let w: W04Db;
let org: string;
let kekDir: string;
let fake: FakeArcane;
const deps = (principal: ForkPrincipal | null, extra: Partial<ServiceDeps> = {}): ServiceDeps => ({
    db: w.db, principal, kekDir, allowlist: parseAllowlist("127.0.0.1"), sleep: noSleep, assertConfigAllowed: async () => {}, ...extra,
});
const admin = () => P("admin", [org, "owner"]);
const KEY = () => fake.state.validKey;
const ok = (o: Outcome) => { if (!o.ok) throw new Error(`expected ok, got ${o.code}: ${o.message}`); return o; };
const connCount = async () => Number((await q(w, "select count(*) c from fork_arcane_connection")).rows[0].c);
const auditRows = async () => (await q(w, "select action, result, resource_id, redacted_details d from fork_audit_event order by seq")).rows;

beforeAll(async () => {
    w = await freshForkDb();
    org = await seedOrg(w.pool, "solo");
    kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w05-kek-")), "fork-kek");
});
afterAll(async () => { await w.drop(); });
beforeEach(async () => {
    resetRateLimits();
    fake = await startFakeArcane();
    await q(w, "delete from fork_arcane_connection");
    await q(w, "delete from fork_audit_event").catch(() => undefined); // trigger-protected: ignored, tests filter by action/resource instead
});
afterEach(async () => { await fake.close(); });

const save = (o: Record<string, unknown> = {}, d: ServiceDeps = deps(admin())) => saveConnection(d, {name: "arcane", baseUrl: fake.url, apiKey: KEY(), ...o});

describe("E1 save", () => {
    it("creates a connection: DTO without key, healthy, version pinned, only key-covered environments stored (no apiUrl anywhere)", async () => {
        const r = ok(await save());
        expect(r.connection).toMatchObject({name: "arcane", baseUrl: fake.url, healthStatus: "healthy", lastErrorClass: null, pinnedApiVersion: "2.17.3", tlsInsecure: false, allowProjectsRead: false, keyId: "key-1"});
        expect(r.connection?.lastCheckedAt).toBeInstanceOf(Date);
        expect(r.verification?.environments).toEqual([{externalId: "0", name: "local", reachable: true, errorClass: null}]);
        const envs = (await q(w, "select external_id, name, enabled, host_role from fork_arcane_environment")).rows;
        expect(envs).toEqual([{external_id: "0", name: "local", enabled: false, host_role: "production"}]); // e9 (not covered by the key) is never stored
        const dump = JSON.stringify((await q(w, "select * from fork_arcane_environment")).rows) + JSON.stringify((await q(w, "select * from fork_arcane_connection")).rows);
        expect(dump).not.toMatch(/internal-secret-host|other-internal-host|someone-elses-env/);
        // the key round-trips only through the KEK envelope (AAD = row id)
        expect(await readConnectionApiKey(w.db, org, r.connection!.id, kekDir)).toBe(KEY());
        expect(dump).not.toContain(KEY());
        // tier-1 calls only, GET only, key header only on authenticated paths
        expect(new Set(fake.requests.map((x) => x.method))).toEqual(new Set(["GET"]));
        expect(fake.requests.every((x) => x.path.startsWith("/api/version") || x.key === KEY())).toBe(true);
        expect(fake.requests.map((x) => x.path.split("?")[0]).filter((p) => /workspace|compose|edit-config|\/test$/.test(p))).toEqual([]);
    });

    it("refuses and stores NOTHING when the key holds more than the discovery minimum (exact names listed)", async () => {
        fake.state.grants.push({permission: "containers:read", environmentId: "0"}, {permission: "apikeys:create", environmentId: null});
        const r = await save();
        expect(r).toMatchObject({ok: false, code: "refused", errorClass: "key_too_broad", extraPermissions: ["apikeys:create", "containers:read"]});
        expect(await connCount()).toBe(0);
        expect(JSON.stringify(r)).not.toContain(KEY());
    });

    it.each([
        ["wrong Arcane version", () => { fake.state.version = "2.18.0"; }, "incompatible"],
        ["invalid key (401)", () => { fake.state.validKey = "arc_FAKEPFX1_DIFFERENT_KEY_VALUE"; }, "invalid_key"],
        ["own key row not listed", () => { fake.state.keyPrefix = "arc_NOMATCH0"; }, "key_unverifiable"],
    ])("refuses on creation: %s", async (_n, setup, cls) => {
        const k = KEY();
        setup();
        expect(await save({apiKey: k})).toMatchObject({ok: false, code: "refused", errorClass: cls});
        expect(await connCount()).toBe(0);
    });

    it("default deny: without the operator allow-list a loopback Arcane is refused as blocked_url and never contacted", async () => {
        const r = await save({}, deps(admin(), {allowlist: parseAllowlist("")}));
        expect(r).toMatchObject({ok: false, code: "refused", errorClass: "blocked_url"});
        expect(fake.requests).toHaveLength(0);
        const meta = await save({baseUrl: "http://169.254.169.254"}, deps(admin(), {allowlist: parseAllowlist("169.254.169.254,127.0.0.1")}));
        expect(meta).toMatchObject({ok: false, errorClass: "blocked_url"});
    });

    it("missing permissions on an environment ⇒ saved as degraded/partial with the gap named; a 403/502 environment ⇒ degraded", async () => {
        fake.state.grants = fake.state.grants.filter((g) => g.permission !== "images:list");
        const r = ok(await save());
        expect(r.connection).toMatchObject({healthStatus: "degraded", lastErrorClass: "partial"});
        expect(r.verification?.missingPermissions).toEqual(["images:list (environment 0)"]);
    });

    it("name conflict and invalid input are refused cleanly", async () => {
        ok(await save());
        expect(await save()).toMatchObject({ok: false, code: "invalid_input", message: expect.stringContaining("already exists")});
        expect(await save({name: ""})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await save({apiKey: undefined, name: "other"})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await save({name: "x", baseUrl: "https://u:p@arcane.example.com"})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await save({name: "x2", extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
    });

    it("trailing /api in the pasted URL is normalised away", async () => {
        const r = ok(await save({baseUrl: `${fake.url}/api/`}));
        expect(r.connection?.baseUrl).toBe(fake.url);
    });

    it("TLS opt-out is explicit: stored, warned (https), and flips are audited as their own event", async () => {
        const r = ok(await save({tlsInsecure: true}));
        expect(r.connection?.tlsInsecure).toBe(true);
        const rows = (await auditRows()).filter((a) => a.resource_id === r.connection!.id);
        expect(rows.map((a) => a.action)).toContain("fork.arcane.tls_verification_disabled");
        // turning it back on is a normal save (no extra event), default for new connections is verify
        const again = ok(await save({connectionId: r.connection!.id, tlsInsecure: false, baseUrl: fake.url}));
        expect(again.connection?.tlsInsecure).toBe(false);
        expect(Number((await q(w, "select count(*) c from fork_arcane_connection where tls_insecure")).rows[0].c)).toBe(0);
    });

    it("tier-2 opt-in changes what the self-test allows and is warned about", async () => {
        fake.state.grants.push({permission: "projects:read", environmentId: "0"});
        expect(await save()).toMatchObject({ok: false, errorClass: "key_too_broad", extraPermissions: [expect.stringContaining("projects:read")]});
        const r = ok(await save({allowProjectsRead: true}));
        expect(r.connection?.allowProjectsRead).toBe(true);
        expect(r.warnings.join(" ")).toContain("projects:read");
    });
});

describe("E1 test / state mapping", () => {
    it("persists each Arcane condition as a connection state + error class, with lastCheckedAt", async () => {
        const id = ok(await save()).connection!.id;
        const run = async (setup: () => void, state: string, cls: string | null) => {
            setup();
            const r = ok(await testConnection(deps(admin(), {rate: () => ({ok: true})}), {connectionId: id}));
            expect(r.connection).toMatchObject({healthStatus: state, lastErrorClass: cls});
            const row = (await q(w, "select health_status, last_error_class from fork_arcane_connection where id=$1", [id])).rows[0];
            expect(row).toEqual({health_status: state, last_error_class: cls});
            return r;
        };
        await run(() => {}, "healthy", null);
        await run(() => { fake.state.containerStatus["0"] = 403; }, "degraded", "permission"); // manager + key fine, one environment refuses ⇒ degraded, class says why
        await run(() => { fake.state.containerStatus["0"] = 502; }, "degraded", "unreachable"); // remote environment down (Arcane answers 502)
        await run(() => { fake.state.containerStatus = {}; fake.state.version = "9.9.9"; }, "degraded", "incompatible");
        await run(() => { fake.state.version = "2.17.3"; fake.state.grants.push({permission: "volumes:read", environmentId: "0"}); }, "auth_failed", "key_too_broad");
        await run(() => { fake.state.grants.pop(); fake.state.grants = fake.state.grants.filter((g) => g.permission !== "networks:list"); }, "degraded", "partial");
        await run(() => { fake.state.grants = [{permission: "environments:list", environmentId: null}, ...MIN_PERMS("0")]; fake.state.validKey = "arc_FAKEPFX1_ROTATED_ELSEWHERE_1"; }, "auth_failed", "invalid_key");
        await run(() => { fake.state.validKey = "arc_FAKEPFX1_SECRETSECRETSECRET"; fake.state.forceStatus = 503; }, "unreachable", "unreachable");
        await run(() => { fake.state.forceStatus = undefined; }, "healthy", null);
        await fake.close();
        fake = await startFakeArcane({}); // different port ⇒ the stored URL is dead
        const dead = ok(await testConnection(deps(admin(), {rate: () => ({ok: true})}), {connectionId: id}));
        expect(dead.connection).toMatchObject({healthStatus: "unreachable", lastErrorClass: "unreachable"});
    });
});

describe("E1 rotate", () => {
    it("replaces the key only after the new key verifies; a refused key keeps the old one", async () => {
        const c = ok(await save()).connection!;
        const before = (await q(w, "select api_key_enc from fork_arcane_connection where id=$1", [c.id])).rows[0].api_key_enc;
        const bad = await rotateKey(deps(admin()), {connectionId: c.id, apiKey: "arc_FAKEPFX1_WRONGWRONGWRONG"});
        expect(bad).toMatchObject({ok: false, code: "refused", errorClass: "invalid_key"});
        expect(await readConnectionApiKey(w.db, org, c.id, kekDir)).toBe(KEY());

        fake.state.validKey = "arc_FAKEPFX1_NEWKEYNEWKEYNEWKEY";
        fake.state.keyId = "key-2";
        const r = ok(await rotateKey(deps(admin()), {connectionId: c.id, apiKey: "arc_FAKEPFX1_NEWKEYNEWKEYNEWKEY"}));
        expect(r.connection).toMatchObject({keyId: "key-2", healthStatus: "healthy"});
        expect(await readConnectionApiKey(w.db, org, c.id, kekDir)).toBe("arc_FAKEPFX1_NEWKEYNEWKEYNEWKEY");
        const after = (await q(w, "select api_key_enc from fork_arcane_connection where id=$1", [c.id])).rows[0].api_key_enc;
        expect(JSON.stringify(after)).not.toEqual(JSON.stringify(before));
        expect(JSON.stringify(after)).not.toContain("NEWKEYNEWKEY");
    });
    it("a too-broad new key is refused with the exact permissions", async () => {
        const c = ok(await save()).connection!;
        fake.state.grants.push({permission: "volumes:read", environmentId: "0"});
        expect(await rotateKey(deps(admin()), {connectionId: c.id, apiKey: KEY()})).toMatchObject({ok: false, errorClass: "key_too_broad", extraPermissions: ["volumes:read"]});
    });
});

describe("E4 SEC-10 key re-entry on host/port/scheme change", () => {
    let other: FakeArcane;
    beforeEach(async () => { other = await startFakeArcane(); });
    afterEach(async () => { await other.close(); });

    it.each([
        ["host", () => `http://localhost:${fake.port}`],
        ["port", () => other.url],
        ["scheme", () => `https://127.0.0.1:${fake.port}`],
    ])("changing the %s without re-entering the key is refused, nothing changes, and the stored key is never sent to the new endpoint", async (_n, newUrl) => {
        const c = ok(await save()).connection!;
        other.requests.length = 0;
        const before = JSON.stringify((await q(w, "select base_url, api_key_enc from fork_arcane_connection where id=$1", [c.id])).rows);
        const dep = deps(admin(), {resolve: async (h) => (h === "localhost" ? [{address: "127.0.0.1", family: 4}] : [{address: h, family: 4}]), allowlist: parseAllowlist("127.0.0.1,localhost")});
        const r = await saveConnection(dep, {connectionId: c.id, name: "arcane", baseUrl: newUrl()});
        expect(r).toMatchObject({ok: false, code: "key_reentry_required"});
        expect(JSON.stringify((await q(w, "select base_url, api_key_enc from fork_arcane_connection where id=$1", [c.id])).rows)).toBe(before);
        expect(other.requests).toHaveLength(0);
        const denied = (await auditRows()).filter((a) => a.resource_id === c.id && a.result === "denied");
        expect(denied.at(-1)?.d).toMatchObject({reason: "key-reentry-required"});
    });

    it("with the key typed again the new endpoint is verified and the key replaced", async () => {
        const c = ok(await save()).connection!;
        other.state.validKey = "arc_FAKEPFX1_SECOND_ENDPOINT_KEY";
        const r = ok(await saveConnection(deps(admin()), {connectionId: c.id, name: "arcane", baseUrl: other.url, apiKey: "arc_FAKEPFX1_SECOND_ENDPOINT_KEY"}));
        expect(r.connection?.baseUrl).toBe(other.url);
        expect(await readConnectionApiKey(w.db, org, c.id, kekDir)).toBe("arc_FAKEPFX1_SECOND_ENDPOINT_KEY");
        expect(other.requests.some((x) => x.key === "arc_FAKEPFX1_SECOND_ENDPOINT_KEY")).toBe(true);
    });

    it("same endpoint (rename, path-only change, flag change) needs no key and reuses the stored one", async () => {
        const c = ok(await save()).connection!;
        const r = ok(await saveConnection(deps(admin()), {connectionId: c.id, name: "renamed", baseUrl: `${fake.url}/`, allowProjectsRead: false}));
        expect(r.connection).toMatchObject({name: "renamed", healthStatus: "healthy"});
        expect(fake.requests.at(-1)?.key).toBe(KEY());
    });
});

describe("E1 disconnect", () => {
    it("removes the connection and its encrypted key; stacks, backups and recovery points stay (D32)", async () => {
        const c = ok(await save()).connection!;
        const envId = (await q(w, "select id from fork_arcane_environment where connection_id=$1", [c.id])).rows[0].id;
        const stack = await seedStack(w.pool, org, envId, "kept-stack");
        const rp = await seedRp(w.pool, stack);
        const r = ok(await disconnect(deps(admin()), {connectionId: c.id}));
        expect(r.connection).toBeNull();
        expect(await connCount()).toBe(0);
        expect((await q(w, "select count(*)::int c from fork_arcane_environment")).rows[0].c).toBe(0);
        expect((await q(w, "select environment_id, environment_name from fork_stack where id=$1", [stack])).rows[0]).toEqual({environment_id: null, environment_name: "env"});
        expect((await q(w, "select status from fork_recovery_point where id=$1", [rp])).rows[0].status).toBe("verified");
        const a = (await auditRows()).filter((x) => x.action === "fork.arcane.connection.disconnect" && x.resource_id === c.id);
        expect(a).toHaveLength(1);
        expect(a[0].d).toMatchObject({keptStacks: 1});
        await expect(readConnectionApiKey(w.db, org, c.id, kekDir)).rejects.toThrow();
        expect(await disconnect(deps(admin()), {connectionId: c.id})).toMatchObject({ok: false, code: "not_found"});
    });
});

describe("E2 no secret in DTO / audit / logs / errors (canary)", () => {
    it("the key never appears in results, DB rows, audit rows, errors or any console/stdout/stderr write", async () => {
        const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info"), vi.spyOn(console, "debug"), vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
        const results: unknown[] = [];
        const c = ok(await save()); results.push(c);
        results.push(await testConnection(deps(admin()), {connectionId: c.connection!.id}));
        results.push(await rotateKey(deps(admin()), {connectionId: c.connection!.id, apiKey: "arc_FAKEPFX1_WRONG_CANARY_KEY_1"}));
        fake.state.grants.push({permission: "containers:read", environmentId: "0"});
        results.push(await save({name: "second", apiKey: KEY()}));
        results.push(await save({connectionId: c.connection!.id, name: "arcane", baseUrl: "http://localhost:1/x", apiKey: undefined}));
        results.push(await save({name: "third", apiKey: "arc_FAKEPFX1_CANARY BAD KEY"})); // invalid format
        const text = JSON.stringify(results) + JSON.stringify((await auditRows())) + JSON.stringify((await q(w, "select * from fork_arcane_connection")).rows)
            + spies.flatMap((s) => s.mock.calls.map((a) => String(a[0]))).join("\n");
        for (const secret of [KEY(), "WRONG_CANARY_KEY", "CANARY BAD KEY", "SECRETSECRETSECRET"]) expect(text).not.toContain(secret);
        for (const s of spies) s.mockRestore();
    });
});

describe("E3/E6 role × action matrix (recorded for the §4.9 gate)", () => {
    type Who = {name: string; principal: () => ForkPrincipal | null; allowed: boolean; code?: string; idCode?: string};
    const matrix: Who[] = [
        {name: "system admin (org owner)", principal: () => P("admin", [org, "owner"]), allowed: true},
        {name: "system admin (no membership)", principal: () => P("admin"), allowed: true},
        {name: "superadmin", principal: () => P("superadmin", [org, "member"]), allowed: true},
        {name: "org owner (system role user)", principal: () => P("user", [org, "owner"]), allowed: false, code: "forbidden"},
        {name: "org admin", principal: () => P("user", [org, "admin"]), allowed: false, code: "forbidden"},
        {name: "org member", principal: () => P("user", [org, "member"]), allowed: false, code: "forbidden"},
        {name: "pending account", principal: () => P("pending", [org, "owner"]), allowed: false, code: "forbidden"},
        {name: "user without membership", principal: () => P("user"), allowed: false, code: "forbidden", idCode: "not_found"}, // no relation to the owning org ⇒ indistinguishable from "missing" (SEC-12)
        {name: "no principal", principal: () => null, allowed: false, code: "forbidden"},
    ];
    const actions = ["save", "test", "rotate", "disconnect"] as const;
    const table: string[] = [];
    for (const who of matrix) {
        for (const action of actions) {
            it(`${who.name} × ${action} → ${who.allowed ? "allowed" : who.code}`, async () => {
                // an existing connection created by a real admin
                const seed = ok(await save({}, deps(admin()))).connection!;
                const before = await connCount();
                const d = deps(who.principal());
                const run = {
                    save: () => saveConnection(d, {name: "second", baseUrl: fake.url, apiKey: KEY()}),
                    test: () => testConnection(d, {connectionId: seed.id}),
                    rotate: () => rotateKey(d, {connectionId: seed.id, apiKey: KEY()}),
                    disconnect: () => disconnect(d, {connectionId: seed.id}),
                }[action];
                const r = await run();
                if (who.allowed) {
                    expect(r.ok, `${who.name} × ${action}`).toBe(true);
                } else {
                    expect(r).toMatchObject({ok: false, code: action !== "save" && who.idCode ? who.idCode : who.code});
                    expect(await connCount()).toBe(before); // nothing mutated
                    const row = (await q(w, "select health_status from fork_arcane_connection where id=$1", [seed.id])).rows[0];
                    expect(row).toBeDefined(); // not disconnected
                    const denied = (await auditRows()).filter((a) => a.result === "denied" && a.action.startsWith("fork.arcane.connection."));
                    expect(denied.length).toBeGreaterThan(0);
                }
                table.push(`${who.name} | ${action} | ${r.ok ? "allowed" : (r as {code: string}).code}`);
            });
        }
    }
    afterAll(() => { console.info(`ROLE_X_ACTION_MATRIX\n${table.join("\n")}`); });
});

describe("E3 IDOR / existence oracle", () => {
    it("a foreign-org id and a missing id are indistinguishable (not_found); single-tenant is required for creation", async () => {
        const c = ok(await save()).connection!;
        const orgB = await seedOrg(w.pool, "second-org");
        const foreign = P("user", [orgB, "owner"]);
        const missing = "99999999-9999-4999-8999-999999999999";
        for (const [fn, input] of [[testConnection, {connectionId: c.id}], [disconnect, {connectionId: c.id}], [rotateKey, {connectionId: c.id, apiKey: KEY()}]] as const) {
            const a = await fn(deps(foreign), input as never);
            const b = await fn(deps(foreign), {...input, connectionId: missing} as never);
            expect(a).toMatchObject({ok: false, code: "not_found"});
            expect({...a}).toEqual({...b});
        }
        // two organizations ⇒ no new connection can be created
        expect(await save({name: "x"}, deps(admin()))).toMatchObject({ok: false, code: "single_tenant_required"});
        await q(w, "update organization set deleted_at = now() where id=$1", [orgB]);
    });
});

describe("D21 self-check gate, rate limit", () => {
    it("while the self-check fails every action is refused with the reason, audited, and Arcane is never contacted", async () => {
        const c = ok(await save()).connection!;
        fake.requests.length = 0;
        process.env.FORK_STACKS_ENABLED = "true";
        registerActivePolicyProbe(async () => 1);
        registerSelfCheck(async () => ({ok: false, failed: "signup-open"}));
        setLaneStatus({state: "applied"});
        try {
            const d = (): ServiceDeps => ({...deps(admin()), assertConfigAllowed: undefined});
            for (const r of [
                await saveConnection(d(), {name: "arcane", baseUrl: fake.url, apiKey: KEY()}),
                await testConnection(d(), {connectionId: c.id}),
                await rotateKey(d(), {connectionId: c.id, apiKey: KEY()}),
                await disconnect(d(), {connectionId: c.id}),
            ]) expect(r).toMatchObject({ok: false, code: "locked", message: expect.stringContaining("self-check-failed")});
            expect(fake.requests).toHaveLength(0);
            expect(await connCount()).toBe(1);
            const denied = (await auditRows()).filter((a) => a.result === "denied" && JSON.stringify(a.d).includes("locked:self-check-failed"));
            expect(denied.length).toBeGreaterThanOrEqual(4);
            // flag off + nothing activated ⇒ "not enabled"
            registerActivePolicyProbe(async () => 0);
            delete process.env.FORK_STACKS_ENABLED;
            expect(await testConnection(d(), {connectionId: c.id})).toMatchObject({ok: false, code: "locked", message: expect.stringContaining("not enabled")});
        } finally {
            delete process.env.FORK_STACKS_ENABLED;
        }
    });

    it("test/save/rotate are rate limited per user (6 per minute); disconnect has its own bucket", async () => {
        const c = ok(await save()).connection!; // 1
        for (let i = 0; i < 5; i++) ok(await testConnection(deps(admin()), {connectionId: c.id})); // 2..6
        const limited = await testConnection(deps(admin()), {connectionId: c.id});
        expect(limited).toMatchObject({ok: false, code: "rate_limited", retryAfterSeconds: expect.any(Number)});
        expect(await save({name: "z"})).toMatchObject({ok: false, code: "rate_limited"});
        expect((await auditRows()).some((a) => a.d?.reason === "rate-limited")).toBe(true);
        ok(await disconnect(deps(admin()), {connectionId: c.id})); // separate bucket
        expect(fake.requests.length).toBeGreaterThan(0);
    });
});
