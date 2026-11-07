import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {cancelStackRun, startStackRun, type RunDepsWithPrincipal} from "@/fork/runs/run-service";
import {mkWorld, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let other: string;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; other = await seedOrg(pool, "other"); });
afterAll(async () => { await t?.drop(); });
beforeEach(() => resetRateLimits());
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const P = (w: World, systemRole: string | null, ...m: [string, string][]): ForkPrincipal => ({userId: "00000000-0000-4000-8000-0000000000cc", systemRole, memberships: m.map(([organizationId, role]) => ({organizationId, role}))});
const D = (w: World, principal: ForkPrincipal | null, over: Partial<RunDepsWithPrincipal> = {}): RunDepsWithPrincipal => ({...w.deps, principal, ...over});
const MISSING = "00000000-0000-4000-8000-000000000999";

describe("runs: server-side permission checks + audit on every mutation (wave security checks)", () => {
    it("`backup.run` = organization owner/admin: an admin starts a run (audited as the user)", async () => {
        const w = await mkWorld(t);
        const r = await startStackRun(D(w, P(w, null, [w.org, "admin"])), {stackId: w.stackId});
        expect(r).toMatchObject({ok: true});
        const a = await q("select actor_user_id, action, result from fork_audit_event where action='fork.stack_run.start' order by seq desc limit 1");
        expect(a[0]).toMatchObject({actor_user_id: "00000000-0000-4000-8000-0000000000cc", result: "success"});
        expect((await q("select trigger, triggered_by from fork_stack_run where stack_id=$1", [w.stackId]))[0]).toMatchObject({trigger: "manual", triggered_by: "00000000-0000-4000-8000-0000000000cc"});
    });

    it("a plain member of the owning org: 403-equivalent `forbidden`; no run, denied audit", async () => {
        const w = await mkWorld(t);
        expect(await startStackRun(D(w, P(w, null, [w.org, "member"])), {stackId: w.stackId})).toEqual({ok: false, code: "forbidden"});
        expect(await q("select 1 from fork_stack_run where stack_id=$1", [w.stackId])).toHaveLength(0);
        expect((await q("select result, redacted_details d from fork_audit_event where action='fork.stack_run.start' order by seq desc limit 1"))[0]).toMatchObject({result: "denied", d: {reason: "forbidden"}});
    });

    it("IDOR: another organization's admin, a stranger and a missing id are indistinguishable (`not_found`); anonymous is forbidden", async () => {
        const w = await mkWorld(t);
        const foreign = await startStackRun(D(w, P(w, "user", [other, "owner"])), {stackId: w.stackId});
        const missing = await startStackRun(D(w, P(w, "user", [other, "owner"])), {stackId: MISSING});
        const stranger = await startStackRun(D(w, P(w, "user")), {stackId: w.stackId});
        expect(foreign).toEqual({ok: false, code: "not_found"});
        expect(missing).toEqual(foreign);
        expect(stranger).toEqual(foreign);
        expect(await startStackRun(D(w, null), {stackId: w.stackId})).toEqual({ok: false, code: "forbidden"});
        expect(await q("select 1 from fork_stack_run where stack_id=$1", [w.stackId])).toHaveLength(0);
    });

    it("strict input: unknown keys, a non-uuid and a missing id are refused before anything is read", async () => {
        const w = await mkWorld(t);
        for (const bad of [{stackId: w.stackId, extra: 1}, {stackId: "nope"}, {}, null, "x"]) expect(await startStackRun(D(w, P(w, null, [w.org, "owner"])), bad)).toEqual({ok: false, code: "invalid_input"});
    });

    it("rate limited per user", async () => {
        const w = await mkWorld(t);
        const d = D(w, P(w, null, [w.org, "owner"]));
        const results = [];
        for (let i = 0; i < 8; i++) results.push((await startStackRun(d, {stackId: w.stackId})) as {ok: boolean; code?: string});
        expect(results.filter((r) => !r.ok && r.code === "rate_limited").length).toBeGreaterThan(0);
        expect(results[0].ok).toBe(true);
    });

    it("an activation that no longer holds refuses with the pause reason and the policy is paused (F7 through the action)", async () => {
        const w = await mkWorld(t);
        await pool.query("update \"user\" set role='user' where id=$1", [w.userId]);
        const r = await startStackRun(D(w, P(w, null, [w.org, "owner"])), {stackId: w.stackId});
        expect(r).toEqual({ok: false, code: "reauth_failed", reason: "capability_lost"});
        expect((await q("select protection_state from fork_stack where id=$1", [w.stackId]))[0].protection_state).toBe("paused");
    });

    it("a manual run is allowed while configuration is LOCKED (it is not a configuration change) but never in mode off", async () => {
        const locked = await mkWorld(t, {deps: {mode: async () => "locked"}});
        expect((await startStackRun(D(locked, P(locked, null, [locked.org, "owner"])), {stackId: locked.stackId})).ok).toBe(true);
        const off = await mkWorld(t, {deps: {mode: async () => "off"}});
        expect(await startStackRun(D(off, P(off, null, [off.org, "owner"])), {stackId: off.stackId})).toEqual({ok: false, code: "off"});
    });

    it("cancel: same checks (owner/admin, resource-scoped, not_found for a foreign run), audited", async () => {
        const w = await mkWorld(t);
        const started = await startStackRun(D(w, P(w, null, [w.org, "owner"])), {stackId: w.stackId});
        if (!started.ok) throw new Error("not started");
        expect(await cancelStackRun(D(w, P(w, null, [w.org, "member"])), {runId: started.runId})).toEqual({ok: false, code: "forbidden"});
        expect(await cancelStackRun(D(w, P(w, "user", [other, "owner"])), {runId: started.runId})).toEqual({ok: false, code: "not_found"});
        expect(await cancelStackRun(D(w, P(w, "user", [other, "owner"])), {runId: MISSING})).toEqual({ok: false, code: "not_found"});
        expect(await cancelStackRun(D(w, null), {runId: started.runId})).toEqual({ok: false, code: "forbidden"});
        expect(await cancelStackRun(D(w, P(w, null, [w.org, "owner"])), {runId: "nope"})).toEqual({ok: false, code: "invalid_input"});
        const done = await cancelStackRun(D(w, P(w, null, [w.org, "owner"])), {runId: started.runId});
        expect(done).toMatchObject({ok: true});
        expect((await q("select state from fork_stack_run where id=$1", [started.runId]))[0].state).toBe("cancelled");
        expect(await cancelStackRun(D(w, P(w, null, [w.org, "owner"])), {runId: started.runId})).toEqual({ok: false, code: "not_active"});
        expect((await q("select actor_user_id from fork_audit_event where action='fork.stack_run.cancel'"))[0].actor_user_id).toBeTruthy();
    });
});
