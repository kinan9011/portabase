import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {verifyAuditChain} from "@/fork/audit";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import {setEnvironmentHostRole} from "@/fork/environment";
import {registerActivePolicyProbe, registerSelfCheck, resetForkState, setLaneStatus} from "@/fork/mode";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {hashPlan} from "@/fork/restore/plan";
import {approveRestorePlan, checkPlanFresh, createRestorePlan, getRestorePlanView, loadFreshPlan, setStackPrivacy, type PlanRow, type RestoreDeps} from "@/fork/restore/service";
import {RestorePlanV1} from "@/fork/restore/schema";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {P, req, seedUser, seedWorld, type World} from "@/fork/__tests__/w16-world";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

let t: W04Db; let pool: Pool; let org: string; let owner: string, admin: string, member: string, sysadmin: string, outsider: string;
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const principals = () => ({
    admin: P(admin, "user", [org, "admin"]), owner: P(owner, "user", [org, "owner"]), member: P(member, "user", [org, "member"]),
    sysadmin: P(sysadmin, "admin"), outsider: P(outsider, "user", [randomUUID(), "owner"]),
});
let clock = new Date();
const deps = (principal: RestoreDeps["principal"], over: Partial<RestoreDeps> = {}): RestoreDeps => ({db: t.db, principal, now: () => clock, configAllowed: async () => true, ...over});
const create = async (w: World, p: RestoreDeps["principal"], over: Record<string, unknown> = {}, d: Partial<RestoreDeps> = {}) => createRestorePlan(deps(p, d), req(w, over));
const must = async (w: World, over: Record<string, unknown> = {}) => { const r = await create(w, principals().admin, over); if (!r.ok) throw new Error(`create refused: ${r.code}`); return r; };
const events = async (since = 0) => (await q("select action, result, resource_type, resource_id, redacted_details d from fork_audit_event where seq > $1 order by seq", [since])).rows;
const maxSeq = async () => Number((await q("select coalesce(max(seq),0) m from fork_audit_event")).rows[0].m);
const dbRow = async (id: string): Promise<PlanRow> => {
    const {forkRestorePlan} = await import("@/fork/db/schema/restore");
    const {eq} = await import("drizzle-orm");
    return (await t.db.select().from(forkRestorePlan).where(eq(forkRestorePlan.id, id)))[0];
};

beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool; org = await seedOrg(pool);
    [owner, admin, member, outsider] = await Promise.all([seedUser(pool), seedUser(pool), seedUser(pool), seedUser(pool)]);
    sysadmin = await seedUser(pool, "admin");
});
afterAll(async () => { await t?.drop(); });
beforeEach(() => { resetRateLimits(); clock = new Date(); });

