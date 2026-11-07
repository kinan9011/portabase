import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {schedulerTick} from "@/fork/runs/scheduler";
import {startRun} from "@/fork/runs/start";
import {loadStackDetail} from "@/fork/stacks/queries";
import {mkWorld, setEncryption, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; });
afterAll(async () => { await t?.drop(); });
beforeEach(async () => { await pool.query("update fork_stack_policy set deactivated_at=now() where deactivated_at is null"); await setEncryption(pool, true); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const policy = async (w: World) => (await q("select p.paused_at, p.pause_reason, s.protection_state from fork_stack_policy p join fork_stack s on s.id=p.stack_id where p.stack_id=$1", [w.stackId]))[0];
const runCount = async (w: World) => (await q("select count(*)::int c from fork_stack_run where stack_id=$1", [w.stackId]))[0].c as number;
const go = (w: World) => startRun(w.deps, {stackId: w.stackId, trigger: "manual", userId: w.userId});

describe("runs: F7 / D31 run-time re-authorization — failure ⇒ pause + alert, no run", () => {
    const CASES: [string, (w: World) => Promise<void>, string, Parameters<typeof mkWorld>[1]?][] = [
        ["the activating user lost the system admin right", (w) => pool.query("update \"user\" set role='user' where id=$1", [w.userId]).then(() => undefined), "capability_lost"],
        ["the activating user was banned", (w) => pool.query("update \"user\" set banned=true where id=$1", [w.userId]).then(() => undefined), "user_blocked"],
        ["the activating user is pending", (w) => pool.query("update \"user\" set role='pending' where id=$1", [w.userId]).then(() => undefined), "user_blocked"],
        ["the activating user was deleted", (w) => pool.query("delete from \"user\" where id=$1", [w.userId]).then(() => undefined), "user_missing"],
        ["the user is a system admin but only a plain MEMBER of the agent's organization (upstream agent ACL)", (w) => pool.query("update member set role='member' where user_id=$1", [w.userId]).then(() => undefined), "agent_acl_lost"],
        ["backup encryption was switched off (D39)", () => setEncryption(pool, false), "encryption_off"],
        ["the storage channel was disabled", (w) => pool.query("update storage_channel set enabled=false where id = any($1::uuid[])", [w.channels]).then(() => undefined), "channels_unavailable"],
        ["the agent was deleted", (w) => pool.query("delete from agents where id=$1", [w.agent]).then(() => undefined), "agent_gone"],
    ];
    it.each(CASES)("%s ⇒ policy paused (%s), alert queued once, audit written, NO run row", async (_name, revoke, reason) => {
        const w = await mkWorld(t);
        await revoke(w);
        const r = await go(w);
        expect(r).toEqual({kind: "refused", code: "reauth_failed", reason});
        expect(await policy(w)).toMatchObject({pause_reason: reason, protection_state: "paused"});
        expect((await policy(w)).paused_at).toBeTruthy();
        expect(await runCount(w)).toBe(0);
        expect((await q("select action, result, redacted_details as d from fork_audit_event where resource_id=$1", [w.stackId]))[0]).toMatchObject({action: "fork.stack_run.paused", result: "denied", d: {reason}});
        expect((await q("select payload from fork_notification_outbox where kind='run.policy_paused' and payload->>'stackId'=$1", [w.stackId]))).toHaveLength(1);
        // once paused: refused as paused (no second audit / alert), the scheduler does not touch it, a manual retry cannot run
        expect(await go(w)).toEqual({kind: "refused", code: "paused"});
        expect(await q("select 1 from fork_audit_event where resource_id=$1", [w.stackId])).toHaveLength(1);
        expect((await q("select 1 from fork_notification_outbox where kind='run.policy_paused' and payload->>'stackId'=$1", [w.stackId]))).toHaveLength(1);
        w.clock.t = new Date("2026-11-08T02:10:00Z");
        await schedulerTick(w.deps);
        expect(await runCount(w)).toBe(0);
    });

    it("facet 6: the stack details show 'paused after re-authorization' (the W09 read side is fed by protection_state)", async () => {
        const w = await mkWorld(t, {userRole: "admin"});
        await pool.query("update \"user\" set role='user' where id=$1", [w.userId]);
        await go(w);
        const d = (await loadStackDetail(t.db, w.org, w.stackId, {now: w.clock.t, configLocked: false}))!;
        if (d.inventory.state !== "ok") throw new Error("inventory");
        expect(d.inventory.protection.facets.pausedAfterReauthorization).toBe(true);
    });

    it("an authorized user CAN run: the SAME world with intact rights starts (control for the cases above)", async () => {
        const w = await mkWorld(t);
        expect((await go(w)).kind).toBe("started");
        expect(await policy(w)).toMatchObject({pause_reason: null, protection_state: "active"});
    });

    it("a manual run by ANOTHER user is judged against the ACTIVATION record, not the caller (the caller's own right is the action's `backup.run` check)", async () => {
        const w = await mkWorld(t);
        await pool.query("update \"user\" set role='user' where id=$1", [w.userId]);
        const r = await startRun(w.deps, {stackId: w.stackId, trigger: "manual", userId: "00000000-0000-4000-8000-0000000000bb"});
        expect(r).toMatchObject({kind: "refused", code: "reauth_failed", reason: "capability_lost"});
    });

    it("a stack that was never activated cannot run", async () => {
        const w = await mkWorld(t);
        await pool.query("update fork_stack_policy set activated_at=null where stack_id=$1", [w.stackId]);
        expect(await go(w)).toEqual({kind: "refused", code: "not_active"});
        expect(await go({...w, stackId: "00000000-0000-4000-8000-000000000999"})).toEqual({kind: "refused", code: "not_found"});
    });

    it("fix-and-reactivate path: clearing the pause columns the way activateStackPolicy does makes the policy runnable again", async () => {
        const w = await mkWorld(t);
        await pool.query("update \"user\" set role='user' where id=$1", [w.userId]);
        await go(w);
        await pool.query("update \"user\" set role='admin' where id=$1", [w.userId]);
        expect(await go(w)).toEqual({kind: "refused", code: "paused"}); // regaining the right is NOT enough: only an authorized re-activation clears it
        await pool.query("update fork_stack_policy set paused_at=null, pause_reason=null where stack_id=$1", [w.stackId]);
        await pool.query("update fork_stack set protection_state='active' where id=$1", [w.stackId]);
        expect((await go(w)).kind).toBe("started");
    });
});
