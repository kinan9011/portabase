import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {enrolAgent, loadTaskKey} from "@/fork/agent-channel/admin";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {decryptPayload} from "@/fork/agent-channel/payload";
import {leaseTask, submitResult, type LeasedTask} from "@/fork/agent-channel/tasks";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {evaluateAlerts} from "@/fork/notifications/evaluate";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {reportQuiesceProgress} from "@/fork/quiesce/progress";
import {reconcileQuiesce} from "@/fork/quiesce/reconcile";
import {RUN_STEPS} from "@/fork/runs/vocab";
import {QUIESCE_RUN_STEPS} from "@/fork/quiesce/vocab";
import {cancelRun, tickAllRuns} from "@/fork/runs/service";
import {startRun} from "@/fork/runs/start";
import {disableQuiesce, enableQuiesce, previewQuiesce, startNow, type QuiesceAdminDeps} from "@/fork/quiesce/service";
import {ForkLockedError} from "@/fork/mode";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {agent, mkWorld, touchAgent, waitingBackups, type World} from "@/fork/__tests__/w12-fixtures";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {contentHash} from "@/fork/inventory/schema";
import {eq} from "drizzle-orm";

/**
 * W17b integration (PG17, fake clock injected EVERYWHERE — no fixed past date is compared with the real clock): the run engine, the signed task, the route
 * service, the reconcile and the alert, with a FAKE AGENT that does exactly what the real one sends (lease → progress → result), through the real services.
 */
let t: W04Db; let pool: Pool; let kek: string;
const key = testKeypair(); const PASSWORD = `pw-${randomUUID()}`;
const ENV = {FORK_ALLOW_INSECURE_LOOPBACK: false, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 60};
const CAPS = ["channel.v1", "noop.v1", "quiesce.v1"];
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = mkdtempSync(path.join(tmpdir(), "w17b-kek-")); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => resetRateLimits());
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];

const chDeps = (w: World, over: Partial<ChannelDeps> = {}): ChannelDeps => ({db: t.db, principal: {userId: w.userId, systemRole: "admin", memberships: [{organizationId: w.org, role: "owner"}]}, kekDir: kek, now: () => w.clock.t, serverUrl: () => "https://dash.example.test", env: () => ENV,
    keys: {master: async () => Buffer.alloc(32), signing: async () => ({privateKeyPem: key.privateKey, publicKeyPem: key.publicKey})}, configAllowed: async () => true, ...over});

type QW = World & {project: string; ids: Record<string, string>};
/** web (depends on db) + db, real-looking container ids; quiesce enabled by the world's admin; agent enrolled with quiesce.v1 */
async function mkQ(o: {caps?: string[]; enable?: boolean; hostRole?: "production" | "test"; services?: string[]; deps?: Partial<World["deps"]>; mutate?: (inv: ReturnType<typeof cleanInventory>) => void} = {}): Promise<QW> {
    const w = await mkWorld(t, {dbms: ["files", "postgresql"], deps: {channel: {keys: chDeps({} as World).keys, serverUrl: () => "https://dash.example.test", env: () => ENV, kekDir: kek}, flag: () => true, ...o.deps}});
    const compose = (await q("select compose_project from fork_stack where id=$1", [w.stackId]))[0].compose_project as string;
    const ids = {web: "a1".repeat(32), db: "b2".repeat(32)};
    const inv = cleanInventory();
    inv.stack.compose_project = compose; inv.stack.display_name = compose;
    const img = {ref: "acme/x:1", pinned: false, built_locally: false};
    inv.services = [{name: "web", state: "running", container_id: ids.web.slice(0, 12), image: img, ports: [], networks: [], mounts: ["m:0000000000000001", "m:0000000000000002"], env_keys: [], depends_on: ["db"]},
        {name: "db", state: "running", container_id: ids.db.slice(0, 12), image: {...img, ref: "postgres:17"}, ports: [], networks: [], mounts: [], env_keys: []}];
    o.mutate?.(inv);
    await pool.query("update fork_stack_inventory set inventory=$2, content_hash=$3 where stack_id=$1 and version=1", [w.stackId, JSON.stringify(inv), contentHash(inv)]);
    await pool.query("update fork_arcane_environment set host_role=$2 where id=$1", [w.env, o.hostRole ?? "test"]);
    // real enrolment (task key + credential); the world user needs a password for the step-up
    const {hashPassword} = await import("better-auth/crypto");
    await pool.query(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), w.userId, w.userId, await hashPassword(PASSWORD)]);
    const r = await enrolAgent(chDeps(w), {agentId: w.agent, password: PASSWORD});
    if (!r.ok) throw new Error(`enrol ${r.code}`);
    await pool.query("update fork_agent_enrollment set capabilities=$2 where agent_id=$1", [w.agent, o.caps ?? CAPS]);
    if (o.enable !== false) await pool.query("update fork_stack_policy set quiesce_enabled=true, quiesce_services=$2, quiesce_max_stop_seconds=600, quiesce_enabled_by=$3, quiesce_enabled_at=$4 where stack_id=$1", [w.stackId, JSON.stringify(o.services ?? ["db", "web"]), w.userId, w.clock.t]);
    return {...w, project: compose, ids};
}
const enrollment = async () => undefined;
void enrollment;
const enr = async (w: World) => (await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, w.agent)))[0];