describe("createRestorePlan", () => {
    it("org admin ⇒ ok; immutable row; hash recomputes after the jsonb round trip; expiry = created + 24 h", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        expect(r.outcome).toBe("ready");
        const x = await dbRow(r.planId);
        expect(x.createdAt.getTime()).toBe(clock.getTime());
        expect(x.expiresAt.getTime() - x.createdAt.getTime()).toBe(24 * 3_600_000);
        expect(x.planHash).toBe(r.planHash);
        expect(hashPlan(RestorePlanV1.parse(x.plan))).toBe(r.planHash);
        expect(x).toMatchObject({purpose: "restore", mode: "new_stack", planVersion: 1, outcome: "ready", rpSequence: 1, createdBy: admin, organizationId: org});
        expect(x.approvals).toEqual([]);
        expect(x.targetAgentName).toBe(w.agentName);
    });
    it("is a dry-run: writes only fork_restore_plan and fork_audit_event (no task, no other fork table)", async () => {
        const w = await seedWorld(pool, {org});
        const tables = (await q("select table_name from information_schema.tables where table_schema='public' and table_name like 'fork\\_%' order by 1")).rows.map((x) => x.table_name as string);
        const count = async () => Object.fromEntries(await Promise.all(tables.map(async (n) => [n, Number((await q(`select count(*) c from "${n}"`)).rows[0].c)])));
        const before = await count();
        await must(w);
        const after = await count();
        const changed = tables.filter((n) => before[n] !== after[n]).sort();
        expect(changed).toEqual(["fork_audit_event", "fork_restore_plan"]);
        expect(after.fork_agent_task).toBe(before.fork_agent_task);
    });
    it("the plan is honest about this release: production target ⇒ approval required; deferred checks are not 'met'", async () => {
        const w = await seedWorld(pool, {org});
        const x = await dbRow((await must(w)).planId);
        const plan = RestorePlanV1.parse(x.plan);
        expect(plan.approvals_required.map((a) => a.kind)).toEqual(["production_target"]);
        expect(plan.preconditions.filter((p) => p.state === "deferred").map((p) => p.code)).toEqual(expect.arrayContaining(["restore_root_on_agent", "target_empty", "manifest_signature"]));
        expect(JSON.stringify(plan)).not.toMatch(/tested/i);
    });
    it("only verified RPs: incomplete / failed / purged are refused with no row", async () => {
        const w = await seedWorld(pool, {org});
        const before = Number((await q("select count(*) c from fork_restore_plan")).rows[0].c);
        await q("update fork_recovery_point set status='incomplete', verified_at=null, downgrade_reason='artifact_missing' where id=$1", [w.rp]);
        expect(await create(w, principals().admin)).toMatchObject({ok: false, code: "rp_not_verified"});
        await q("update fork_recovery_point set status='verified', verified_at=now(), downgrade_reason=null, purged_at=now() where id=$1", [w.rp]);
        expect(await create(w, principals().admin)).toMatchObject({ok: false, code: "rp_purged"});
        expect(Number((await q("select count(*) c from fork_restore_plan")).rows[0].c)).toBe(before);
    });
    it("invalid input (unknown key, bad enum, bad uuid, mapping with traversal shape) ⇒ invalid_input", async () => {
        const w = await seedWorld(pool, {org});
        for (const bad of [{...req(w), extra: 1}, req(w, {purpose: "mirror"}), req(w, {rpId: "x"}), req(w, {mode: "mirror"}), {}, null, "x"]) expect(await createRestorePlan(deps(principals().admin), bad)).toMatchObject({ok: false, code: "invalid_input"});
    });
    it("a hostile restore_root is planned as BLOCKED (reason), never as an action outside a root", async () => {
        const w = await seedWorld(pool, {org});
        const r = await create(w, principals().admin, {mappings: {...req(w).mappings, restore_root: "/etc"}});
        expect(r).toMatchObject({ok: true, outcome: "blocked"});
        if (r.ok) expect(RestorePlanV1.parse((await dbRow(r.planId)).plan).blockers).toContain("restore_root_rejected");
    });
});

