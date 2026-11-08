import {rmSync} from "node:fs";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {cancelQueuedTask, leaseTask} from "@/fork/agent-channel/tasks";
import {cancelRestoreRun} from "@/fork/restore-run/service";
import {loadFreshPlan} from "@/fork/restore/service";
import {enqueueRestoreTask} from "@/fork/restore-tasks/enqueue";
import {freshForkDb, seedOrg, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {harness, CAPS, type Harness} from "@/fork/__tests__/w18a-world";
import {adminUser, newKek, seedW17World} from "@/fork/__tests__/w17-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string; let h: Harness;
const key = testKeypair();
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { h = harness(t, kek, key, org); h.reset(); });

const world = () => seedW17World(t, kek, key, admin, {org, caps: CAPS, hostRole: "test"});
const SEL = {select: ["dir:/srv/app", "volume:app_data"], mode: "selective" as const};

describe("W18a D-8: the project a run of THIS plan created on the target is not a plan-staleness input", () => {
    it("foreign project of the plan's name ⇒ stale; the same row with an ACTIVE run of the plan ⇒ fresh; run terminal ⇒ stale again; a DIFFERENT project stays stale", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const c = await h.plan(w);
        const project = (await h.q("select plan->'target'->>'project' p from fork_restore_plan where id=$1", [c.planId]))[0].p as string;
        const fresh = () => loadFreshPlan({db: t.db, now: h.now, principal: starter}, c.planId, c.planHash).then((r) => (r.ok ? "fresh" : r.code));
        expect(await fresh()).toBe("fresh");
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        // restore_db brought the restore's own project up on the target, an Arcane sync then discovered it
        await seedStack(pool, org, w.tgtEnv, project);
        expect(await fresh()).toBe("fresh"); // the exclusion: an active run of this very plan
        await cancelRestoreRun(d, {runId: s.runId});
        await h.tick(d, s.runId); // terminal
        expect(await fresh()).toBe("stale"); // without an active run the row is a real collision again
        // exact name only: a different held project still makes an active run's plan stale
        const w2 = await world();
        const d2 = h.deps(w2, starter);
        const c2 = await h.plan(w2, SEL);
        const s2 = await h.start(d2, c2);
        if (!s2.ok) throw new Error(s2.code);
        await seedStack(pool, org, w2.tgtEnv, "some-other-project");
        expect(await loadFreshPlan({db: t.db, now: h.now, principal: starter}, c2.planId, c2.planHash).then((r) => (r.ok ? "fresh" : r.code))).toBe("stale");
    });

    it("end to end: the project appears on the target between restore_db and compose_up; the run still finishes (no stale refusal after data was written)", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const c = await h.plan(w);
        const project = (await h.q("select plan->'target'->>'project' p from fork_restore_plan where id=$1", [c.planId]))[0].p as string;
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        let injected = false;
        for (let i = 0; i < 40; i++) {
            await h.tick(d, s.runId);
            const r = await h.run(s.runId);
            if (r.state !== "running") break;
            if (!injected && (r.steps as {name: string; status: string}[]).find((x) => x.name === "restore_db")?.status === "done") { await seedStack(pool, org, w.tgtEnv, project); injected = true; }
            await h.agentStep(w);
        }
        expect(injected).toBe(true);
        expect(await h.run(s.runId)).toMatchObject({state: "succeeded", verification: "started"});
    });
});

describe("W18a channel: cancelQueuedTask", () => {
    it("a queued, never-leased task is cancelled (payload purged) and never handed out; a leased one is not", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const base = {...d, principal: starter};
        const a = await enqueueRestoreTask(base as never, {type: "restore_probe", agentId: w.agent, workspace: "/srv/restore/app"});
        const b = await enqueueRestoreTask(base as never, {type: "restore_probe", agentId: w.agent, workspace: "/srv/restore/app"});
        if (!a.ok || !b.ok) throw new Error("enqueue");
        expect(await cancelQueuedTask(t.db, {taskId: a.taskId, agentId: w.agent, now: h.now()})).toBe(true);
        expect((await h.q("select status, payload_enc is null as purged, finished_at is not null as fin from fork_agent_task where id=$1", [a.taskId]))[0]).toEqual({status: "cancelled", purged: true, fin: true});
        const leased = await leaseTask(t.db, await h.enr(w.agent), {capabilities: CAPS, leaseSeconds: 60, now: h.now()});
        expect(leased?.task_id).toBe(b.taskId); // the cancelled task was skipped
        expect(await cancelQueuedTask(t.db, {taskId: b.taskId, agentId: w.agent, now: h.now()})).toBe(false); // in the agent's hands
        expect(await cancelQueuedTask(t.db, {taskId: a.taskId, agentId: w.agent, now: h.now()})).toBe(false); // already terminal
        expect(await cancelQueuedTask(t.db, {taskId: b.taskId, agentId: crypto.randomUUID(), now: h.now()})).toBe(false); // another agent's id never matches
    });
});
