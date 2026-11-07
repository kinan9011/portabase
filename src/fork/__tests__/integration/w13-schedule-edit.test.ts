import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import type {MaterializeDeps} from "@/fork/materialize/apply";
import {ForkLockedError} from "@/fork/mode";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {schedulerTick} from "@/fork/runs/scheduler";
import {updateStackSchedule} from "@/fork/stack-policy/update-schedule";
import {mkWorld, T0, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let other: string;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; other = await seedOrg(pool, "other"); });
afterAll(async () => { await t?.drop(); });
beforeEach(() => resetRateLimits());
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const USER = "00000000-0000-4000-8000-0000000000dd";
const P = (systemRole: string | null, ...m: [string, string][]): ForkPrincipal => ({userId: USER, systemRole, memberships: m.map(([organizationId, role]) => ({organizationId, role}))});
const D = (p: ForkPrincipal | null, over: Partial<MaterializeDeps> = {}): MaterializeDeps => ({db: t.db, principal: p, assertConfigAllowed: async () => undefined, rate: () => ({ok: true}), now: () => new Date(T0), ...over});
const input = (w: World, o: Record<string, unknown> = {}) => ({stackId: w.stackId, schedule: {preset: "every_6h", timezone: "Europe/Berlin", minute: 15, hour: 0, weekday: 0, monthday: 1}, retention: {keep_last: 5, daily: 10, weekly: 2, monthly: 3, yearly: 1}, ...o});
const admin = (w: World) => P("admin", [w.org, "owner"]);
const MISSING = "00000000-0000-4000-8000-000000000999";

