import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {runsTick} from "@/fork/runs/job";
import {schedulerTick} from "@/fork/runs/scheduler";
import {tickAllRuns} from "@/fork/runs/service";
import {startRun} from "@/fork/runs/start";
import {agent, mkWorld, naive, touchAgent, waitingBackups, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; });
afterAll(async () => { await t?.drop(); });
// the scheduler considers EVERY active policy: switch off the worlds of earlier tests so counts are about this test only
beforeEach(async () => { await pool.query("update fork_stack_policy set deactivated_at=now() where deactivated_at is null"); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const at = (w: World, iso: string) => { w.clock.t = new Date(iso); };
const runs = (w: World) => q("select * from fork_stack_run where stack_id=$1 order by started_at, scheduled_for", [w.stackId]);
const happy = async (w: World) => { for (const b of await waitingBackups(pool, w)) if (b.status === "waiting") { await agent.pickUp(pool, w, b.id); await agent.succeed(pool, w, b.id); } };

describe("runs: dashboard-held schedule (D14) — ARCH-17 capture window + skip semantics, ARCH-10 missed runs", () => {
    it("a slot inside the capture window STARTS a scheduled run; the same slot never runs twice", async () => {
        const w = await mkWorld(t);
        at(w, "2026-11-07T02:10:00Z");
        const r1 = await schedulerTick(w.deps);
        expect(r1).toMatchObject({considered: 1, started: 1, skipped: 0});
        const [row] = await runs(w);
        expect(row).toMatchObject({trigger: "schedule", state: "starting", triggered_by: null});
        expect(new Date(row.scheduled_for).toISOString()).toBe("2026-11-07T02:00:00.000Z");
        // a second tick while it runs: overlap is for a NEW slot only; the same slot is already handled
        expect(await schedulerTick(w.deps)).toMatchObject({started: 0, skipped: 0});
        await touchAgent(pool, w);
        for (let i = 0; i < 6; i++) { await tickAllRuns(w.deps); await happy(w); w.clock.t = new Date(w.clock.t.getTime() + 1000); }
        expect((await runs(w))[0].state).toBe("succeeded");
        expect(await schedulerTick(w.deps)).toMatchObject({started: 0, skipped: 0});
        expect((await runs(w)).length).toBe(1);
        expect((await q("select last_scheduled_at from fork_schedule_state where stack_id=$1", [w.stackId]))[0].last_scheduled_at).toBeTruthy();
    });

    it("past the capture window the slot is MISSED: a skipped row, an audit event and an alert — never a silent gap; idempotent", async () => {
        const w = await mkWorld(t);
        at(w, "2026-11-07T10:00:00Z"); // 8 h after the 02:00 slot, window 60 min
        expect(await schedulerTick(w.deps)).toMatchObject({started: 0, skipped: 1});
        expect(await schedulerTick(w.deps)).toMatchObject({started: 0, skipped: 0});
        const rows = await runs(w);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({state: "skipped", skip_reason: "missed", trigger: "schedule"});
        expect((await q("select action, result from fork_audit_event where resource_id=$1", [rows[0].id]))[0]).toMatchObject({action: "fork.stack_run.skipped", result: "denied"});
        expect((await q("select kind from fork_notification_outbox where kind='run.skipped'")).length).toBeGreaterThanOrEqual(1);
    });

    it("downtime: 10 days of missed daily slots produce ONE decision, not ten (no backlog replay)", async () => {
        const w = await mkWorld(t);
        await pool.query("update fork_stack_policy set activated_at=$2 where stack_id=$1", [w.stackId, new Date("2026-10-27T00:00:00Z")]);
        at(w, "2026-11-07T02:20:00Z");
        expect(await schedulerTick(w.deps)).toMatchObject({started: 1, skipped: 0});
        expect((await runs(w)).length).toBe(1);
    });

    it("overlap: a slot that falls due while a run is active is skipped(overlap), the active run is untouched", async () => {
        const w = await mkWorld(t);
        at(w, "2026-11-06T09:00:00Z");
        await pool.query("update fork_stack_policy set activated_at=$2 where stack_id=$1", [w.stackId, new Date("2026-11-06T08:00:00Z")]);
        const manual = await startRun(w.deps, {stackId: w.stackId, trigger: "manual", userId: w.userId});
        expect(manual.kind).toBe("started");
        at(w, "2026-11-07T02:05:00Z"); // the 02:00 slot is due, the manual run is still active
        expect(await schedulerTick(w.deps)).toMatchObject({started: 0, skipped: 1});
        const rows = await runs(w);
        expect(rows.map((r) => [r.trigger, r.state, r.skip_reason])).toEqual(expect.arrayContaining([["manual", "starting", null], ["schedule", "skipped", "overlap"]]));
    });

    it("capacity: the slot waits (no row, not consumed) while the host is busy, starts when it frees up, and is missed once the window ends", async () => {
        const w = await mkWorld(t, {cfg: {maxPerAgent: 1}});
        const other = (await pool.query("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name, protection_state) values ($1,$2,'env','busy','busy','active') returning id", [w.org, w.env])).rows[0].id as string;
        await pool.query("insert into fork_stack_run (stack_id, trigger, state) values ($1,'manual','running')", [other]);
        at(w, "2026-11-07T02:10:00Z");
        expect(await schedulerTick(w.deps)).toMatchObject({started: 0, waiting: 1});
        expect(await runs(w)).toHaveLength(0);
        await pool.query("update fork_stack_run set state='failed', reason='member_failed', finished_at=now() where stack_id=$1", [other]);
        at(w, "2026-11-07T02:40:00Z");
        expect(await schedulerTick(w.deps)).toMatchObject({started: 1});
        const w2 = await mkWorld(t, {cfg: {maxPerAgent: 1}});
        const other2 = (await pool.query("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name, protection_state) values ($1,$2,'env','busy2','busy2','active') returning id", [w2.org, w2.env])).rows[0].id as string;
        await pool.query("insert into fork_stack_run (stack_id, trigger, state) values ($1,'manual','running')", [other2]);
        at(w2, "2026-11-07T03:30:00Z"); // 90 min after the slot: the window is over
        expect(await schedulerTick(w2.deps)).toMatchObject({started: 0, skipped: 1});
        expect((await runs(w2))[0]).toMatchObject({state: "skipped", skip_reason: "missed"});
    });

    it("timezone: 03:00 Europe/Berlin is the 02:00Z slot in winter", async () => {
        const w = await mkWorld(t, {schedule: {preset: "daily", timezone: "Europe/Berlin", minute: 0, hour: 3, weekday: 0, monthday: 1}});
        at(w, "2026-11-07T02:05:00Z");
        expect(await schedulerTick(w.deps)).toMatchObject({started: 1});
        expect(new Date((await runs(w))[0].scheduled_for).toISOString()).toBe("2026-11-07T02:00:00.000Z");
    });

    it("a paused, deactivated or never-activated policy is never scheduled", async () => {
        const paused = await mkWorld(t);
        await pool.query("update fork_stack_policy set paused_at=now(), pause_reason='capability_lost' where stack_id=$1", [paused.stackId]);
        await pool.query("update fork_stack set protection_state='paused' where id=$1", [paused.stackId]);
        const off = await mkWorld(t);
        await pool.query("update fork_stack_policy set deactivated_at=now() where stack_id=$1", [off.stackId]);
        const never = await mkWorld(t);
        await pool.query("update fork_stack_policy set activated_at=null where stack_id=$1", [never.stackId]);
        for (const w of [paused, off, never]) { at(w, "2026-11-07T02:10:00Z"); await schedulerTick(w.deps); expect(await runs(w)).toHaveLength(0); }
    });

    it("an invalid stored schedule never runs and never throws; the other stacks are unaffected", async () => {
        const bad = await mkWorld(t);
        await pool.query("update fork_stack_policy set schedule='{\"preset\":\"nonsense\"}' where stack_id=$1", [bad.stackId]);
        const good = await mkWorld(t);
        at(good, "2026-11-07T02:10:00Z");
        const r = await schedulerTick(good.deps);
        expect(r.failed).toBeGreaterThanOrEqual(1);
        expect(await runs(bad)).toHaveLength(0);
        expect((await runs(good)).length).toBe(1);
    });

    it("mode: off ⇒ nothing; locked ⇒ the schedule KEEPS running (ADR-010 degraded mode)", async () => {
        const w = await mkWorld(t, {deps: {mode: async () => "off"}});
        at(w, "2026-11-07T02:10:00Z");
        expect(await schedulerTick(w.deps)).toMatchObject({considered: 0, started: 0});
        await pool.query("update fork_stack_policy set deactivated_at=now() where stack_id=$1", [w.stackId]);
        const l = await mkWorld(t, {deps: {mode: async () => "locked"}});
        at(l, "2026-11-07T02:10:00Z");
        const tick = await runsTick(l.deps);
        expect(tick.scheduler).toMatchObject({started: 1});
        expect((await runs(l))[0].trigger).toBe("schedule");
    });

    it("runsTick isolates failures and runs retention only when asked", async () => {
        const w = await mkWorld(t);
        at(w, "2026-11-07T02:10:00Z");
        const r = await runsTick(w.deps, {retention: true});
        expect(r.scheduler.started).toBe(1);
        expect(r.retention).toBeDefined();
        expect((await runsTick(w.deps)).retention).toBeUndefined();
    });
});

void naive;