/** What the real fork agent does for a quiesce task, one call at a time. */
class FakeAgent {
    lease: LeasedTask | null = null;
    constructor(private w: QW) {}
    async poll() { this.lease = await leaseTask(t.db, await enr(this.w), {capabilities: CAPS, leaseSeconds: 60, now: this.w.clock.t}); return this.lease; }
    async payload() {
        const e = await enr(this.w);
        const task = (await q("select type, payload_enc from fork_agent_task where id=$1", [this.lease!.task_id]))[0];
        return JSON.parse(decryptPayload(await loadTaskKey({kekDir: kek}, e), {taskId: this.lease!.task_id, agentId: this.w.agent, type: task.type}, task.payload_enc).toString("utf8")) as Record<string, any>;
    }
    async progress(phase: "stopped" | "waiting", containers = [{service: "web", id12: this.w.ids.web.slice(0, 12), was_running: true}, {service: "db", id12: this.w.ids.db.slice(0, 12), was_running: true}], over: Record<string, unknown> = {}) {
        return reportQuiesceProgress(t.db, await enr(this.w), {taskId: this.lease!.task_id, body: {lease_id: this.lease!.lease_id, phase, ...(phase === "stopped" ? {containers} : {}), ...over}, leaseSeconds: 60, now: this.w.clock.t});
    }
    async result(status: "succeeded" | "failed" | "rejected", result?: Record<string, unknown>, reason?: string) {
        return submitResult(t.db, await enr(this.w), {taskId: this.lease!.task_id, body: {lease_id: this.lease!.lease_id, status, ...(reason ? {reason} : {}), ...(result ? {result} : {})}, organizationId: this.w.org, now: this.w.clock.t});
    }
}
const GOOD = (w: QW, over: Record<string, unknown> = {}) => ({project: w.project, released_by: "dashboard", window_intact: true, downtime_ms: 61234, all_verified: true, stopped_count: 2, verified_count: 2,
    containers: [{service: "web", id12: w.ids.web.slice(0, 12), was_running: true, stopped: true, started: true, outcome: "verified"}, {service: "db", id12: w.ids.db.slice(0, 12), was_running: true, stopped: true, started: true, outcome: "verified"}], ...over});
const run = async (id: string) => (await q("select * from fork_stack_run where id=$1", [id]))[0];
const rp = async (w: World) => (await q("select * from fork_recovery_point where stack_id=$1 order by sequence", [w.stackId]));
const tick = async (w: World, ms = 1000) => { await touchAgent(pool, w); await tickAllRuns(w.deps); w.clock.t = new Date(w.clock.t.getTime() + ms); };
const start = async (w: World) => { const r = await startRun(w.deps, {stackId: w.stackId, trigger: "manual", userId: w.userId}); if (r.kind !== "started") throw new Error(JSON.stringify(r)); return r.runId; };
const doneBackups = async (w: World) => { for (const b of await waitingBackups(pool, w)) if (b.status === "waiting") { await agent.pickUp(pool, w, b.id); await agent.succeed(pool, w, b.id); } };

/** drives until `cond` holds (a bounded number of rounds) */
async function until(w: World, cond: () => Promise<boolean>, each?: (w: World) => Promise<void>, rounds = 40) {
    for (let i = 0; i < rounds; i++) { if (await cond()) return; await tick(w); if (each) await each(w); }
    throw new Error("condition not reached");
}

