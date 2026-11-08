import {rmSync} from "node:fs";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {verifyAuditChain} from "@/fork/audit";
import {ScheduleSchema} from "@/fork/schedule/schedule";
import {loadProtectionByStackId} from "@/fork/stacks/protection-load";
import {testRestoreSchedulerTick} from "@/fork/test-restore/scheduler";
import {runTestRestoreNow, setTestRestoreSchedule, wipeTestRestoreNow} from "@/fork/test-restore/service";
import {getTestRestoreView} from "@/fork/test-restore/view";
import {advanceTestRestoreWipes} from "@/fork/test-restore/wipe";
import {tickRestoreRun} from "@/fork/restore-run/tick";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {harness, CAPS, type Harness, type Reply} from "@/fork/__tests__/w18a-world";
import {adminUser, newKek, seedW17World, type W17} from "@/fork/__tests__/w17-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string; let h: Harness;
const key = testKeypair();

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(async () => { h = harness(t, kek, key, org); h.reset(); await pool.query("delete from fork_test_restore_schedule"); });

const world = (o: {hostRole?: "production" | "test"} = {}) => seedW17World(t, kek, key, admin, {org, caps: CAPS, hostRole: o.hostRole ?? "test"});
/** a system admin who is ALSO an org owner (D-10), resolvable by the tick's `principalOf` */
const operator = async (): Promise<ForkPrincipal> => {
    const base = await h.user("sys");
    const p: ForkPrincipal = {...base, memberships: [{organizationId: org, role: "owner"}]};
    h.principals.set(p.userId, p);
    return p;
};
const HOURLY = (now: Date) => ScheduleSchema.parse({preset: "hourly", timezone: "UTC", minute: (now.getUTCMinutes() + 59) % 60, hour: 0, weekday: 0, monthday: 1});
const privacy = (w: W17, v: boolean | null) => pool.query("update fork_stack set contains_personal_data=$2 where id=$1", [w.stack, v]);

/** schedule row via the REAL service, then enabled_at moved 2 h back so the latest hourly slot (1 min ago) is inside the capture window */
async function configure(w: W17, op: ForkPrincipal, over: Record<string, unknown> = {}) {
    const d = h.deps(w, op);
    const r = await setTestRestoreSchedule(d, {stackId: w.stack, enabled: true, schedule: HOURLY(h.now()), targetAgentId: w.agent, restoreRoot: "/srv/restore", staleAfterDays: 14, ...over});
    if (r.ok) await pool.query("update fork_test_restore_schedule set enabled_at = $2 where stack_id=$1", [w.stack, new Date(h.now().getTime() - 2 * 3_600_000)]);
    return r;
}
/** tick run + wipe, answer the fake agent, until the wipe has an end state */
async function settle(d: ReturnType<Harness["deps"]>, w: W17, runId: string, script: Record<string, Reply | undefined> = {}, max = 60) {
    for (let i = 0; i < max; i++) {
        const r = await h.run(runId);
        if (["running", "awaiting_approval"].includes(r.state)) await tickRestoreRun(d, runId);
        else await advanceTestRestoreWipes(d);
        const x = await h.run(runId);
        if (!["running", "awaiting_approval"].includes(x.state) && ["verified", "not_needed", "failed"].includes(x.wipe_state)) return x;
        await h.agentStep(w, script);
    }
    return h.run(runId);
}
const outbox = (kind: string) => h.q("select dedupe_key from fork_notification_outbox where kind=$1", [kind]);

