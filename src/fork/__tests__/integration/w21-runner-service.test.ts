import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {enrolAgent, loadTaskKey} from "@/fork/agent-channel/admin";
import {authenticateAgent} from "@/fork/agent-channel/auth";
import {decodeBundle} from "@/fork/agent-channel/bundle";
import {decryptPayload} from "@/fork/agent-channel/payload";
import {leaseTask, submitResult} from "@/fork/agent-channel/tasks";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {RUNNER_CAPABILITY} from "@/fork/agent-channel/vocab";
import {updateEnvironment} from "@/fork/arcane/environment-service";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {RunnerNotIsolatedError} from "@/fork/runner/evaluate";
import {RunnerProbePayload} from "@/fork/runner/payload-schema";
import {assertRunnerReady, assertRunnerTarget, designateRunner, requestRunnerProbe, runnerIsolation, setRunnerTargets, undesignateRunner, type RunnerDeps} from "@/fork/runner/service";
import {eq} from "drizzle-orm";
import {freshForkDb, seedAgent, seedBackup, seedChannel, seedConnection, seedEnvironment, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

let t: W04Db; let pool: Pool; let kek: string; let org: string;
const key = testKeypair(); const PASSWORD = `pw-${randomUUID()}`;
const ENV = {FORK_ALLOW_INSECURE_LOOPBACK: false, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 60};
const RUNNER_CAPS = ["channel.v1", "channel-maint.v1", "noop.v1", "runner.v1"];
let flag = true;
let admin: string;
// the injected clock is "now" for producer AND evaluator: relative to the real clock so nothing depends on a fixed past instant
const NOW = () => new Date();
const resolve = async (h: string) => (h === "mail.prod.example" ? ["10.20.30.25"] : []);

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = mkdtempSync(path.join(tmpdir(), "w21-kek-")); org = await seedOrg(pool); admin = await user("admin"); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { resetRateLimits(); flag = true; });

