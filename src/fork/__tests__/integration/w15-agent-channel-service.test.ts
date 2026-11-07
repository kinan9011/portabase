import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {enrolAgent, revokeEnrollment, rotateCredential, setChannelEnabled} from "@/fork/agent-channel/admin";
import {authenticateAgent} from "@/fork/agent-channel/auth";
import {decodeBundle, type ChannelBundle} from "@/fork/agent-channel/bundle";
import {parseBearer} from "@/fork/agent-channel/credential";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {verifyEnvelope} from "@/fork/agent-channel/envelope";
import {recordHashReport} from "@/fork/agent-channel/hash-report";
import {decryptPayload} from "@/fork/agent-channel/payload";
import {enqueueTask, heartbeatTask, leaseTask, submitResult} from "@/fork/agent-channel/tasks";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {freshForkDb, seedAgent, seedBackup, seedChannel, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

let t: W04Db; let pool: Pool; let kek: string; let org: string;
const key = testKeypair(); const PASSWORD = `pw-${randomUUID()}`;
let NOW = new Date("2026-11-07T12:00:00Z");
const ENV = {FORK_ALLOW_INSECURE_LOOPBACK: false, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 60};
let serverUrl = "https://dash.example.test";

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = mkdtempSync(path.join(tmpdir(), "w15-kek-")); org = await seedOrg(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { resetRateLimits(); NOW = new Date("2026-11-07T12:00:00Z"); serverUrl = "https://dash.example.test"; });

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

async function enrolled(admin: string, version: string | null = "1.25.2") {
    const agentId = await seedAgent(pool, org);
    if (version !== undefined) await pool.query("update agents set version=$1 where id=$2", [version, agentId]);
    const r = await enrolAgent(deps(admin), {agentId, password: PASSWORD});
    if (!r.ok) throw new Error(`enrol: ${r.code}`);
    return {agentId, bundle: decodeBundle(r.bundle), raw: r.bundle};
}
const authz = (b: ChannelBundle) => `Bearer ${b.credential}`;
async function auth(agentId: string, header: string | null, source = "1.2.3.4") {
    return authenticateAgent(t.db, {agentId, authorization: header, source, now: NOW});
}
async function enrol(admin: string, b: ChannelBundle) {
    const a = await auth(b.agent_id, authz(b));
    if (!a.ok) throw new Error(`auth ${a.code}`);
    return a.enrollment;
}
const CAPS = ["channel.v1", "noop.v1", "plaintext-hash.v1"];

describe("enrol / revoke / rotate (ADR-007 D2)", () => {
    it("only a system admin with the right password and an https URL can enrol; the secret is stored hashed only", async () => {
        const admin = await user("admin"); const plain = await user("user");
        const agentId = await seedAgent(pool, org);
        expect(await enrolAgent(deps(plain, "user"), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "forbidden"});
        expect(await enrolAgent(deps(null), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "forbidden"});
        expect(await enrolAgent(deps(admin), {agentId, password: "nope"})).toMatchObject({ok: false, code: "step_up_failed"});
        serverUrl = "http://192.168.8.32:8887"; // the pilot: plain-HTTP LAN
        expect(await enrolAgent(deps(admin), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "insecure_transport"});
        expect(await enrolAgent(deps(admin, "admin", {env: () => ({...ENV, FORK_ALLOW_INSECURE_LOOPBACK: true})}), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "insecure_transport"});
        expect(await q("select 1 from fork_agent_enrollment where agent_id=$1", [agentId])).toHaveLength(0);
        serverUrl = "https://dash.example.test";
        expect(await enrolAgent(deps(admin, "admin", {configAllowed: async () => false}), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "locked"});
        const r = await enrolAgent(deps(admin), {agentId, password: PASSWORD});
        expect(r).toMatchObject({ok: true, reenrolled: false});
        if (!r.ok) return;
        const b = decodeBundle(r.bundle);
        expect(b.pins[0].kid).toBe(r.kid); expect(b.server_url).toBe(serverUrl); expect(b.pin_fingerprint).toBe(r.pinFingerprint);
        const secret = parseBearer(`Bearer ${b.credential}`)!.secret;
        const dump = JSON.stringify(await q("select * from fork_agent_enrollment")) + JSON.stringify(await q("select * from fork_audit_event"));
        expect(dump).not.toContain(secret); expect(dump).not.toContain(b.task_key_b64);
        expect(await enrolAgent(deps(admin), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "already_enrolled"});
        expect(await enrolAgent(deps(admin), {agentId, password: PASSWORD, reenroll: true})).toMatchObject({ok: true, reenrolled: true});
    });

    it("credential: unknown agent, wrong secret, wrong agent path, malformed header — all the same 401; version never matters", async () => {
        const admin = await user("admin");
        for (const version of ["1.25.2", "1.0.0", null]) {
            const {agentId, bundle} = await enrolled(admin, version);
            expect(await auth(agentId, authz(bundle))).toMatchObject({ok: true});
        }
        const {agentId, bundle} = await enrolled(admin);
        const other = await enrolled(admin);
        const wrong = `Bearer fork.${agentId}.${"A".repeat(43)}`;
        const results = [
            await auth(agentId, wrong), await auth(agentId, null), await auth(agentId, "Bearer junk"),
            await auth(randomUUID(), authz(bundle)), await auth("not-a-uuid", authz(bundle)),
            await auth(agentId, authz(other.bundle)), // X's credential on Y's path
            await auth(other.agentId, authz(bundle)),
        ];
        for (const r of results) expect(r).toEqual({ok: false, status: 401, code: "unauthorized"});
    });

    it("revoke is immediate and cancels open tasks; disable answers 403 only to the real credential; re-enrol makes old tasks unleasable", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        let e = await enrol(admin, bundle);
        await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW});
        const queued = await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "a1"}});
        expect(queued.ok).toBe(true);
        expect(await setChannelEnabled(deps(admin), {agentId, enabled: false})).toMatchObject({ok: true, enabled: false});
        expect(await auth(agentId, authz(bundle))).toEqual({ok: false, status: 403, code: "channel_disabled"});
        expect(await auth(agentId, `Bearer fork.${agentId}.${"B".repeat(43)}`)).toMatchObject({status: 401}); // a stranger learns nothing
        expect(await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "a2"}})).toMatchObject({ok: false, code: "agent_disabled"});
        await setChannelEnabled(deps(admin), {agentId, enabled: true});
        // re-enrol: the queued task of the old generation is cancelled and the old credential is dead
        const re = await enrolAgent(deps(admin), {agentId, password: PASSWORD, reenroll: true});
        expect(re.ok).toBe(true);
        expect(await auth(agentId, authz(bundle))).toMatchObject({ok: false, status: 401});
        expect((await q("select status from fork_agent_task where agent_id=$1", [agentId])).map((r) => r.status)).toEqual(["cancelled"]);
        const nb = decodeBundle((re as {bundle: string}).bundle);
        e = await enrol(admin, nb);
        expect(await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW})).toBeNull();
        expect(await revokeEnrollment(deps(admin), {agentId})).toEqual({ok: true});
        expect(await auth(agentId, authz(nb))).toMatchObject({ok: false, status: 401});
        expect(await revokeEnrollment(deps(await user("user"), "user"), {agentId})).toMatchObject({ok: false, code: "forbidden"});
    });

    it("rotation: both secrets work until the new one is first used, then only the new one; the overlap also ends after 24 h", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        const r = await rotateCredential(deps(admin), {agentId, password: PASSWORD});
        expect(r.ok).toBe(true);
        const fresh = `Bearer ${(r as {credential: string}).credential}`;
        expect(await auth(agentId, authz(bundle))).toMatchObject({ok: true});
        expect(await auth(agentId, fresh)).toMatchObject({ok: true});
        expect(await auth(agentId, authz(bundle))).toMatchObject({ok: false, status: 401});
        // time-based end of overlap
        const second = await rotateCredential(deps(admin), {agentId, password: PASSWORD});
        const f2 = `Bearer ${(second as {credential: string}).credential}`;
        NOW = new Date(NOW.getTime() + 25 * 3_600_000);
        expect(await auth(agentId, fresh)).toMatchObject({ok: false, status: 401});
        expect(await auth(agentId, f2)).toMatchObject({ok: true});
        expect(await rotateCredential(deps(admin), {agentId, password: "bad"})).toMatchObject({ok: false, code: "step_up_failed"});
    });

    it("rate limits failed attempts per source (429 with Retry-After seconds)", async () => {
        const admin = await user("admin");
        const {agentId} = await enrolled(admin);
        let last;
        for (let i = 0; i < 40; i++) last = await auth(agentId, `Bearer fork.${agentId}.${"C".repeat(43)}`, "9.9.9.9");
        expect(last).toMatchObject({ok: false, status: 429, code: "rate_limited"});
    });
});