describe("ACL / IDOR (SEC-12)", () => {
    it("member ⇒ forbidden; outsider / random / malformed ids ⇒ the SAME not_found", async () => {
        const w = await seedWorld(pool, {org});
        expect(await create(w, principals().member)).toMatchObject({ok: false, code: "forbidden"});
        expect(await create(w, null)).toMatchObject({ok: false, code: "forbidden"});
        const a = await create(w, principals().outsider);
        const b = await createRestorePlan(deps(principals().admin), req(w, {rpId: randomUUID()}));
        const c = await createRestorePlan(deps(principals().outsider), req(w, {rpId: randomUUID()}));
        expect([a, b, c]).toEqual([{ok: false, code: "not_found"}, {ok: false, code: "not_found"}, {ok: false, code: "not_found"}]);
    });
    it("a target agent of another organization is not_found (agent ACL copy, D31)", async () => {
        const w = await seedWorld(pool, {org});
        const other = await seedWorld(pool);
        expect(await createRestorePlan(deps(principals().admin), req(w, {targetAgentId: other.agent}))).toEqual({ok: false, code: "not_found"});
        expect(await createRestorePlan(deps(principals().admin), req(w, {targetAgentId: randomUUID()}))).toEqual({ok: false, code: "not_found"});
    });
    it("read: member forbidden, other org / unknown id not_found, admin ok", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        expect(await getRestorePlanView(deps(principals().member), {planId: r.planId})).toMatchObject({ok: false, code: "forbidden"});
        expect(await getRestorePlanView(deps(principals().outsider), {planId: r.planId})).toEqual({ok: false, code: "not_found"});
        expect(await getRestorePlanView(deps(principals().admin), {planId: randomUUID()})).toEqual({ok: false, code: "not_found"});
        expect(await getRestorePlanView(deps(principals().admin), {planId: "nope"})).toMatchObject({ok: false, code: "invalid_input"});
        expect((await getRestorePlanView(deps(principals().admin), {planId: r.planId})).ok).toBe(true);
    });
    it("approve production_target: org admin forbidden, owner ok, system admin WITHOUT membership ok", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        const body = {planId: r.planId, planHash: r.planHash, kind: "production_target"};
        expect(await approveRestorePlan(deps(principals().admin), body)).toMatchObject({ok: false, code: "forbidden"});
        expect(await approveRestorePlan(deps(principals().member), body)).toMatchObject({ok: false, code: "forbidden"});
        expect(await approveRestorePlan(deps(principals().outsider), body)).toEqual({ok: false, code: "not_found"});
        const a = await approveRestorePlan(deps(principals().owner), body);
        expect(a).toMatchObject({ok: true, approvals: [{kind: "production_target"}]});
        expect((await approveRestorePlan(deps(principals().sysadmin), body)).ok).toBe(true);
    });
    it("destructive_replace (existing_stack): admin ok, member forbidden", async () => {
        const w = await seedWorld(pool, {org, roots: ["/srv"]});
        const tgtStack = (await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name) values ($1,$2,'env','app','app') returning id", [org, w.tgtEnv])).rows[0].id;
        await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [tgtStack, "e".repeat(64), JSON.stringify(w.inventory)]);
        const r = await must(w, {mode: "existing_stack"});
        expect(r.outcome).toBe("ready");
        const plan = RestorePlanV1.parse((await dbRow(r.planId)).plan);
        expect(plan.approvals_required.map((a) => a.kind)).toEqual(["production_target", "destructive_replace"]);
        expect(plan.actions.filter((a) => a.destructive).length).toBeGreaterThan(0);
        const body = {planId: r.planId, planHash: r.planHash, kind: "destructive_replace"};
        expect(await approveRestorePlan(deps(principals().member), body)).toMatchObject({ok: false, code: "forbidden"});
        expect((await approveRestorePlan(deps(principals().admin), body)).ok).toBe(true);
    });
});

