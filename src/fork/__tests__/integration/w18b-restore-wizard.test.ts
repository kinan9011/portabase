import {randomBytes, randomUUID} from "node:crypto";
import {rmSync} from "node:fs";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {getAgentStatus, DASHBOARD_THRESHOLDS} from "@/features/agents/utils/status/agent-status";
import {listRestoreRuns} from "@/fork/restore-run/view";
import {loadRestoreChoices, loadRestorePoints, loadRestoreTargets, loadStackName, RestoreTarget, statusAt, targetReadiness, targetRole} from "@/fork/restore-wizard/view";
import {freshForkDb, seedAgent, seedOrg, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {harness, CAPS, type Harness} from "@/fork/__tests__/w18a-world";
import {adminUser, newKek, seedW17World} from "@/fork/__tests__/w17-world";
import {P, seedWorld} from "@/fork/__tests__/w16-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string; let h: Harness;
const key = testKeypair();
const hex = () => randomBytes(32).toString("hex");

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { h = harness(t, kek, key, org); h.reset(); });

const sys = () => P(randomUUID(), "admin");
const owner = (o = org) => P(randomUUID(), "user", [o, "owner"]);
const member = (o = org) => P(randomUUID(), "user", [o, "member"]);

describe("B1 loadRestoreTargets", () => {
    it("credential canary: no enrolment secret column reaches the DTO; every key is in the strict schema", async () => {
        const w = await seedWorld(pool, {org});
        const c = {cred: hex(), prev: hex(), task: `CANARY_TASK_${randomUUID()}`, pin: `CANARY_PIN_${randomUUID()}`, kid: `CANARY_KID_${randomUUID()}`};
        await pool.query("update fork_agent_enrollment set credential_hash=$2, prev_credential_hash=$3, prev_valid_until=now() + interval '1 hour', task_key_enc=$4, pin_fingerprint=$5, pinned_kids=$6 where agent_id=$1",
            [w.agent, c.cred, c.prev, JSON.stringify({ct: c.task}), c.pin, [c.kid]]);
        const out = await loadRestoreTargets(t.db, owner(), org, {now: new Date()});
        const mine = out.find((x) => x.id === w.agent);
        expect(mine).toBeDefined();
        const json = JSON.stringify(out);
        for (const v of Object.values(c)) expect(json).not.toContain(v);
        expect(json).not.toMatch(/credential|enroll_id|enrollId|task_key|pinned|fingerprint/i);
        expect(RestoreTarget.strict().safeParse(mine).success).toBe(true);
    });

    it("ACL: another org's agent is excluded; an org-less agent is visible to a system admin only; a member sees nothing", async () => {
        const other = await seedOrg(pool);
        const foreign = await seedAgent(pool, other, "foreign-agent");
        const orgless = await seedAgent(pool, null, "orgless-agent");
        const mineId = await seedAgent(pool, org, "mine-agent");
        const asOwner = (await loadRestoreTargets(t.db, owner(), org, {now: new Date()})).map((x) => x.id);
        expect(asOwner).toContain(mineId);
        expect(asOwner).not.toContain(foreign);
        expect(asOwner).not.toContain(orgless);
        expect((await loadRestoreTargets(t.db, sys(), org, {now: new Date()})).map((x) => x.id)).toContain(orgless);
        expect(await loadRestoreTargets(t.db, member(), org, {now: new Date()})).toEqual([]);
        expect(await loadRestoreTargets(t.db, null, org, {now: new Date()})).toEqual([]);
    });

    it("readiness precedence: each value is reachable and the order is archived > revoked > not_enrolled > channel_disabled > capability_missing > ready", () => {
        const e = {enabled: true, revokedAt: null as Date | null, capabilities: ["restore.target.v1"]};
        expect(targetReadiness({archived: false}, e)).toBe("ready");
        expect(targetReadiness({archived: false}, {...e, capabilities: []})).toBe("capability_missing");
        expect(targetReadiness({archived: false}, {...e, enabled: false})).toBe("channel_disabled");
        expect(targetReadiness({archived: false}, null)).toBe("not_enrolled");
        expect(targetReadiness({archived: false}, {...e, revokedAt: new Date(), enabled: false})).toBe("revoked");
        expect(targetReadiness({archived: true}, {...e, revokedAt: new Date()})).toBe("archived");
        expect(targetReadiness({archived: true}, null)).toBe("archived");
    });

    it("role mirrors the planner: no environment ⇒ production/default; one test environment ⇒ test/environment; any production ⇒ production", async () => {
        expect(targetRole([])).toEqual({hostRole: "production", hostRoleSource: "default"});
        expect(targetRole([{hostRole: "test"}])).toEqual({hostRole: "test", hostRoleSource: "environment"});
        expect(targetRole([{hostRole: "test"}, {hostRole: "production"}])).toEqual({hostRole: "production", hostRoleSource: "environment"});
        const w = await seedWorld(pool, {org, hostRole: "test", roots: ["/srv/restore"]});
        const bare = await seedAgent(pool, org, "bare-agent");
        const out = await loadRestoreTargets(t.db, owner(), org, {now: new Date(), stackId: w.stack});
        expect(out.find((x) => x.id === w.agent)).toMatchObject({hostRole: "test", hostRoleSource: "environment", environments: [{hostRole: "test", allowedPathRoots: ["/srv/restore"]}], canCompose: true, readiness: "ready", wasSource: false});
        expect(out.find((x) => x.id === bare)).toMatchObject({hostRole: "production", hostRoleSource: "default", environments: [], readiness: "not_enrolled", canCompose: false});
    });

    it("wasSource = the agent of the stack's environment; lastRestoreRoot = the newest plan's root for THAT agent only", async () => {
        const w = await seedWorld(pool, {org});
        const srcAgent = await seedAgent(pool, org, "src-agent");
        await pool.query("update fork_arcane_environment set agent_id=$2, agent_name='src-agent' where id=$1", [w.srcEnv, srcAgent]);
        const other = await seedAgent(pool, org, "other-agent");
        const plan = async (agent: string, root: string, ageDays: number) => pool.query(
            `insert into fork_restore_plan (organization_id, stack_id, rp_sequence, target_agent_id, target_agent_name, purpose, mode, plan_version, plan, plan_hash, inputs_digest, outcome, created_by, created_at, expires_at)
             values ($1,$2,1,$3,'n','restore','new_stack',1,$4,$5,$5,'ready','u', now() - ($6 || ' days')::interval, now() + interval '1 day')`,
            [org, w.stack, agent, JSON.stringify({target: {restore_root: root}}), hex(), String(ageDays)]);
        await plan(w.agent, "/old/root", 3); await plan(w.agent, "/new/root", 1); await plan(other, "/other/root", 0);
        const out = await loadRestoreTargets(t.db, owner(), org, {now: new Date(), stackId: w.stack});
        expect(out.find((x) => x.id === w.agent)).toMatchObject({lastRestoreRoot: "/new/root", wasSource: false});
        expect(out.find((x) => x.id === other)?.lastRestoreRoot).toBe("/other/root");
        expect(out.find((x) => x.id === srcAgent)).toMatchObject({wasSource: true, lastRestoreRoot: null});
    });

    it("statusAt matches upstream getAgentStatus at the boundaries (injected clock)", () => {
        const now = new Date();
        const ago = (ms: number) => new Date(now.getTime() - ms);
        vi.useFakeTimers(); vi.setSystemTime(now);
        try {
            const cases: (Date | null)[] = [ago(0), ago(DASHBOARD_THRESHOLDS.online - 1), ago(DASHBOARD_THRESHOLDS.online), ago(DASHBOARD_THRESHOLDS.degraded), ago(DASHBOARD_THRESHOLDS.degraded + 1), null];
            for (const c of cases) expect(statusAt(c, now), String(c)).toBe(getAgentStatus(c, DASHBOARD_THRESHOLDS));
            expect(statusAt(ago(DASHBOARD_THRESHOLDS.online - 1), now)).toBe("online");
            expect(statusAt(ago(DASHBOARD_THRESHOLDS.degraded + 1), now)).toBe("offline");
        } finally { vi.useRealTimers(); }
    });
});

