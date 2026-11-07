import {generateKeyPairSync, randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {enrolAgent, loadTaskKey, revokeEnrollment, rotateCredential} from "@/fork/agent-channel/admin";
import {authenticateAgent} from "@/fork/agent-channel/auth";
import {decodeBundle, type ChannelBundle} from "@/fork/agent-channel/bundle";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {pinFingerprint} from "@/fork/agent-channel/envelope";
import {pinDashboardKey, requestCredentialRotation, unpinDashboardKey} from "@/fork/agent-channel/maint";
import {decryptPayload} from "@/fork/agent-channel/payload";
import {enqueueTask, leaseTask, submitResult} from "@/fork/agent-channel/tasks";
import {MAINT_CAPABILITY} from "@/fork/agent-channel/vocab";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {freshForkDb, seedAgent, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

/** W15b: signed channel maintenance (ADR-007 A11/A12). `now` always derives from the real clock at test start (never a fixed past date). */
let t: W04Db; let pool: Pool; let kek: string; let org: string;
const key = testKeypair(); const PASSWORD = `pw-${randomUUID()}`;
let NOW = new Date();
const ENV = {FORK_ALLOW_INSECURE_LOOPBACK: false, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 60};
let serverUrl = "https://dash.example.test";
const CAPS = ["channel.v1", "noop.v1", "plaintext-hash.v1", MAINT_CAPABILITY];
const HOUR = 3_600_000;

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = mkdtempSync(path.join(tmpdir(), "w15b-kek-")); org = await seedOrg(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { resetRateLimits(); NOW = new Date(); serverUrl = "https://dash.example.test"; });

const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
async function user(role: string) {
    const id = randomUUID();
    await pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,$2,$3,true,$4)`, [id, role, `${id}@t.test`, role]);
    const {hashPassword} = await import("better-auth/crypto");
    await pool.query(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), id, id, await hashPassword(PASSWORD)]);
    return id;
}
const deps = (userId: string | null, role = "admin", over: Partial<ChannelDeps> = {}): ChannelDeps => ({
    db: t.db, principal: userId ? {userId, systemRole: role, memberships: []} : null, kekDir: kek, now: () => NOW, serverUrl: () => serverUrl, env: () => ENV,
    keys: {master: async () => Buffer.alloc(32), signing: async () => ({privateKeyPem: key.privateKey, publicKeyPem: key.publicKey})}, configAllowed: async () => true, ...over});

async function enrolled(admin: string, caps: string[] | null = CAPS) {
    const agentId = await seedAgent(pool, org);
    const r = await enrolAgent(deps(admin), {agentId, password: PASSWORD});
    if (!r.ok) throw new Error(`enrol: ${r.code}`);
    if (caps) await pool.query("update fork_agent_enrollment set capabilities=$1, capabilities_seen_at=now() where agent_id=$2", [caps, agentId]);
    return {agentId, bundle: decodeBundle(r.bundle)};
}
const authz = (b: ChannelBundle) => `Bearer ${b.credential}`;
const auth = (agentId: string, header: string | null) => authenticateAgent(t.db, {agentId, authorization: header, source: "1.2.3.4", now: NOW});
async function enrol(b: ChannelBundle) {
    const a = await auth(b.agent_id, authz(b));
    if (!a.ok) throw new Error(`auth ${a.code}`);
    return a.enrollment;
}
const enrolmentRow = async (agentId: string) => (await q("select * from fork_agent_enrollment where agent_id=$1", [agentId]))[0];
const taskRow = async (id: string) => (await q("select * from fork_agent_task where id=$1", [id]))[0];
async function decryptTask(agentId: string, taskId: string) {
    const row = await taskRow(taskId); const e = await enrolmentRow(agentId);
    const k = await loadTaskKey({kekDir: kek}, {id: e.id, taskKeyEnc: e.task_key_enc});
    return JSON.parse(decryptPayload(k, {taskId, agentId, type: row.type}, row.payload_enc).toString("utf8")) as Record<string, string>;
}
const lease = async (b: ChannelBundle, at = NOW) => leaseTask(t.db, await enrol(b), {capabilities: CAPS, leaseSeconds: 60, now: at});
const rsaPem = (bits: number) => generateKeyPairSync("rsa", {modulusLength: bits, publicKeyEncoding: {type: "spki", format: "pem"}, privateKeyEncoding: {type: "pkcs8", format: "pem"}}).publicKey;
const ecPem = () => generateKeyPairSync("ec", {namedCurve: "P-256", publicKeyEncoding: {type: "spki", format: "pem"}, privateKeyEncoding: {type: "pkcs8", format: "pem"}}).publicKey;

describe("signed rotate_credential (A12)", () => {
    it("queues a signed task, parks the new hash in the pending slot, returns and audits no secret; the agent proving the new one promotes it and kills the old one", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        const r = await requestCredentialRotation(deps(admin), {agentId, password: PASSWORD});
        expect(r).toMatchObject({ok: true});
        if (!r.ok) return;
        expect(Object.keys(r).sort()).toEqual(["notAfter", "ok", "taskId"]);
        const row = await taskRow(r.taskId);
        expect(row).toMatchObject({type: "rotate_credential", requires: [MAINT_CAPABILITY], status: "queued", kid: kidOfPublicKey(key.publicKey)});
        const e = await enrolmentRow(agentId);
        expect(e.pending_task_id).toBe(r.taskId);
        expect(new Date(e.pending_valid_until).getTime()).toBe(new Date(r.notAfter).getTime() + 24 * HOUR);
        const {credential} = await decryptTask(agentId, r.taskId);
        expect(credential).toMatch(/^fork\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
        const secret = credential.split(".")[2];
        const dump = JSON.stringify(await q("select * from fork_audit_event")) + JSON.stringify(r);
        expect(dump).not.toContain(secret); expect(dump).not.toContain(bundle.task_key_b64);
        // the old credential still works (the agent has not proven the new one yet) and does NOT promote anything
        expect(await auth(agentId, authz(bundle))).toMatchObject({ok: true});
        expect((await enrolmentRow(agentId)).pending_task_id).toBe(r.taskId);
        // the new one authenticates as `pending`, is promoted, the old one is dead, the confirmation is audited
        expect(await auth(agentId, `Bearer ${credential}`)).toMatchObject({ok: true});
        const after = await enrolmentRow(agentId);
        expect([after.pending_credential_hash, after.pending_task_id, after.pending_valid_until, after.prev_credential_hash]).toEqual([null, null, null, null]);
        expect(await auth(agentId, authz(bundle))).toMatchObject({ok: false, status: 401});
        expect(await auth(agentId, `Bearer ${credential}`)).toMatchObject({ok: true});
        expect((await q("select redacted_details as details, actor_kind from fork_audit_event where action='fork.agent_channel.rotate_confirmed' and resource_id=$1", [agentId]))).toEqual([{details: {taskId: r.taskId}, actor_kind: "system"}]);
        expect((await q("select result from fork_audit_event where action='fork.agent_channel.rotate_task' and resource_id=$1", [agentId])).map((x) => x.result)).toEqual(["success"]);
    });

    it("a rejected/failed result clears the pending slot and the old credential keeps working", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        const r = await requestCredentialRotation(deps(admin), {agentId, password: PASSWORD}) as {taskId: string};
        const leased = (await lease(bundle))!;
        const e = await enrol(bundle);
        expect(await submitResult(t.db, e, {taskId: r.taskId, body: {lease_id: leased.lease_id, status: "failed", reason: "payload_invalid"}, organizationId: org, now: NOW})).toEqual({ok: true});
        expect((await enrolmentRow(agentId)).pending_credential_hash).toBeNull();
        expect(await auth(agentId, authz(bundle))).toMatchObject({ok: true});
        // and a new rotation can be requested again
        expect(await requestCredentialRotation(deps(admin), {agentId, password: PASSWORD})).toMatchObject({ok: true});
    });

    it("a task that was never delivered and expired clears the pending slot (no brick, no stuck rotation)", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        await requestCredentialRotation(deps(admin), {agentId, password: PASSWORD});
        expect((await enrolmentRow(agentId)).pending_task_id).not.toBeNull();
        expect(await lease(bundle, new Date(NOW.getTime() + 11 * 60_000))).toBeNull(); // past not_after (10 min), attempts = 0
        expect((await enrolmentRow(agentId)).pending_credential_hash).toBeNull();
        expect(await auth(agentId, authz(bundle))).toMatchObject({ok: true});
    });

    it("a delivered-but-unfinished task keeps the pending slot until pending_valid_until, then it is dropped", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        const r = await requestCredentialRotation(deps(admin), {agentId, password: PASSWORD}) as {taskId: string; notAfter: string};
        const leased = (await lease(bundle))!; // attempts = 1: the agent may have applied it
        expect(leased.task_id).toBe(r.taskId);
        const credential = (await decryptTask(agentId, r.taskId)).credential;
        // the task expires, but the new credential stays provable for the bound
        expect(await lease(bundle, new Date(NOW.getTime() + 11 * 60_000))).toBeNull();
        expect((await taskRow(r.taskId)).status).toBe("expired");
        expect((await enrolmentRow(agentId)).pending_task_id).toBe(r.taskId);
        // a second request is refused while pending
        expect(await requestCredentialRotation(deps(admin), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "rotation_in_progress"});
        // …after the bound it is dropped on the next lease call, the old credential still works and the new one does not
        const late = new Date(new Date(r.notAfter).getTime() + 24 * HOUR + 1000);
        expect(await lease(bundle, late)).toBeNull();
        expect((await enrolmentRow(agentId)).pending_credential_hash).toBeNull();
        expect(await authenticateAgent(t.db, {agentId, authorization: `Bearer ${credential}`, source: "5.6.7.8", now: late})).toMatchObject({ok: false, status: 401});
        expect(await authenticateAgent(t.db, {agentId, authorization: authz(bundle), source: "5.6.7.8", now: late})).toMatchObject({ok: true});
    });

    it("operator rotation and signed rotation exclude each other; revoke and re-enrol clear the pending slot", async () => {
        const admin = await user("admin");
        const a = await enrolled(admin);
        await requestCredentialRotation(deps(admin), {agentId: a.agentId, password: PASSWORD});
        expect(await rotateCredential(deps(admin), {agentId: a.agentId, password: PASSWORD})).toMatchObject({ok: false, code: "rotation_in_progress"});
        const re = await enrolAgent(deps(admin), {agentId: a.agentId, password: PASSWORD, reenroll: true});
        expect(re.ok).toBe(true);
        expect((await enrolmentRow(a.agentId)).pending_credential_hash).toBeNull();
        const b = await enrolled(admin);
        await requestCredentialRotation(deps(admin), {agentId: b.agentId, password: PASSWORD});
        expect(await revokeEnrollment(deps(admin), {agentId: b.agentId})).toEqual({ok: true});
        const row = await enrolmentRow(b.agentId);
        expect([row.pending_credential_hash, row.pending_task_id, row.pending_valid_until]).toEqual([null, null, null]);
        // an operator rotation (overlap slot) blocks a signed one
        const c = await enrolled(admin);
        await rotateCredential(deps(admin), {agentId: c.agentId, password: PASSWORD});
        expect(await requestCredentialRotation(deps(admin), {agentId: c.agentId, password: PASSWORD})).toMatchObject({ok: false, code: "rotation_in_progress"});
    });
});

describe("pin_add / pin_revoke", () => {
    it("pin_add validates the key (RSA 2048..8192 only), queues a signed task with kid + normalised SPKI, audits kid and fingerprint but never the PEM", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        const k2 = testKeypair();
        for (const bad of ["not a pem", ecPem(), rsaPem(1024), ""]) expect(await pinDashboardKey(deps(admin), {agentId, password: PASSWORD, pem: bad})).toMatchObject({ok: false, code: bad === "" ? "invalid_input" : "invalid_key"});
        expect(await pinDashboardKey(deps(admin), {agentId, password: PASSWORD, pem: key.publicKey})).toMatchObject({ok: false, code: "already_pinned"});
        const r = await pinDashboardKey(deps(admin), {agentId, password: PASSWORD, pem: k2.publicKey});
        expect(r).toMatchObject({ok: true, kid: k2.kid, fingerprint: pinFingerprint(k2.publicKey)});
        if (!r.ok) return;
        expect(await taskRow(r.taskId)).toMatchObject({type: "pin_add", requires: [MAINT_CAPABILITY]});
        const p = await decryptTask(agentId, r.taskId);
        expect(Object.keys(p).sort()).toEqual(["kid", "pem"]);
        expect(p.kid).toBe(k2.kid); expect(kidOfPublicKey(p.pem)).toBe(k2.kid);
        const audit = JSON.stringify(await q("select redacted_details as details from fork_audit_event where action='fork.agent_channel.pin_add'"));
        expect(audit).toContain(k2.kid); expect(audit).toContain(pinFingerprint(k2.publicKey)); expect(audit).not.toContain("PUBLIC KEY");
        // the agent's result updates the pinned kids (sorted, validated); garbage is ignored
        const leased = (await lease(bundle))!; const e = await enrol(bundle);
        const both = [kidOfPublicKey(key.publicKey), k2.kid].sort();
        expect(await submitResult(t.db, e, {taskId: r.taskId, body: {lease_id: leased.lease_id, status: "succeeded", result: {pinned: [...both].reverse()}}, organizationId: org, now: NOW})).toEqual({ok: true});
        expect((await enrolmentRow(agentId)).pinned_kids).toEqual(both);
        const again = await pinDashboardKey(deps(admin), {agentId, password: PASSWORD, pem: rsaPem(2048)}) as {taskId: string};
        const l2 = (await lease(bundle))!;
        await submitResult(t.db, e, {taskId: again.taskId, body: {lease_id: l2.lease_id, status: "succeeded", result: {pinned: ["not-a-kid", 7]}}, organizationId: org, now: NOW});
        expect((await enrolmentRow(agentId)).pinned_kids).toEqual(both);
    });

    it("pin_limit at 8, and a refusal never queues anything", async () => {
        const admin = await user("admin");
        const {agentId} = await enrolled(admin);
        await pool.query("update fork_agent_enrollment set pinned_kids=$1 where agent_id=$2", [Array.from({length: 8}, (_, i) => `00000000000${i}`), agentId]);
        expect(await pinDashboardKey(deps(admin), {agentId, password: PASSWORD, pem: testKeypair().publicKey})).toMatchObject({ok: false, code: "pin_limit"});
        expect(await q("select 1 from fork_agent_task where agent_id=$1", [agentId])).toHaveLength(0);
    });

    it("unpin: never the signing key, never an unknown kid, never the last pin; success queues a signed pin_revoke", async () => {
        const admin = await user("admin");
        const {agentId} = await enrolled(admin);
        const k2 = testKeypair(); const kid1 = kidOfPublicKey(key.publicKey);
        const set = (kids: string[]) => pool.query("update fork_agent_enrollment set pinned_kids=$1 where agent_id=$2", [kids, agentId]);
        await set([kid1, k2.kid]);
        expect(await unpinDashboardKey(deps(admin), {agentId, password: PASSWORD, kid: kid1})).toMatchObject({ok: false, code: "pin_in_use"});
        expect(await unpinDashboardKey(deps(admin), {agentId, password: PASSWORD, kid: "ffffffffffff"})).toMatchObject({ok: false, code: "not_pinned"});
        expect(await unpinDashboardKey(deps(admin), {agentId, password: PASSWORD, kid: "NOT-A-KID"})).toMatchObject({ok: false, code: "invalid_input"});
        await set([k2.kid]);
        expect(await unpinDashboardKey(deps(admin), {agentId, password: PASSWORD, kid: k2.kid})).toMatchObject({ok: false, code: "last_pin"});
        await set([kid1, k2.kid]);
        const r = await unpinDashboardKey(deps(admin), {agentId, password: PASSWORD, kid: k2.kid});
        expect(r).toMatchObject({ok: true, kid: k2.kid});
        if (r.ok) { expect(await taskRow(r.taskId)).toMatchObject({type: "pin_revoke"}); expect(await decryptTask(agentId, r.taskId)).toEqual({kid: k2.kid}); }
    });
});

describe("gates shared by every maintenance service", () => {
    const calls: [string, (d: ChannelDeps, agentId: string, password?: string) => Promise<{ok: boolean; code?: string}>][] = [
        ["rotate", (d, agentId, password = PASSWORD) => requestCredentialRotation(d, {agentId, password})],
        ["pin_add", (d, agentId, password = PASSWORD) => pinDashboardKey(d, {agentId, password, pem: testKeypair().publicKey})],
        ["pin_revoke", (d, agentId, password = PASSWORD) => unpinDashboardKey(d, {agentId, password, kid: "ffffffffffff"})],
    ];
    for (const [name, call] of calls) {
        it(`${name}: non-admin forbidden (+ denied audit), locked, http, wrong password, missing capability, disabled, revoked`, async () => {
            const admin = await user("admin"); const plain = await user("user");
            const {agentId} = await enrolled(admin);
            expect(await call(deps(plain, "user"), agentId)).toMatchObject({ok: false, code: "forbidden"});
            expect(await call(deps(null), agentId)).toMatchObject({ok: false, code: "forbidden"});
            expect((await q("select result, redacted_details as details from fork_audit_event where actor_user_id=$1 and resource_id=$2", [plain, agentId])).map((r) => `${r.result}:${r.details.reason}`)).toContain("denied:forbidden");
            expect(await call(deps(admin, "admin", {configAllowed: async () => false}), agentId)).toMatchObject({ok: false, code: "locked"});
            expect(await call(deps(admin), agentId, "wrong")).toMatchObject({ok: false, code: "step_up_failed"});
            serverUrl = "http://192.168.8.32:8887";
            expect(await call(deps(admin), agentId)).toMatchObject({ok: false, code: "insecure_transport"});
            serverUrl = "https://dash.example.test";
            expect(await q("select 1 from fork_agent_task where agent_id=$1", [agentId])).toHaveLength(0);
            // an agent that never reported channel-maint.v1
            const old = await enrolled(admin, ["channel.v1", "noop.v1"]);
            expect(await call(deps(admin), old.agentId)).toMatchObject({ok: false, code: "capability_missing"});
            // disabled / revoked
            await pool.query("update fork_agent_enrollment set enabled=false where agent_id=$1", [agentId]);
            expect(await call(deps(admin), agentId)).toMatchObject({ok: false, code: "agent_disabled"});
            await revokeEnrollment(deps(admin), {agentId});
            expect(await call(deps(admin), agentId)).toMatchObject({ok: false, code: "not_enrolled"});
            expect(await call(deps(admin), randomUUID())).toMatchObject({ok: false, code: "not_found"});
        });
    }

    it("the generic enqueue refuses every maintenance type; the DB has no secret after any of this (canary scan)", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        for (const type of ["pin_add", "pin_revoke", "rotate_credential"]) {
            expect(await enqueueTask(deps(admin), {agentId, type, payload: {kid: "ffffffffffff", credential: `fork.${agentId}.${"Z".repeat(43)}`, pem: "x"}})).toMatchObject({ok: false, code: "invalid_input"});
        }
        expect(await q("select 1 from fork_agent_task where agent_id=$1", [agentId])).toHaveLength(0);
        const r = await requestCredentialRotation(deps(admin), {agentId, password: PASSWORD}) as {taskId: string};
        const secret = (await decryptTask(agentId, r.taskId)).credential.split(".")[2];
        const dump = JSON.stringify(await q("select * from fork_audit_event")) + JSON.stringify(await q("select id, type, kid, status, result, envelope_text, signature from fork_agent_task"))
            + JSON.stringify(await q("select credential_hash, pending_credential_hash, pinned_kids from fork_agent_enrollment"));
        expect(dump).not.toContain(secret); expect(dump).not.toContain(bundle.task_key_b64); expect(dump).not.toContain("PUBLIC KEY");
        // the DB constraint: pending columns are all-or-none
        const fresh = await enrolled(admin);
        await expect(pool.query("update fork_agent_enrollment set pending_credential_hash=$1 where agent_id=$2", ["a".repeat(64), fresh.agentId])).rejects.toThrow(/pending_ck|violates check/);
    });
});