describe("D44 end to end", () => {
    beforeEach(() => { resetForkState(); process.env.FORK_ARCANE_ENABLED = "true"; setLaneStatus({state: "applied"}); registerActivePolicyProbe(async () => 0); registerSelfCheck(async () => ({ok: true})); });
    afterEach(() => { delete process.env.FORK_ARCANE_ENABLED; resetForkState(); });
    it("test restore to a production environment is refused and audited; a system admin flips it to test; personal data needs the per-stack opt-in", async () => {
        const w = await seedWorld(pool, {org});
        const test = (p: RestoreDeps["principal"] = principals().admin) => createRestorePlan(deps(p, {configAllowed: undefined}), req(w, {purpose: "test_restore"}));
        const s0 = await maxSeq();
        expect(await test()).toMatchObject({ok: false, code: "test_restore_target_not_test"});
        expect((await events(s0)).at(-1)).toMatchObject({action: "fork.restore_plan.create", result: "denied", d: expect.objectContaining({reason: "test_restore_target_not_test"})});
        // host_role is a SYSTEM ADMIN setting (SEC-11): the org owner can not do it
        await expect(setEnvironmentHostRole(t.db, principals().owner, w.tgtEnv, "test")).rejects.toThrow();
        expect(await setEnvironmentHostRole(t.db, principals().sysadmin, w.tgtEnv, "test")).toEqual({hostRole: "test"});
        // undeclared personal data = personal data (OD-1): refused until the system admin opts the stack in
        expect(await test()).toMatchObject({ok: false, code: "personal_data_no_opt_in"});
        expect(await setStackPrivacy(deps(principals().owner, {configAllowed: undefined}), {stackId: w.stack, containsPersonalData: true, testRestoreOptIn: true})).toMatchObject({ok: false, code: "forbidden"});
        expect(await setStackPrivacy(deps(principals().sysadmin, {configAllowed: undefined}), {stackId: w.stack, containsPersonalData: true, testRestoreOptIn: true})).toEqual({ok: true});
        const ok = await test();
        expect(ok).toMatchObject({ok: true, outcome: "ready"});
        if (!ok.ok) return;
        const plan = RestorePlanV1.parse((await dbRow(ok.planId)).plan);
        expect(plan).toMatchObject({purpose: "test_restore", approvals_required: [], secrets: []});
        expect(plan.actions.every((a) => (a.destination.path ?? "").includes("/scratch/"))).toBe(true);
        expect(plan.actions.some((a) => a.kind === "compose_up")).toBe(false);
        const st = (await q("select contains_personal_data, test_restore_opt_in_by from fork_stack where id=$1", [w.stack])).rows[0];
        expect(st).toEqual({contains_personal_data: true, test_restore_opt_in_by: sysadmin});
        // clearing the opt-in refuses again
        await setStackPrivacy(deps(principals().sysadmin, {configAllowed: undefined}), {stackId: w.stack, containsPersonalData: true, testRestoreOptIn: false});
        expect(await test()).toMatchObject({ok: false, code: "personal_data_no_opt_in"});
        // declared NOT personal ⇒ allowed without opt-in
        await setStackPrivacy(deps(principals().sysadmin, {configAllowed: undefined}), {stackId: w.stack, containsPersonalData: false, testRestoreOptIn: false});
        expect((await test()).ok).toBe(true);
        // a plain restore on the same target is unaffected by the privacy flag
        expect((await create(w, principals().admin)).ok).toBe(true);
    });
    it("mode existing_stack for a test restore is refused", async () => {
        const w = await seedWorld(pool, {org, hostRole: "test"});
        await q("update fork_stack set contains_personal_data=false where id=$1", [w.stack]);
        expect(await create(w, principals().admin, {purpose: "test_restore", mode: "existing_stack"})).toMatchObject({ok: false, code: "test_restore_mode_invalid"});
    });
});

