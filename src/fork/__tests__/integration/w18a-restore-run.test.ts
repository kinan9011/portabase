import {rmSync} from "node:fs";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {verifyAuditChain} from "@/fork/audit";
import type {StepRecord} from "@/fork/runs/engine";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {harness, CAPS, type Harness} from "@/fork/__tests__/w18a-world";
import {adminUser, newKek, seedW17World} from "@/fork/__tests__/w17-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string; let h: Harness;
const key = testKeypair();

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { h = harness(t, kek, key, org); h.reset(); });

const world = (o: {hostRole?: "production" | "test"} = {}) => seedW17World(t, kek, key, admin, {org, caps: CAPS, hostRole: o.hostRole ?? "test"});
const stepNames = (steps: StepRecord[]) => steps.map((s) => `${s.name}:${s.status}`);

describe("W18a orchestrator — happy path and honest terminal states", () => {
    it("new_stack + PostgreSQL: every step in order, exactly one task per step, succeeded/started, audit chain intact, notification, overrides purge", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const c = await h.plan(w);
        const s = await h.start(d, c);
        expect(s).toMatchObject({ok: true});
        if (!s.ok) return;
        const r = await h.drive(d, w, s.runId);
        expect(r.state).toBe("succeeded");
        expect(r.verification).toBe("started");
        expect(r.reason).toBeNull();
        expect(stepNames(r.steps)).toEqual(["verify_manifest:done", "probe:done", "stage:done", "apply:done", "render:done", "restore_db:done", "compose_up:done", "check_services:done"]);
        const j = await h.journal(s.runId);
        expect(j.map((x) => x.step)).toEqual(["probe", "stage", "apply", "render", "restore_db", "compose_up"]); // one task per step, in order
        expect(new Set(j.map((x) => x.task_id)).size).toBe(6);
        expect(r.services).toEqual([{service: "web", state: "running"}, {service: "db", state: "running"}]);
        expect((await h.q("select kind, payload from fork_notification_outbox where dedupe_key=$1", [`restore:${s.runId}:succeeded`]))[0]).toMatchObject({kind: "restore.finished"});
        expect((await h.q("select count(*)::int n from fork_audit_event where action='fork.restore_run.finish' and resource_id=$1", [s.runId]))[0].n).toBe(1);
        expect(await verifyAuditChain(t.db)).toMatchObject({ok: true});
        // every task of the run was addressed to the target agent only
        expect((await h.q("select distinct agent_id from fork_agent_task")).map((x) => x.agent_id)).toEqual([w.agent]);
    });

    it("a data-only plan (selective): verify, probe, stage, apply ⇒ succeeded/data_only; no render, db or up task", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const c = await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"});
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        const r = await h.drive(d, w, s.runId);
        expect(r).toMatchObject({state: "succeeded", verification: "data_only"});
        expect(stepNames(r.steps)).toEqual(["verify_manifest:done", "probe:done", "stage:done", "apply:done"]);
        expect((await h.journal(s.runId)).map((x) => x.task_type)).toEqual(["restore_probe", "restore_stage", "restore_apply"]);
    });

    it("forged manifest (one flipped byte) and rollback (validly signed, other sequence) are refused at verify_manifest: ZERO tasks, failed/manifest_mismatch", async () => {
        const w = await world();
        const flipped = w.manifestJson.replace("sequence", "sequencf");
        await pool.query("update fork_recovery_point set sequence=5 where id=$1", [w.rp]); // the plan binds sequence 5 …
        const rollback = await h.signedManifestOf(w, 4); // … a validly signed manifest of the previous snapshot is a rollback
        for (const [name, bundle] of [["forged", {json: flipped, sigB64: w.manifestSig}], ["rollback", rollback]] as const) {
            const d = h.deps(w, await h.user("admin"), {manifest: async () => bundle});
            const c = await h.plan(w);
            const before = (await h.q("select count(*)::int n from fork_agent_task"))[0].n;
            const s = await h.start(d, c);
            if (!s.ok) throw new Error(`${name}: ${s.code}`);
            await h.tick(d, s.runId);
            const r = await h.run(s.runId);
            expect(r, name).toMatchObject({state: "failed", reason: "manifest_mismatch", failed_step: "verify_manifest"});
            expect((await h.q("select count(*)::int n from fork_agent_task"))[0].n, name).toBe(before);
            expect((await h.journal(s.runId)).length).toBe(0);
            expect((await h.q("select kind from fork_notification_outbox where dedupe_key=$1", [`restore:${s.runId}:failed`]))[0]).toMatchObject({kind: "restore.failed"});
            // free the target agent for the next case: the failed run is terminal, the plan is used
        }
    });
});