describe("W-TR scheduled data-only test restore", () => {
    it("happy path: scheduler tick starts a schedule-triggered run → data_verified → verified wipe → decaying facet; no generic restore notification", async () => {
        const w = await world(); await privacy(w, false);
        const op = await operator();
        expect(await configure(w, op)).toEqual({ok: true});
        const d = h.deps(w, null);
        const tick = await testRestoreSchedulerTick(d);
        expect(tick).toMatchObject({considered: 1, started: 1});
        const [row] = await h.q("select id, trigger, scheduled_for, purpose, mode from fork_restore_run where stack_id=$1", [w.stack]);
        expect(row).toMatchObject({trigger: "schedule", purpose: "test_restore", mode: "new_stack"});
        expect(row.scheduled_for).not.toBeNull();
        const r = await settle(d, w, row.id);
        expect(r).toMatchObject({state: "succeeded", verification: "data_verified", wipe_state: "verified", reason: null});
        expect(r.integrity).toEqual({checked: 1, failed: 0, not_supported: 0});
        expect((r.steps as {name: string; status: string}[]).map((s) => `${s.name}:${s.status}`)).toEqual(["verify_manifest:done", "probe:done", "stage:done", "apply:done", "integrity:done"]);
        expect((await h.journal(row.id)).map((x) => x.step)).toEqual(["probe", "stage", "apply", "integrity", "wipe", "wipe_check"]);
        expect((await h.q("select action, redacted_details from fork_audit_event where action='fork.test_restore.wipe' and resource_id=$1", [row.id]))[0].redacted_details).toMatchObject({workspaceState: "absent", removedWorkspace: false});
        expect(await outbox("restore.finished")).toEqual([]);
        const prot = await loadProtectionByStackId(t.db, w.stack, {configLocked: false, now: h.now()});
        expect(prot?.facets.testRestore).toEqual({daysAgo: 0, stale: false});
        const v = await getTestRestoreView(h.deps(w, op), {stackId: w.stack});
        expect(v.ok && v.view.last).toMatchObject({state: "succeeded", trigger: "schedule", wipe: {state: "verified"}});
        expect(v.ok && v.view.last?.durationSeconds).not.toBeNull();
        // the slot is consumed: a second tick starts nothing
        expect(await testRestoreSchedulerTick(d)).toMatchObject({started: 0});
        expect(await verifyAuditChain(t.db)).toMatchObject({ok: true});
    });

    it("engine integrity failure: run failed/integrity_failed, wipe still verified, facet keeps the OLD value, one test_restore.failed", async () => {
        const w = await world(); await privacy(w, false);
        const op = await operator();
        await configure(w, op);
        const d = h.deps(w, null);
        // an older verified test restore (5 days ago) seeds the facet
        await testRestoreSchedulerTick(d);
        const [first] = await h.q("select id from fork_restore_run where stack_id=$1", [w.stack]);
        await settle(d, w, first.id);
        const old = new Date(h.now().getTime() - 5 * 86_400_000);
        await pool.query("update fork_restore_run set finished_at=$2, created_at=$2 where id=$1", [first.id, old]);
        await pool.query("update fork_test_restore_schedule set last_scheduled_at=$2 where stack_id=$1", [w.stack, new Date(h.now().getTime() - 3 * 3_600_000)]);
        // next slot: engine says corrupt
        expect(await testRestoreSchedulerTick(d)).toMatchObject({started: 1});
        const [second] = await h.q("select id from fork_restore_run where stack_id=$1 and id<>$2", [w.stack, first.id]);
        const r = await settle(d, w, second.id, {restore_verify: {status: "failed", reason: "integrity_failed"}});
        expect(r).toMatchObject({state: "failed", reason: "integrity_failed", failed_step: "integrity", wipe_state: "verified", verification: null});
        const prot = await loadProtectionByStackId(t.db, w.stack, {configLocked: false, now: h.now()});
        expect(prot?.facets.testRestore.daysAgo).toBe(5); // a failure never refreshes the facet
        expect((await outbox("test_restore.failed")).map((x) => x.dedupe_key)).toEqual([`test_restore:${second.id}:failed`]);
    });

    it("a tampered artifact fails at stage; forged manifest ⇒ zero tasks and the wipe is 'not_needed'", async () => {
        const w = await world(); await privacy(w, false);
        const op = await operator();
        await configure(w, op);
        const d = h.deps(w, null);
        await testRestoreSchedulerTick(d);
        const [a] = await h.q("select id from fork_restore_run where stack_id=$1", [w.stack]);
        const r = await settle(d, w, a.id, {restore_stage: {status: "failed", reason: "checksum_mismatch"}});
        expect(r).toMatchObject({state: "failed", reason: "checksum_mismatch", failed_step: "stage", wipe_state: "verified"});
        await pool.query("delete from fork_restore_run where id=$1", [a.id]);
        const forged = h.deps(w, null, {manifest: async () => ({json: w.manifestJson.replace("sequence", "sequencf"), sigB64: w.manifestSig})});
        await pool.query("update fork_test_restore_schedule set last_scheduled_at=null where stack_id=$1", [w.stack]);
        await testRestoreSchedulerTick(forged);
        const [b] = await h.q("select id from fork_restore_run where stack_id=$1", [w.stack]);
        const before = (await h.tasks(w.agent)).length;
        const rb = await settle(forged, w, b.id);
        expect(rb).toMatchObject({state: "failed", wipe_state: "not_needed"});
        expect((await h.tasks(w.agent)).length).toBe(before); // no task was enqueued for a forged manifest
    });

    it("wipe not verified (probe says 'owned'): wipe failed + critical notification, the stack is blocked, 'Wipe now' re-runs it and unblocks", async () => {
        const w = await world(); await privacy(w, false);
        const op = await operator();
        await configure(w, op);
        const d = h.deps(w, null);
        await testRestoreSchedulerTick(d);
        const [a] = await h.q("select id from fork_restore_run where stack_id=$1", [w.stack]);
        const owned = {restore_probe: {result: {roots: [], workspace_state: "owned", arch: null, compose_version: null, rules_sha256: null}}};
        // the first probe (a task of the RUN) must still pass: script by type is per call, so answer the run steps with the default and only then flip
        for (let i = 0; i < 40 && (await h.run(a.id)).state === "running"; i++) { await tickRestoreRun(d, a.id); await h.agentStep(w); }
        const r = await settle(d, w, a.id, owned);
        expect(r).toMatchObject({state: "succeeded", wipe_state: "failed", wipe_reason: "wipe_unverified"});
        expect((await outbox("test_restore.wipe_failed")).length).toBe(1);
        const prot = await loadProtectionByStackId(t.db, w.stack, {configLocked: false, now: h.now()});
        expect(prot?.facets.testRestore.daysAgo).toBeNull(); // no verified wipe ⇒ no facet
        // next slot is skipped as wipe_pending
        await pool.query("update fork_test_restore_schedule set last_scheduled_at=$2 where stack_id=$1", [w.stack, new Date(h.now().getTime() - 3 * 3_600_000)]);
        expect(await testRestoreSchedulerTick(d)).toMatchObject({started: 0, skipped: 1});
        expect((await h.q("select last_reason from fork_test_restore_schedule where stack_id=$1", [w.stack]))[0].last_reason).toBe("wipe_pending");
        expect(await runTestRestoreNow(h.deps(w, op), {stackId: w.stack})).toMatchObject({ok: false, code: "wipe_pending"});
        // admin re-arms; this time the probe says absent
        h.advance(5_000); // a re-armed wipe only counts journal rows created AFTER it was re-armed (the harness clock is frozen otherwise)
        expect(await wipeTestRestoreNow(h.deps(w, op), {runId: a.id})).toEqual({ok: true});
        h.advance(5_000);
        const again = await settle(d, w, a.id);
        expect(again).toMatchObject({wipe_state: "verified"});
        expect((await h.journal(a.id)).filter((x) => x.step === "wipe").length).toBe(2); // a NEW attempt, the old failure is not inherited
    });

    it("personal data: NULL / true without opt-in ⇒ skipped with 0 plans, 0 runs, 0 tasks and one skipped notification; false runs; opt-in runs", async () => {
        const w = await world();
        const op = await operator();
        await privacy(w, null);
        await configure(w, op);
        const d = h.deps(w, null);
        expect(await testRestoreSchedulerTick(d)).toMatchObject({started: 0, skipped: 1});
        expect((await h.q("select count(*)::int n from fork_restore_plan where stack_id=$1", [w.stack]))[0].n).toBe(0);
        expect((await h.q("select count(*)::int n from fork_restore_run where stack_id=$1", [w.stack]))[0].n).toBe(0);
        expect((await h.tasks(w.agent)).length).toBe(0);
        expect((await outbox("test_restore.skipped")).filter((x) => x.dedupe_key.includes(w.stack)).length).toBe(1);
        expect((await h.q("select last_reason from fork_test_restore_schedule where stack_id=$1", [w.stack]))[0].last_reason).toBe("personal_data_no_opt_in");
        // declared personal data + explicit opt-in ⇒ a manual run is accepted
        await privacy(w, true);
        await pool.query("update fork_stack set test_restore_opt_in_at=now(), test_restore_opt_in_by=$2 where id=$1", [w.stack, op.userId]);
        expect(await runTestRestoreNow(h.deps(w, op), {stackId: w.stack})).toMatchObject({ok: true});
    });

    it("no verified recovery point ⇒ skip no_verified_rp; target not test ⇒ configure refused; personal data refused by the PLANNER too (pre-check bypass)", async () => {
        const w = await world(); await privacy(w, false);
        const op = await operator();
        await configure(w, op);
        await pool.query("update fork_recovery_point set status='pending_verification' where stack_id=$1", [w.stack]);
        const d = h.deps(w, null);
        await testRestoreSchedulerTick(d);
        expect((await h.q("select last_reason from fork_test_restore_schedule where stack_id=$1", [w.stack]))[0].last_reason).toBe("no_verified_rp");
        await pool.query("update fork_recovery_point set status='verified' where stack_id=$1", [w.stack]);
        // production target
        const prod = await world({hostRole: "production"});
        expect(await setTestRestoreSchedule(h.deps(w, op), {stackId: w.stack, enabled: true, schedule: HOURLY(h.now()), targetAgentId: prod.agent, restoreRoot: "/srv/restore", staleAfterDays: 14})).toMatchObject({ok: false, code: "target_not_test"});
        // an env flipped to production AFTER enabling is refused by the planner at the next fire
        await pool.query("update fork_arcane_environment set host_role='production' where agent_id=$1", [w.agent]);
        await pool.query("update fork_test_restore_schedule set last_scheduled_at=null where stack_id=$1", [w.stack]);
        await testRestoreSchedulerTick(d);
        expect((await h.q("select last_reason from fork_test_restore_schedule where stack_id=$1", [w.stack]))[0].last_reason).toBe("test_restore_target_not_test");
        expect((await h.q("select count(*)::int n from fork_restore_run where stack_id=$1", [w.stack]))[0].n).toBe(0);
    });

    it("ACL: member / org admin without system admin / system admin without org role are refused; foreign and random stack ids are identical not_found; denials audited; locked refused", async () => {
        const w = await world(); await privacy(w, false);
        const body = (stackId: string) => ({stackId, enabled: false, schedule: HOURLY(h.now()), targetAgentId: null, restoreRoot: null, staleAfterDays: 14});
        const member = await h.user("member"), orgAdmin = await h.user("admin"), sysOnly = await h.user("sys");
        for (const p of [member, orgAdmin, sysOnly]) expect(await setTestRestoreSchedule(h.deps(w, p), body(w.stack)), p.userId).toMatchObject({ok: false});
        expect(await setTestRestoreSchedule(h.deps(w, null), body(w.stack))).toMatchObject({ok: false, code: "forbidden"});
        const op = await operator();
        const nf1 = await setTestRestoreSchedule(h.deps(w, op), body("00000000-0000-4000-8000-0000000000aa"));
        const nf2 = await runTestRestoreNow(h.deps(w, op), {stackId: "00000000-0000-4000-8000-0000000000bb"});
        expect([nf1, nf2].map((x) => x.ok === false && x.code)).toEqual(["not_found", "not_found"]);
        expect((await h.q("select count(*)::int n from fork_audit_event where action='fork.test_restore.denied'"))[0].n).toBeGreaterThanOrEqual(5);
        expect(await setTestRestoreSchedule({...h.deps(w, op), configAllowed: async () => false}, body(w.stack))).toMatchObject({ok: false, code: "locked"});
        // members read, org admins configure nothing; the restore root is admin-only
        expect(await setTestRestoreSchedule(h.deps(w, op), {...body(w.stack), enabled: true, targetAgentId: w.agent, restoreRoot: "/srv/restore"})).toEqual({ok: true});
        const mv = await getTestRestoreView(h.deps(w, member), {stackId: w.stack});
        expect(mv.ok && mv.view.admin).toBeNull();
        expect(mv.ok && mv.view.can).toEqual({configure: false, runNow: false, wipeNow: false});
        const av = await getTestRestoreView(h.deps(w, op), {stackId: w.stack});
        expect(av.ok && av.view.admin?.restoreRoot).toBe("/srv/restore");
        expect(JSON.stringify(mv)).not.toContain("/srv/restore");
        expect(JSON.stringify(mv)).not.toContain(w.agent);
        expect(av.ok && av.view.admin?.schedule?.preset).toBe("hourly");
        expect(av.ok && av.view.admin?.targetAgentId).toBe(w.agent);
    });

    it("a selective restore run (data_only) never feeds the facet (purpose filter)", async () => {
        const w = await world(); await privacy(w, false);
        const d = h.deps(w, await h.user("admin"));
        const c = await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"});
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        expect(await h.drive(d, w, s.runId)).toMatchObject({state: "succeeded", verification: "data_only"});
        const prot = await loadProtectionByStackId(t.db, w.stack, {configLocked: false, now: h.now()});
        expect(prot?.facets.testRestore.daysAgo).toBeNull();
        // mutation guard for the purpose filter: even a (forged) data_verified + verified-wipe row of purpose `restore` must not count
        await pool.query("update fork_restore_run set verification='data_verified', wipe_state='verified' where id=$1", [s.runId]);
        const forged = await loadProtectionByStackId(t.db, w.stack, {configLocked: false, now: h.now()});
        expect(forged?.facets.testRestore.daysAgo).toBeNull();
    });

    it("migration CHECKs reject verification 'tested', trigger 'cron' and stale_after_days 0", async () => {
        const w = await world();
        await expect(pool.query("insert into fork_test_restore_schedule (stack_id, organization_id, schedule, stale_after_days, updated_at) values ($1,$2,'{}',0,now())", [w.stack, org])).rejects.toThrow(/fork_tr_schedule_stale_ck/);
        await expect(pool.query("update fork_restore_run set verification='tested' where false returning 1").then(() => pool.query("select 1"))).resolves.toBeDefined();
        const [r] = (await pool.query("select conname from pg_constraint where conname in ('fork_restore_run_trigger_ck','fork_restore_run_verification_ck','fork_restore_run_task_step_ck','fork_restore_run_wipe_ck')")).rows;
        expect(r).toBeDefined();
        const defs = (await pool.query("select conname, pg_get_constraintdef(oid) d from pg_constraint where conname in ('fork_restore_run_verification_ck','fork_restore_run_trigger_ck')")).rows as {conname: string; d: string}[];
        expect(defs.find((x) => x.conname === "fork_restore_run_verification_ck")?.d).toContain("data_verified");
        expect(defs.find((x) => x.conname === "fork_restore_run_verification_ck")?.d).not.toContain("tested");
        expect(defs.find((x) => x.conname === "fork_restore_run_trigger_ck")?.d).not.toContain("cron");
    });
});
