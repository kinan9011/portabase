import {randomUUID} from "node:crypto";
import {eq} from "drizzle-orm";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {rmSync} from "node:fs";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {decryptPayload} from "@/fork/agent-channel/payload";
import {verifyEnvelope} from "@/fork/agent-channel/envelope";
import {enqueueTask, heartbeatTask, insertSignedTask, leaseTask, submitResult} from "@/fork/agent-channel/tasks";
import {loadTaskKey} from "@/fork/agent-channel/admin";
import {RESTORE_TASK_TYPES} from "@/fork/agent-channel/vocab";
import {RESTORE_REASONS} from "@/fork/restore-tasks/codes";
import {enqueueRestoreTask, type RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {adminUser, approveRestorePlan, createRestorePlan, deps as chDeps, newKek, P, req, seedW17World, type W17} from "@/fork/__tests__/w17-world";
import {seedUser} from "@/fork/__tests__/w16-world";
import {signManifest} from "@/fork/manifest/sign";
import {buildManifest} from "@/fork/manifest/build";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string; let member: string; let outsider: string;
const key = testKeypair();
let NOW = new Date("2026-11-07T12:00:00Z");
const SECRET_QS = "X-Amz-Signature=SECRETSIG123&X-Amz-Credential=AKIACANARY";
const url = (n: string) => `https://minio.example.test/bucket/${n}?${SECRET_QS}`;
const urls = async (id: string) => url(id);
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const principal = (id: string, role: string | null, org2?: string): RestoreTaskDeps => chDeps(t, kek, key, id, {role, memberships: org2 ? [[org2, role === "admin" ? "member" : (role ?? "member")]] : [], now: () => NOW, over: {artifactUrl: urls}});
const asAdmin = (over: Partial<RestoreTaskDeps> = {}): RestoreTaskDeps => ({...chDeps(t, kek, key, admin, {role: "user", memberships: [[org, "admin"]], now: () => NOW, over: {artifactUrl: urls}}), ...over});

beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool);
    admin = await adminUser(pool); member = await seedUser(pool); outsider = await seedUser(pool);
});
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { resetRateLimits(); NOW = new Date("2026-11-07T12:00:00Z"); });

/** A plan in `restore` mode on a test host: `selective`, everything selected. */
async function planFor(w: W17, over: Record<string, unknown> = {}, approve = true) {
    const clock = {now: () => NOW};
    const keys = ["compose", "volume", "db"].map((r) => ({compose: "dir:/srv/app", volume: "volume:app_data", db: "db:db"}[r] as string));
    const c = await createRestorePlan({db: t.db, principal: P(admin, "user", [org, "admin"]), configAllowed: async () => true, ...clock}, req(w, {mode: "selective", mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: keys, sqlite: null}, ...over}));
    if (!c.ok) throw new Error(`plan refused: ${c.code}`);
    if (approve) for (const kind of ["production_target", "destructive_replace"] as const) {
        await approveRestorePlan({db: t.db, principal: P(admin, "admin"), configAllowed: async () => true, ...clock}, {planId: c.planId, planHash: c.planHash, kind});
    }
    return c;
}
const stage = (w: W17, c: {planId: string; planHash: string}, over: Record<string, unknown> = {}) => ({type: "restore_stage", planId: c.planId, planHash: c.planHash, restoreId: randomUUID(), manifest: {json: w.manifestJson, sigB64: w.manifestSig}, ...over});
const enrolmentOf = async (agentId: string) => (await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId)))[0];
const audits = async () => q("select action, result, redacted_details d from fork_audit_event where action like 'fork.restore_task%' order by seq");