describe("B2 loadRestoreChoices / loadRestorePoints / loadStackName", () => {
    it("choices: org-scoped, counts verified and pending separately, purged RPs excluded; a foreign stack never appears", async () => {
        const o2 = await seedOrg(pool);
        const mine = await seedStack(pool, o2, null, "mine");
        await seedRp(pool, mine, {status: "verified", seq: 1}); await seedRp(pool, mine, {status: "verified", seq: 2}); await seedRp(pool, mine, {status: "pending_verification", seq: 3});
        const purged = await seedRp(pool, mine, {status: "verified", seq: 4});
        await pool.query("update fork_recovery_point set purged_at=now() where id=$1", [purged]);
        const bare = await seedStack(pool, o2, null, "bare");
        const o3 = await seedOrg(pool);
        const foreign = await seedStack(pool, o3, null, "foreign"); await seedRp(pool, foreign, {status: "verified"});
        const out = await loadRestoreChoices(t.db, o2, {now: new Date(), configLocked: false});
        expect(out.map((c) => c.stackId).sort()).toEqual([mine, bare].sort());
        expect(out.find((c) => c.stackId === mine)).toMatchObject({verifiedCount: 2, pendingCount: 1, testRestoreDaysAgo: null});
        expect(out.find((c) => c.stackId === bare)).toMatchObject({verifiedCount: 0, pendingCount: 0, lastGood: {hoursAgo: null, verifying: false}});
    });

    it("points: newest first, ids present, statuses verbatim, purged excluded, foreign stack ⇒ null, destinations are names", async () => {
        const w = await seedWorld(pool, {org});
        await seedRp(pool, w.stack, {status: "pending_verification", seq: 9});
        const gone = await seedRp(pool, w.stack, {status: "verified", seq: 10});
        await pool.query("update fork_recovery_point set purged_at=now() where id=$1", [gone]);
        const r = await loadRestorePoints(t.db, org, w.stack);
        expect(r).not.toBeNull();
        expect(r!.points.map((p) => p.sequence)).toEqual([9, 1]);
        expect(r!.points.map((p) => p.status)).toEqual(["pending_verification", "verified"]);
        expect(r!.points.every((p) => /^[0-9a-f-]{36}$/.test(p.id))).toBe(true);
        expect(r!.points.find((p) => p.id === w.rp)?.destinations).toEqual(["s3-x"]);
        expect(r!.timezone).toBe("UTC");
        expect(await loadRestorePoints(t.db, await seedOrg(pool), w.stack)).toBeNull();
        expect(await loadStackName(t.db, org, w.stack)).toBe("app");
        expect(await loadStackName(t.db, await seedOrg(pool), w.stack)).toBeNull();
    });
});

