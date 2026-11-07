import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {ForkForbiddenError, ForkNotFoundError, type ForkPrincipal, FORK_RESOURCE_KINDS, type ForkResourceKind} from "@/fork/acl";
import {setEnvironmentHostRole} from "@/fork/environment";
import {assertForkResource} from "@/fork/resource-scope";
import {ForkLockedError, registerActivePolicyProbe, registerSelfCheck, resetForkState, setLaneStatus} from "@/fork/mode";
import {freshForkDb, seedArtifact, seedConnection, seedEnvironment, seedOrg, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";

let w: W04Db;
let A: string, B: string;
const ids = {} as Record<"A" | "B", Record<ForkResourceKind, string>>;
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);

beforeAll(async () => {
    w = await freshForkDb();
    A = await seedOrg(w.pool, "org-a");
    B = await seedOrg(w.pool, "org-b");
    for (const [k, org] of [["A", A], ["B", B]] as const) {
        const conn = await seedConnection(w.pool, org, `c-${k}`);
        const env = await seedEnvironment(w.pool, conn, null, null, k);
        const stack = await seedStack(w.pool, org, env, `stack-${k.toLowerCase()}`);
        const inv = (await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,'{}') returning id", [stack, "a".repeat(64)])).rows[0].id;
        const rp = await seedRp(w.pool, stack, {status: "incomplete"});
        const art = await seedArtifact(w.pool, rp);
        const run = (await q("insert into fork_stack_run (stack_id, trigger, state) values ($1,'manual','failed') returning id", [stack])).rows[0].id;
        ids[k] = {connection: conn, environment: env, stack, stack_inventory: inv, recovery_point: rp, recovery_point_artifact: art, stack_run: run};
    }
});
afterAll(async () => { await w.drop(); });

const P = (systemRole: string | null, ...m: [string, string][]): ForkPrincipal => ({userId: "00000000-0000-4000-8000-000000000001", systemRole, memberships: m.map(([organizationId, role]) => ({organizationId, role}))});
const outcome = (p: Promise<unknown>) => p.then(() => "allowed", (e) => (e instanceof ForkNotFoundError ? "404" : e instanceof ForkForbiddenError ? "403" : `other:${e}`));

describe("E3 SEC-12 resource-scoped ACL — IDOR on every resource-ID kind", () => {
    const READ = "stacks.view";
    const CONFIG = "arcane.manage";
    it.each(FORK_RESOURCE_KINDS)("%s: own-org member reads; foreign-org member/admin/owner get NOT FOUND (no existence oracle); missing id is indistinguishable", async (kind) => {
        const mine = ids.A[kind], theirs = ids.B[kind];
        expect(await outcome(assertForkResource(w.db, P("user", [A, "member"]), READ, {kind, id: mine}))).toBe("allowed");
        for (const role of ["member", "admin", "owner"]) {
            expect(await outcome(assertForkResource(w.db, P("user", [A, role]), READ, {kind, id: theirs})), `${kind}/${role}`).toBe("404");
        }
        const missing = await outcome(assertForkResource(w.db, P("user", [A, "owner"]), READ, {kind, id: "99999999-9999-4999-8999-999999999999"}));
        expect(missing).toBe("404"); // same answer as "exists in another org"
        expect(await outcome(assertForkResource(w.db, P("user", [A, "owner"]), READ, {kind, id: "not-a-uuid"}))).toBe("404");
        expect(await outcome(assertForkResource(w.db, P("user", [A, "owner"]), READ, {kind, id: "' or 1=1 --"}))).toBe("404");
    });
    it.each(FORK_RESOURCE_KINDS)("%s: a member of the OWNING org without the capability gets 403; no principal/pending ⇒ 404", async (kind) => {
        expect(await outcome(assertForkResource(w.db, P("user", [A, "owner"]), CONFIG, {kind, id: ids.A[kind]}))).toBe("403"); // config = system admin only (D21)
        expect(await outcome(assertForkResource(w.db, null, READ, {kind, id: ids.A[kind]}))).toBe("404");
        expect(await outcome(assertForkResource(w.db, P("pending"), READ, {kind, id: ids.A[kind]}))).toBe("404");
    });
    it("system admin may configure (single-tenant operator); org membership is not required", async () => {
        for (const kind of FORK_RESOURCE_KINDS) expect(await outcome(assertForkResource(w.db, P("admin"), CONFIG, {kind, id: ids.A[kind]}))).toBe("allowed");
    });
    it("a member of both orgs gets each org's resources only through that org's role", async () => {
        const p = P("user", [A, "member"], [B, "owner"]);
        expect(await outcome(assertForkResource(w.db, p, "repository.prune", {kind: "stack", id: ids.A.stack}))).toBe("403");
        expect(await outcome(assertForkResource(w.db, p, "repository.prune", {kind: "stack", id: ids.B.stack}))).toBe("allowed");
    });
});

