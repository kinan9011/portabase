import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {cancelRun, tickAllRuns, tickRun} from "@/fork/runs/service";
import {startRun} from "@/fork/runs/start";
import {agent, mkWorld, naive, setEncryption, sha, smallCfg, touchAgent, waitingBackups, T0, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; });
afterAll(async () => { await t?.drop(); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];

/** Plays N agent rounds: each tick, `play` may act on the waiting backups; time moves `step` ms per round. */
async function drive(w: World, o: {rounds?: number; stepMs?: number; play?: (backups: Awaited<ReturnType<typeof waitingBackups>>, round: number) => Promise<void>} = {}) {
    for (let r = 0; r < (o.rounds ?? 10); r++) {
        await touchAgent(pool, w);
        await tickAllRuns(w.deps);
        if (o.play) await o.play(await waitingBackups(pool, w), r);
        w.clock.t = new Date(w.clock.t.getTime() + (o.stepMs ?? 1000));
        if ((await q("select 1 from fork_stack_run where stack_id=$1 and state in ('starting','running','finalizing')", [w.stackId])).length === 0) return;
    }
}
const happy = (w: World, opts: Parameters<typeof agent.succeed>[3] = {}) => async (bs: Awaited<ReturnType<typeof waitingBackups>>) => {
    for (const b of bs) if (b.status === "waiting") { await agent.pickUp(pool, w, b.id); await agent.succeed(pool, w, b.id, opts); }
};
const rp = async (stackId: string) => (await q("select * from fork_recovery_point where stack_id=$1 order by sequence", [stackId]));
const run = async (id: string) => (await q("select * from fork_stack_run where id=$1", [id]))[0];
const start = async (w: World, trigger: "manual" | "schedule" = "manual") => {
    const r = await startRun(w.deps, {stackId: w.stackId, trigger, userId: trigger === "manual" ? w.userId : null});
    if (r.kind !== "started") throw new Error(`not started: ${JSON.stringify(r)}`);
    return r.runId;
};

describe("runs: happy path — grouped backup becomes a pending_verification RecoveryPoint (D43), never verified", () => {
    it("two members × one channel: both triggered together, RP with linked artifacts, checksums, sequence, schedule state", async () => {
        const w = await mkWorld(t);
        const id = await start(w);
        await drive(w, {play: happy(w)});
        const r = await run(id);
        expect(r).toMatchObject({state: "succeeded", reason: null, validator_blocked: false, inventory_refresh: "ok"});
        const [point] = await rp(w.stackId);
        expect(point).toMatchObject({status: "pending_verification", downgrade_reason: null, sequence: "1", required_artifact_count: 2, present_artifact_count: 2, consistency_level: "mixed", verified_at: null, run_id: id});
        expect(Number(point.total_size_bytes)).toBe(2000);
        const arts = await q("select * from fork_recovery_point_artifact where rp_id=$1 order by source_name", [point.id]);
        expect(arts).toHaveLength(2);
        for (const a of arts) {
            expect(a).toMatchObject({presence: "present", required: true, encrypted: true, archive_kind: "archive_enc", channel_id: w.channels[0], channel_kind: "s3"});
            expect(a.backup_id).toBeTruthy(); expect(a.backup_storage_id).toBeTruthy(); expect(a.stack_source_id).toBeTruthy();
            expect(a.ciphertext_sha256).toBe(sha(a.backup_storage_id)); // the dashboard-computed checksum, tied to the storage row
            expect(a.generated_id).toMatch(/^[0-9a-f-]{36}$/);
        }
        const items = await q("select state, backup_id from fork_stack_run_item where run_id=$1", [id]);
        expect(items.map((i) => i.state)).toEqual(["succeeded", "succeeded"]);
        // BOTH member backups were queued in the same trigger step (grouped), through the upstream waiting row
        const bs = await waitingBackups(pool, w);
        expect(bs).toHaveLength(2);
        const ss = (await q("select last_run_status, consecutive_failures, last_run_finished_at from fork_schedule_state where stack_id=$1", [w.stackId]))[0];
        expect(ss).toMatchObject({last_run_status: "success", consecutive_failures: 0});
        expect((await q("select count(*)::int c from fork_recovery_point where status='verified'"))[0].c).toBe(0);
        const audit = await q("select action, result from fork_audit_event where resource_id=$1 order by seq", [id]);
        expect(audit.map((a) => a.action)).toEqual(["fork.stack_run.start", "fork.stack_run.finish"]);
    });

    it("the next run gets sequence 2 and its own RP (monotonic per stack)", async () => {
        const w = await mkWorld(t);
        for (let i = 0; i < 2; i++) { await start(w); await drive(w, {play: happy(w)}); }
        expect((await rp(w.stackId)).map((x) => [x.sequence, x.status])).toEqual([["1", "pending_verification"], ["2", "pending_verification"]]);
    });

    it("restic artifacts need no object checksum: the snapshot id is the identity; archive_kind restic_snapshot, always encrypted", async () => {
        const w = await mkWorld(t, {dbms: ["files"]});
        await start(w);
        await drive(w, {play: happy(w, {engine: "restic"})});
        const [point] = await rp(w.stackId);
        expect(point, JSON.stringify(point)).toMatchObject({status: "pending_verification"});
        const [a] = await q("select * from fork_recovery_point_artifact where rp_id=$1", [point.id]);
        expect(a).toMatchObject({archive_kind: "restic_snapshot", encrypted: true, ciphertext_sha256: null});
        expect(a.path_or_snapshot_id).toMatch(/^[0-9a-f]{64}$/);
    });

    it("two channels ⇒ two artifact slots per member (required_artifact_count = members × channels)", async () => {
        const w = await mkWorld(t, {channels: 2});
        await start(w);
        await drive(w, {play: happy(w)});
        const [point] = await rp(w.stackId);
        expect(point).toMatchObject({status: "pending_verification", required_artifact_count: 4, present_artifact_count: 4});
    });
});

describe("runs: honest failures — nothing claims success", () => {
    it("one member fails ⇒ INCOMPLETE RP of what was captured (member_failed), run incomplete, alert queued", async () => {
        const w = await mkWorld(t);
        const id = await start(w);
        await drive(w, {play: async (bs) => { for (const [i, b] of bs.entries()) if (b.status === "waiting") { await agent.pickUp(pool, w, b.id); if (i === 0) await agent.succeed(pool, w, b.id); else await agent.fail(pool, w, b.id); } }});
        expect(await run(id)).toMatchObject({state: "incomplete", reason: "member_failed"});
        const [point] = await rp(w.stackId);
        expect(point).toMatchObject({status: "incomplete", downgrade_reason: "member_failed", required_artifact_count: 2, present_artifact_count: 1});
        const arts = await q("select presence from fork_recovery_point_artifact where rp_id=$1 order by presence", [point.id]);
        expect(arts.map((a) => a.presence)).toEqual(["missing", "present"]);
        expect((await q("select kind from fork_notification_outbox where dedupe_key=$1", [`run.incomplete:${id}`])).length).toBe(1);
        expect((await q("select last_run_status from fork_schedule_state where stack_id=$1", [w.stackId]))[0].last_run_status).toBe("partial");
    });

    it("every member fails ⇒ failed run, failed RP (member_failed), failure counted for the dead-man", async () => {
        const w = await mkWorld(t);
        const id = await start(w);
        await drive(w, {play: async (bs) => { for (const b of bs) if (b.status === "waiting") { await agent.pickUp(pool, w, b.id); await agent.fail(pool, w, b.id); } }});
        expect(await run(id)).toMatchObject({state: "failed", reason: "member_failed"});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "failed", downgrade_reason: "member_failed", present_artifact_count: 0});
        expect((await q("select last_run_status, consecutive_failures from fork_schedule_state where stack_id=$1", [w.stackId]))[0]).toMatchObject({last_run_status: "failed", consecutive_failures: 1});
        expect((await q("select state from fork_notification_outbox where dedupe_key=$1", [`run.failed:${id}`])).length).toBe(1);
    });

    it("STUCK waiting (agent silent / poll failing): item + run FAILED 'agent_did_not_start', the waiting row is cancelled, no pending RP", async () => {
        const w = await mkWorld(t);
        const id = await start(w);
        await drive(w, {rounds: 3});
        w.clock.t = new Date(w.clock.t.getTime() + 11 * 60_000); // past the 10 min wait timeout, nothing ever picked the backups up
        await drive(w, {rounds: 3});
        expect(await run(id)).toMatchObject({state: "failed", reason: "agent_did_not_start"});
        const items = await q("select state, reason from fork_stack_run_item where run_id=$1", [id]);
        expect(items.every((i) => i.state === "failed" && i.reason === "agent_did_not_start")).toBe(true);
        const [point] = await rp(w.stackId);
        expect(point).toMatchObject({status: "failed", downgrade_reason: "member_timeout"});
        expect((await waitingBackups(pool, w)).every((b) => b.status === "failed" && b.deleted_at !== null)).toBe(true); // a late agent start can no longer create orphan data
        expect((await q("select count(*)::int c from fork_recovery_point where stack_id=$1 and status in ('pending_verification','verified')", [w.stackId]))[0].c).toBe(0);
    });

    it("STUCK ongoing (per-source lock held: the agent bails, the row stays ongoing) ⇒ FAILED 'agent_made_no_progress'", async () => {
        const w = await mkWorld(t, {dbms: ["files"]});
        const id = await start(w);
        await drive(w, {rounds: 3, play: async (bs) => { for (const b of bs) if (b.status === "waiting") await agent.pickUp(pool, w, b.id); }});
        w.clock.t = new Date(w.clock.t.getTime() + 31 * 60_000);
        await drive(w, {rounds: 3});
        expect(await run(id), JSON.stringify(await q("select i.state, i.reason, i.last_progress_at, b.updated_at, b.status from fork_stack_run_item i join backups b on b.id=i.backup_id where i.run_id=$1", [id]))).toMatchObject({state: "failed", reason: "agent_made_no_progress"});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "failed", downgrade_reason: "member_timeout"});
    });

    it("an agent that keeps making progress is NOT timed out (progress evidence resets the stall clock)", async () => {
        const w = await mkWorld(t, {dbms: ["files"]});
        const id = await start(w);
        await drive(w, {rounds: 1, play: async (bs) => { for (const b of bs) await agent.pickUp(pool, w, b.id); }});
        for (let i = 0; i < 4; i++) { // 4 × 20 min with a heartbeat each time: well past 30 min in total
            w.clock.t = new Date(w.clock.t.getTime() + 20 * 60_000);
            await pool.query("update backups set updated_at=$1 where database_id=$2", [naive(w.clock.t), w.members[0].databaseId]);
            await touchAgent(pool, w);
            await tickAllRuns(w.deps);
        }
        expect((await run(id)).state).toBe("running");
        await agent.succeed(pool, w, (await waitingBackups(pool, w))[0].id);
        await drive(w);
        expect((await run(id)).state).toBe("succeeded");
    });

    it("hard run deadline: everything unfinished fails with run_timeout", async () => {
        const w = await mkWorld(t, {dbms: ["files"], cfg: {maxRunMs: 5 * 60_000, waitTimeoutMs: 3_600_000, stallTimeoutMs: 3_600_000}});
        const id = await start(w);
        await drive(w, {rounds: 2});
        w.clock.t = new Date(w.clock.t.getTime() + 6 * 60_000);
        await drive(w, {rounds: 3});
        expect(await run(id)).toMatchObject({state: "failed"});
        expect((await q("select reason from fork_stack_run_item where run_id=$1", [id]))[0].reason).toBe("run_timeout");
    });

    it("nothing could be queued (every member busy with a manual backup) ⇒ failed RP 'run_not_started', run failed", async () => {
        const w = await mkWorld(t);
        for (const m of w.members) await pool.query("insert into backups (database_id, status) values ($1,'waiting')", [m.databaseId]);
        const id = await start(w);
        await drive(w, {rounds: 4});
        expect(await run(id)).toMatchObject({state: "failed", reason: "nothing_queued"});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "failed", downgrade_reason: "run_not_started", required_artifact_count: 2, present_artifact_count: 0});
        expect((await q("select reason from fork_stack_run_item where run_id=$1", [id])).map((i) => i.reason)).toEqual(["member_busy", "member_busy"]);
    });

    it("a member with a method conflict is skipped, the other is still captured ⇒ INCOMPLETE", async () => {
        const w = await mkWorld(t);
        await pool.query("update databases set method_conflict='archive vs restic' where id=$1", [w.members[1].databaseId]);
        const id = await start(w);
        await drive(w, {play: happy(w)});
        expect(await run(id)).toMatchObject({state: "incomplete"});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "incomplete", downgrade_reason: "member_failed", present_artifact_count: 1});
        expect((await q("select reason from fork_stack_run_item where run_id=$1 and state='skipped'", [id]))[0].reason).toBe("member_method_conflict");
    });

    it("planned / canary / drifted members are not part of a run: they are listed as skipped and the RP is incomplete", async () => {
        const w = await mkWorld(t);
        await pool.query("update fork_stack_source set status='canary' where id=$1", [w.members[1].linkId]);
        const id = await start(w);
        await drive(w, {play: happy(w)});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "incomplete"});
        expect((await q("select reason from fork_stack_run_item where run_id=$1 and state='skipped'", [id]))[0].reason).toBe("member_not_active");
    });
});

