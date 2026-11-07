import {createHash, randomUUID} from "node:crypto";
import {rmSync} from "node:fs";
import {eq} from "drizzle-orm";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {loadTaskKey} from "@/fork/agent-channel/admin";
import {decryptPayload} from "@/fork/agent-channel/payload";
import {insertSignedTask, leaseTask} from "@/fork/agent-channel/tasks";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {buildPolicyApproval} from "@/fork/policy/approval";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {enqueueRestoreTask, type RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {latestRender, renderVerdict, submitRender} from "@/fork/restore-tasks/render";
import {blankPolicyView} from "@/fork/restore-tasks/view";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {adminUser, approveRestorePlan, createRestorePlan, deps as chDeps, newKek, P, req, seedW17World, type W17} from "@/fork/__tests__/w17-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string;
const key = testKeypair();
const NOW = new Date("2026-11-07T12:00:00Z");
const CAPS = ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"];
const W = "/srv/restore/app";
const CANARY = "OVERRIDE-CANARY-4417";
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const asAdmin = (over: Partial<RestoreTaskDeps> = {}): RestoreTaskDeps => ({...chDeps(t, kek, key, admin, {role: "user", memberships: [[org, "admin"]], now: () => NOW}), artifactUrl: async (id) => `https://minio.example.test/${id}?X-Amz-Signature=S`, ...over});

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => resetRateLimits());

const DOC = {name: "app", services: {web: {image: "nginx:1", environment: {A: "x"}, networks: {default: null}}}, networks: {default: {name: "app_default"}}};
async function planFor(w: W17, select = ["dir:/srv/app", "volume:app_data", "db:db"], mode: "new_stack" | "selective" = "new_stack") {
    const clock = {now: () => NOW};
    const c = await createRestorePlan({db: t.db, principal: P(admin, "user", [org, "admin"]), configAllowed: async () => true, ...clock}, req(w, {mode, mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select, sqlite: null}}));
    if (!c.ok) throw new Error(`plan refused: ${c.code}`);
    for (const kind of ["production_target", "destructive_replace"] as const) await approveRestorePlan({db: t.db, principal: P(admin, "admin"), configAllowed: async () => true, ...clock}, {planId: c.planId, planHash: c.planHash, kind});
    return c;
}
const manifest = (w: W17) => ({json: w.manifestJson, sigB64: w.manifestSig});
const enr = async (agentId: string) => (await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId)))[0]!;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** a SUCCEEDED compose_render task of `w.agent` with a stored (blanked) render of `doc` for `restoreId` */
async function storedRender(w: W17, restoreId: string, doc: unknown, o: {status?: "succeeded" | "failed"} = {}) {
    const e = await enr(w.agent);
    const taskKey = await loadTaskKey(chDeps(t, kek, key, admin), e);
    const ins = await t.db.transaction((tx) => insertSignedTask(tx as never, {e, agentName: "x", type: "compose_render", plaintext: Buffer.from("{}"), targetAgentId: w.agent, actorUserId: admin, signing: {privateKeyPem: key.privateKey}, kid: key.kid, taskKey, now: NOW, ttlMs: 600_000}));
    const l = await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW});
    const view = Buffer.from(JSON.stringify(blankPolicyView(doc)));
    const r = await submitRender(t.db, e, {taskId: ins.taskId, organizationId: org, now: NOW, body: {lease_id: l!.lease_id, restore_id: restoreId, view_b64: view.toString("base64"), view_sha256: sha(view), raw: {refused: false, violations: [], reason: null}, roots: [W], files: ["compose.yml"], compose_version: "5.4.0", rules_sha256: "e".repeat(64)}});
    expect(r).toMatchObject({ok: true});
    await pool.query("update fork_agent_task set status=$2, finished_at=now(), lease_id=null, lease_until=null where id=$1", [ins.taskId, o.status ?? "succeeded"]);
    return {taskId: ins.taskId, sha: sha(view)};
}
const payloadOf = async (w: W17, taskId: string, type: string) => {
    const [task] = await q("select * from fork_agent_task where id=$1", [taskId]);
    return JSON.parse(decryptPayload(await loadTaskKey(chDeps(t, kek, key, admin), await enr(w.agent)), {taskId, agentId: w.agent, type}, task.payload_enc).toString());
};
const world = () => seedW17World(t, kek, key, admin, {org, caps: CAPS});