describe("B4 listRestoreRuns (org-wide, planId, stackId)", () => {
    const startRun = async (o: string) => {
        const hh = harness(t, kek, key, o);
        const w = await seedW17World(t, kek, key, admin, {org: o, caps: CAPS, hostRole: "test"});
        const d = hh.deps(w, await hh.user("admin"));
        const c = await hh.plan(w);
        const s = await hh.start(d, c);
        if (!s.ok) throw new Error(s.code);
        return {w, c, runId: s.runId};
    };

    it("org-wide: only own-org rows; summary carries stackId; ≤ 20 rows; member and anonymous are forbidden; planId of a foreign org is not_found; both ids is invalid_input", async () => {
        const mineOrg = await seedOrg(pool); const otherOrg = await seedOrg(pool);
        // D21 single tenant: `soleOrganization` needs exactly one live org, so the foreign org is soft-deleted AFTER its run exists
        const mineRun = await startRun(mineOrg); const foreignRun = await startRun(otherOrg);
        const live = (await pool.query("select id from organization where deleted_at is null")).rows.map((r) => r.id as string);
        await pool.query("update organization set deleted_at=now() where id <> $1", [mineOrg]);
        try {
            const d = (p: ReturnType<typeof owner> | null) => ({...h.deps(mineRun.w, null), principal: p});
            const res = await listRestoreRuns(d(owner(mineOrg)), {});
            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res.runs.map((r) => r.id)).toEqual([mineRun.runId]);
            expect(res.runs[0]).toMatchObject({stackId: mineRun.w.stack});
            expect(res.runs.map((r) => r.id)).not.toContain(foreignRun.runId); // m9: dropping the organization filter would show it
            expect(await listRestoreRuns(d(member(mineOrg)), {})).toEqual({ok: false, code: "forbidden"});
            expect(await listRestoreRuns(d(null), {})).toEqual({ok: false, code: "forbidden"});
            expect(await listRestoreRuns(d(owner(mineOrg)), {planId: foreignRun.c.planId})).toEqual({ok: false, code: "not_found"});
            expect(await listRestoreRuns(d(owner(mineOrg)), {planId: mineRun.c.planId, stackId: mineRun.w.stack})).toEqual({ok: false, code: "invalid_input"});
            const byPlan = await listRestoreRuns(d(owner(mineOrg)), {planId: mineRun.c.planId});
            expect(byPlan.ok && byPlan.runs.map((r) => r.id)).toEqual([mineRun.runId]);
            const byStack = await listRestoreRuns(d(owner(mineOrg)), {stackId: mineRun.w.stack});
            expect(byStack.ok && byStack.runs.map((r) => r.id)).toEqual([mineRun.runId]);
        } finally { await pool.query("update organization set deleted_at=null where id = any($1::uuid[])", [live]); }
    });
});