describe("approvals reference the hash", () => {
    it("records the hash; idempotent per kind; wrong hash / tamper / blocked / not required are refused", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        const body = {planId: r.planId, planHash: r.planHash, kind: "production_target"};
        expect(await approveRestorePlan(deps(principals().owner), {...body, planHash: "0".repeat(64)})).toMatchObject({ok: false, code: "hash_mismatch"});
        expect(await approveRestorePlan(deps(principals().owner), {...body, kind: "destructive_replace"})).toMatchObject({ok: false, code: "approval_not_required"});
        const a1 = await approveRestorePlan(deps(principals().owner), body);
        const a2 = await approveRestorePlan(deps(principals().owner), body);
        expect(a1.ok && a2.ok).toBe(true);
        const x = await dbRow(r.planId);
        expect(x.approvals).toEqual([{kind: "production_target", capability: "restore.production.approve", plan_hash: r.planHash, approved_by: owner, approved_at: clock.toISOString()}]);
        // the approval did not change the hash-bound plan
        expect(hashPlan(RestorePlanV1.parse(x.plan))).toBe(r.planHash);
        // tamper: flip an action op inside the stored jsonb
        await q("update fork_restore_plan set plan = jsonb_set(plan, '{actions,0,op}', '\"skip\"') where id=$1", [r.planId]);
        expect(await approveRestorePlan(deps(principals().owner), body)).toMatchObject({ok: false, code: "plan_tampered"});
        expect(await loadFreshPlan(deps(principals().admin), r.planId, r.planHash)).toMatchObject({ok: false, code: "plan_tampered"});
        const view = await getRestorePlanView(deps(principals().admin), {planId: r.planId});
        expect(view).toMatchObject({ok: false, code: "plan_tampered"});
    });
    it("a blocked plan can not be approved", async () => {
        const w = await seedWorld(pool, {org, caps: ["channel.v1"]});
        const r = await must(w);
        expect(r.outcome).toBe("blocked");
        expect(await approveRestorePlan(deps(principals().owner), {planId: r.planId, planHash: r.planHash, kind: "production_target"})).toMatchObject({ok: false, code: "plan_blocked"});
    });
});

describe("freshness / expiry (injected clock)", () => {
    const fresh = async (w: World, id: string, hash: string, at: number) => { const t1 = new Date(clock.getTime() + at); return loadFreshPlan({db: t.db, principal: principals().admin, now: () => t1}, id, hash); };
    it("fresh for 23 h 59 m, expired at 24 h", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        expect((await fresh(w, r.planId, r.planHash, 24 * 3_600_000 - 60_000)).ok).toBe(true);
        expect(await fresh(w, r.planId, r.planHash, 24 * 3_600_000)).toMatchObject({ok: false, code: "expired"});
        expect(await approveRestorePlan(deps(principals().owner, {now: () => new Date(clock.getTime() + 25 * 3_600_000)}), {planId: r.planId, planHash: r.planHash, kind: "production_target"})).toMatchObject({ok: false, code: "expired"});
    });
    it("stale when the target inventory, the host role, the RP, the enrolment or the plan version changes; NOT when only last_sync_at moves", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        const f = async () => (await fresh(w, r.planId, r.planHash, 60_000)).ok;
        expect(await f()).toBe(true);
        await q("update fork_arcane_environment set last_sync_at = last_sync_at + interval '1 hour' where id=$1", [w.tgtEnv]);
        expect(await f()).toBe(true);
        // enrolment capability change
        await q("update fork_agent_enrollment set capabilities = capabilities || '{extra.v1}' where agent_id=$1", [w.agent]);
        expect(await f()).toBe(false);
        await q("update fork_agent_enrollment set capabilities = array_remove(capabilities, 'extra.v1') where agent_id=$1", [w.agent]);
        expect(await f()).toBe(true);
        // host role flip
        await q("update fork_arcane_environment set host_role='test' where id=$1", [w.tgtEnv]);
        expect(await f()).toBe(false);
        await q("update fork_arcane_environment set host_role='production' where id=$1", [w.tgtEnv]);
        expect(await f()).toBe(true);
        // a new target inventory (content hash changes the facts)
        const ts = (await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name) values ($1,$2,'env','other','other') returning id", [org, w.tgtEnv])).rows[0].id;
        expect(await f()).toBe(false); // a new project on the target
        await q("delete from fork_stack where id=$1", [ts]);
        expect(await f()).toBe(true);
        // RP downgraded (direct SQL, test only)
        const verifiedAt = (await q("select verified_at from fork_recovery_point where id=$1", [w.rp])).rows[0].verified_at as Date;
        await q("update fork_recovery_point set status='incomplete', verified_at=null, downgrade_reason='artifact_missing' where id=$1", [w.rp]);
        const res = await fresh(w, r.planId, r.planHash, 60_000);
        expect(res).toMatchObject({ok: false, code: "stale"});
        const c = await checkPlanFresh({db: t.db, now: () => new Date(clock.getTime() + 60_000)}, await dbRow(r.planId));
        expect(c).toEqual({fresh: false, code: "stale", reason: "rp_not_verified"});
        await q("update fork_recovery_point set status='verified', verified_at=$2, downgrade_reason=null where id=$1", [w.rp, verifiedAt]);
        expect(await f()).toBe(true);
        // a RE-verification (new verified_at) is a different input: the plan is stale and must be re-planned
        await q("update fork_recovery_point set verified_at = verified_at + interval '1 minute' where id=$1", [w.rp]);
        expect(await f()).toBe(false);
        await q("update fork_recovery_point set verified_at=$2 where id=$1", [w.rp, verifiedAt]);
        // plan version bump
        await q("update fork_restore_plan set plan_version = 2 where id=$1", [r.planId]);
        expect(await fresh(w, r.planId, r.planHash, 60_000)).toMatchObject({ok: false, code: "stale"});
    });
    it("a deleted RP / agent (SET NULL) makes the plan stale (not_found)", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        await q("update fork_restore_plan set target_agent_id = null where id=$1", [r.planId]);
        expect(await checkPlanFresh({db: t.db, now: () => clock}, await dbRow(r.planId))).toEqual({fresh: false, code: "stale", reason: "not_found"});
    });
    it("the view reports freshness", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        const v = await getRestorePlanView(deps(principals().admin), {planId: r.planId});
        expect(v.ok && v.view.freshness).toBe("fresh");
        const old = await getRestorePlanView(deps(principals().admin, {now: () => new Date(clock.getTime() + 25 * 3_600_000)}), {planId: r.planId});
        expect(old.ok && old.view.freshness).toBe("expired");
    });
});