describe("E6 SEC-11 host_role setter: system admin only, validated, audited, blocked while locked", () => {
    const events = async (since: number) => (await q("select action, result, resource_id, redacted_details d from fork_audit_event where seq > $1 order by seq", [since])).rows;
    const maxSeq = async () => Number((await q("select coalesce(max(seq),0) m from fork_audit_event")).rows[0].m);
    beforeEach(() => {
        resetForkState();
        process.env.FORK_ARCANE_ENABLED = "true";
        setLaneStatus({state: "applied"});
        registerActivePolicyProbe(async () => 0);
        registerSelfCheck(async () => ({ok: true}));
    });
    afterEach(() => { delete process.env.FORK_ARCANE_ENABLED; resetForkState(); });
    const role = async (id: string) => (await q("select host_role from fork_arcane_environment where id=$1", [id])).rows[0].host_role;

    it("system admin sets test then production; the change is audited with from/to", async () => {
        const s = await maxSeq();
        const env = ids.A.environment;
        expect(await setEnvironmentHostRole(w.db, P("admin"), env, "test")).toEqual({hostRole: "test"});
        expect(await role(env)).toBe("test");
        await setEnvironmentHostRole(w.db, P("superadmin"), env, "production");
        expect(await role(env)).toBe("production");
        expect(await events(s)).toMatchObject([
            {action: "fork.host_role.set", result: "success", d: {from: "production", to: "test"}},
            {action: "fork.host_role.set", result: "success", d: {from: "test", to: "production"}},
        ]);
    });
    it("org owner / admin / member are refused (403, audited as denied) and nothing changes; foreign org ⇒ 404 + audited denied", async () => {
        const s = await maxSeq();
        const env = ids.A.environment;
        for (const r of ["owner", "admin", "member"]) expect(await outcome(setEnvironmentHostRole(w.db, P("user", [A, r]), env, "test"))).toBe("403");
        expect(await outcome(setEnvironmentHostRole(w.db, P("user", [B, "owner"]), env, "test"))).toBe("404");
        expect(await outcome(setEnvironmentHostRole(w.db, null, env, "test"))).toBe("404");
        expect(await role(env)).toBe("production");
        expect((await events(s)).every((e) => e.result === "denied" && e.action === "fork.host_role.set")).toBe(true);
        expect((await events(s)).length).toBe(5);
    });
    it("invalid values (`runner` is R3-only, junk, non-strings) are rejected and audited as failure", async () => {
        const s = await maxSeq();
        for (const bad of ["runner", "prod", "", null, 1, {a: 1}]) await expect(setEnvironmentHostRole(w.db, P("admin"), ids.A.environment, bad)).rejects.toThrow(/invalid host_role/);
        expect(await role(ids.A.environment)).toBe("production");
        expect((await events(s)).every((e) => e.result === "failure")).toBe(true);
    });
    it("refused while configuration is locked (self-check red + activated policy)", async () => {
        registerActivePolicyProbe(async () => 1);
        registerSelfCheck(async () => ({ok: false, failed: "org-count"}));
        await expect(setEnvironmentHostRole(w.db, P("admin"), ids.A.environment, "test")).rejects.toBeInstanceOf(ForkLockedError);
        expect(await role(ids.A.environment)).toBe("production");
    });
});
