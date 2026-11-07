import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {loadTrustAnchors} from "@/fork/manifest/anchors";
import {listManifestSnapshots, readManifestSnapshot} from "@/fork/manifest/store";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {verifyRecoveryPoint} from "@/fork/verify/service";
import {mkWorld, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";
import {fixtureObject, FIXTURE_MASTER, hasRestic, localRepos, mkDeps, pendingRp} from "@/fork/__tests__/w14-verify-helpers";

let t: W04Db; let pool: Pool;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; });
afterAll(async () => { await t?.drop(); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const fx = fixtureObject();
const world = (o: Parameters<typeof mkWorld>[1] = {}) => mkWorld(t, {dbms: ["postgresql"], ...o});
const rpRow = async (id: string) => (await q("select * from fork_recovery_point where id=$1", [id]))[0];

describe.skipIf(!hasRestic)("verify job: pending_verification → verified ONLY on real evidence (D43/D24)", () => {
    it("happy: decrypt + gzip + tar + plaintext hash/size ⇒ verified, manifest snapshot in the channel, read back, signature verifies, audit + schedule state", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            expect((await rpRow(rpId)).status).toBe("pending_verification");
            const d = mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos});
            const out = await verifyRecoveryPoint(d, rpId);
            expect(out).toEqual({outcome: "verified", rpId, manifestChannels: 1});
            const rp = await rpRow(rpId);
            expect(rp).toMatchObject({status: "verified", downgrade_reason: null});
            expect(rp.verified_at).toBeTruthy();
            expect(rp.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(rp.manifest_sig_kid).toMatch(/^[0-9a-f]{12}$/);
            expect(rp.manifest_refs).toHaveLength(1);
            const [art] = await q("select * from fork_recovery_point_artifact where rp_id=$1", [rpId]);
            expect(art.plaintext_sha256).toBe(fx.plaintextSha256);
            expect(Number(art.plaintext_size)).toBe(fx.plaintextSize);
            expect(art.dump_format).toBe("pg_custom");
            expect(art.archive_format_version).toBe(1);
            expect((await q("select last_verified_rp_at from fork_schedule_state where stack_id=$1", [w.stackId]))[0].last_verified_rp_at).toBeTruthy();
            expect((await q("select action, result, actor_kind from fork_audit_event where resource_id=$1", [rpId])).some((a) => a.action === "fork.recovery_point.verify" && a.result === "success" && a.actor_kind === "system")).toBe(true);
            // the snapshot really is in the repo and verifies against the anchors with the stack/RP/sequence bound
            const run = (await d.manifestRunner(w.channels[0], w.stackId, FIXTURE_MASTER)).run;
            const ids = await listManifestSnapshots(run, rpId);
            expect(ids).toEqual([rp.manifest_refs[0].snapshot_id]);
            const back = await readManifestSnapshot(run, ids[0]);
            const anchors = await loadTrustAnchors(w.deps.db);
            expect(verifyManifestBundle({json: back.json, sig: back.sig}, anchors, {stackId: w.stackId, rpId, sequence: Number(rp.sequence)}).ok).toBe(true);
            expect(back.json).toContain(fx.plaintextSha256);
            // verified RPs cannot be verified again (idempotent) and the dead-man now has its reference
            expect(await verifyRecoveryPoint(d, rpId)).toEqual({outcome: "skipped", rpId, why: "not_pending"});
        } finally { repos.drop(); }
    });

    it("TRUNCATED `.tar.gz.enc` (the M2 lab case) ⇒ failed with a plain reason, NEVER verified, no manifest written", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            const cut = fx.bytes.subarray(0, fx.bytes.length - 1000);
            const out = await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: cut}), repos}), rpId);
            expect(out).toMatchObject({outcome: "failed", reason: "verify_failed", code: "truncated"});
            const rp = await rpRow(rpId);
            expect(rp).toMatchObject({status: "failed", downgrade_reason: "verify_failed", verified_at: null, manifest_sha256: null});
            expect(rp.verify_report).toMatchObject({outcome: "failed", code: "truncated"});
            expect(repos.opened).toHaveLength(0); // nothing signed or written
            expect((await q("select count(*)::int c from fork_recovery_point where stack_id=$1 and status='verified'", [w.stackId]))[0].c).toBe(0);
            // terminal: a failed RP is never picked up again
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos}), rpId)).toEqual({outcome: "skipped", rpId, why: "not_pending"});
        } finally { repos.drop(); }
    });

    it("flipped byte / wrong master key ⇒ failed auth_failed; agent-reported size ≠ decrypted size ⇒ failed size_mismatch (boundary truncation seam)", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const flipped = Buffer.from(fx.bytes); flipped[flipped.length - 20] ^= 1;
            const a = await pendingRp(pool, w, fx.plaintextSize);
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: flipped}), repos}), a)).toMatchObject({outcome: "failed", code: "auth_failed"});
            const b = await pendingRp(pool, w, fx.plaintextSize);
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos, master: Buffer.alloc(32, 7)}), b)).toMatchObject({outcome: "failed", code: "auth_failed"});
            const c = await pendingRp(pool, w, fx.plaintextSize + 1);
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos}), c)).toMatchObject({outcome: "failed", code: "size_mismatch"});
            for (const id of [a, b, c]) expect((await rpRow(id)).status).toBe("failed");
        } finally { repos.drop(); }
    });

    it("INFRASTRUCTURE trouble is not an integrity verdict: mid-stream socket error ⇒ retry with backoff, failed:verify_failed(infrastructure) only after max attempts", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            const d = mkDeps(w, {serve: () => ({bytes: fx.bytes, throwMidway: true}), repos});
            expect(await verifyRecoveryPoint(d, rpId)).toMatchObject({outcome: "retry", attempt: 1, code: "infrastructure"});
            let rp = await rpRow(rpId);
            expect(rp.status).toBe("pending_verification");
            expect(rp.verify_report).toMatchObject({attempts: 1, outcome: "retry"});
            expect(rp.verify_report.nextAttemptAt).toBeTruthy();
            expect(await verifyRecoveryPoint(d, rpId)).toMatchObject({outcome: "retry", attempt: 2});
            expect(await verifyRecoveryPoint(d, rpId)).toMatchObject({outcome: "failed", reason: "verify_failed", code: "infrastructure"});
            rp = await rpRow(rpId);
            expect(rp).toMatchObject({status: "failed", downgrade_reason: "verify_failed", verified_at: null});
            // a 500 from storage is infrastructure too
            const w2 = await world();
            const r2 = await pendingRp(pool, w2, fx.plaintextSize);
            expect(await verifyRecoveryPoint(mkDeps(w2, {serve: () => ({status: 500}), repos}), r2)).toMatchObject({outcome: "retry"});
        } finally { repos.drop(); }
    });

    it("object GONE (404) ⇒ downgraded incomplete:artifact_missing, artifact marked missing, never verified", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({status: 404}), repos}), rpId)).toEqual({outcome: "downgraded", rpId, reason: "artifact_missing"});
            expect(await rpRow(rpId)).toMatchObject({status: "incomplete", downgrade_reason: "artifact_missing", verified_at: null, present_artifact_count: 0});
            expect((await q("select presence from fork_recovery_point_artifact where rp_id=$1", [rpId]))[0].presence).toBe("missing");
        } finally { repos.drop(); }
    });

    it("signing key unavailable ⇒ retried, then failed (never an unsigned `verified`); no snapshot is written", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            const d = mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos, signingKey: null, overrides: {maxAttempts: 2}});
            expect(await verifyRecoveryPoint(d, rpId)).toMatchObject({outcome: "retry", code: "signing_unavailable"});
            expect(await verifyRecoveryPoint(d, rpId)).toMatchObject({outcome: "failed", code: "signing_unavailable"});
            expect((await rpRow(rpId)).status).toBe("failed");
            expect(repos.opened).toHaveLength(0);
        } finally { repos.drop(); }
    });

    it("an unencrypted artifact is never verified (D39) even if everything else is fine", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            await pool.query("update fork_recovery_point_artifact set encrypted=false, archive_kind='archive_plain' where rp_id=$1", [rpId]);
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos}), rpId)).toMatchObject({outcome: "failed", reason: "unencrypted"});
            expect((await rpRow(rpId)).status).toBe("failed");
        } finally { repos.drop(); }
    });

    it("D32: a required artifact whose FK was lost (SET NULL) is downgraded, not verified", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            await pool.query("update fork_recovery_point_artifact set backup_storage_id=null where rp_id=$1", [rpId]);
            expect(await verifyRecoveryPoint(mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos}), rpId)).toMatchObject({outcome: "downgraded", reason: "fk_null"});
            expect((await rpRow(rpId)).status).toBe("incomplete");
        } finally { repos.drop(); }
    });

    it("two channels ⇒ the manifest snapshot is stored in BOTH before promotion; one unreachable ⇒ no promotion", async () => {
        const repos = localRepos();
        try {
            const w = await world({channels: 2});
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            const base = mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos});
            const broken = {...base, manifestRunner: async (ch: string, st: string, m: Buffer) => { if (ch === w.channels[1]) throw new Error("channel down"); return base.manifestRunner(ch, st, m); }};
            expect(await verifyRecoveryPoint(broken, rpId)).toMatchObject({outcome: "retry", code: "infrastructure"});
            expect((await rpRow(rpId)).status).toBe("pending_verification");
            expect(await verifyRecoveryPoint(base, rpId)).toMatchObject({outcome: "verified", manifestChannels: 2});
            expect((await rpRow(rpId)).manifest_refs).toHaveLength(2);
            // the retry did not pile up a second snapshot in channel 0
            const run0 = (await base.manifestRunner(w.channels[0], w.stackId, FIXTURE_MASTER)).run;
            expect(await listManifestSnapshots(run0, rpId)).toHaveLength(1);
        } finally { repos.drop(); }
    });

    it("a RESTIC artifact is verified by opening its snapshot (no plaintext hash by design, not_applicable_restic) — and a mixed RP (archive + restic) is promoted", async () => {
        const repos = localRepos();
        try {
            const w = await world({dbms: ["postgresql", "files"]});
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            // turn the second member's artifact into a restic one (as the real agent produces for `files`)
            const [fa] = await q("select id from fork_recovery_point_artifact where rp_id=$1 and engine='files'", [rpId]);
            await pool.query("update fork_recovery_point_artifact set archive_kind='restic_snapshot', path_or_snapshot_id=$2, generated_id='gen-restic', plaintext_sha256=null where id=$1", [fa.id, "a".repeat(64)]);
            await pool.query("update backup_storage set engine='restic', path=$2 where id=(select backup_storage_id from fork_recovery_point_artifact where id=$1)", [fa.id, "a".repeat(64)]);
            const seen: unknown[] = [];
            const d = mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos, overrides: {checkResticSnapshot: async (a) => { seen.push(a); return true; }}});
            expect(await verifyRecoveryPoint(d, rpId)).toMatchObject({outcome: "verified"});
            expect(seen).toHaveLength(1);
            const m = await readManifestSnapshot((await d.manifestRunner(w.channels[0], w.stackId, FIXTURE_MASTER)).run, (await rpRow(rpId)).manifest_refs[0].snapshot_id);
            expect(JSON.parse(m.json).artifacts.some((a: {plaintext_hash_source: string}) => a.plaintext_hash_source === "not_applicable_restic")).toBe(true);
            // an unreadable snapshot is infrastructure (retry), a missing one downgrades
            const w2 = await world({dbms: ["files"]});
            const r2 = await pendingRp(pool, w2, 1000);
            await pool.query("update fork_recovery_point_artifact set archive_kind='restic_snapshot', path_or_snapshot_id=$2, generated_id='g2' where rp_id=$1", [r2, "b".repeat(64)]);
            expect(await verifyRecoveryPoint(mkDeps(w2, {serve: () => ({}), repos, overrides: {checkResticSnapshot: async () => "missing"}}), r2)).toMatchObject({outcome: "downgraded", reason: "artifact_missing"});
        } finally { repos.drop(); }
    });

    it("concurrent verify of the same RP promotes it exactly once", async () => {
        const repos = localRepos();
        try {
            const w = await world();
            const rpId = await pendingRp(pool, w, fx.plaintextSize);
            const d = mkDeps(w, {serve: () => ({bytes: fx.bytes}), repos});
            const outs = await Promise.all([verifyRecoveryPoint(d, rpId), verifyRecoveryPoint(d, rpId)]);
            expect(outs.filter((o) => o.outcome === "verified")).toHaveLength(1);
            expect(outs.filter((o) => o.outcome === "skipped")).toHaveLength(1);
            expect((await q("select count(*)::int c from fork_audit_event where resource_id=$1 and action='fork.recovery_point.verify' and result='success'", [rpId]))[0].c).toBe(1);
        } finally { repos.drop(); }
    });
});

void (undefined as unknown as World);