describe("runs: EU-04 validator blocked ⇒ INCOMPLETE RP of everything readable, plus an event", () => {
    it("members that cover nothing: the run still captures them and finalizes incomplete(validator_blocked)", async () => {
        const w = await mkWorld(t, {covers: false});
        const id = await start(w);
        await drive(w, {play: happy(w)});
        expect(await run(id)).toMatchObject({state: "incomplete", validator_blocked: true, reason: null});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "incomplete", downgrade_reason: "validator_blocked", present_artifact_count: 2});
        expect((await q("select kind from fork_notification_outbox where dedupe_key=$1", [`run.blocked:${id}`])).length).toBe(1);
    });
});

describe("runs: D39 / checksums — never pending_verification with an unencrypted or unchecksummed artifact", () => {
    it("an archive without the .enc suffix ⇒ incomplete(unencrypted)", async () => {
        const w = await mkWorld(t, {dbms: ["files"]});
        await start(w);
        await drive(w, {play: happy(w, {ext: ".tar.gz"})});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "incomplete", downgrade_reason: "unencrypted"});
        expect((await q("select encrypted, archive_kind from fork_recovery_point_artifact"))[0]).toBeTruthy();
    });
    it("encryption switched off in settings during the run ⇒ incomplete(unencrypted)", async () => {
        const w = await mkWorld(t, {dbms: ["files"]});
        await start(w);
        await setEncryption(pool, false);
        await drive(w, {play: happy(w)});
        await setEncryption(pool, true);
        // the policy is paused? no: re-authorization happens at run START only; the finaliser still refuses to call it encrypted
        expect((await rp(w.stackId))[0]).toMatchObject({status: "incomplete", downgrade_reason: "unencrypted"});
    });
    it("the object cannot be hashed (3 attempts across ticks) ⇒ incomplete(checksum_unavailable), never a made-up checksum", async () => {
        let calls = 0;
        const w = await mkWorld(t, {dbms: ["files"], deps: {hash: async () => { calls++; return null; }}});
        await start(w);
        await drive(w, {play: happy(w)});
        expect(calls).toBe(3);
        const [point] = await rp(w.stackId);
        expect(point).toMatchObject({status: "incomplete", downgrade_reason: "checksum_unavailable"});
        expect((await q("select ciphertext_sha256 from fork_recovery_point_artifact where rp_id=$1", [point.id]))[0].ciphertext_sha256).toBeNull();
    });
    it("a transient hash failure is retried and then succeeds", async () => {
        let calls = 0;
        const w = await mkWorld(t, {dbms: ["files"], deps: {hash: async (r) => (++calls < 2 ? null : {sha256: sha(r.backupStorageId), bytes: 1})}});
        await start(w);
        await drive(w, {play: happy(w)});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "pending_verification"});
    });
});