describe("task round trip + isolation (ADR-007 D1/D3/D4/D7/D8)", () => {
    it("queue → lease → verify under the pinned key → decrypt → heartbeat → result; idempotent result; payload purged; no canary in DB/audit", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        const e = await enrol(admin, bundle);
        // capability gate: nothing can be enqueued before the agent reported noop.v1
        expect(await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "x"}})).toMatchObject({ok: false, code: "capability_missing"});
        expect(await leaseTask(t.db, e, {capabilities: [...CAPS, "Bad Cap!", 7, "x".repeat(200)], leaseSeconds: 60, now: NOW})).toBeNull();
        expect((await q("select capabilities from fork_agent_enrollment where agent_id=$1", [agentId]))[0].capabilities).toEqual(["channel.v1", "noop.v1", "plaintext-hash.v1"]);
        const enq = await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "CANARY-ECHO-7"}});
        expect(enq).toMatchObject({ok: true, seq: 1});
        const leased = await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW});
        expect(leased).not.toBeNull();
        const v = verifyEnvelope(leased!.envelope, leased!.signature, bundle.pins);
        expect(v).toMatchObject({ok: true});
        const env = (v as {envelope: any}).envelope;
        expect(env).toMatchObject({agent_id: agentId, enroll_id: bundle.enroll_id, type: "noop", seq: 1, requires: ["noop.v1"]});
        expect(env.not_after - env.issued_at).toBe(600);
        const plain = decryptPayload(Buffer.from(bundle.task_key_b64, "base64"), {taskId: env.task_id, agentId, type: "noop"}, leased!.payload_enc!);
        expect(JSON.parse(plain.toString())).toEqual({echo: "CANARY-ECHO-7"});
        // the same lease is handed out again (one task in flight)
        expect((await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW}))!.lease_id).toBe(leased!.lease_id);
        expect(await heartbeatTask(t.db, e, {taskId: env.task_id, leaseId: leased!.lease_id, leaseSeconds: 60, now: NOW})).toMatchObject({ok: true});
        expect(await heartbeatTask(t.db, e, {taskId: env.task_id, leaseId: randomUUID(), leaseSeconds: 60, now: NOW})).toMatchObject({ok: false, status: 409});
        const body = {lease_id: leased!.lease_id, status: "succeeded", result: {echo: "CANARY-ECHO-7", token: "should-be-redacted-secret", note: "ok"}};
        expect(await submitResult(t.db, e, {taskId: env.task_id, body, organizationId: org, now: NOW})).toEqual({ok: true});
        expect(await submitResult(t.db, e, {taskId: env.task_id, body, organizationId: org, now: NOW})).toEqual({ok: true, duplicate: true});
        expect(await submitResult(t.db, e, {taskId: env.task_id, body: {...body, status: "failed"}, organizationId: org, now: NOW})).toMatchObject({ok: false, status: 409});
        const [row] = await q("select status, payload_enc, result, lease_id, finished_at from fork_agent_task where id=$1", [env.task_id]);
        expect(row.status).toBe("succeeded"); expect(row.payload_enc).toBeNull(); expect(row.lease_id).toBeNull(); expect(row.finished_at).not.toBeNull();
        expect(JSON.stringify(row.result)).not.toContain("should-be-redacted-secret");
        const dump = JSON.stringify(await q("select * from fork_audit_event"));
        expect(dump).not.toContain("CANARY-ECHO-7");
        expect((await q("select action, result from fork_audit_event where action like 'fork.agent_task.%' and resource_id = any($1) order by seq", [[agentId, env.task_id]])).map((r) => `${r.action}:${r.result}`)).toEqual(["fork.agent_task.enqueue:denied", "fork.agent_task.enqueue:success", "fork.agent_task.result:success"]); // the denied one = capability_missing before the first lease
        expect(await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW})).toBeNull();
    });

    it("isolation (E2): agent X can never lease, heartbeat, finish or read the task of agent Y; with the real routes' auth X's bearer on Y's path is a 401", async () => {
        const admin = await user("admin");
        const x = await enrolled(admin), y = await enrolled(admin);
        const ex = await enrol(admin, x.bundle), ey = await enrol(admin, y.bundle);
        await leaseTask(t.db, ey, {capabilities: CAPS, leaseSeconds: 60, now: NOW});
        const enq = await enqueueTask(deps(admin), {agentId: y.agentId, type: "noop", payload: {echo: "forY"}}) as {taskId: string};
        expect(await leaseTask(t.db, ex, {capabilities: CAPS, leaseSeconds: 60, now: NOW})).toBeNull();
        expect(await auth(y.agentId, authz(x.bundle))).toMatchObject({ok: false, status: 401});
        const leased = (await leaseTask(t.db, ey, {capabilities: CAPS, leaseSeconds: 60, now: NOW}))!;
        // X holds Y's task id and lease id (worst case) but is a different enrolment
        expect(await heartbeatTask(t.db, ex, {taskId: enq.taskId, leaseId: leased.lease_id, leaseSeconds: 60, now: NOW})).toMatchObject({ok: false, status: 404});
        expect(await submitResult(t.db, ex, {taskId: enq.taskId, body: {lease_id: leased.lease_id, status: "succeeded"}, organizationId: org, now: NOW})).toMatchObject({ok: false, status: 404});
        // Y's payload is unreadable with X's task key
        expect(() => decryptPayload(Buffer.from(x.bundle.task_key_b64, "base64"), {taskId: enq.taskId, agentId: y.agentId, type: "noop"}, leased.payload_enc!)).toThrow();
        // ... and the envelope is signed for Y only
        const env = (verifyEnvelope(leased.envelope, leased.signature, y.bundle.pins) as {envelope: any}).envelope;
        expect(env.agent_id).toBe(y.agentId); expect(env.agent_id).not.toBe(x.agentId);
        expect((await q("select status from fork_agent_task where id=$1", [enq.taskId]))[0].status).toBe("leased");
    });

    it("seq is strictly increasing per agent; expiry, lost leases and attempts behave (at-least-once, bounded)", async () => {
        const admin = await user("admin");
        const {agentId, bundle} = await enrolled(admin);
        const e = await enrol(admin, bundle);
        await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW});
        const t1 = await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "t1"}}) as {taskId: string; seq: number};
        const t2 = await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "t2"}}) as {taskId: string; seq: number};
        expect([t1.seq, t2.seq]).toEqual([1, 2]);
        // lowest seq first; a lease that is never renewed returns the task to the queue
        const l1 = (await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW}))!;
        expect(l1.task_id).toBe(t1.taskId);
        NOW = new Date(NOW.getTime() + 61_000);
        const again = (await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW}))!;
        expect(again.task_id).toBe(t1.taskId); expect(again.lease_id).not.toBe(l1.lease_id);
        expect(await heartbeatTask(t.db, e, {taskId: t1.taskId, leaseId: l1.lease_id, leaseSeconds: 60, now: NOW})).toMatchObject({ok: false, status: 409}); // stale lease id
        // past not_after nothing starts: both expire and their payload is purged
        NOW = new Date(NOW.getTime() + 11 * 60_000);
        expect(await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW})).toBeNull();
        const rows = await q("select status, payload_enc from fork_agent_task where agent_id=$1 order by seq", [agentId]);
        expect(rows.map((r) => r.status)).toEqual(["expired", "expired"]); expect(rows.every((r) => r.payload_enc === null)).toBe(true);
        // attempts are bounded: a task whose lease is lost 5 times fails
        const t3 = await enqueueTask(deps(admin, "admin", {now: () => NOW}), {agentId, type: "noop", payload: {echo: "t3"}}) as {taskId: string; seq: number};
        expect(t3.seq).toBe(3);
        for (let i = 0; i < 5; i++) { await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 15, now: NOW}); NOW = new Date(NOW.getTime() + 16_000); }
        await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 15, now: NOW});
        expect((await q("select status, result from fork_agent_task where id=$1", [t3.taskId]))[0]).toMatchObject({status: "failed", result: {reason: "lease_lost"}});
    });

    it("enqueue is an audited admin-only mutation: forbidden / locked / bad payload / http are refused and audited, no task is created", async () => {
        const admin = await user("admin"); const plain = await user("user");
        const {agentId, bundle} = await enrolled(admin);
        const e = await enrol(admin, bundle);
        await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW});
        expect(await enqueueTask(deps(plain, "user"), {agentId, type: "noop", payload: {echo: "x"}})).toMatchObject({ok: false, code: "forbidden"});
        expect(await enqueueTask(deps(admin, "admin", {configAllowed: async () => false}), {agentId, type: "noop", payload: {echo: "x"}})).toMatchObject({ok: false, code: "locked"});
        expect(await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "has space"}})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "x", extra: 1}})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await enqueueTask(deps(admin), {agentId, type: "format_disk", payload: {}})).toMatchObject({ok: false, code: "invalid_input"});
        serverUrl = "http://192.168.8.32:8887";
        expect(await enqueueTask(deps(admin), {agentId, type: "noop", payload: {echo: "x"}})).toMatchObject({ok: false, code: "insecure_transport"});
        expect(await q("select 1 from fork_agent_task where agent_id=$1", [agentId])).toHaveLength(0);
        expect((await q("select redacted_details->>'reason' r from fork_audit_event where action='fork.agent_task.enqueue' and result='denied' and resource_id=$1 order by seq", [agentId])).map((r) => r.r)).toEqual(expect.arrayContaining(["forbidden", "locked", "insecure_transport"]));
    });
});