describe("W13 schedule edit (D31 controlled copy; system admin only; refused while locked)", () => {
    it("a system administrator edits schedule + retention: stored, cron + next runs returned, audited with numbers only, sources untouched", async () => {
        const w = await mkWorld(t);
        const before = (await q("select count(*)::int c from fork_stack_source where stack_id=$1", [w.stackId]))[0].c;
        const r = await updateStackSchedule(D(admin(w)), input(w));
        expect(r).toMatchObject({ok: true, noop: false, paused: false, cron: "15 */6 * * *"});
        if (!r.ok) throw new Error("x");
        expect(r.nextRuns).toHaveLength(3);
        const row = (await q("select schedule, policy from fork_stack_policy where stack_id=$1", [w.stackId]))[0];
        expect(row.schedule).toMatchObject({preset: "every_6h", timezone: "Europe/Berlin", minute: 15});
        expect(row.policy).toEqual({keep_last: 5, daily: 10, weekly: 2, monthly: 3, yearly: 1});
        expect((await q("select count(*)::int c from fork_stack_source where stack_id=$1", [w.stackId]))[0].c).toBe(before);
        const a = (await q("select actor_user_id, result, redacted_details d from fork_audit_event where action='fork.stack_policy.edit_schedule' order by seq desc limit 1"))[0];
        expect(a).toMatchObject({actor_user_id: USER, result: "success", d: {schedulePreset: "every_6h", timezone: "Europe/Berlin", retentionKeepLast: 5}});
    });

    it("an identical edit is a no-op (no audit, no write)", async () => {
        const w = await mkWorld(t);
        const same = {stackId: w.stackId, schedule: {preset: "daily", timezone: "UTC", minute: 0, hour: 2, weekday: 0, monthday: 1}, retention: {keep_last: 3, daily: 7, weekly: 4, monthly: 6, yearly: 0}};
        const n = (await q("select count(*)::int c from fork_audit_event where action='fork.stack_policy.edit_schedule'"))[0].c;
        expect(await updateStackSchedule(D(admin(w)), same)).toMatchObject({ok: true, noop: true});
        expect((await q("select count(*)::int c from fork_audit_event where action='fork.stack_policy.edit_schedule'"))[0].c).toBe(n);
    });

    it("refused for a non-admin: org owner/admin without the system role, plain member, anonymous (denied audit, nothing written)", async () => {
        const w = await mkWorld(t);
        const before = (await q("select schedule from fork_stack_policy where stack_id=$1", [w.stackId]))[0].schedule;
        for (const p of [P("user", [w.org, "owner"]), P("user", [w.org, "member"]), null]) {
            expect(await updateStackSchedule(D(p), input(w))).toMatchObject({ok: false, code: "forbidden"});
        }
        expect((await q("select schedule from fork_stack_policy where stack_id=$1", [w.stackId]))[0].schedule).toEqual(before);
        expect((await q("select result from fork_audit_event where action='fork.stack_policy.edit_schedule' order by seq desc limit 1"))[0].result).toBe("denied");
    });

    it("IDOR: another organization's owner, a stranger and a missing id are indistinguishable (`not_found`); a SYSTEM admin is instance-wide by design (D21: one organization)", async () => {
        const w = await mkWorld(t);
        const before = (await q("select schedule from fork_stack_policy where stack_id=$1", [w.stackId]))[0].schedule;
        const foreign = await updateStackSchedule(D(P("user", [other, "owner"])), input(w));
        const missing = await updateStackSchedule(D(P("user", [other, "owner"])), input(w, {stackId: MISSING}));
        const stranger = await updateStackSchedule(D(P("user")), input(w));
        expect(foreign).toMatchObject({ok: false, code: "not_found"});
        expect(missing).toEqual(foreign);
        expect(stranger).toEqual(foreign);
        expect((await q("select schedule from fork_stack_policy where stack_id=$1", [w.stackId]))[0].schedule).toEqual(before);
    });

    it("refused while the self-check fails (locked) and in mode off; the stored schedule is unchanged", async () => {
        const w = await mkWorld(t);
        const before = (await q("select schedule from fork_stack_policy where stack_id=$1", [w.stackId]))[0].schedule;
        const locked = await updateStackSchedule(D(admin(w), {assertConfigAllowed: async () => { throw new ForkLockedError("locked", "self-check-failed"); }}), input(w));
        expect(locked).toMatchObject({ok: false, code: "locked"});
        const off = await updateStackSchedule(D(admin(w), {assertConfigAllowed: async () => { throw new ForkLockedError("off"); }}), input(w));
        expect(off).toMatchObject({ok: false, code: "locked"});
        expect((await q("select schedule from fork_stack_policy where stack_id=$1", [w.stackId]))[0].schedule).toEqual(before);
    });

    it("strict input: unknown keys, bad timezone, bad cron, out-of-range retention are refused with paths + codes only (never the value)", async () => {
        const w = await mkWorld(t);
        const cases: Record<string, unknown>[] = [
            {extra: 1}, {schedule: {preset: "daily", timezone: "Mars/Olympus", minute: 0, hour: 2, weekday: 0, monthday: 1}},
            {schedule: {preset: "cron", cron: "CANARY-not-a-cron", timezone: "UTC", minute: 0, hour: 2, weekday: 0, monthday: 1}},
            {retention: {keep_last: 0, daily: 7, weekly: 4, monthly: 6, yearly: 0}}, {retention: {keep_last: 3, daily: 9999, weekly: 4, monthly: 6, yearly: 0}},
        ];
        for (const c of cases) {
            const r = await updateStackSchedule(D(admin(w)), input(w, c));
            expect(r).toMatchObject({ok: false, code: "invalid_input"});
            expect(JSON.stringify(r)).not.toContain("CANARY");
        }
        expect(await updateStackSchedule(D(admin(w)), null)).toMatchObject({ok: false, code: "invalid_input"});
    });

    it("a stack without an active policy cannot be edited (refused, denied audit)", async () => {
        const w = await mkWorld(t);
        await pool.query("update fork_stack_policy set deactivated_at = now() where stack_id=$1", [w.stackId]);
        expect(await updateStackSchedule(D(admin(w)), input(w))).toMatchObject({ok: false, code: "refused", reason: "no_active_policy"});
    });

    it("rate limited per user", async () => {
        const w = await mkWorld(t);
        const {checkRate} = await import("@/fork/net/rate-limit");
        const rs = [];
        for (let i = 0; i < 25; i++) rs.push(await updateStackSchedule(D(admin(w), {rate: checkRate}), input(w, {retention: {keep_last: 1 + (i % 50), daily: 1, weekly: 1, monthly: 1, yearly: 0}})) as {ok: boolean; code?: string});
        expect(rs.some((r) => !r.ok && r.code === "rate_limited")).toBe(true);
    });

    it("does NOT clear a pause (only a full re-activation by an authorized user does, F7) and reports it", async () => {
        const w = await mkWorld(t);
        await pool.query("update fork_stack_policy set paused_at=now(), pause_reason='capability_lost' where stack_id=$1", [w.stackId]);
        const r = await updateStackSchedule(D(admin(w)), input(w));
        expect(r).toMatchObject({ok: true, paused: true});
        expect((await q("select pause_reason from fork_stack_policy where stack_id=$1", [w.stackId]))[0].pause_reason).toBe("capability_lost");
    });

    it("the new schedule does not back-fill slots that would have been due: the scheduler's reference moves to the edit time", async () => {
        const w = await mkWorld(t);
        // 10:00 UTC now; an hourly schedule has a slot at 10:00 (due) — an EDIT at 10:00 must not start a run for it
        await updateStackSchedule(D(admin(w), {now: () => new Date(T0)}), input(w, {schedule: {preset: "hourly", timezone: "UTC", minute: 0, hour: 0, weekday: 0, monthday: 1}}));
        w.clock.t = new Date(T0.getTime() + 5 * 60_000);
        await schedulerTick(w.deps);
        expect(await q("select 1 from fork_stack_run where stack_id=$1", [w.stackId])).toHaveLength(0);
        w.clock.t = new Date(T0.getTime() + 61 * 60_000); // the NEXT slot (11:00) does run
        await schedulerTick(w.deps);
        expect((await q("select trigger from fork_stack_run where stack_id=$1", [w.stackId]))[0]?.trigger).toBe("schedule");
    });
});
