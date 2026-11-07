import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {verifyRecoveryPoint} from "@/fork/verify/service";
import {mkWorld} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";
import {fixtureObject, hasRestic, localRepos, mkDeps, pendingRp} from "@/fork/__tests__/w14-verify-helpers";

/** D45 (W15): the fork agent's plaintext SHA-256 + size, reported through the channel, is cross-checked by the W14 verify job; a mismatch makes the RP `failed`. */
let t: W04Db; let pool: Pool;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; });
afterAll(async () => { await t?.drop(); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const fx = fixtureObject();
const world = () => mkWorld(t, {dbms: ["postgresql"]});
const report = async (rpId: string, sha: string, size: number) => {
    const [a] = await q("select backup_id from fork_recovery_point_artifact where rp_id=$1", [rpId]);
    await pool.query("insert into fork_agent_hash_report (backup_id, sha256, size_bytes) values ($1,$2,$3)", [a.backup_id, sha, size]);
};

describe.skipIf(!hasRestic)("verify job × agent plaintext hash (D45)", () => {
    it("the agent's report equals the dashboard's own hash ⇒ verified, and the report records `agent_hash: match`", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            await report(rpId, fx.plaintextSha256, fx.plaintextSize);
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos}), rpId)).toEqual({outcome: "verified", rpId, manifestChannels: 1});
            const [rp] = await q("select status, verify_report from fork_recovery_point where id=$1", [rpId]);
            expect(rp.status).toBe("verified");
            expect(rp.verify_report.results[0]).toMatchObject({code: "ok", agent_hash: "match"});
        } finally { repos.drop(); }
    });

    it("a DIFFERENT agent hash ⇒ RP failed (plaintext_hash_mismatch), never verified, no manifest snapshot written", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            await report(rpId, "0".repeat(64), fx.plaintextSize);
            const out = await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos}), rpId);
            expect(out).toEqual({outcome: "failed", rpId, reason: "plaintext_hash_mismatch", code: "agent_hash_mismatch"});
            const [rp] = await q("select status, downgrade_reason, manifest_refs, manifest_sha256, verified_at from fork_recovery_point where id=$1", [rpId]);
            expect(rp).toMatchObject({status: "failed", downgrade_reason: "plaintext_hash_mismatch", manifest_sha256: null, verified_at: null});
            expect((await q("select action, result from fork_audit_event where resource_id=$1", [rpId])).some((a) => a.action === "fork.recovery_point.verify" && a.result === "failure")).toBe(true);
        } finally { repos.drop(); }
    });

    it("a different agent SIZE alone also fails; a RP that is already failed is not re-verified", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            await report(rpId, fx.plaintextSha256, fx.plaintextSize + 1);
            const d = mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos});
            expect(await verifyRecoveryPoint(d, rpId)).toMatchObject({outcome: "failed", reason: "plaintext_hash_mismatch"});
            expect(await verifyRecoveryPoint(d, rpId)).toEqual({outcome: "skipped", rpId, why: "not_pending"});
        } finally { repos.drop(); }
    });

    it("no report (old agent / channel off) ⇒ still verified by the dashboard's own hash, recorded honestly as `agent_hash: absent`", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos}), rpId)).toMatchObject({outcome: "verified"});
            const [rp] = await q("select verify_report from fork_recovery_point where id=$1", [rpId]);
            expect(rp.verify_report.results[0].agent_hash).toBe("absent");
        } finally { repos.drop(); }
    });
});