describe("restore task enqueue (the only builder of restore tasks)", () => {
    it("happy path: strict payload, envelope targeted at the plan's target, audit without URL/manifest/path", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const c = await planFor(w);
        const restoreId = randomUUID();
        const r = await enqueueRestoreTask(asAdmin(), stage(w, c, {restoreId}));
        expect(r).toMatchObject({ok: true});
        if (!r.ok) return;
        const [task] = await q("select * from fork_agent_task where id=$1", [r.taskId]);
        expect(task.type).toBe("restore_stage");
        expect(task.agent_id).toBe(w.agent);
        const env = JSON.parse(task.envelope_text);
        expect(env.target_agent_id).toBe(w.agent);
        expect(env.requires).toEqual(["restore.target.v1"]);
        expect(verifyEnvelope(task.envelope_text, task.signature, [{kid: key.kid, pem: key.publicKey}])).toMatchObject({ok: true});
        const enr = await enrolmentOf(w.agent);
        const payload = JSON.parse(decryptPayload(await loadTaskKey(chDeps(t, kek, key, admin), enr), {taskId: task.id, agentId: w.agent, type: "restore_stage"}, task.payload_enc).toString());
        expect(payload).toMatchObject({v: 1, restore_id: restoreId, plan_id: c.planId, plan_hash: c.planHash, rp_id: w.rp, stack_id: w.stack, purpose: "restore", mode: "selective", host_role: "test", workspace: "/srv/restore/app"});
        expect(payload.manifest.sha256).toBe(w.manifestSha);
        expect(Buffer.from(payload.manifest.json_b64, "base64").toString()).toBe(w.manifestJson);
        expect(payload.artifacts).toHaveLength(3);
        expect(payload.artifacts.every((a: {url: string}) => a.url.includes("SECRETSIG123"))).toBe(true);
        expect(payload.paths.every((p: {dest: string}) => p.dest.startsWith("/srv/restore/app/"))).toBe(true);
        // canary: nothing sensitive in audit (URL query, manifest bytes, paths)
        const dump = JSON.stringify(await audits()) + JSON.stringify(await q("select result from fork_agent_task"));
        for (const bad of ["SECRETSIG123", "AKIACANARY", "minio.example.test", w.manifestSig.slice(0, 40), "/srv/restore"]) expect(dump).not.toContain(bad);
        expect(await audits()).toContainEqual(expect.objectContaining({action: "fork.restore_task.enqueue", result: "success"}));
    });

    it("forbidden: member, outsider, unknown plan (same answer, audited as denied)", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const c = await planFor(w);
        for (const d of [principal(member, "user", org), principal(outsider, "user", randomUUID()), chDeps(t, kek, key, null)]) {
            expect(await enqueueRestoreTask(d, stage(w, c))).toEqual({ok: false, code: "forbidden"});
        }
        expect(await enqueueRestoreTask(asAdmin(), stage(w, {planId: randomUUID(), planHash: c.planHash}))).toEqual({ok: false, code: "forbidden"});
        expect(await q("select 1 from fork_agent_task where agent_id=$1", [w.agent])).toHaveLength(0);
    });

    it("locked / rate limited / invalid input", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const c = await planFor(w);
        expect(await enqueueRestoreTask(asAdmin({configAllowed: async () => false}), stage(w, c))).toMatchObject({ok: false, code: "locked"});
        expect(await enqueueRestoreTask(asAdmin(), {...stage(w, c), extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await enqueueRestoreTask(asAdmin(), {type: "noop"})).toMatchObject({ok: false, code: "invalid_input"});
        const limited = asAdmin({rate: () => ({ok: false, retryAfterSeconds: 7})});
        expect(await enqueueRestoreTask(limited, stage(w, c))).toMatchObject({ok: false, code: "rate_limited", retryAfterSeconds: 7});
    });

    it("stale / expired / tampered-hash plans are refused (cleanup of an aged-out plan still works)", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const c = await planFor(w);
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c, {planHash: "0".repeat(64)}))).toMatchObject({ok: false, code: "hash_mismatch"});
        NOW = new Date(NOW.getTime() + 25 * 3_600_000); // past the 24 h plan lifetime
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c))).toMatchObject({ok: false, code: "expired"});
        expect(await enqueueRestoreTask(asAdmin(), {type: "restore_apply", planId: c.planId, planHash: c.planHash, restoreId: randomUUID(), manifest: {json: w.manifestJson, sigB64: w.manifestSig}})).toMatchObject({ok: false, code: "expired"});
        const r = await enqueueRestoreTask(asAdmin(), {type: "restore_cleanup", planId: c.planId, planHash: c.planHash, restoreId: randomUUID(), cleanup: {workspace: true, volumes: true, networks: true, containers: false}});
        expect(r).toMatchObject({ok: true});
        await pool.query("update fork_restore_plan set plan_hash = $2 where id=$1", [c.planId, "1".repeat(64)]);
        expect(await enqueueRestoreTask(asAdmin(), {type: "restore_cleanup", planId: c.planId, planHash: "1".repeat(64), restoreId: randomUUID(), cleanup: {workspace: true, volumes: true, networks: true, containers: false}})).toMatchObject({ok: false, code: "plan_tampered"});
    });

    it("unapproved production target is refused; approved passes", async () => {
        const w = await seedW17World(t, kek, key, admin, {org, hostRole: "production"});
        const c = await planFor(w, {}, false);
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c))).toMatchObject({ok: false, code: "approval_missing"});
        await approveRestorePlan({db: t.db, principal: P(admin, "admin"), configAllowed: async () => true, now: () => NOW}, {planId: c.planId, planHash: c.planHash, kind: "production_target"});
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c))).toMatchObject({ok: true});
    });

    it("blocked plan, existing_stack plan", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const blocked = await planFor(w, {mappings: {target_project: null, restore_root: null, volumes: null, select: ["dir:/srv/app"], sqlite: null}}, false);
        expect(await enqueueRestoreTask(asAdmin(), stage(w, blocked))).toMatchObject({ok: false, code: "plan_blocked"});
        const w2 = await seedW17World(t, kek, key, admin, {org});
        const ex = await createRestorePlan({db: t.db, principal: P(admin, "user", [org, "admin"]), configAllowed: async () => true, now: () => NOW}, req(w2, {mode: "existing_stack"}));
        if (ex.ok) expect(await enqueueRestoreTask(asAdmin(), stage(w2, ex))).toMatchObject({ok: false});
    });

    it("capability missing / channel disabled / not enrolled: refused with the code, task never inserted", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const c = await planFor(w);
        // a capability change makes the plan stale for stage/apply (the planner re-runs); cleanup uses the untampered row only, so it reaches the enrolment checks
        const cleanup = {type: "restore_cleanup", planId: c.planId, planHash: c.planHash, restoreId: randomUUID(), cleanup: {workspace: true, volumes: true, networks: true, containers: false}};
        await pool.query("update fork_agent_enrollment set capabilities=$2 where agent_id=$1", [w.agent, ["channel.v1", "noop.v1"]]);
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c))).toMatchObject({ok: false, code: "stale"});
        expect(await enqueueRestoreTask(asAdmin(), cleanup)).toMatchObject({ok: false, code: "capability_missing"});
        await pool.query("update fork_agent_enrollment set capabilities=$2, enabled=false where agent_id=$1", [w.agent, ["channel.v1", "restore.target.v1"]]);
        expect(await enqueueRestoreTask(asAdmin(), cleanup)).toMatchObject({ok: false, code: "agent_disabled"});
        await pool.query("update fork_agent_enrollment set enabled=true, revoked_at=now() where agent_id=$1", [w.agent]);
        expect(await enqueueRestoreTask(asAdmin(), cleanup)).toMatchObject({ok: false, code: "not_enrolled"});
        expect(await q("select 1 from fork_agent_task where agent_id=$1", [w.agent])).toHaveLength(0);
    });

    it("forged manifests: other key, tampered byte, other RP (rollback), sha ≠ plan", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const c = await planFor(w);
        const other = testKeypair();
        const m = JSON.parse(w.manifestJson);
        const forged = signManifest({...m, kid: other.kid}, other.privateKey);
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c, {manifest: {json: forged.json, sigB64: forged.sig.toString("base64")}}))).toMatchObject({ok: false, code: "manifest_mismatch"});
        const tampered = w.manifestJson.replace('"app"', '"apq"');
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c, {manifest: {json: tampered, sigB64: w.manifestSig}}))).toMatchObject({ok: false, code: "manifest_mismatch"});
        // an older RP of the same stack posing as the planned one
        const older = signManifest({...m, rp: {...m.rp, id: randomUUID(), sequence: 0 + 1}}, key.privateKey);
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c, {manifest: {json: older.json, sigB64: older.sig.toString("base64")}}))).toMatchObject({ok: false, code: "manifest_mismatch"});
        // a valid signature over different bytes (changed sequence ⇒ different sha, wrong binding)
        const reseq = signManifest({...m, signed_at: "2026-11-07T11:00:00Z"}, key.privateKey);
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c, {manifest: {json: reseq.json, sigB64: reseq.sig.toString("base64")}}))).toMatchObject({ok: false, code: "manifest_mismatch"});
        expect(await q("select 1 from fork_agent_task where agent_id=$1", [w.agent])).toHaveLength(0);
    });

    it("payload too large, artifact unavailable", async () => {
        const w = await seedW17World(t, kek, key, admin, {org, extraManifestArtifacts: 200});
        const c = await planFor(w);
        expect(await enqueueRestoreTask(asAdmin(), stage(w, c))).toMatchObject({ok: false, code: "payload_too_large"});
        const w2 = await seedW17World(t, kek, key, admin, {org});
        const c2 = await planFor(w2);
        expect(await enqueueRestoreTask(asAdmin({artifactUrl: async () => null}), stage(w2, c2))).toMatchObject({ok: false, code: "artifact_unavailable"});
    });

    it("target is always the plan's target; restore_probe works for an org admin; apply carries the manifest hash; cleanup carries the flags", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const c = await planFor(w);
        const a = await enqueueRestoreTask(asAdmin(), {type: "restore_apply", planId: c.planId, planHash: c.planHash, restoreId: randomUUID(), manifest: {json: w.manifestJson, sigB64: w.manifestSig}});
        expect(a).toMatchObject({ok: true});
        const p = await enqueueRestoreTask(asAdmin(), {type: "restore_probe", agentId: w.agent});
        expect(p).toMatchObject({ok: true});
        const rows = await q("select type, envelope_text from fork_agent_task where agent_id=$1 order by seq", [w.agent]);
        for (const r of rows) expect(JSON.parse(r.envelope_text).target_agent_id).toBe(w.agent);
        expect(await enqueueRestoreTask(principal(member, "user", org), {type: "restore_probe", agentId: w.agent})).toEqual({ok: false, code: "forbidden"});
    });
});