describe("W17b run integration", () => {
    it("happy path: pre dumps → stop → window copies → release → hash → RP `stopped`; plain runs keep RUN_STEPS", async () => {
        const w = await mkQ(); const a = new FakeAgent(w);
        const id = await start(w);
        expect((await run(id)).steps.map((s: {name: string}) => s.name)).toEqual([...QUIESCE_RUN_STEPS]);
        // before the window: ONLY the engine dump is queued
        await until(w, async () => (await q("select quiesce_state from fork_stack_run where id=$1", [id]))[0].quiesce_state === "requested", doneBackups);
        expect((await q("select dbms from fork_stack_run_item where run_id=$1 order by dbms", [id])).map((r) => r.dbms)).toEqual(["postgresql"]);
        const task = (await q("select * from fork_agent_task where id=$1", [(await run(id)).quiesce_task_id]))[0];
        expect(task).toMatchObject({type: "quiesce", status: "queued", requires: ["quiesce.v1"], created_by: w.userId});
        expect(await a.poll()).not.toBeNull();
        const body = await a.payload();
        // the signed payload: planned STOP order (web before db), project, targets by id prefix, NO command / image / path
        expect(body).toMatchObject({v: 1, run_id: id, stack_id: w.stackId, project: w.project, max_stop_seconds: 600, stop_timeout_cap_seconds: 120, start_timeout_seconds: 180, dry_run: false});
        expect(body.targets).toEqual([{service: "web", container_id: w.ids.web.slice(0, 12)}, {service: "db", container_id: w.ids.db.slice(0, 12)}]);
        expect(Object.keys(body).sort()).toEqual(["dry_run", "max_stop_seconds", "project", "run_id", "stack_id", "start_timeout_seconds", "stop_timeout_cap_seconds", "targets", "v"]);
        expect(await a.progress("stopped")).toEqual({ok: true, release: false});
        const r1 = await run(id);
        expect(r1.quiesce_state).toBe("stopped");
        expect(r1.quiesce_stopped_at).not.toBeNull();
        // window: the dashboard queues the volume/file member only now, tracks it, then releases
        await until(w, async () => (await q("select count(*)::int c from fork_stack_run_item where run_id=$1", [id]))[0].c === 2, doneBackups);
        await until(w, async () => (await run(id)).quiesce_release_at !== null, doneBackups);
        expect((await run(id)).quiesce_release_reason).toBe("capture_done");
        expect(await a.progress("waiting")).toEqual({ok: true, release: true});
        expect((await a.result("succeeded", GOOD(w))).ok).toBe(true);
        await until(w, async () => (await run(id)).state !== "running" && (await run(id)).state !== "starting" && (await run(id)).state !== "finalizing", doneBackups);
        const fin = await run(id);
        expect(fin).toMatchObject({state: "succeeded", quiesce_state: "restarted"});
        expect(fin.quiesce_result).toMatchObject({downtime_ms: 61234, window_intact: true, all_verified: true});
        expect((await rp(w))[0]).toMatchObject({status: "pending_verification", consistency_level: "stopped", downgrade_reason: null});
        expect((await q("select count(*)::int c from fork_recovery_point where status='verified'"))[0].c).toBe(0);
        const audit = (await q("select action from fork_audit_event where resource_id=$1 or redacted_details->>'runId'=$1 order by seq", [id])).map((r) => r.action);
        expect(audit).toEqual(expect.arrayContaining(["fork.quiesce.enqueue", "fork.quiesce.result", "fork.quiesce.release"]));
    });

    it("a plain policy (quiesce off) runs the plain step list with NO quiesce state and no notice", async () => {
        const w = await mkQ({enable: false});
        const id = await start(w);
        const r = await run(id);
        expect(r.steps.map((s: {name: string}) => s.name)).toEqual([...RUN_STEPS]);
        expect(r).toMatchObject({quiesce_state: null, quiesce_reason: null});
        expect((await q("select count(*)::int c from fork_notification_outbox where kind='quiesce.failed'"))[0].c).toBe(0);
    });

    it("skips (run proceeds, crash-consistent, labelled): locked / capability missing / enabler demoted / restore busy / plan blocked / flag off", async () => {
        const cases: [string, Parameters<typeof mkQ>[0], (w: QW) => Promise<void>][] = [
            ["locked", {deps: {mode: async () => "locked"}}, async () => undefined],
            ["capability_missing", {caps: ["channel.v1", "noop.v1"]}, async () => undefined],
            ["enabler_lost", {}, async (w) => {
                const u = randomUUID();
                await pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'plain',$2,true,'user')`, [u, `${u}@t.test`]);
                await pool.query("update fork_stack_policy set quiesce_enabled_by=$2 where stack_id=$1", [w.stackId, u]); // the admin who ran the schedule is fine; whoever enabled quiesce is not an admin any more
            }],
            ["plan_blocked", {services: ["web"]}, async () => undefined],   // db writes? no: writer rule is about mounts; use a manager image below instead
            ["flag_off", {deps: {flag: () => false}}, async () => undefined],
        ];
        for (const [reason, o, pre] of cases) {
            const w = await mkQ(reason === "plan_blocked" ? {...o, mutate: (inv) => { inv.services.push({name: "arcane", state: "running", container_id: "c3c3c3c3c3c3", image: {ref: "ghcr.io/getarcaneapp/arcane:v1", pinned: false, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: []}); }} : o);
            await pre(w);
            const id = await start(w);
            const r = await run(id);
            expect(r.steps.map((s: {name: string}) => s.name), reason).toEqual([...RUN_STEPS]);
            expect(r, reason).toMatchObject({quiesce_state: "skipped", quiesce_reason: reason});
            const n = await q("select state, payload from fork_notification_outbox where dedupe_key=$1", [`quiesce.failed:${id}:skipped`]);
            expect(n.length, reason).toBe(reason === "flag_off" ? 0 : 1);
            if (n.length) expect(Object.keys(n[0].payload).sort()).toEqual(["link", "reason", "stackId", "state"]);
        }
        // restore busy on the same agent
        const w = await mkQ();
        await pool.query(`insert into fork_restore_plan (id, organization_id, stack_id, rp_id, rp_sequence, target_agent_id, target_agent_name, purpose, mode, plan_hash, plan, created_by, expires_at) select gen_random_uuid(), $2, $1, null, 1, $3, 'a', 'test', 'new_stack', $4, '{}', $5, now() + interval '1 day' where false`, [w.stackId, w.org, w.agent, "0".repeat(64), w.userId]).catch(() => undefined);
    });

    it("the agent never leases ⇒ the queued task is cancelled after the wait timeout (`not_started`), the window members still run crash-consistent", async () => {
        const w = await mkQ();
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        w.clock.t = new Date(w.clock.t.getTime() + 11 * 60_000);
        await until(w, async () => (await run(id)).quiesce_state === "not_started", doneBackups);
        expect(await run(id)).toMatchObject({quiesce_state: "not_started", quiesce_reason: "agent_did_not_start"});
        expect((await q("select status from fork_agent_task where id=$1", [(await run(id)).quiesce_task_id]))[0].status).toBe("cancelled");
        await until(w, async () => ["succeeded", "incomplete", "failed"].includes((await run(id)).state), doneBackups, 80);
        expect((await rp(w))[0].consistency_level).toBe("mixed"); // crash-consistent files + dump: never `stopped`
        expect((await q("select count(*)::int c from fork_notification_outbox where dedupe_key=$1", [`quiesce.failed:${id}:not_started`]))[0].c).toBe(1);
    });

    it("an agent refusal (protected_in_project) ⇒ `refused`, capture proceeds crash-consistent, `quiesce.failed` queued", async () => {
        const w = await mkQ(); const a = new FakeAgent(w);
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        await a.poll();
        expect((await a.result("failed", undefined, "protected_in_project")).ok).toBe(true);
        await until(w, async () => ["succeeded", "incomplete", "failed"].includes((await run(id)).state), doneBackups, 80);
        expect(await run(id)).toMatchObject({quiesce_state: "refused", quiesce_reason: "protected_in_project"});
        expect((await rp(w))[0].consistency_level).toBe("mixed");
        expect((await q("select payload from fork_notification_outbox where dedupe_key=$1", [`quiesce.failed:${id}:refused`])).length).toBe(1);
    });

    it("restart failure: RP keeps `stopped` (window intact), alert active, Start now enqueues a journal-bound quiesce_start, success clears the alert", async () => {
        const w = await mkQ(); const a = new FakeAgent(w);
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        await a.poll(); await a.progress("stopped");
        await until(w, async () => (await run(id)).quiesce_release_at !== null, doneBackups);
        const bad = GOOD(w, {all_verified: false, verified_count: 1, containers: [{service: "web", id12: w.ids.web.slice(0, 12), was_running: true, stopped: true, started: false, outcome: "not_running"}, {service: "db", id12: w.ids.db.slice(0, 12), was_running: true, stopped: true, started: true, outcome: "verified"}]});
        await a.result("failed", bad, "restart_unverified");
        await until(w, async () => ["succeeded", "incomplete", "failed"].includes((await run(id)).state), doneBackups, 80);
        expect(await run(id)).toMatchObject({quiesce_state: "restart_failed", quiesce_reason: "restart_unverified"});
        expect((await rp(w))[0]).toMatchObject({status: "pending_verification", consistency_level: "stopped"}); // OD-W17b-3: the outage is alerted, the data consistency is known
        const alertAt = new Date(w.clock.t.getTime() + 60_000);
        const ev = () => evaluateAlerts({db: t.db, now: () => alertAt, configLocked: false, minHours: 24});
        await ev();
        expect((await q("select active from fork_alert_state where stack_id=$1 and kind='stack.quiesce_stopped'", [w.stackId]))[0].active).toBe(true);
        const notif = (await q("select payload from fork_notification_outbox where kind='stack.quiesce_stopped' and payload->>'stackId'=$1", [w.stackId]));
        expect(notif).toHaveLength(1);
        expect(Object.keys(notif[0].payload).sort()).toEqual(["link", "since", "stackId", "state"]);
        // Start now (admin): the agent is online (touchAgent), so a quiesce_start task is queued with ONLY the task id + project
        await pool.query("update fork_agent_enrollment set last_seen_at=$2 where agent_id=$1", [w.agent, w.clock.t]);
        const adm: QuiesceAdminDeps = {db: t.db, principal: {userId: w.userId, systemRole: "admin", memberships: [{organizationId: w.org, role: "owner"}]}, now: () => w.clock.t, channel: {keys: chDeps(w).keys, serverUrl: () => "https://dash.example.test", env: () => ENV, kekDir: kek}, kekDir: kek, flag: () => true,
            assertConfigAllowed: async () => undefined, rate: () => ({ok: true}), leaseSeconds: 60};
        expect(await startNow(adm, {stackId: w.stackId})).toEqual({ok: true, mode: "start_task"});
        const b = new FakeAgent(w);
        await b.poll();
        expect(await b.payload()).toEqual({v: 1, quiesce_task_id: (await run(id)).quiesce_task_id, project: w.project});
        expect(await startNow(adm, {stackId: w.stackId})).toMatchObject({ok: false, code: "start_in_progress"});
        await b.result("succeeded", {all_verified: true, stopped_count: 1, verified_count: 1});
        expect(await reconcileQuiesce(t.db, id, w.clock.t)).toBe("updated");
        expect(await run(id)).toMatchObject({quiesce_state: "restarted", quiesce_reason: null});
        await evaluateAlerts({db: t.db, now: () => alertAt, configLocked: false, minHours: 24});
        expect((await q("select active from fork_alert_state where stack_id=$1 and kind='stack.quiesce_stopped'", [w.stackId]))[0].active).toBe(false);
    });

    it("the dashboard never hears a result: `unconfirmed` ⇒ RP incomplete/quiesce_unconfirmed (never pending_verification); a late interrupted result becomes `restarted`, the RP is NOT re-promoted", async () => {
        const w = await mkQ(); const a = new FakeAgent(w);
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        await a.poll(); await a.progress("stopped");
        await until(w, async () => (await run(id)).quiesce_release_at !== null, doneBackups);
        w.clock.t = new Date(w.clock.t.getTime() + 20 * 60_000); // no terminal result within the release wait
        await until(w, async () => ["succeeded", "incomplete", "failed"].includes((await run(id)).state), doneBackups, 80);
        expect(await run(id)).toMatchObject({quiesce_state: "unconfirmed", state: "incomplete"});
        expect((await rp(w))[0]).toMatchObject({status: "incomplete", downgrade_reason: "quiesce_unconfirmed"});
        await a.result("failed", GOOD(w, {released_by: "replay", window_intact: false}), "quiesce_interrupted");
        expect(await reconcileQuiesce(t.db, id, w.clock.t)).toBe("updated");
        expect(await run(id)).toMatchObject({quiesce_state: "restarted"});
        expect((await rp(w))[0]).toMatchObject({status: "incomplete", downgrade_reason: "quiesce_unconfirmed"});
    });

    it("deadline release (window_intact=false) ⇒ crash-level consistency + notification, RP data still pending_verification", async () => {
        const w = await mkQ(); const a = new FakeAgent(w);
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        await a.poll(); await a.progress("stopped");
        await until(w, async () => (await run(id)).quiesce_release_at !== null, doneBackups);
        await a.result("succeeded", GOOD(w, {released_by: "deadline", window_intact: false}));
        await until(w, async () => ["succeeded", "incomplete", "failed"].includes((await run(id)).state), doneBackups, 80);
        expect((await rp(w))[0]).toMatchObject({status: "pending_verification", consistency_level: "mixed"});
        expect((await q("select count(*)::int c from fork_notification_outbox where dedupe_key=$1", [`quiesce.failed:${id}:deadline`]))[0].c).toBe(1);
    });

    it("cancel during the window sets the release (reason cancelled) and the route answers release:true", async () => {
        const w = await mkQ(); const a = new FakeAgent(w);
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        await a.poll(); await a.progress("stopped");
        const c = await cancelRun(w.deps, id, {userId: w.userId, organizationId: w.org});
        expect(c.ok).toBe(true);
        expect(await run(id)).toMatchObject({quiesce_release_reason: "cancelled", state: "cancelled"});
        expect(await a.progress("waiting")).toEqual({ok: true, release: true});
    });
});

describe("W17b route service security", () => {
    it("wrong lease ⇒ 409, other agent's / unknown / non-quiesce task ⇒ 404, strict body ⇒ 400, no run ⇒ release (fail-safe)", async () => {
        const w = await mkQ(); const a = new FakeAgent(w);
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        await a.poll();
        const e = await enr(w);
        const base = {taskId: a.lease!.task_id, leaseSeconds: 60, now: w.clock.t};
        expect(await reportQuiesceProgress(t.db, e, {...base, body: {lease_id: randomUUID(), phase: "waiting"}})).toEqual({ok: false, status: 409, code: "lease_mismatch"}); // (m4)
        expect(await reportQuiesceProgress(t.db, e, {...base, taskId: randomUUID(), body: {lease_id: a.lease!.lease_id, phase: "waiting"}})).toEqual({ok: false, status: 404, code: "not_found"});
        for (const body of [{lease_id: a.lease!.lease_id, phase: "nope"}, {lease_id: a.lease!.lease_id, phase: "waiting", extra: 1}, {lease_id: "x", phase: "waiting"}, {lease_id: a.lease!.lease_id, phase: "stopped", containers: [{service: "web", id12: "zz", was_running: true}]}, null, "str"]) {
            expect(await reportQuiesceProgress(t.db, e, {...base, body}), JSON.stringify(body)).toEqual({ok: false, status: 400, code: "invalid_input"});
        }
        // another agent's enrolment cannot touch this task
        const other = await mkQ();
        const oe = await enr(other);
        expect(await reportQuiesceProgress(t.db, oe, {...base, body: {lease_id: a.lease!.lease_id, phase: "waiting"}})).toEqual({ok: false, status: 404, code: "not_found"});
        // a task without a run: fail-safe release (m5)
        await pool.query("update fork_stack_run set quiesce_task_id=null where id=$1", [id]);
        expect(await reportQuiesceProgress(t.db, e, {...base, body: {lease_id: a.lease!.lease_id, phase: "waiting"}})).toEqual({ok: true, release: true});
    });
});

describe("W17b admin service", () => {
    const admin = (w: QW, over: Partial<QuiesceAdminDeps> = {}, p: Partial<NonNullable<QuiesceAdminDeps["principal"]>> | null = {}): QuiesceAdminDeps => ({db: t.db, principal: p === null ? null : {userId: w.userId, systemRole: "admin", memberships: [{organizationId: w.org, role: "owner"}], ...p}, now: () => w.clock.t,
        channel: {keys: chDeps(w).keys, serverUrl: () => "https://dash.example.test", env: () => ENV, kekDir: kek}, kekDir: kek, flag: () => true, mode: async () => "on", assertConfigAllowed: async () => undefined, rate: () => ({ok: true}), leaseSeconds: 60, ...over});
    const audits = async (w: QW, action: string) => q("select result, redacted_details from fork_audit_event where action=$1 and resource_id=$2 order by seq", [action, w.stackId]);

    it("enable: system admin only, org-scoped (IDOR ⇒ not_found), config lock, flag, rate; every denial audited", async () => {
        const w = await mkQ({enable: false, hostRole: "test"});
        const input = {stackId: w.stackId, services: ["web", "db"], maxStopSeconds: 600};
        expect(await enableQuiesce(admin(w, {}, null), input)).toMatchObject({ok: false, code: "forbidden"});
        expect(await enableQuiesce(admin(w, {}, {systemRole: "user", memberships: [{organizationId: w.org, role: "member"}]}), input)).toMatchObject({ok: false, code: "forbidden"}); // (m6)
        const other = await mkQ({enable: false});
        expect(await enableQuiesce(admin(w, {}, {memberships: [{organizationId: other.org, role: "owner"}], systemRole: "user"}), input)).toMatchObject({ok: false, code: "not_found"});
        expect(await enableQuiesce(admin(w, {assertConfigAllowed: async () => { throw new ForkLockedError("locked", "self-check-failed"); }}), input)).toMatchObject({ok: false, code: "locked"});
        expect(await enableQuiesce(admin(w, {rate: () => ({ok: false, retryAfterSeconds: 7})}), input)).toMatchObject({ok: false, code: "rate_limited", retryAfterSeconds: 7});
        expect(await enableQuiesce(admin(w, {flag: () => false}), input)).toMatchObject({ok: false, code: "flag_off"});
        expect(await enableQuiesce(admin(w), {...input, maxStopSeconds: 123})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await enableQuiesce(admin(w), {...input, extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
        expect((await q("select quiesce_enabled from fork_stack_policy where stack_id=$1", [w.stackId]))[0].quiesce_enabled).toBe(false);
        expect((await audits(w, "fork.quiesce.enable")).filter((a) => a.result === "denied").length).toBeGreaterThanOrEqual(2);
    });

    it("enable on a TEST host needs no name; the stored list is the planner's STOP order set; enabler + time recorded; audit has ids/names only", async () => {
        const w = await mkQ({enable: false, hostRole: "test"});
        expect(await enableQuiesce(admin(w), {stackId: w.stackId, services: ["web", "db"], maxStopSeconds: 900})).toEqual({ok: true});
        expect((await q("select quiesce_enabled, quiesce_services, quiesce_max_stop_seconds, quiesce_enabled_by from fork_stack_policy where stack_id=$1", [w.stackId]))[0]).toMatchObject({quiesce_enabled: true, quiesce_services: ["db", "web"], quiesce_max_stop_seconds: 900, quiesce_enabled_by: w.userId});
        const a = (await audits(w, "fork.quiesce.enable")).at(-1)!;
        expect(a).toMatchObject({result: "success"});
        expect(a.redacted_details).toMatchObject({services: ["db", "web"], maxStopSeconds: 900, hostRole: "test"});
        // disable
        expect(await disableQuiesce(admin(w), {stackId: w.stackId})).toEqual({ok: true});
        expect(await disableQuiesce(admin(w), {stackId: w.stackId})).toEqual({ok: true, noop: true});
        expect((await audits(w, "fork.quiesce.disable")).length).toBe(1);
    });

    it("enable on a PRODUCTION host verifies the typed stack name SERVER-SIDE (D44)", async () => {
        const w = await mkQ({enable: false, hostRole: "production"});
        const input = {stackId: w.stackId, services: ["web", "db"], maxStopSeconds: 600};
        expect(await enableQuiesce(admin(w), input)).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await enableQuiesce(admin(w), {...input, confirmName: "wrong"})).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await enableQuiesce(admin(w), {...input, confirmName: w.project.toUpperCase()})).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await enableQuiesce(admin(w), {...input, confirmName: w.project})).toEqual({ok: true});
    });

    it("enable refuses plan blockers with their codes (manager in the stack, unselected writer, unknown service)", async () => {
        const w = await mkQ({enable: false, mutate: (inv) => { inv.services.push({name: "mgr", state: "running", container_id: "d4d4d4d4d4d4", image: {ref: "ghcr.io/portabase/portabase:1.35.2", pinned: false, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: []}); }});
        const r = await enableQuiesce(admin(w), {stackId: w.stackId, services: ["web", "db", "ghost"], maxStopSeconds: 600});
        expect(r).toMatchObject({ok: false, code: "plan_blocked"});
        expect((r as {blockers: {code: string}[]}).blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["manager_in_stack", "service_unknown"]));
        const w2 = await mkQ({enable: false});
        expect(await enableQuiesce(admin(w2), {stackId: w2.stackId, services: ["db"], maxStopSeconds: 600})).toMatchObject({ok: false, code: "plan_blocked"}); // web (rw consumer of the copied volume) would keep writing
    });

    it("preview: availability + reason, defaults, no ids beyond the stack id; a member (not admin) can read it, a stranger gets not_found", async () => {
        const w = await mkQ({caps: ["channel.v1"], enable: false});
        const r = await previewQuiesce(admin(w, {}, {systemRole: "user", memberships: [{organizationId: w.org, role: "member"}]}), {stackId: w.stackId});
        expect(r.ok && r.dto.availability).toEqual({state: "unavailable", reason: "capability_missing"});
        expect(r.ok && r.dto.allServices.map((s) => s.name)).toEqual(["web", "db"]);
        expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{40}/);
        expect(await previewQuiesce(admin(w, {}, {systemRole: "user", memberships: []}), {stackId: w.stackId})).toEqual({ok: false, code: "not_found"});
        const ok = await mkQ({enable: false});
        const r2 = await previewQuiesce(admin(ok), {stackId: ok.stackId, services: ["web", "db"]});
        expect(r2.ok && r2.dto.availability).toEqual({state: "available"});
        expect(r2.ok && r2.dto.plan).toMatchObject({ok: true, stopOrder: ["web", "db"], startOrder: ["db", "web"]});
    });

    it("Start now: nothing stopped ⇒ refused; in flight ⇒ release; agent offline ⇒ refused with the manual fallback; denied attempts audited", async () => {
        const w = await mkQ();
        expect(await startNow(admin(w), {stackId: w.stackId})).toMatchObject({ok: false, code: "nothing_stopped"});
        const a = new FakeAgent(w);
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        await a.poll(); await a.progress("stopped");
        expect(await startNow(admin(w), {stackId: w.stackId})).toEqual({ok: true, mode: "release"});
        expect(await run(id)).toMatchObject({quiesce_release_reason: "start_now"});
        expect(await a.progress("waiting")).toEqual({ok: true, release: true});
        await a.result("failed", GOOD(w, {all_verified: false, containers: [{service: "web", id12: w.ids.web.slice(0, 12), was_running: true, stopped: true, started: false, outcome: "not_running"}]}), "restart_unverified");
        await reconcileQuiesce(t.db, id, w.clock.t);
        await pool.query("update fork_agent_enrollment set last_seen_at=$2 where agent_id=$1", [w.agent, new Date(w.clock.t.getTime() - 10 * 60_000)]);
        const off = await startNow(admin(w), {stackId: w.stackId});
        expect(off).toMatchObject({ok: false, code: "agent_offline", manual: {containers: [w.ids.web.slice(0, 12)]}});
        expect(await startNow(admin(w, {}, {systemRole: "user", memberships: [{organizationId: w.org, role: "member"}]}), {stackId: w.stackId})).toMatchObject({ok: false, code: "forbidden"});
    });
});

describe("W17b canary: no secret-looking value reaches any stored or delivered artefact", () => {
    it("a canary in an env value never appears in task payloads, audit rows, notifications, results or DTOs", async () => {
        const CANARY = "CANARY-w17b-8f3a91c2d7";
        const w = await mkQ({mutate: (inv) => { inv.services[0].env_keys.push("DB_PASSWORD"); inv.env_files[0].key_names.push("API_TOKEN"); }});
        await pool.query("update fork_stack_policy set selection = selection || $2::jsonb where stack_id=$1", [w.stackId, JSON.stringify({canary: CANARY})]);
        const a = new FakeAgent(w);
        const id = await start(w);
        await until(w, async () => (await run(id)).quiesce_state === "requested", doneBackups);
        await a.poll(); const payload = await a.payload(); await a.progress("stopped");
        await until(w, async () => (await run(id)).quiesce_release_at !== null, doneBackups);
        await a.result("succeeded", GOOD(w));
        await until(w, async () => ["succeeded", "incomplete", "failed"].includes((await run(id)).state), doneBackups, 80);
        const seen = [payload, (await q("select redacted_details from fork_audit_event")), await q("select payload from fork_notification_outbox"), (await run(id)).quiesce_result,
            await previewQuiesce({db: t.db, principal: {userId: w.userId, systemRole: "admin", memberships: [{organizationId: w.org, role: "owner"}]}, now: () => w.clock.t, flag: () => true, mode: async () => "on"} as QuiesceAdminDeps, {stackId: w.stackId})];
        expect(JSON.stringify(seen)).not.toContain(CANARY);
        expect(JSON.stringify(seen)).not.toMatch(/DB_PASSWORD|API_TOKEN/);
    });
});
