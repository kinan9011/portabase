import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {discoveredFrom, LAB_PROXY} from "@/fork/__tests__/discovered-fixtures";
import {freshForkDb, seedAgent, seedConnection, seedEnvironment, seedOrg, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {P, seedUser} from "@/fork/__tests__/w16-world";
import {contentHash} from "@/fork/inventory/schema";
import {normalizeEnvironment} from "@/fork/inventory/normalize";
import {planStack} from "@/fork/materialize/plan";
import {SelectionSchema} from "@/fork/materialize/types";
import {RestorePlanV1} from "@/fork/restore/schema";
import {createRestorePlan, type RestoreDeps} from "@/fork/restore/service";

/**
 * Lab-shape: the inventory is produced by the REAL ingest path (scrubbed lab Arcane v2.17.3 captures → normaliser), the member sources by the REAL
 * materializer planner, and the plan by the real service. Assertions are on codes / kinds, never on fixture text.
 */
let t: W04Db; let pool: Pool;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; });
afterAll(async () => { await t?.drop(); });

describe("restore plan from a lab-derived inventory", () => {
    it("every materialized source gets exactly one action of the matching kind; the plan is stored, hash-bound and honest about what is deferred", async () => {
        const l = await discoveredFrom();
        const norm = normalizeEnvironment({connectionId: "00000000-0000-4000-8000-000000000001", environmentId: "0", arcaneVersion: "2.17.3", capturedAt: new Date("2026-11-07T00:00:00Z"), ...l, networks: [...l.networks, LAB_PROXY]});
        const inv = norm.stacks[0].inventory;
        const project = inv.stack.compose_project;
        const org = await seedOrg(pool); const admin = await seedUser(pool);
        const conn = await seedConnection(pool, org); const srcEnv = await seedEnvironment(pool, conn, null, null, "src");
        const stack = await seedStack(pool, org, srcEnv, project);
        await pool.query("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [stack, contentHash(inv), JSON.stringify(inv)]);
        const rp = await seedRp(pool, stack, {status: "verified"});
        await pool.query("update fork_recovery_point set manifest_sha256=$2, manifest_sig_kid='0123456789ab', inventory_version=1, inventory_hash=$3 where id=$1", [rp, "a".repeat(64), contentHash(inv)]);
        const planned = planStack(inv, SelectionSchema.parse({})).sources;
        expect(planned.length).toBeGreaterThan(0);
        const chan = (await pool.query("insert into storage_channel (organization_id, provider, name, config, enabled) values ($1,'s3','x','{}',true) returning id", [org])).rows[0].id;
        for (const [n, s] of planned.entries()) {
            const sid = (await pool.query("insert into fork_stack_source (stack_id, role, resource_key, origin, dbms, engine, member_name, covers_keys, desired_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
                [stack, s.role, s.resourceKey, s.origin, s.dbms, s.engine, s.memberName, [...s.covers], "c".repeat(64)])).rows[0].id;
            await pool.query(`insert into fork_recovery_point_artifact (rp_id, stack_source_id, source_name, engine, archive_kind, encrypted, channel_id, channel_kind, plaintext_sha256, plaintext_size, required, presence)
                values ($1,$2,$3,$4,'archive_enc',true,$5,'s3',$6,10,true,'present')`, [rp, sid, s.memberName, s.dbms, chan, String(n % 10).repeat(64)]);
        }
        const agentName = "lab-restore-host"; const agent = await seedAgent(pool, org, agentName);
        await pool.query("insert into fork_agent_enrollment (agent_id, credential_hash, task_key_enc, pin_fingerprint, enrolled_by, capabilities) values ($1,$2,'{}','ffffffff','u','{restore.target.v1,compose.render.v1}')", [agent, "d".repeat(64)]);
        const tgt = await seedEnvironment(pool, conn, agent, agentName, "tgt");
        await pool.query("update fork_arcane_environment set last_sync_status='ok', last_sync_at=now() where id=$1", [tgt]);

        const d: RestoreDeps = {db: t.db, principal: P(admin, "user", [org, "admin"]), configAllowed: async () => true};
        const r = await createRestorePlan(d, {rpId: rp, targetAgentId: agent, purpose: "restore", mode: "new_stack", mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: null, sqlite: null}});
        if (!r.ok) throw new Error(`refused: ${r.code}`);
        const plan = RestorePlanV1.parse((await pool.query("select plan from fork_restore_plan where id=$1", [r.planId])).rows[0].plan);

        const kindOf = {compose: "restore_compose_dir", env: "restore_compose_dir", volume: "restore_volume", bind: "restore_path", db: "restore_db_dump"} as const;
        for (const s of planned) {
            const acts = plan.actions.filter((a) => a.resource_key === s.resourceKey);
            expect(acts, s.resourceKey).toHaveLength(1);
            const want = s.dbms === "sqlite" ? "restore_sqlite_file" : kindOf[s.role];
            expect(acts[0].kind, s.resourceKey).toBe(want);
            expect(acts[0].artifact_ids).toHaveLength(1);
            expect(acts[0].risk, `${s.resourceKey}: ${acts[0].reasons}`).not.toBe("blocked");
        }
        expect(plan.actions.filter((a) => a.kind === "compose_up")).toHaveLength(1);
        expect(plan.blockers).toEqual([]);
        expect(plan.outcome).toBe("ready");
        expect(plan.target).toMatchObject({host_role: "production", host_role_source: "environment", project, restore_root: "/srv/restore"});
        expect(plan.preconditions.find((p) => p.code === "manifest_signature")?.state).toBe("deferred");
        // every destination of a path action stays under the restore root
        for (const a of plan.actions) if (a.destination.path) expect(a.destination.path.startsWith(`/srv/restore/${project}/`), a.destination.path).toBe(true);
    });
});