describe("compose task enqueue (W17-ii E14)", () => {
    it("compose_render: strict payload with the compose ref, capability both, audit without overrides", async () => {
        const w = await world();
        const c = await planFor(w);
        const restoreId = randomUUID();
        const r = await enqueueRestoreTask(asAdmin(), {type: "compose_render", planId: c.planId, planHash: c.planHash, restoreId, manifest: manifest(w), overrides: {env: {OVERRIDE_PROBE: CANARY}, overrideYml: "services:\n  web:\n    image: nginx:2\n"}});
        expect(r).toMatchObject({ok: true});
        if (!r.ok) return;
        const [task] = await q("select * from fork_agent_task where id=$1", [r.taskId]);
        expect(JSON.parse(task.envelope_text).requires).toEqual(["compose.render.v1", "restore.target.v1"]);
        const p = await payloadOf(w, r.taskId, "compose_render");
        expect(p).toMatchObject({restore_id: restoreId, manifest_sha256: w.manifestSha, workspace: W});
        expect(p.compose.dir.startsWith(`${W}/`)).toBe(true);
        expect(p.compose.env).toEqual({OVERRIDE_PROBE: CANARY});
        // canary: the override value is only inside payload_enc
        const everything = JSON.stringify(await q("select * from fork_agent_task where id=$1", [r.taskId])) + JSON.stringify(await q("select * from fork_audit_event"));
        expect(everything).not.toContain(CANARY);
        expect(everything).not.toContain("nginx:2");
    });

    it("an agent without compose.render.v1 gets no compose task (planner blocks); a selective plan has no compose_up ⇒ mode_unsupported", async () => {
        const nocaps = await seedW17World(t, kek, key, admin, {org, caps: ["channel.v1", "noop.v1", "restore.target.v1"]});
        const c0 = await planFor(nocaps);
        expect(await enqueueRestoreTask(asAdmin(), {type: "compose_render", planId: c0.planId, planHash: c0.planHash, restoreId: randomUUID(), manifest: manifest(nocaps)})).toMatchObject({ok: false, code: "plan_blocked"});
        const w2 = await world();
        const c2 = await planFor(w2, ["dir:/srv/app", "volume:app_data"], "selective");
        expect(await enqueueRestoreTask(asAdmin(), {type: "compose_render", planId: c2.planId, planHash: c2.planHash, restoreId: randomUUID(), manifest: manifest(w2)})).toMatchObject({ok: false, code: "mode_unsupported"});
    });

    it("a poisoned override YAML is refused before signing: raw_refused, no task row", async () => {
        const w = await world();
        const c = await planFor(w);
        const before = (await q("select count(*)::int n from fork_agent_task"))[0].n;
        const r = await enqueueRestoreTask(asAdmin(), {type: "compose_render", planId: c.planId, planHash: c.planHash, restoreId: randomUUID(), manifest: manifest(w), overrides: {env: {}, overrideYml: "services:\n  web:\n    env_file: /etc/passwd\n"}});
        expect(r).toMatchObject({ok: false, code: "raw_refused"});
        expect((await q("select count(*)::int n from fork_agent_task"))[0].n).toBe(before);
    });

    it("compose_up / restore_db need a stored render of THIS agent and restore; failed or foreign renders are ignored", async () => {
        const w = await world();
        const c = await planFor(w);
        const restoreId = randomUUID();
        const up = (extra: Record<string, unknown> = {}, rid = restoreId) => enqueueRestoreTask(asAdmin(), {type: "compose_up", planId: c.planId, planHash: c.planHash, restoreId: rid, manifest: manifest(w), approval: null, ...extra});
        expect(await up()).toMatchObject({ok: false, code: "render_missing"});
        await storedRender(w, restoreId, DOC, {status: "failed"});
        expect(await up()).toMatchObject({ok: false, code: "render_missing"});
        const other = await world();
        await storedRender(other, restoreId, DOC); // another agent's render of "the same" restore id
        expect(await up()).toMatchObject({ok: false, code: "render_missing"});
        const good = await storedRender(w, restoreId, DOC);
        expect((await latestRender(t.db, {restoreId, agentId: w.agent}))?.taskId).toBe(good.taskId);
        const r = await up();
        expect(r).toMatchObject({ok: true});
        if (!r.ok) return;
        const p = await payloadOf(w, r.taskId, "compose_up");
        expect(p).toMatchObject({compose_sha256: good.sha, approval: null, manifest_sha256: w.manifestSha});
        expect(p.volumes.length).toBeGreaterThan(0);
        // `allow` verdict + a token ⇒ approval_invalid
        expect(await up({approval: {v: 1}})).toMatchObject({ok: false, code: "approval_invalid"});
        // restore_db: the plan has a PostgreSQL dump
        const d = await enqueueRestoreTask(asAdmin(), {type: "restore_db", planId: c.planId, planHash: c.planHash, restoreId, manifest: manifest(w), approval: null});
        expect(d).toMatchObject({ok: true});
        if (d.ok) expect((await payloadOf(w, d.taskId, "restore_db")).dbs.length).toBeGreaterThan(0);
    });

    it("flagged render: no token ⇒ approval_invalid; exact token ⇒ signed payload carries it; hard refusal ⇒ policy_refused", async () => {
        const w = await world();
        const c = await planFor(w);
        const restoreId = randomUUID();
        const flagged = {...DOC, services: {web: {...DOC.services.web, privileged: true}}};
        const row0 = await storedRender(w, restoreId, flagged);
        const rid2 = randomUUID();
        await storedRender(w, rid2, {...DOC, services: {web: {...DOC.services.web, env_file: [{path: "/etc/passwd"}]}}});
        const up = (approval: unknown) => enqueueRestoreTask(asAdmin(), {type: "compose_up", planId: c.planId, planHash: c.planHash, restoreId, manifest: manifest(w), approval});
        expect(await up(null)).toMatchObject({ok: false, code: "approval_invalid"});
        const verdict = renderVerdict((await latestRender(t.db, {restoreId, agentId: w.agent}))!, W);
        expect(verdict.verdict).toBe("needs-explicit-override");
        const built = buildPolicyApproval({verdict, confirmations: {web: "ALLOW web"}, context: {stack_id: w.stack, rp_id: w.rp, target_agent_id: w.agent}});
        if (!built.ok) throw new Error(built.code);
        const r = await up(built.token);
        expect(r).toMatchObject({ok: true});
        if (r.ok) expect(await payloadOf(w, r.taskId, "compose_up")).toMatchObject({compose_sha256: row0.sha, approval: built.token});
        // a token for another agent is refused
        const foreign = buildPolicyApproval({verdict, confirmations: {web: "ALLOW web"}, context: {stack_id: w.stack, rp_id: w.rp, target_agent_id: randomUUID()}});
        if (foreign.ok) expect(await up(foreign.token)).toMatchObject({ok: false, code: "approval_invalid"});
        // a hard refusal (the render reads outside the root) ⇒ policy_refused, whatever the token
        expect(await enqueueRestoreTask(asAdmin(), {type: "compose_up", planId: c.planId, planHash: c.planHash, restoreId: rid2, manifest: manifest(w), approval: built.token})).toMatchObject({ok: false, code: "policy_refused"});
    });

    it("restore_db on a plan without PostgreSQL dumps is mode_unsupported", async () => {
        const w = await world();
        const c = await planFor(w, ["dir:/srv/app", "volume:app_data"], "selective");
        const restoreId = randomUUID();
        await storedRender(w, restoreId, DOC);
        expect(await enqueueRestoreTask(asAdmin(), {type: "restore_db", planId: c.planId, planHash: c.planHash, restoreId, manifest: manifest(w), approval: null})).toMatchObject({ok: false, code: "mode_unsupported"});
    });
});