const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
async function user(role: string) {
    const id = randomUUID();
    await pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,$2,$3,true,$4)`, [id, role, `${id}@t.test`, role]);
    const {hashPassword} = await import("better-auth/crypto");
    await pool.query(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), id, id, await hashPassword(PASSWORD)]);
    return id;
}
const deps = (userId: string | null, role = "admin", over: Partial<RunnerDeps> = {}): RunnerDeps => ({
    db: t.db, principal: userId ? {userId, systemRole: role, memberships: []} : null, kekDir: kek, now: NOW, serverUrl: () => "https://dash.example.test", env: () => ENV, resolve,
    keys: {master: async () => Buffer.alloc(32), signing: async () => ({privateKeyPem: key.privateKey, publicKeyPem: key.publicKey})}, configAllowed: async () => true, mirrorsEnabled: () => flag, ...over});
async function enrolledAgent(caps: string[] = RUNNER_CAPS) {
    const agentId = await seedAgent(pool, org);
    const r = await enrolAgent(deps(admin), {agentId, password: PASSWORD});
    if (!r.ok) throw new Error(`enrol: ${r.code}`);
    if (caps.length) await t.db.update(forkAgentEnrollment).set({capabilities: caps}).where(eq(forkAgentEnrollment.agentId, agentId));
    return {agentId, bundle: decodeBundle(r.bundle)};
}
async function designated(caps: string[] = RUNNER_CAPS) {
    const a = await enrolledAgent(caps);
    const r = await designateRunner(deps(admin), {agentId: a.agentId, password: PASSWORD});
    if (!r.ok) throw new Error(`designate: ${r.code}`);
    return a;
}
const audits = async (action: string, agentId: string) => q("select result, redacted_details d from fork_audit_event where action=$1 and resource_id=$2 order by seq", [action, agentId]);

describe("designation: gates, refusals, audit", () => {
    it("flag off → mirrors_disabled (nothing written)", async () => {
        const {agentId} = await enrolledAgent();
        flag = false;
        expect(await designateRunner(deps(admin), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "mirrors_disabled"});
        expect(await q("select 1 from fork_runner where agent_id=$1", [agentId])).toHaveLength(0);
        for (const f of [() => undesignateRunner(deps(admin), {agentId}), () => setRunnerTargets(deps(admin), {agentId, targets: []}), () => requestRunnerProbe(deps(admin), {agentId})]) expect(await f()).toMatchObject({ok: false, code: "mirrors_disabled"});
    });
    it("a non-admin and an anonymous caller are forbidden; the denial is audited", async () => {
        const {agentId} = await enrolledAgent();
        const plain = await user("user");
        expect(await designateRunner(deps(plain, "user"), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "forbidden"});
        expect(await designateRunner(deps(null), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "forbidden"});
        expect((await audits("fork.runner.designate", agentId)).map((r) => [r.result, r.d.reason])).toContainEqual(["denied", "forbidden"]);
        expect(await q("select 1 from fork_runner where agent_id=$1", [agentId])).toHaveLength(0);
    });
    it("D21 lock → locked; wrong password → step_up_failed (audited); bad input → invalid_input", async () => {
        const {agentId} = await enrolledAgent();
        expect(await designateRunner(deps(admin, "admin", {configAllowed: async () => false}), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "locked"});
        expect(await designateRunner(deps(admin), {agentId, password: "nope"})).toMatchObject({ok: false, code: "step_up_failed"});
        expect((await audits("fork.runner.designate", agentId)).map((r) => r.d.reason)).toEqual(expect.arrayContaining(["locked", "step_up_failed"]));
        expect(await designateRunner(deps(admin), {agentId: "x", password: PASSWORD})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await designateRunner(deps(admin), {agentId, password: PASSWORD, extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
    });
    it("an unenrolled agent cannot be designated; a designation can be made once and removed", async () => {
        const bare = await seedAgent(pool, org);
        expect(await designateRunner(deps(admin), {agentId: bare, password: PASSWORD})).toMatchObject({ok: false, code: "not_enrolled"});
        const {agentId} = await enrolledAgent();
        expect(await designateRunner(deps(admin), {agentId, password: PASSWORD})).toEqual({ok: true});
        expect(await designateRunner(deps(admin), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "already_designated"});
        expect(await undesignateRunner(deps(admin), {agentId})).toEqual({ok: true});
        expect(await undesignateRunner(deps(admin), {agentId})).toMatchObject({ok: false, code: "not_a_runner"});
        const acts = (await audits("fork.runner.designate", agentId)).filter((r) => r.result === "success");
        expect(acts).toHaveLength(1);
    });
    it("an agent mapped to an Arcane environment cannot be designated (and the audit says why)", async () => {
        const {agentId} = await enrolledAgent();
        const conn = await seedConnection(pool, org, `c-${randomUUID().slice(0, 4)}`);
        await seedEnvironment(pool, conn, agentId, "n", `e-${randomUUID().slice(0, 4)}`);
        expect(await designateRunner(deps(admin), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "agent_mapped_to_environment"});
        expect((await audits("fork.runner.designate", agentId)).map((r) => r.d.reason)).toContain("agent_mapped_to_environment");
    });
    it("an agent that owns an upstream database cannot be designated (the stock loop would push it storage credentials)", async () => {
        const {agentId} = await enrolledAgent();
        await seedBackup(pool, agentId, await seedChannel(pool, org));
        expect(await designateRunner(deps(admin), {agentId, password: PASSWORD})).toMatchObject({ok: false, code: "agent_has_databases"});
    });
    it("the Arcane environment service refuses to map a designated runner (other direction)", async () => {
        const {agentId} = await designated();
        const conn = await seedConnection(pool, org, `c-${randomUUID().slice(0, 4)}`);
        const env = await seedEnvironment(pool, conn, null, null, `e-${randomUUID().slice(0, 4)}`);
        const r = await updateEnvironment({db: t.db, principal: {userId: admin, systemRole: "admin", memberships: [{organizationId: org, role: "owner"}]}, assertConfigAllowed: async () => {}}, {environmentId: env, agentId});
        expect(r).toMatchObject({ok: false, code: "invalid_input"});
        expect((await q("select agent_id from fork_arcane_environment where id=$1", [env]))[0].agent_id).toBeNull();
    });
    it("eligibility: no row = not a runner; no runner.v1 = not attested; attested = ok; mapping/databases after the fact make it ineligible", async () => {
        const plain = await enrolledAgent();
        expect(await assertRunnerTarget(t.db, plain.agentId)).toEqual({ok: false, code: "not_a_runner"});
        const noCap = await designated(["channel.v1", "noop.v1"]);
        expect(await assertRunnerTarget(t.db, noCap.agentId)).toEqual({ok: false, code: "not_attested"});
        const good = await designated();
        expect((await assertRunnerTarget(t.db, good.agentId)).ok).toBe(true);
        await seedEnvironment(pool, await seedConnection(pool, org, `c-${randomUUID().slice(0, 4)}`), good.agentId, "n", `e-${randomUUID().slice(0, 4)}`); // mapped behind our back
        expect(await assertRunnerTarget(t.db, good.agentId)).toEqual({ok: false, code: "agent_mapped_to_environment"});
        const dbOwner = await designated();
        await seedBackup(pool, dbOwner.agentId, await seedChannel(pool, org));
        expect(await assertRunnerTarget(t.db, dbOwner.agentId)).toEqual({ok: false, code: "agent_has_databases"});
    });
});

describe("targets", () => {
    it("admin targets are validated (loopback refused), stored, capped, and audited with a count + sha only", async () => {
        const {agentId} = await designated();
        const good = [{kind: "tcp", host: "10.20.30.25", port: 25, class: "smtp", label: "Prod SMTP"}];
        const r = await setRunnerTargets(deps(admin), {agentId, targets: good});
        expect(r).toMatchObject({ok: true, count: 1});
        expect((await q("select probe_targets from fork_runner where agent_id=$1", [agentId]))[0].probe_targets).toEqual(good);
        expect(await setRunnerTargets(deps(admin), {agentId, targets: [{...good[0], host: "127.0.0.1"}]})).toMatchObject({ok: false, code: "target_invalid"});
        expect(await setRunnerTargets(deps(admin), {agentId, targets: Array.from({length: 25}, () => good[0])})).toMatchObject({ok: false, code: "too_many_targets"});
        const a = (await audits("fork.runner.targets_set", agentId)).find((x) => x.result === "success")!;
        expect(Object.keys(a.d).sort()).toEqual(["configSha256", "count"]);
        expect(JSON.stringify(a.d)).not.toContain("10.20.30.25");
        const nr = await enrolledAgent();
        expect(await setRunnerTargets(deps(admin), {agentId: nr.agentId, targets: good})).toMatchObject({ok: false, code: "not_a_runner"});
    });
});

describe("probe request → result → verdict", () => {
    const targets = [{kind: "tcp", host: "mail.prod.example", port: 25, class: "smtp", label: "Prod SMTP"}, {kind: "tcp", host: "10.20.30.54", port: 5432, class: "database", label: "Prod DB"}];

    it("a production (non-designated) agent and a designated agent without runner.v1 are refused", async () => {
        const prod = await enrolledAgent(["channel.v1", "noop.v1", "restore.target.v1"]);
        expect(await requestRunnerProbe(deps(admin), {agentId: prod.agentId})).toMatchObject({ok: false, code: "not_a_runner"});
        const unattested = await designated(["channel.v1", "noop.v1"]);
        expect(await requestRunnerProbe(deps(admin), {agentId: unattested.agentId})).toMatchObject({ok: false, code: "not_attested"});
        expect(await q("select 1 from fork_agent_task where agent_id=any($1) and type='runner_probe'", [[prod.agentId, unattested.agentId]])).toHaveLength(0);
    });
    it("a non-admin cannot request a probe; a rate limit applies", async () => {
        const {agentId} = await designated();
        const plain = await user("user");
        expect(await requestRunnerProbe(deps(plain, "user"), {agentId})).toMatchObject({ok: false, code: "forbidden"});
        let last: unknown = null;
        for (let i = 0; i < 12; i++) last = await requestRunnerProbe(deps(admin), {agentId});
        expect(last).toMatchObject({ok: false});
        expect(["rate_limited", "probe_in_progress"]).toContain((last as {code: string}).code);
    });
    it("success: a signed targeted runner_probe task whose decrypted payload is valid; a second request is probe_in_progress; the audit carries no host or payload", async () => {
        const {agentId} = await designated();
        expect(await setRunnerTargets(deps(admin), {agentId, targets})).toMatchObject({ok: true});
        const r = await requestRunnerProbe(deps(admin), {agentId});
        if (!r.ok) throw new Error(r.code);
        // the dashboard URL is dash.example.test (unresolvable in the test resolver ⇒ skipped), mail.prod.example resolves to 10.20.30.25
        expect(r.skipped).toBeGreaterThanOrEqual(1); // dashboard + any arcane.lab connection seeded by earlier cases
        const [task] = await q("select type, requires, envelope_text, status, payload_enc, enroll_id from fork_agent_task where id=$1", [r.taskId]);
        expect(task).toMatchObject({type: "runner_probe", requires: ["runner.v1"], status: "queued"});
        expect(JSON.parse(task.envelope_text)).toMatchObject({type: "runner_probe", target_agent_id: agentId, requires: ["runner.v1"]}); // the SIGNED envelope names the target (the column is not written by insertSignedTask, W15/W17 behaviour)
        const [e] = await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
        const plain = JSON.parse(decryptPayload(await loadTaskKey({kekDir: kek}, e), {taskId: r.taskId, agentId, type: "runner_probe"}, task.payload_enc).toString("utf8"));
        expect(RunnerProbePayload.safeParse(plain).success).toBe(true);
        expect(plain.probe_id).toBe(r.probeId);
        expect(plain.targets.map((x: {host: string}) => x.host).sort()).toEqual(["10.20.30.25", "10.20.30.54", "example.com", "mail.prod.example"]);
        expect(await requestRunnerProbe(deps(admin), {agentId})).toMatchObject({ok: false, code: "probe_in_progress"});
        const rows = await audits("fork.runner.probe", agentId);
        const ok = rows.find((x) => x.result === "success")!;
        expect(Object.keys(ok.d).sort()).toEqual(["configSha256", "targetCount", "taskId"]);
        const dump = JSON.stringify(rows);
        for (const secret of ["10.20.30", "mail.prod.example", "example.com", "payload", "probe_id"]) expect(dump).not.toContain(secret);
    });
    it("end to end through the real lease + result path: isolated, then not_isolated on a leak; stale, targets_changed and not_attested fail closed; assertRunnerReady throws for each", async () => {
        const {agentId, bundle} = await designated();
        await setRunnerTargets(deps(admin), {agentId, targets});
        const opts = () => ({now: NOW(), serverUrl: "https://dash.example.test"});
        expect(await runnerIsolation(t.db, agentId, opts())).toEqual({state: "unknown", reason: "never_probed"});
        await expect(assertRunnerReady(t.db, agentId, opts())).rejects.toBeInstanceOf(RunnerNotIsolatedError);

        const run = async (outcomes: (id: string, i: number) => "blocked" | "reachable" | "error", over: Record<string, unknown> = {}) => {
            const r = await requestRunnerProbe(deps(admin), {agentId});
            if (!r.ok) throw new Error(r.code);
            const auth = await authenticateAgent(t.db, {agentId, authorization: `Bearer ${bundle.credential}`, source: "1.2.3.4", now: NOW()});
            if (!auth.ok) throw new Error(auth.code);
            const [{targets: stored}] = (await q("select last_probe_targets as targets from fork_runner where agent_id=$1", [agentId])) as {targets: {targets: {id: string}[]}}[];
            const leased = await leaseTask(t.db, auth.enrollment, {capabilities: RUNNER_CAPS, leaseSeconds: 60, now: NOW()});
            expect(leased?.task_id).toBe(r.taskId);
            const body = {lease_id: leased!.lease_id, status: "succeeded", result: {v: 1, probe_id: r.probeId, targets_sha256: await shaOf(agentId), self_dns: "ok", results: stored.targets.map((x, i) => ({id: x.id, outcome: outcomes(x.id, i)})), wiped: {containers: 1, networks: 1}, ...over}};
            expect(await submitResult(t.db, auth.enrollment, {taskId: r.taskId, body, organizationId: null, now: NOW()})).toMatchObject({ok: true});
            return r;
        };
        await run(() => "blocked");
        expect(await runnerIsolation(t.db, agentId, opts())).toMatchObject({state: "isolated", targetCount: 4});
        expect((await assertRunnerReady(t.db, agentId, opts())).state).toBe("isolated");
        // stale: evaluated "later" than maxAge
        expect(await runnerIsolation(t.db, agentId, {...opts(), maxAgeMs: 1, now: new Date(Date.now() + 5_000)})).toEqual({state: "unknown", reason: "stale"});
        // targets changed after the probe
        await setRunnerTargets(deps(admin), {agentId, targets: [...targets, {kind: "tcp", host: "10.20.30.80", port: 8080, class: "webhook", label: "Hook"}]});
        expect(await runnerIsolation(t.db, agentId, opts())).toEqual({state: "unknown", reason: "targets_changed"});
        await expect(assertRunnerReady(t.db, agentId, opts())).rejects.toBeInstanceOf(RunnerNotIsolatedError);
        // a leak
        await run((_id, i) => (i === 0 ? "reachable" : "blocked"));
        const leak = await runnerIsolation(t.db, agentId, opts());
        expect(leak.state).toBe("not_isolated");
        expect(JSON.stringify(leak)).not.toContain("10.20.30");
        await expect(assertRunnerReady(t.db, agentId, opts())).rejects.toBeInstanceOf(RunnerNotIsolatedError);
        // an error outcome is inconclusive
        await run((_id, i) => (i === 1 ? "error" : "blocked"));
        expect(await runnerIsolation(t.db, agentId, opts())).toEqual({state: "unknown", reason: "inconclusive"});
        // a clean probe again, then the agent loses its runner attestation
        await run(() => "blocked");
        expect((await runnerIsolation(t.db, agentId, opts())).state).toBe("isolated");
        await t.db.update(forkAgentEnrollment).set({capabilities: ["channel.v1"]}).where(eq(forkAgentEnrollment.agentId, agentId));
        expect(await runnerIsolation(t.db, agentId, opts())).toEqual({state: "unknown", reason: "not_attested"});
    });
    it("the agent's refusal reasons are accepted as results (role_forbidden, helper_failed, wipe_incomplete) and read as probe_failed", async () => {
        const {agentId, bundle} = await designated();
        for (const reason of ["role_forbidden", "helper_failed", "wipe_incomplete"] as const) {
            const r = await requestRunnerProbe(deps(admin), {agentId});
            if (!r.ok) throw new Error(r.code);
            const auth = await authenticateAgent(t.db, {agentId, authorization: `Bearer ${bundle.credential}`, source: "1.2.3.4", now: NOW()});
            if (!auth.ok) throw new Error(auth.code);
            const leased = await leaseTask(t.db, auth.enrollment, {capabilities: RUNNER_CAPS, leaseSeconds: 60, now: NOW()});
            expect(await submitResult(t.db, auth.enrollment, {taskId: r.taskId, body: {lease_id: leased!.lease_id, status: reason === "role_forbidden" ? "rejected" : "failed", reason}, organizationId: null, now: NOW()})).toMatchObject({ok: true});
            expect(await runnerIsolation(t.db, agentId, {now: NOW(), serverUrl: "https://dash.example.test"})).toEqual({state: "unknown", reason: "probe_failed"});
        }
    });
    it("a runner-attested agent is never a restore target: the planner's capability precondition needs restore.target.v1, which a runner never reports", async () => {
        const {agentId} = await designated();
        const [e] = await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
        expect(e.capabilities).toContain(RUNNER_CAPABILITY);
        expect(e.capabilities).not.toContain("restore.target.v1");
        expect(e.capabilities).not.toContain("compose.render.v1");
    });
    it("the table CHECKs reject an oversized or non-array target list and a malformed sha", async () => {
        const {agentId} = await designated();
        await expect(pool.query("update fork_runner set probe_targets='{}'::jsonb where agent_id=$1", [agentId])).rejects.toThrow(/fork_runner_targets_ck/);
        await expect(pool.query("update fork_runner set probe_targets=$2::jsonb where agent_id=$1", [agentId, JSON.stringify(["x".repeat(17000)])])).rejects.toThrow(/fork_runner_targets_ck/);
        await expect(pool.query("update fork_runner set last_probe_config_sha256='nothex' where agent_id=$1", [agentId])).rejects.toThrow(/fork_runner_sha_ck/);
    });
});

async function shaOf(agentId: string): Promise<string> {
    const {targetsSha} = await import("@/fork/runner/targets");
    const [r] = await q("select last_probe_targets as t from fork_runner where agent_id=$1", [agentId]);
    return targetsSha((r.t as {targets: never[]}).targets);
}