describe("runs: idempotency, capacity, cancel, crash resume, degraded mode, Arcane down", () => {
    it("double trigger ⇒ a single run (partial unique index), the loser is refused already_running", async () => {
        const w = await mkWorld(t);
        const rs = await Promise.all([startRun(w.deps, {stackId: w.stackId, trigger: "manual", userId: w.userId}), startRun(w.deps, {stackId: w.stackId, trigger: "manual", userId: w.userId})]);
        expect(rs.filter((r) => r.kind === "started")).toHaveLength(1);
        expect(rs.filter((r) => r.kind === "refused" && (r.code === "already_running" || r.code === "capacity"))).toHaveLength(1); // whichever guard answers first; the unique index is the race-proof one
        expect((await q("select count(*)::int c from fork_stack_run where stack_id=$1", [w.stackId]))[0].c).toBe(1);
    });

    it("the same scheduled slot twice ⇒ one row (retry safe)", async () => {
        const w = await mkWorld(t);
        const slot = new Date("2026-11-07T02:00:00Z");
        const a = await startRun(w.deps, {stackId: w.stackId, trigger: "schedule", scheduledFor: slot});
        expect(a.kind).toBe("started");
        await pool.query("update fork_stack_run set state='failed', reason='member_failed', finished_at=now() where stack_id=$1", [w.stackId]); // finished, so the active-run index is free
        const b = await startRun(w.deps, {stackId: w.stackId, trigger: "schedule", scheduledFor: slot});
        expect(b.kind).toBe("exists");
        expect((await q("select count(*)::int c from fork_stack_run where stack_id=$1", [w.stackId]))[0].c).toBe(1);
    });

    it("capacity: the agent has unlimited parallelism, the fork caps concurrent runs per host agent", async () => {
        const w = await mkWorld(t, {cfg: {maxPerAgent: 1}});
        await start(w);
        // a second stack on the SAME agent/environment
        const second = (await pool.query("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name, protection_state) values ($1,$2,'env','second','second','active') returning id", [w.org, w.env])).rows[0].id as string;
        await pool.query(`insert into fork_stack_policy (stack_id, activated_at, schedule, storage_channel_ids, activation) values ($1,now(),'{}',$2,$3)`, [second, w.channels, JSON.stringify({userId: w.userId})]);
        const r = await startRun(w.deps, {stackId: second, trigger: "manual", userId: w.userId});
        expect(r).toEqual({kind: "refused", code: "capacity", scope: "agent"});
    });

    it("cancel: waiting backups are cancelled upstream, items cancelled, RP failed(run_cancelled), audit written", async () => {
        const w = await mkWorld(t);
        const id = await start(w);
        await tickAllRuns(w.deps);
        const res = await cancelRun(w.deps, id, {userId: w.userId, organizationId: w.org});
        expect(res).toEqual({ok: true, cancelledWaiting: 2});
        expect(await run(id)).toMatchObject({state: "cancelled", reason: "cancelled"});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "failed", downgrade_reason: "run_cancelled"});
        expect((await waitingBackups(pool, w)).every((b) => b.status === "failed" && b.deleted_at !== null)).toBe(true);
        expect((await q("select action from fork_audit_event where resource_id=$1 order by seq", [id])).map((a) => a.action)).toContain("fork.stack_run.cancel");
        expect(await cancelRun(w.deps, id, {userId: w.userId, organizationId: w.org})).toEqual({ok: false, code: "not_active"});
    });

    it("crash resume: a new process continues from the persisted steps; trigger is NOT repeated", async () => {
        const w = await mkWorld(t);
        const id = await start(w);
        await tickAllRuns(w.deps); // refresh, validate, trigger done; track waiting
        const steps = (await run(id)).steps as {name: string; status: string}[];
        expect(steps.map((s) => [s.name, s.status])).toEqual([["refresh_inventory", "done"], ["validate", "done"], ["trigger", "done"], ["track", "running"], ["hash", "pending"], ["finalize", "pending"]]);
        const beforeIds = (await waitingBackups(pool, w)).map((b) => b.id);
        const restarted = {...w, deps: {...w.deps, owner: "another-process"}};
        await drive(restarted, {play: happy(w)});
        expect((await run(id)).state).toBe("succeeded");
        expect((await waitingBackups(pool, w)).map((b) => b.id)).toEqual(beforeIds); // no duplicate backups
        expect((await q("select count(*)::int c from fork_recovery_point where run_id=$1", [id]))[0].c).toBe(1);
    });

    it("two processes race on one run: the lease keeps one of them out (busy)", async () => {
        const w = await mkWorld(t);
        const id = await start(w);
        await pool.query("insert into fork_lock (name, owner, expires_at) values ($1,'other', $2)", [`run:${id}`, new Date(w.clock.t.getTime() + 60_000)]);
        expect(await tickRun(w.deps, id)).toEqual({runId: id, state: "busy"});
        w.clock.t = new Date(w.clock.t.getTime() + 61_000); // the other process died: its lease expires and is stolen
        expect((await tickRun(w.deps, id)).state).toBe("advanced");
    });

    it("UX-09: Arcane unreachable ⇒ the run proceeds on the last inventory and says so", async () => {
        const w = await mkWorld(t, {deps: {refresh: async () => "failed"}});
        const id = await start(w);
        await drive(w, {play: happy(w)});
        expect(await run(id)).toMatchObject({state: "succeeded", inventory_refresh: "failed", inventory_version: 1});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "pending_verification", inventory_version: 1});
    });

    it("a refresh that THROWS is the same as Arcane down (never aborts the run)", async () => {
        const w = await mkWorld(t, {deps: {refresh: async () => { throw new Error("boom"); }}});
        const id = await start(w);
        await drive(w, {play: happy(w)});
        expect(await run(id)).toMatchObject({state: "succeeded", inventory_refresh: "failed"});
    });

    it("ADR-010 degraded mode: while LOCKED the run still executes end to end; discovery is not attempted", async () => {
        let refreshed = 0;
        const w = await mkWorld(t, {deps: {mode: async () => "locked", refresh: async () => { refreshed++; return "ok"; }}});
        const id = await start(w);
        await drive(w, {play: happy(w)});
        expect(refreshed).toBe(0);
        expect(await run(id)).toMatchObject({state: "succeeded", inventory_refresh: "skipped_locked"});
        expect((await rp(w.stackId))[0]).toMatchObject({status: "pending_verification"});
    });

    it("mode off ⇒ nothing starts", async () => {
        const w = await mkWorld(t, {deps: {mode: async () => "off"}});
        expect(await startRun(w.deps, {stackId: w.stackId, trigger: "manual", userId: w.userId})).toEqual({kind: "refused", code: "off"});
    });

    it("canary: no secret-looking text from upstream ends up in run/item/RP/audit/outbox rows", async () => {
        const w = await mkWorld(t, {deps: {hash: async () => { throw new Error("Bearer SECRET-CANARY-123 https://u:p@host"); }}});
        await start(w);
        await drive(w, {play: happy(w)});
        const dump = JSON.stringify([
            await q("select * from fork_stack_run where stack_id=$1", [w.stackId]), await q("select * from fork_stack_run_item"), await q("select * from fork_recovery_point where stack_id=$1", [w.stackId]),
            await q("select * from fork_recovery_point_artifact"), await q("select redacted_details from fork_audit_event"), await q("select payload from fork_notification_outbox"),
        ]);
        expect(dump).not.toMatch(/SECRET-CANARY|u:p@host/);
    });
});

void T0; void smallCfg;