describe("locked mode, rate limit, audit", () => {
    it("locked configuration refuses create / approve / privacy; the read still works", async () => {
        const w = await seedWorld(pool, {org});
        const r = await must(w);
        const locked = {configAllowed: async () => false};
        expect(await create(w, principals().admin, {}, locked)).toMatchObject({ok: false, code: "locked"});
        expect(await approveRestorePlan(deps(principals().owner, locked), {planId: r.planId, planHash: r.planHash, kind: "production_target"})).toMatchObject({ok: false, code: "locked"});
        expect(await setStackPrivacy(deps(principals().sysadmin, locked), {stackId: w.stack, containsPersonalData: false, testRestoreOptIn: false})).toMatchObject({ok: false, code: "locked"});
        expect((await getRestorePlanView(deps(principals().admin, locked), {planId: r.planId})).ok).toBe(true);
    });
    it("the REAL mode gate (failing self-check ⇒ locked) refuses creation", async () => {
        const w = await seedWorld(pool, {org});
        resetForkState(); process.env.FORK_ARCANE_ENABLED = "true"; setLaneStatus({state: "applied"}); registerActivePolicyProbe(async () => 0); registerSelfCheck(async () => ({ok: false, failed: "x"}));
        try { expect(await createRestorePlan(deps(principals().admin, {configAllowed: undefined}), req(w))).toMatchObject({ok: false, code: "locked"}); }
        finally { delete process.env.FORK_ARCANE_ENABLED; resetForkState(); }
    });
    it("the 11th create in a minute is rate limited", async () => {
        const w = await seedWorld(pool, {org});
        const u = P(admin, "user", [org, "admin"]);
        for (let i = 0; i < 10; i++) expect((await createRestorePlan(deps(u), req(w))).ok).toBe(true);
        expect(await createRestorePlan(deps(u), req(w))).toMatchObject({ok: false, code: "rate_limited", retryAfterSeconds: expect.any(Number)});
    });
    it("every success and every denial writes exactly one audit event with the expected action; the chain verifies", async () => {
        const w = await seedWorld(pool, {org});
        const s0 = await maxSeq();
        const r = await must(w);                                                             // success
        await create(w, principals().member);                                                // denied (forbidden)
        await approveRestorePlan(deps(principals().owner), {planId: r.planId, planHash: r.planHash, kind: "production_target"}); // success
        await approveRestorePlan(deps(principals().owner), {planId: r.planId, planHash: "0".repeat(64), kind: "production_target"}); // denied (hash_mismatch)
        await setStackPrivacy(deps(principals().sysadmin), {stackId: w.stack, containsPersonalData: false, testRestoreOptIn: false});  // success
        const ev = (await events(s0)).map((e) => `${e.action}:${e.result}`);
        expect(ev).toEqual(["fork.restore_plan.create:success", "fork.restore_plan.create:denied", "fork.restore_plan.approve:success", "fork.restore_plan.approve:denied", "fork.stack.privacy.set:success"]);
        const first = (await events(s0))[0];
        expect(first.d).toEqual({rp_id: w.rp, rp_sequence: 1, purpose: "restore", mode: "new_stack", target_agent_id: w.agent, plan_hash: r.planHash, outcome: "ready", blockers: [], actions: 4, approvals_required: ["production_target"]});
        expect(await verifyAuditChain(t.db)).toMatchObject({ok: true});
    });
});

