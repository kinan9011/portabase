import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {loadActivityView} from "@/fork/stacks/activity-view";
import {loadBackupsView} from "@/fork/stacks/backups-view";
import {loadSafetyStrip} from "@/fork/stacks/safety-queries";
import {mkWorld, T0, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let w: World; let other: World;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; w = await mkWorld(t); other = await mkWorld(t); });
afterAll(async () => { await t?.drop(); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

async function mkRp(stackId: string, seq: number, status: string, o: {reason?: string; runId?: string | null; size?: number; verified?: boolean; consistency?: string} = {}) {
    const id = (await q(
        `insert into fork_recovery_point (stack_id, stack_name, sequence, status, downgrade_reason, run_id, consistency_level, required_artifact_count, present_artifact_count, total_size_bytes, created_at, finalized_at, verified_at, inventory_version)
         values ($1,'s',$2,$3,$4,$5,$6,2,2,$7,$8,$9,$10,1) returning id`,
        [stackId, seq, status, o.reason ?? null, o.runId ?? null, o.consistency ?? "mixed", o.size ?? 5000, at(seq), new Date(at(seq).getTime() + 90_000), o.verified ? at(seq) : null]))[0].id as string;
    return id;
}
const mkArtifact = (rpId: string, o: {name: string; channel: string | null; kind?: string; sum?: string | null; presence?: string; path?: string}) =>
    pool.query(`insert into fork_recovery_point_artifact (rp_id, source_name, engine, archive_kind, encrypted, channel_id, path_or_snapshot_id, size_bytes, ciphertext_sha256, presence, required)
        values ($1,$2,'archive',$3,true,$4,$5,1234,$6,$7,true)`, [rpId, o.name, o.kind ?? "archive_enc", o.channel, o.path ?? "/srv/CANARY/path/db.enc", o.sum === undefined ? "ab".repeat(32) : o.sum, o.presence ?? "present"]);

describe("Backups view (RP table + detail)", () => {
    it("lists newest first with honest statuses, destination NAMES, size, duration; detail adds artifacts; no path / id / hash beyond 12 hex leaks", async () => {
        await pool.query("update storage_channel set name='Offsite S3' where id=$1", [w.channels[0]]);
        const runId = (await q("insert into fork_stack_run (stack_id, trigger, state, started_at) values ($1,'manual','succeeded',$2) returning id", [w.stackId, at(1)]))[0].id;
        const rp1 = await mkRp(w.stackId, 1, "verified", {verified: true});
        const rp2 = await mkRp(w.stackId, 2, "pending_verification", {runId});
        const rp3 = await mkRp(w.stackId, 3, "failed", {reason: "member_timeout"});
        await mkArtifact(rp2, {name: "db", channel: w.channels[0]});
        await mkArtifact(rp2, {name: "files", channel: w.channels[0], kind: "restic_snapshot", sum: null, presence: "unknown"});
        await mkArtifact(rp1, {name: "db", channel: randomUUID()}); // channel deleted since
        await mkArtifact(rp3, {name: "db", channel: null});

        const v = (await loadBackupsView(t.db, w.org, w.stackId))!;
        expect(v.rows.map((r) => [r.sequence, r.status])).toEqual([[3, "failed"], [2, "pending_verification"], [1, "verified"]]);
        expect(v.rows[1]).toMatchObject({destinations: ["Offsite S3"], durationSeconds: 90, trigger: "manual", sizeBytes: 5000, consistency: "mixed", required: 2, present: 2, verifiedAt: null});
        expect(v.rows[2].destinations).toEqual(["Removed storage channel"]);
        expect(v.rows[0]).toMatchObject({reason: "member_timeout", destinations: []});
        expect(v.timezone).toBe("UTC");
        expect(v.detail).toBeNull();

        const d = (await loadBackupsView(t.db, w.org, w.stackId, {sequence: 2}))!.detail!;
        expect(d.row.sequence).toBe(2);
        expect(d.artifacts).toEqual([
            {source: "db", engine: "archive", kind: "archive_enc", encrypted: true, destination: "Offsite S3", sizeBytes: 1234, checksum: {recorded: true, short: "abababababab"}, presence: "present", required: true},
            {source: "files", engine: "archive", kind: "restic_snapshot", encrypted: true, destination: "Offsite S3", sizeBytes: 1234, checksum: {recorded: false, short: null}, presence: "unknown", required: true},
        ]);
        const json = JSON.stringify([v, d]);
        for (const bad of ["CANARY", "/srv", rp1, rp2, rp3, "ababababababababab"]) expect(json).not.toContain(bad);
    });

    it("another organization's stack, a missing stack and a foreign sequence all answer null / no detail (no oracle)", async () => {
        expect(await loadBackupsView(t.db, other.org, w.stackId)).toBeNull();
        expect(await loadBackupsView(t.db, w.org, randomUUID())).toBeNull();
        expect((await loadBackupsView(t.db, w.org, w.stackId, {sequence: 999}))!.detail).toBeNull();
        const oRp = await mkRp(other.stackId, 1, "pending_verification");
        expect(oRp).toBeTruthy();
        expect((await loadBackupsView(t.db, w.org, w.stackId, {sequence: 1}))!.detail!.row.status).toBe("verified"); // own #1, not the other stack's #1
    });

    it("purged (retention tombstones) are not listed; the total counts only live recovery points", async () => {
        const rp = await mkRp(w.stackId, 50, "incomplete", {reason: "member_failed"});
        await pool.query("update fork_recovery_point set purged_at = now() where id=$1", [rp]);
        const v = (await loadBackupsView(t.db, w.org, w.stackId))!;
        expect(v.rows.find((r) => r.sequence === 50)).toBeUndefined();
        expect(v.total).toBe(3);
    });
});

describe("Activity view (durable runs, steps, items)", () => {
    it("shows runs newest first with persisted steps + member items + the RP, identically on every read (reload-safe)", async () => {
        await pool.query("delete from fork_stack_run where stack_id=$1", [other.stackId]);
        const steps = [
            {name: "refresh_inventory", status: "done", attempts: 1, errors: 0, startedAt: at(2).toISOString(), finishedAt: at(2).toISOString()},
            {name: "validate", status: "done", attempts: 1, errors: 0},
            {name: "trigger", status: "done", attempts: 1, errors: 0},
            {name: "track", status: "running", attempts: 7, errors: 0},
            {name: "hash", status: "pending", attempts: 0, errors: 0},
            {name: "bogus_step", status: "done", attempts: 1, errors: 0},
            {name: "finalize", status: "failed", attempts: 1, errors: 0, code: "raw error with /srv/secret", },
        ];
        const run = (await q("insert into fork_stack_run (stack_id, trigger, state, started_at, steps, inventory_refresh) values ($1,'schedule','running',$2,$3,'failed') returning id", [w.stackId, at(100), JSON.stringify(steps)]))[0].id as string;
        await pool.query("insert into fork_stack_run_item (run_id, source_name, dbms, state, reason, required) values ($1,'files-0','files','succeeded',null,true),($1,'db','postgresql','failed','agent_did_not_start',true)", [run]);
        const a = (await loadActivityView(t.db, w.org, w.stackId))!;
        const b = (await loadActivityView(t.db, w.org, w.stackId))!;
        expect(a).toEqual(b);
        expect(a.runs[0]).toMatchObject({id: run, trigger: "schedule", state: "running", inventoryRefresh: "failed", rp: null});
        expect(a.runs[0].steps.map((s) => s.name)).toEqual(["refresh_inventory", "validate", "trigger", "track", "hash", "finalize"]); // unknown step dropped
        expect(a.runs[0].steps.at(-1)).toMatchObject({name: "finalize", status: "failed", code: null}); // free-text code never passes
        expect(a.runs[0].items.map((i) => [i.source, i.state, i.reason])).toEqual([["db", "failed", "agent_did_not_start"], ["files-0", "succeeded", null]]);
        expect(a.activeStage).toBe("track");
        expect(JSON.stringify(a)).not.toContain("/srv");
    });

    it("another organization's stack and a missing stack answer null", async () => {
        expect(await loadActivityView(t.db, other.org, w.stackId)).toBeNull();
        expect(await loadActivityView(t.db, w.org, randomUUID())).toBeNull();
    });
});

describe("Strip data", () => {
    it("classifies every stack of the organization only, once per agent for poll failures, and reports counts", async () => {
        // second stack of the SAME organization on the SAME agent/environment
        const inv = (await q("select inventory, content_hash from fork_stack_inventory where stack_id=$1", [w.stackId]))[0];
        const s2 = (await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name, project_id, project_name, protection_state) values ($1,$2,'env','blog','blog',$3,'p','unprotected') returning id", [w.org, w.env, w.project]))[0].id as string;
        await pool.query("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [s2, inv.content_hash, JSON.stringify(inv.inventory)]);
        for (const sid of [w.stackId, s2]) {
            await pool.query(`insert into fork_stack_source (stack_id, role, resource_key, status, dbms, engine, member_name, covers_keys, desired_hash, drift_reason)
                values ($1,'compose',$2,'blocked','docker-volume','archive','m','{}',$3,'agent_poll_failing')`, [sid, `m:${randomUUID()}`, "0".repeat(64)]);
        }
        const s = await loadSafetyStrip(t.db, w.org, {configLocked: false, now: at(3)});
        expect(s.total).toBe(2);
        expect(s.items.map((i) => i.name).sort()).toEqual(["blog", expect.stringMatching(/^app-/)].sort());
        expect(s.counts.safe + s.counts.needsAttention + s.counts.notProtected).toBe(2);
        expect(s.counts.safe).toBe(0); // nothing can be Protected before W14 (kit + verified RPs): honest
        expect(s.items.find((i) => i.name === "blog")).toMatchObject({bucket: "not_protected", reasons: ["unprotected"]});
        const active = s.items.find((i) => i.name !== "blog")!;
        expect(active.bucket).toBe("needs_attention");
        expect(active.reasons).toContain("agent_poll_failing");
        expect(s.agentIssues).toHaveLength(1); // one agent, two affected stacks ⇒ ONE item
        expect(s.agentIssues[0].stacks.map((x) => x.name).sort()).toEqual(["blog", active.name].sort());
        expect(s.capped).toBe(false);
        // never another organization's stack
        expect(JSON.stringify(s)).not.toContain(other.stackId);
        const o = await loadSafetyStrip(t.db, other.org, {configLocked: false, now: at(3)});
        expect(o.total).toBe(1);
        expect(o.agentIssues).toEqual([]);
    });

    it("configuration locked is a warning facet on the active stack", async () => {
        const s = await loadSafetyStrip(t.db, w.org, {configLocked: true, now: at(3)});
        expect(s.items.find((i) => i.name !== "blog")!.reasons).toContain("config_locked");
    });
});