const FAILS = [
    ["probe", "restore_probe", "root_not_shared"], ["stage", "restore_stage", "checksum_mismatch"], ["apply", "restore_apply", "volume_exists"],
    ["render", "compose_render", "render_failed"], ["restore_db", "restore_db", "db_restore_failed"], ["compose_up", "compose_up", "container_conflict"],
] as const;
const ALL = ["verify_manifest", "probe", "stage", "apply", "render", "restore_db", "compose_up", "check_services"];

describe("W18a orchestrator — a failure at ANY step is never recorded as success", () => {
    it.each(FAILS)("agent fails %s (%s, %s): run failed at that step, reason verbatim, later steps failed without a code, no later task", async (step, type, reason) => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const c = await h.plan(w);
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        const r = await h.drive(d, w, s.runId, {[type]: {status: "failed", reason}});
        expect(r).toMatchObject({state: "failed", failed_step: step, reason});
        expect(r.verification).toBeNull();
        const steps = r.steps as StepRecord[];
        const at = ALL.indexOf(step);
        expect(steps.slice(0, at).every((x) => x.status === "done")).toBe(true);
        expect(steps[at]).toMatchObject({status: "failed", code: reason});
        for (const later of steps.slice(at + 1)) expect(later).toMatchObject({status: "failed"}), expect(later.code).toBeUndefined();
        expect((await h.journal(s.runId)).map((x) => x.step).at(-1)).toBe(step); // nothing was enqueued after the failure
        expect(await h.tasks(w.agent)).not.toContainEqual(expect.objectContaining({status: "queued"}));
        expect((await h.q("select kind from fork_notification_outbox where dedupe_key=$1", [`restore:${s.runId}:failed`]))[0]).toMatchObject({kind: "restore.failed"});
    });

    it("a service that exited after `up` ⇒ incomplete/service_not_running (never succeeded); restore.failed notification", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const c = await h.plan(w);
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        const r = await h.drive(d, w, s.runId, {compose_up: {result: {project: "app", services: [{service: "web", state: "running"}, {service: "db", state: "exited"}]}}});
        expect(r).toMatchObject({state: "incomplete", reason: "service_not_running", failed_step: "check_services"});
        expect(r.verification).toBeNull();
        expect(r.services).toEqual([{service: "web", state: "running"}, {service: "db", state: "exited"}]);
        expect((await h.q("select kind from fork_notification_outbox where dedupe_key=$1", [`restore:${s.runId}:incomplete`]))[0]).toMatchObject({kind: "restore.failed"});
        // a service missing from the report is the same
        const w2 = await world();
        const d2 = h.deps(w2, await h.user("admin"));
        const s2 = await h.start(d2, await h.plan(w2));
        if (!s2.ok) throw new Error(s2.code);
        expect(await h.drive(d2, w2, s2.runId, {compose_up: {result: {project: "app", services: [{service: "web", state: "running"}]}}})).toMatchObject({state: "incomplete", reason: "service_not_running"});
    });

    it("probe results the plan cannot use are refused with an exact code (root missing / not shared / disk / foreign workspace / no compose / rules drift / malformed)", async () => {
        const base = {roots: [{path: "/srv/restore", shared: true, free_bytes: 1e12}], workspace_state: "absent", compose_version: "5.4.0", rules_sha256: "e".repeat(64)};
        const good = (await import("@/fork/policy/rules")).RULES_SHA256;
        const cases: [string, Record<string, unknown>][] = [
            ["root_missing", {...base, rules_sha256: good, roots: [{path: "/other", shared: true, free_bytes: 1e12}]}],
            ["root_not_shared", {...base, rules_sha256: good, roots: [{path: "/srv/restore", shared: false, free_bytes: 1e12}]}],
            ["insufficient_disk", {...base, rules_sha256: good, roots: [{path: "/srv/restore", shared: true, free_bytes: 10}]}],
            ["workspace_not_owned", {...base, rules_sha256: good, workspace_state: "foreign"}],
            ["compose_unavailable", {...base, rules_sha256: good, compose_version: null}],
            ["rules_mismatch", {...base}],
            ["probe_invalid", {roots: "nope"}],
        ];
        for (const [code, result] of cases) {
            const w = await world();
            const d = h.deps(w, await h.user("admin"));
            const s = await h.start(d, await h.plan(w));
            if (!s.ok) throw new Error(s.code);
            const r = await h.drive(d, w, s.runId, {restore_probe: {result}});
            expect(r, code).toMatchObject({state: "failed", failed_step: "probe", reason: code});
            expect((await h.journal(s.runId)).map((x) => x.step), code).toEqual(["probe"]); // nothing staged on a host that cannot take it
        }
    });
});