describe("D45 hash report (ADR-007 / W15)", () => {
    it("needs the capability, only for the agent's own backups, first report wins, conflict is refused + audited", async () => {
        const admin = await user("admin");
        const x = await enrolled(admin), y = await enrolled(admin);
        const ex = await enrol(admin, x.bundle);
        const ch = await seedChannel(pool, org);
        const bx = await seedBackup(pool, x.agentId, ch), by = await seedBackup(pool, y.agentId, ch);
        const rep = (backup_id: string, sha: string, size = 123) => ({backup_id, sha256: sha.repeat(64), size_bytes: size});
        expect(await recordHashReport(t.db, ex, {body: rep(bx.backupId, "a"), organizationId: org, now: NOW})).toMatchObject({ok: false, status: 403, code: "capability_missing"});
        await leaseTask(t.db, ex, {capabilities: CAPS, leaseSeconds: 60, now: NOW});
        const ex2 = await enrol(admin, x.bundle);
        expect(await recordHashReport(t.db, ex2, {body: rep(by.backupId, "a"), organizationId: org, now: NOW})).toMatchObject({ok: false, status: 404}); // Y's backup
        expect(await recordHashReport(t.db, ex2, {body: rep(randomUUID(), "a"), organizationId: org, now: NOW})).toMatchObject({ok: false, status: 404}); // unknown
        expect(await recordHashReport(t.db, ex2, {body: {...rep(bx.backupId, "a"), extra: 1}, organizationId: org, now: NOW})).toMatchObject({ok: false, status: 400});
        expect(await recordHashReport(t.db, ex2, {body: rep(bx.backupId, "a"), organizationId: org, now: NOW})).toEqual({ok: true});
        expect(await recordHashReport(t.db, ex2, {body: rep(bx.backupId, "a"), organizationId: org, now: NOW})).toEqual({ok: true, duplicate: true});
        expect(await recordHashReport(t.db, ex2, {body: rep(bx.backupId, "b"), organizationId: org, now: NOW})).toMatchObject({ok: false, status: 409});
        expect(await q("select sha256 from fork_agent_hash_report where backup_id=$1", [bx.backupId])).toEqual([{sha256: "a".repeat(64)}]);
        expect((await q("select 1 from fork_audit_event where action='fork.agent_hash.conflict'")).length).toBe(1);
    });
});