describe("canary: the planner never reads or emits a secret", () => {
    it("planted secrets (upstream database config, Arcane API key, storage channel secret, process env) appear in no plan row, audit row, return value, error or console output", async () => {
        const CANARY = `CANARY_W16_${randomUUID().replace(/-/g, "")}`;
        process.env.CANARY_W16 = CANARY;
        const kek = mkdtempSync(path.join(tmpdir(), "w16-kek-"));
        const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
        try {
            const w = await seedWorld(pool, {org});
            // upstream engine source with a password in its config, linked from the member source row
            const db = (await q("insert into databases (name, dbms, agent_id, config) values ('canary-db','postgresql',$1,$2) returning id", [w.agent, JSON.stringify({host: "h", port: 5432, username: "u", password: CANARY, database: "d"})])).rows[0].id;
            await q("update fork_stack_source set database_id=$2 where id=$1", [w.sources.db, db]);
            await insertConnectionWithSecret(t.db, {organizationId: org, name: `canary-${randomUUID().slice(0, 6)}`, baseUrl: "https://arcane.canary", apiKey: CANARY}, kek);
            await q("update storage_channel set config=$2 where organization_id=$1", [org, JSON.stringify({bucket: "b", secretAccessKey: CANARY, accessKeyId: CANARY})]);
            // positive control: the canary really is in the places the planner must not read
            expect(JSON.stringify((await q("select config from databases where id=$1", [db])).rows)).toContain(CANARY);
            expect(JSON.stringify((await q("select config from storage_channel where organization_id=$1", [org])).rows)).toContain(CANARY);
            const out: unknown[] = [];
            const r = await create(w, principals().admin); out.push(r);
            if (!r.ok) throw new Error(r.code);
            out.push(await approveRestorePlan(deps(principals().owner), {planId: r.planId, planHash: r.planHash, kind: "production_target"}));
            out.push(await getRestorePlanView(deps(principals().admin), {planId: r.planId}));
            out.push(await loadFreshPlan(deps(principals().admin), r.planId, r.planHash));
            out.push(await create(w, principals().member));
            const planRows = JSON.stringify((await q("select p::text t from fork_restore_plan p")).rows);
            const auditRows = JSON.stringify((await q("select a::text t from fork_audit_event a")).rows);
            expect(planRows).not.toContain(CANARY);
            expect(auditRows).not.toContain(CANARY);
            expect(JSON.stringify(out)).not.toContain(CANARY);
            for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(CANARY);
        } finally { for (const s of spies) s.mockRestore(); delete process.env.CANARY_W16; rmSync(kek, {recursive: true, force: true}); }
    });
});