describe("channel changes of W17-i", () => {
    it("the generic enqueue refuses every restore task type; targeted insert without/with a foreign target throws", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        for (const type of RESTORE_TASK_TYPES) expect(await enqueueTask(chDeps(t, kek, key, admin, {role: "admin"}), {agentId: w.agent, type, payload: {}})).toMatchObject({ok: false, code: "invalid_input"});
        const e = await enrolmentOf(w.agent);
        const base = {e: e, agentName: "x", type: "restore_probe" as const, plaintext: Buffer.from("{}"), actorUserId: admin, signing: {privateKeyPem: key.privateKey}, kid: key.kid, taskKey: Buffer.alloc(32), now: NOW, ttlMs: 1000};
        await expect(t.db.transaction((tx) => insertSignedTask(tx as never, base))).rejects.toThrow(/target_agent_id/);
        await expect(t.db.transaction((tx) => insertSignedTask(tx as never, {...base, targetAgentId: randomUUID()}))).rejects.toThrow(/target_agent_id/);
        await expect(t.db.transaction((tx) => insertSignedTask(tx as never, {...base, type: "noop", targetAgentId: w.agent}))).rejects.toThrow(/targeted/);
    });

    it("a re-queued ACCEPTED task past not_after is leased again, a never-started one expires (G9)", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const e = await enrolmentOf(w.agent);
        const mk = async () => { const r = await enqueueRestoreTask(asAdmin(), {type: "restore_probe", agentId: w.agent}); if (!r.ok) throw new Error(r.code); return r.taskId; };
        const t1 = await mk();
        const l1 = await leaseTask(t.db, e, {capabilities: ["restore.target.v1"], leaseSeconds: 60, now: NOW});
        expect(l1?.task_id).toBe(t1);
        // lease lapses AND not_after (10 min) passes: the accepted task must come back, not expire
        const later = new Date(NOW.getTime() + 20 * 60_000);
        const l2 = await leaseTask(t.db, e, {capabilities: ["restore.target.v1"], leaseSeconds: 60, now: later});
        expect(l2?.task_id).toBe(t1);
        expect((await q("select status, attempts from fork_agent_task where id=$1", [t1]))[0]).toMatchObject({status: "leased", attempts: 2});
        await submitResult(t.db, e, {taskId: t1, body: {lease_id: l2!.lease_id, status: "succeeded", result: {}}, organizationId: org, now: later});
        // never started: queued, past not_after, attempts 0 ⇒ expired
        const t2 = await mk();
        const l3 = await leaseTask(t.db, e, {capabilities: [], leaseSeconds: 60, now: new Date(later.getTime() + 20 * 60_000)});
        expect(l3).toBeNull();
        expect((await q("select status from fork_agent_task where id=$1", [t2]))[0].status).toBe("expired");
    });

    it("a result with a new restore code is accepted; an unknown code is a 400; detail travels inside result", async () => {
        const w = await seedW17World(t, kek, key, admin, {org});
        const e = await enrolmentOf(w.agent);
        for (const code of ["symlink_escape", ...RESTORE_REASONS]) {
            const r = await enqueueRestoreTask(asAdmin(), {type: "restore_probe", agentId: w.agent});
            if (!r.ok) throw new Error(r.code);
            const l = await leaseTask(t.db, e, {capabilities: ["restore.target.v1"], leaseSeconds: 60, now: NOW});
            expect(await heartbeatTask(t.db, e, {taskId: r.taskId, leaseId: l!.lease_id, leaseSeconds: 60, now: NOW})).toMatchObject({ok: true});
            expect(await submitResult(t.db, e, {taskId: r.taskId, body: {lease_id: l!.lease_id, status: "failed", reason: code, result: {detail: "not_covered", artifact: 2}}, organizationId: org, now: NOW})).toMatchObject({ok: true});
            const [row] = await q("select result from fork_agent_task where id=$1", [r.taskId]);
            expect(row.result).toMatchObject({reason: code, detail: "not_covered", artifact: 2});
        }
        const r = await enqueueRestoreTask(asAdmin(), {type: "restore_probe", agentId: w.agent});
        if (!r.ok) throw new Error(r.code);
        const l = await leaseTask(t.db, e, {capabilities: ["restore.target.v1"], leaseSeconds: 60, now: NOW});
        expect(await submitResult(t.db, e, {taskId: r.taskId, body: {lease_id: l!.lease_id, status: "failed", reason: "made_up_code"}, organizationId: org, now: NOW})).toMatchObject({ok: false, status: 400});
    });
});

void buildManifest;