describe("W18a orchestrator — reload / restart safety", () => {
    it("agent offline: a never-started task expires (the orchestrator expires it itself), is re-enqueued up to 3 times, then failed/agent_offline", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const s = await h.start(d, await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"}));
        if (!s.ok) throw new Error(s.code);
        for (let i = 0; i < 3; i++) { await h.tick(d, s.runId); expect((await h.run(s.runId)).state).toBe("running"); h.advance(11 * 60_000); }
        await h.tick(d, s.runId);
        const r = await h.run(s.runId);
        expect(r).toMatchObject({state: "failed", reason: "agent_offline", failed_step: "probe"});
        expect((await h.journal(s.runId)).length).toBe(3);
        expect((await h.tasks(w.agent)).map((x) => x.status)).toEqual(["expired", "expired", "expired"]);
    });

    it("one expiry, then the agent comes back: a fresh task (attempt 2) and the run finishes", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const s = await h.start(d, await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"}));
        if (!s.ok) throw new Error(s.code);
        await h.tick(d, s.runId);
        h.advance(11 * 60_000);
        expect(await h.agentStep(w)).toBeNull(); // the returning agent polls: the stale task expires, nothing to run
        const r = await h.drive(d, w, s.runId);
        expect(r).toMatchObject({state: "succeeded", verification: "data_only"});
        expect((await h.journal(s.runId)).filter((x) => x.step === "probe").map((x) => x.attempt)).toEqual([1, 2]);
    });

    it("G9 lease lapse: a task the agent started but never reported is re-offered; ONE journal row per step; the run continues", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const s = await h.start(d, await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"}));
        if (!s.ok) throw new Error(s.code);
        await h.tick(d, s.runId);
        expect(await h.agentStep(w, {}, {lapse: true})).toMatchObject({type: "restore_probe"});
        await h.tick(d, s.runId);
        expect((await h.run(s.runId)).state).toBe("running"); // leased ≠ failed
        h.advance(5 * 60_000);
        const r = await h.drive(d, w, s.runId); // the agent polls again: the lapsed lease is re-queued and handed out again
        expect(r).toMatchObject({state: "succeeded"});
        expect((await h.journal(s.runId)).filter((x) => x.step === "probe").length).toBe(1);
        expect((await h.tasks(w.agent)).find((x) => x.type === "restore_probe")).toMatchObject({status: "succeeded", attempts: 2});
    });

    it("7a: a failure inside the enqueue transaction (journal insert) leaves NO task and NO journal row; the next tick enqueues exactly once", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const s = await h.start(d, await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"}));
        if (!s.ok) throw new Error(s.code);
        await pool.query(`create or replace function w18a_boom_fn() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`);
        await pool.query("create trigger w18a_boom_tg before insert on fork_restore_run_task for each row execute function w18a_boom_fn()");
        const enqueued = async () => (await h.q("select count(*)::int n from fork_audit_event where action='fork.restore_task.enqueue'"))[0].n;
        const before = await enqueued();
        try {
            await h.tick(d, s.runId); // verify_manifest ok, probe enqueue explodes (engine counts the error)
            expect(await h.tasks(w.agent)).toEqual([]);
            expect(await h.journal(s.runId)).toEqual([]);
            expect(await enqueued()).toBe(before); // the success audit rolled back with the task
            expect((await h.run(s.runId)).state).toBe("running");
            await pool.query("drop trigger w18a_boom_tg on fork_restore_run_task"); // the fault is gone
            await h.tick(d, s.runId);
            expect((await h.tasks(w.agent)).length).toBe(1);
            expect((await h.journal(s.runId)).length).toBe(1);
        } finally {
            await pool.query("drop trigger if exists w18a_boom_tg on fork_restore_run_task"); await pool.query("drop function if exists w18a_boom_fn()");
        }
    });

    it("7b: the persisted steps are lost after the enqueue committed (crash): the journal is found, NO duplicate task", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const s = await h.start(d, await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"}));
        if (!s.ok) throw new Error(s.code);
        const initial = (await h.run(s.runId)).steps;
        await h.tick(d, s.runId);
        expect((await h.tasks(w.agent)).length).toBe(1);
        await pool.query("update fork_restore_run set steps=$2 where id=$1", [s.runId, JSON.stringify(initial)]); // everything the tick persisted is gone
        await h.tick(d, s.runId);
        await h.tick(d, s.runId);
        expect((await h.tasks(w.agent)).length).toBe(1);
        expect((await h.journal(s.runId)).length).toBe(1);
        const r = await h.drive(d, w, s.runId);
        expect(r.state).toBe("succeeded");
        expect((await h.journal(s.runId)).map((x) => x.step)).toEqual(["probe", "stage", "apply"]);
    });

    it("7c: a second orchestrator (another owner) while the lease is held sees `busy` and does nothing; an expired lease is taken over (restart)", async () => {
        const {acquireLease} = await import("@/fork/locks");
        const {leaseName} = await import("@/fork/restore-run/tick");
        const w = await world();
        const d = h.deps(w, await h.user("admin"), {owner: "orchestrator-b"});
        const s = await h.start(d, await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"}));
        if (!s.ok) throw new Error(s.code);
        expect(await acquireLease(t.db, leaseName(s.runId), "orchestrator-a", 15 * 60_000, h.now())).toBe(true);
        expect(await h.tick(d, s.runId)).toMatchObject({state: "busy"});
        expect(await h.tasks(w.agent)).toEqual([]);
        h.advance(16 * 60_000); // orchestrator A died: its lease expired
        expect(await h.tick(d, s.runId)).toMatchObject({state: "advanced"});
        expect((await h.tasks(w.agent)).length).toBe(1);
    });
});

describe("W18a orchestrator — cancel, deadline, re-authorisation", () => {
    const sel = {select: ["dir:/srv/app", "volume:app_data"], mode: "selective" as const};
    const begin = async () => {
        const w = await world();
        const p = await h.user("admin");
        const d = h.deps(w, p);
        const s = await h.start(d, await h.plan(w, sel));
        if (!s.ok) throw new Error(s.code);
        return {w, p, d, runId: s.runId};
    };

    it("cancel of a never-started task: task cancelled (payload purged, never handed out), run cancelled, NO notification, idempotent", async () => {
        const {w, d, runId} = await begin();
        await h.tick(d, runId);
        const {cancelRestoreRun} = await import("@/fork/restore-run/service");
        expect(await cancelRestoreRun(d, {runId})).toEqual({ok: true});
        expect(await cancelRestoreRun(d, {runId})).toEqual({ok: true}); // idempotent while active
        expect(await h.tick(d, runId)).toMatchObject({state: "failed"});
        const r = await h.run(runId);
        expect(r).toMatchObject({state: "cancelled", reason: "cancelled"});
        expect((await h.tasks(w.agent))[0]).toMatchObject({status: "cancelled", purged: true});
        expect(await h.agentStep(w)).toBeNull(); // nothing left to lease
        expect((await h.q("select count(*)::int n from fork_notification_outbox where dedupe_key like $1", [`restore:${runId}:%`]))[0].n).toBe(0);
        expect(await cancelRestoreRun(d, {runId})).toMatchObject({ok: false, code: "not_active"});
        expect((await h.q("select count(*)::int n from fork_audit_event where action='fork.restore_run.cancel' and resource_id=$1", [runId]))[0].n).toBe(1);
    });

    it("cancel while the agent holds the task: the run stays active until the task reports, then ends cancelled (never a guess)", async () => {
        const {w, d, runId} = await begin();
        await h.tick(d, runId);
        await h.agentStep(w, {}, {lapse: true}); // leased, running on the agent
        const {cancelRestoreRun} = await import("@/fork/restore-run/service");
        await cancelRestoreRun(d, {runId});
        expect(await h.tick(d, runId)).toMatchObject({state: "advanced"});
        expect((await h.run(runId)).state).toBe("running");
        await h.agentStep(w); // the agent finishes the probe it already started
        await h.tick(d, runId);
        expect(await h.run(runId)).toMatchObject({state: "cancelled"});
        expect((await h.journal(runId)).map((x) => x.step)).toEqual(["probe"]); // no further task was enqueued after the cancel request
    });

    it("deadline: past it the run fails run_timeout, a never-started task is cancelled", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"), {maxRunMs: 60_000});
        const s = await h.start(d, await h.plan(w, sel));
        if (!s.ok) throw new Error(s.code);
        await h.tick(d, s.runId);
        h.advance(2 * 60_000);
        await h.tick(d, s.runId);
        expect(await h.run(s.runId)).toMatchObject({state: "failed", reason: "run_timeout", failed_step: "probe"});
        expect((await h.tasks(w.agent))[0]).toMatchObject({status: "cancelled"});
        expect((await h.q("select kind from fork_notification_outbox where dedupe_key=$1", [`restore:${s.runId}:failed`]))[0]).toMatchObject({kind: "restore.failed"});
    });

    it("D31 re-auth every tick: starter demoted to member, banned/deleted ⇒ failed/reauth_failed with no further task", async () => {
        for (const how of ["demoted", "gone"] as const) {
            const {w, p, d, runId} = await begin();
            await h.tick(d, runId);
            const before = (await h.tasks(w.agent)).length;
            if (how === "demoted") h.principals.set(p.userId, {...p, memberships: [{organizationId: org, role: "member"}]});
            else h.principals.delete(p.userId);
            await h.agentStep(w); // the in-flight probe finishes, but the starter has lost the right to order the next step
            await h.tick(d, runId);
            expect(await h.run(runId), how).toMatchObject({state: "failed", reason: "reauth_failed"});
            expect((await h.tasks(w.agent)).length, how).toBe(before);
        }
    });
});
