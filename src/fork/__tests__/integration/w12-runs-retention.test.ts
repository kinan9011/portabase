import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {pruneStack, retentionTick} from "@/fork/recovery-point/prune";
import {deleteBackupViaUpstream} from "@/fork/upstream";
import {mkWorld, naive, setEncryption, T0, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; });
afterAll(async () => { await t?.drop(); });
beforeEach(async () => { await pool.query("update fork_stack_policy set deactivated_at=now() where deactivated_at is null"); await setEncryption(pool, true); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const DAY = 86_400_000;

/** One RP with one real upstream backup + storage row behind its single artifact. */
async function mkRp(w: World, seq: number, daysAgo: number, status = "verified", o: {linkBackup?: boolean} = {}) {
    const at = new Date(T0.getTime() - daysAgo * DAY);
    const m = w.members[0];
    const b = (await q("insert into backups (database_id, status, file_size, created_at) values ($1,'success',10,$2) returning id", [m.databaseId, naive(at)]))[0].id as string;
    const s = (await q("insert into backup_storage (backup_id, storage_channel_id, status, path, size, engine) values ($1,$2,'success','/x.enc',10,'archive') returning id", [b, w.channels[0]]))[0].id as string;
    const rp = (await q(`insert into fork_recovery_point (stack_id, stack_name, sequence, status, required_artifact_count, present_artifact_count, created_at, finalized_at, verified_at)
        values ($1,'app',$2,$3::text,1,1,$4::timestamptz,$4::timestamptz, case when $3::text='verified' then $4::timestamptz end) returning id`, [w.stackId, seq, status, at]))[0].id as string;
    await q(`insert into fork_recovery_point_artifact (rp_id, backup_id, backup_storage_id, source_name, engine, archive_kind, encrypted, channel_id, channel_kind, size_bytes, presence, stack_source_id)
        values ($1,$2,$3,'files-0','files','archive_enc',true,$4,'s3',10,'present',$5)`, [rp, o.linkBackup === false ? null : b, s, w.channels[0], m.linkId]);
    return {rp, backup: b, db: m.databaseId};
}
const fakeDelete = () => {
    const calls: string[] = [];
    let failFor: string | null = null;
    return {calls, failFor: (id: string | null) => { failFor = id; }, fn: async (backupId: string) => { calls.push(backupId); if (backupId === failFor) return {ok: false, error: "delete_failed"}; await pool.query("update backups set deleted_at=now() where id=$1", [backupId]); await pool.query("update backup_storage set deleted_at=now() where backup_id=$1", [backupId]); return {ok: true}; }};
};
const setPolicy = (w: World, p: object) => pool.query("update fork_stack_policy set policy=$2 where stack_id=$1", [w.stackId, JSON.stringify(p)]);
const rpState = async (id: string) => (await q("select status, downgrade_reason, expires_at, purged_at from fork_recovery_point where id=$1", [id]))[0];

describe("runs: D33 fork-owned retention executes through the upstream delete path", () => {
    it("prunes expired RPs: backups deleted via the (fake) upstream service, RP tombstoned with facts, newest kept, audit written", async () => {
        const d = fakeDelete();
        const w = await mkWorld(t, {deps: {deleteBackup: d.fn}});
        await setPolicy(w, {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        const rps = [await mkRp(w, 1, 5), await mkRp(w, 2, 3), await mkRp(w, 3, 1)];
        const r = await pruneStack(w.deps, w.stackId);
        expect(r).toMatchObject({selected: 2, purged: 2, partial: 0, skipped: false});
        expect(d.calls.sort()).toEqual([rps[0].backup, rps[1].backup].sort());
        for (const x of rps.slice(0, 2)) {
            const s = await rpState(x.rp);
            expect(s.purged_at).toBeTruthy(); expect(s.expires_at).toBeTruthy();
            expect((await q("select presence, size_bytes, source_name, channel_id from fork_recovery_point_artifact where rp_id=$1", [x.rp]))[0]).toMatchObject({presence: "missing", source_name: "files-0"}); // facts survive as a tombstone
        }
        expect((await rpState(rps[2].rp)).purged_at).toBeNull(); // (a) the newest verified RP is never pruned
        expect((await q("select action, result from fork_audit_event where action='fork.recovery_point.purge' order by seq")).map((a) => a.result)).toEqual(["success", "success"]);
        const again = await pruneStack(w.deps, w.stackId); // idempotent
        expect(again).toMatchObject({selected: 0, purged: 0});
    });

    it("a delete that FAILS ⇒ RP becomes incomplete(retention_partial), is NOT reported deleted, and is retried (and then purged) on the next pass", async () => {
        const d = fakeDelete();
        const w = await mkWorld(t, {deps: {deleteBackup: d.fn}});
        await setPolicy(w, {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        const old = await mkRp(w, 1, 5); await mkRp(w, 2, 1);
        d.failFor(old.backup);
        expect(await pruneStack(w.deps, w.stackId)).toMatchObject({selected: 1, purged: 0, partial: 1});
        expect(await rpState(old.rp)).toMatchObject({status: "incomplete", downgrade_reason: "retention_partial", purged_at: null});
        expect((await rpState(old.rp)).expires_at).toBeTruthy();
        expect((await q("select result from fork_audit_event where action='fork.recovery_point.purge' and resource_id=$1", [old.rp]))[0].result).toBe("failure");
        d.failFor(null);
        expect(await pruneStack(w.deps, w.stackId)).toMatchObject({selected: 1, purged: 1, partial: 0}); // retried regardless of age
        expect((await rpState(old.rp)).purged_at).toBeTruthy();
    });

    it("(f) no verified RP yet: even a very old pending_verification RP is the only backup and is never deleted; an older sibling goes by age", async () => {
        const d = fakeDelete();
        const w = await mkWorld(t, {deps: {deleteBackup: d.fn}});
        const a = await mkRp(w, 1, 100, "pending_verification"); const b = await mkRp(w, 2, 90, "pending_verification");
        const r = await pruneStack(w.deps, w.stackId);
        expect(r.purged).toBe(1);
        expect((await rpState(b.rp)).purged_at).toBeNull();
        expect((await rpState(a.rp)).purged_at).toBeTruthy();
    });

    it("in use: an active run, or a restoration reading one of the backups, protects the RPs", async () => {
        const d = fakeDelete();
        const w = await mkWorld(t, {deps: {deleteBackup: d.fn}});
        await setPolicy(w, {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        const old = await mkRp(w, 1, 50); await mkRp(w, 2, 1);
        await pool.query("insert into fork_stack_run (stack_id, trigger, state) values ($1,'manual','running')", [w.stackId]);
        expect((await pruneStack(w.deps, w.stackId)).purged).toBe(0);
        await pool.query("update fork_stack_run set state='failed', reason='member_failed', finished_at=now() where stack_id=$1", [w.stackId]);
        await pool.query("insert into restorations (backup_id, database_id, status) values ($1,$2,'ongoing')", [old.backup, old.db]);
        expect((await pruneStack(w.deps, w.stackId)).purged).toBe(0);
        await pool.query("update restorations set status='success'");
        expect((await pruneStack(w.deps, w.stackId)).purged).toBe(1);
        expect(d.calls).toEqual([old.backup]);
    });

    it("authorization: paused / deactivated policies and a user who lost `repository.prune` prune NOTHING", async () => {
        const d = fakeDelete();
        const w = await mkWorld(t, {deps: {deleteBackup: d.fn}});
        await setPolicy(w, {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        await mkRp(w, 1, 50); await mkRp(w, 2, 1);
        await pool.query("update \"user\" set role='user' where id=$1", [w.userId]);
        await pool.query("update member set role='member' where user_id=$1", [w.userId]); // `repository.prune` = org owner OR system admin: lose both
        expect(await pruneStack(w.deps, w.stackId)).toMatchObject({purged: 0, skipped: true});
        expect((await q("select paused_at from fork_stack_policy where stack_id=$1", [w.stackId]))[0].paused_at).toBeNull(); // retention never pauses the policy by itself
        await pool.query("update \"user\" set role='admin' where id=$1", [w.userId]);
        await pool.query("update fork_stack_policy set paused_at=now(), pause_reason='capability_lost' where stack_id=$1", [w.stackId]);
        expect(await pruneStack(w.deps, w.stackId)).toMatchObject({purged: 0, skipped: true});
        expect(d.calls).toEqual([]);
    });

    it("orphan sweep: an unreferenced member backup older than 30 d is deleted, a young one and a referenced one are not; skipped while a run is active", async () => {
        const d = fakeDelete();
        const w = await mkWorld(t, {deps: {deleteBackup: d.fn}});
        await setPolicy(w, {keep_last: 5, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        const kept = await mkRp(w, 1, 40); // referenced by an RP (and verified: kept by keep_last)
        const oldOrphan = (await q("insert into backups (database_id, status, created_at) values ($1,'success',$2) returning id", [w.members[0].databaseId, naive(new Date(T0.getTime() - 45 * DAY))]))[0].id;
        const youngOrphan = (await q("insert into backups (database_id, status, created_at) values ($1,'success',$2) returning id", [w.members[0].databaseId, naive(new Date(T0.getTime() - 5 * DAY))]))[0].id;
        await pool.query("insert into fork_stack_run (stack_id, trigger, state) values ($1,'manual','running')", [w.stackId]);
        expect((await pruneStack(w.deps, w.stackId)).orphansDeleted).toBe(0);
        await pool.query("update fork_stack_run set state='failed', reason='member_failed', finished_at=now() where stack_id=$1", [w.stackId]);
        expect((await pruneStack(w.deps, w.stackId)).orphansDeleted).toBe(1);
        expect(d.calls).toEqual([oldOrphan]);
        expect(d.calls).not.toContain(youngOrphan); expect(d.calls).not.toContain(kept.backup);
    });

    it("retentionTick covers every active stack, never throws for one, and does nothing in mode off; it still runs LOCKED (degraded mode)", async () => {
        const d = fakeDelete();
        const w = await mkWorld(t, {deps: {deleteBackup: d.fn, mode: async () => "locked"}});
        await setPolicy(w, {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        await mkRp(w, 1, 50); await mkRp(w, 2, 1);
        expect(await retentionTick({...w.deps, mode: async () => "off"})).toMatchObject({stacks: 0, purged: 0});
        expect(await retentionTick(w.deps)).toMatchObject({stacks: 1, purged: 1});
    });

    it("the REAL upstream delete service is wired: it soft-deletes the backup and its storage row (storage failures never leave it half-deleted)", async () => {
        const w = await mkWorld(t);
        const {backup, db} = await mkRp(w, 1, 50);
        vi.resetModules();
        const prev = {...process.env};
        Object.assign(process.env, {DATABASE_URL: t.url, PROJECT_URL: "http://127.0.0.1:1", PROJECT_SECRET: "w12-secret-not-real-0123456789-0123456789"});
        try {
            const r = await deleteBackupViaUpstream(backup, db);
            expect(r.ok).toBe(true);
            expect((await q("select deleted_at from backups where id=$1", [backup]))[0].deleted_at).toBeTruthy();
            expect((await q("select deleted_at from backup_storage where backup_id=$1", [backup]))[0].deleted_at).toBeTruthy();
            expect(await deleteBackupViaUpstream("00000000-0000-4000-8000-000000000001", db)).toEqual({ok: false, error: "delete_failed"});
        } finally {
            // close the app pool BEFORE the throw-away DB is dropped (else an unhandled 57P01 fails the run)
            const appDb = (await import("@/db").catch(() => null))?.db as unknown as {$client?: {end: () => Promise<void>}} | undefined;
            await appDb?.$client?.end().catch(() => undefined);
            process.env = prev;
        }
    });
});
