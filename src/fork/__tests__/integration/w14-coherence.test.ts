import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {runRetentionCoherence} from "@/fork/recovery/coherence";
import {sweepManifestForgets} from "@/fork/verify/forget";
import {listManifestSnapshots} from "@/fork/manifest/store";
import {verifyRecoveryPoint} from "@/fork/verify/service";
import {mkWorld} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";
import {fixtureObject, FIXTURE_MASTER, hasRestic, localRepos, mkDeps, pendingRp} from "@/fork/__tests__/w14-verify-helpers";

let t: W04Db; let pool: Pool;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; });
afterAll(async () => { await t?.drop(); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const fx = fixtureObject();
const rp = async (id: string) => (await q("select * from fork_recovery_point where id=$1", [id]))[0];

describe("retention coherence (D32/D33): fork RPs follow upstream's truth, never the other way round", () => {
    it("upstream presence=missing / soft-deleted storage row / failed status ⇒ RP downgraded to incomplete with the reason, never verified", async () => {
        const w = await mkWorld(t, {dbms: ["postgresql"]});
        const a = await pendingRp(pool, w, 1000);
        const b = await pendingRp(pool, w, 1000);
        const c = await pendingRp(pool, w, 1000);
        const d = await pendingRp(pool, w, 1000);
        const sid = async (rpId: string) => (await q("select backup_storage_id from fork_recovery_point_artifact where rp_id=$1", [rpId]))[0].backup_storage_id;
        await pool.query("update backup_storage set presence='missing' where id=$1", [await sid(a)]);
        await pool.query("update backup_storage set deleted_at=now() where id=$1", [await sid(b)]);
        await pool.query("update backup_storage set status='failed' where id=$1", [await sid(c)]);
        await pool.query("update backup_storage set presence='unknown' where id=$1", [await sid(d)]); // not yet checked ≠ gone
        const r = await runRetentionCoherence(t.db);
        expect(r.downgraded.map((x) => x.id).sort()).toEqual([a, b, c].sort());
        for (const id of [a, b, c]) expect(await rp(id)).toMatchObject({status: "incomplete", downgrade_reason: "artifact_missing", verified_at: null});
        expect(await rp(d)).toMatchObject({status: "pending_verification"});
        expect((await q("select count(*)::int c from fork_audit_event where action='fork.recovery_point.downgrade'"))[0].c).toBe(3);
        // idempotent
        expect((await runRetentionCoherence(t.db)).downgraded).toHaveLength(0);
    });

    it("null FK (upstream deleted the backup row: ON DELETE SET NULL) and count mismatch downgrade too; a downgraded VERIFIED RP loses `verified`", async () => {
        const w = await mkWorld(t, {dbms: ["postgresql"]});
        const a = await pendingRp(pool, w, 1000);
        await pool.query("update fork_recovery_point set status='verified', verified_at=now() where id=$1", [a]); // direct seed of an already-verified RP
        await pool.query("delete from backups where id=(select backup_id from fork_recovery_point_artifact where rp_id=$1)", [a]);
        const b = await pendingRp(pool, w, 1000);
        await pool.query("update fork_recovery_point set required_artifact_count = 2 where id=$1", [b]);
        const r = await runRetentionCoherence(t.db);
        const by = new Map(r.downgraded.map((x) => [x.id, x.reason]));
        expect(by.get(a)).toBe("fk_null");
        expect(by.get(b)).toBe("count_mismatch");
        expect(await rp(a)).toMatchObject({status: "incomplete", verified_at: null});
    });
});

describe.skipIf(!hasRestic)("manifest forget for purged RPs (W12 handoff)", () => {
    it("forgets the snapshot in the channel once, marks the ref forgotten, and keeps the ref pending when the channel is down", async () => {
        const repos = localRepos();
        try {
            const w = await mkWorld(t, {dbms: ["postgresql"]});
            const id = await pendingRp(pool, w, fx.plaintextSize);
            const d = mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos});
            expect((await verifyRecoveryPoint(d, id)).outcome).toBe("verified");
            await pool.query("update fork_recovery_point set purged_at=now() where id=$1", [id]);
            const down = {db: t.db, master: async () => FIXTURE_MASTER, manifestRunner: async () => { throw new Error("down"); }};
            expect(await sweepManifestForgets(down)).toEqual({forgotten: 0, pending: 1});
            expect((await rp(id)).manifest_refs[0].forgotten_at).toBeUndefined();
            const up = {db: t.db, master: async () => FIXTURE_MASTER, manifestRunner: d.manifestRunner};
            expect(await sweepManifestForgets(up)).toEqual({forgotten: 1, pending: 0});
            expect((await rp(id)).manifest_refs[0].forgotten_at).toBeTruthy();
            const run = (await d.manifestRunner(w.channels[0], w.stackId, FIXTURE_MASTER)).run;
            expect(await listManifestSnapshots(run, id)).toEqual([]);
            expect(await sweepManifestForgets(up)).toEqual({forgotten: 0, pending: 0}); // nothing left to do
        } finally { repos.drop(); }
    });
});
