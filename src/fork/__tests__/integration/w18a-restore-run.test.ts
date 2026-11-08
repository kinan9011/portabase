import {rmSync} from "node:fs";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {verifyAuditChain} from "@/fork/audit";
import type {StepRecord} from "@/fork/runs/engine";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {harness, CAPS, type Harness} from "@/fork/__tests__/w18a-world";
import {adminUser, newKek, seedW17World} from "@/fork/__tests__/w17-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string; let h: Harness;
const key = testKeypair();

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { h = harness(t, kek, key, org); h.reset(); });

const world = (o: {hostRole?: "production" | "test"} = {}) => seedW17World(t, kek, key, admin, {org, caps: CAPS, hostRole: o.hostRole ?? "test"});
const stepNames = (steps: StepRecord[]) => steps.map((s) => `${s.name}:${s.status}`);

describe("W18a orchestrator — happy path and honest terminal states", () => {
    it("new_stack + PostgreSQL: every step in order, exactly one task per step, succeeded/started, audit chain intact, notification, overrides purge", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const c = await h.plan(w);
        const s = await h.start(d, c);
        expect(s).toMatchObject({ok: true});
        if (!s.ok) return;
        const r = await h.drive(d, w, s.runId);
        expect(r.state).toBe("succeeded");
        expect(r.verification).toBe("started");
        expect(r.reason).toBeNull();
        expect(stepNames(r.steps)).toEqual(["verify_manifest:done", "probe:done", "stage:done", "apply:done", "render:done", "restore_db:done", "compose_up:done", "check_services:done"]);
        const j = await h.journal(s.runId);
        expect(j.map((x) => x.step)).toEqual(["probe", "stage", "apply", "render", "restore_db", "compose_up"]); // one task per step, in order
        expect(new Set(j.map((x) => x.task_id)).size).toBe(6);
        expect(r.services).toEqual([{service: "web", state: "running"}, {service: "db", state: "running"}]);
        expect((await h.q("select kind, payload from fork_notification_outbox where dedupe_key=$1", [`restore:${s.runId}:succeeded`]))[0]).toMatchObject({kind: "restore.finished"});
        expect((await h.q("select count(*)::int n from fork_audit_event where action='fork.restore_run.finish' and resource_id=$1", [s.runId]))[0].n).toBe(1);
        expect(await verifyAuditChain(t.db)).toMatchObject({ok: true});
        // every task of the run was addressed to the target agent only
        expect((await h.q("select distinct agent_id from fork_agent_task")).map((x) => x.agent_id)).toEqual([w.agent]);
    });

    it("a data-only plan (selective): verify, probe, stage, apply ⇒ succeeded/data_only; no render, db or up task", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const c = await h.plan(w, {select: ["dir:/srv/app", "volume:app_data"], mode: "selective"});
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        const r = await h.drive(d, w, s.runId);
        expect(r).toMatchObject({state: "succeeded", verification: "data_only"});
        expect(stepNames(r.steps)).toEqual(["verify_manifest:done", "probe:done", "stage:done", "apply:done"]);
        expect((await h.journal(s.runId)).map((x) => x.task_type)).toEqual(["restore_probe", "restore_stage", "restore_apply"]);
    });

    it("forged manifest (one flipped byte) and rollback (validly signed, other sequence) are refused at verify_manifest: ZERO tasks, failed/manifest_mismatch", async () => {
        const w = await world();
        const flipped = w.manifestJson.replace("sequence", "sequencf");
        await pool.query("update fork_recovery_point set sequence=5 where id=$1", [w.rp]); // the plan binds sequence 5 …
        const rollback = await h.signedManifestOf(w, 4); // … a validly signed manifest of the previous snapshot is a rollback
        for (const [name, bundle] of [["forged", {json: flipped, sigB64: w.manifestSig}], ["rollback", rollback]] as const) {
            const d = h.deps(w, await h.user("admin"), {manifest: async () => bundle});
            const c = await h.plan(w);
            const before = (await h.q("select count(*)::int n from fork_agent_task"))[0].n;
            const s = await h.start(d, c);
            if (!s.ok) throw new Error(`${name}: ${s.code}`);
            await h.tick(d, s.runId);
            const r = await h.run(s.runId);
            expect(r, name).toMatchObject({state: "failed", reason: "manifest_mismatch", failed_step: "verify_manifest"});
            expect((await h.q("select count(*)::int n from fork_agent_task"))[0].n, name).toBe(before);
            expect((await h.journal(s.runId)).length).toBe(0);
            expect((await h.q("select kind from fork_notification_outbox where dedupe_key=$1", [`restore:${s.runId}:failed`]))[0]).toMatchObject({kind: "restore.failed"});
            // free the target agent for the next case: the failed run is terminal, the plan is used
        }
    });
});
