import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {downgradeIncoherentRecoveryPoints} from "@/fork/recovery/downgrade";
import {freshForkDb, seedAgent, seedArtifact, seedBackup, seedChannel, seedConnection, seedEnvironment, seedOrg, seedProject, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";

let w: W04Db;
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);
beforeAll(async () => { w = await freshForkDb(); });
afterAll(async () => { await w.drop(); });

/** One stack with a coherent `verified` RP: 1 required artifact bound to real upstream rows. */
async function scenario(tag: string) {
    const org = await seedOrg(w.pool, `org-${tag}`);
    const agent = await seedAgent(w.pool, org, `agent-${tag}`);
    const channel = await seedChannel(w.pool, org);
    const bk = await seedBackup(w.pool, agent, channel);
    const conn = await seedConnection(w.pool, org, `c-${tag}`);
    const env = await seedEnvironment(w.pool, conn, agent, `agent-${tag}`, tag);
    const project = await seedProject(w.pool, org);
    const stack = await seedStack(w.pool, org, env, `st-${tag}`, project, `proj-${tag}`);
    const rp = await seedRp(w.pool, stack, {status: "verified", required: 1});
    const art = await seedArtifact(w.pool, rp, {backupId: bk.backupId, backupStorageId: bk.backupStorageId, channelId: channel});
    return {org, agent, channel, ...bk, conn, env, project, stack, rp, art};
}
const rp = async (id: string) => (await q("select status, downgrade_reason, verified_at from fork_recovery_point where id=$1", [id])).rows[0];

describe("E8 D32 lab test — delete agent + run upstream cleanup ⇒ upstream no error, RP downgraded", () => {
    it("coherent RP is NOT touched by the downgrade pass", async () => {
        const s = await scenario("ok");
        expect(await downgradeIncoherentRecoveryPoints(w.db)).toEqual([]);
        expect((await rp(s.rp)).status).toBe("verified");
    });

    it("deleting the AGENT (upstream cascades databases → backups → backup_storage) succeeds; fork FKs go NULL, facts survive, RP is downgraded to incomplete:fk_null", async () => {
        const s = await scenario("agent");
        await expect(q("delete from agents where id=$1", [s.agent])).resolves.toBeDefined(); // upstream: no error
        expect((await q("select count(*)::int c from backups where id=$1", [s.backupId])).rows[0].c).toBe(0);

        const env = (await q("select agent_id, agent_name from fork_arcane_environment where id=$1", [s.env])).rows[0];
        expect(env).toEqual({agent_id: null, agent_name: "agent-agent"}); // SET NULL + denormalised name
        const art = (await q("select backup_id, backup_storage_id, engine, generated_id, size_bytes, channel_id, channel_kind, presence from fork_recovery_point_artifact where id=$1", [s.art])).rows[0];
        expect(art).toMatchObject({backup_id: null, backup_storage_id: null, engine: "postgresql", generated_id: "gen-1", channel_kind: "local", presence: "present"});
        expect(Number(art.size_bytes)).toBe(123);
        expect(art.channel_id).toBe(s.channel);
        expect((await rp(s.rp)).status).toBe("verified"); // nothing silently rewrote it yet…

        const downgraded = await downgradeIncoherentRecoveryPoints(w.db);
        expect(downgraded).toContainEqual({id: s.rp, reason: "fk_null"});
        expect(await rp(s.rp)).toEqual({status: "incomplete", downgrade_reason: "fk_null", verified_at: null}); // honest, never `verified`
        expect(await downgradeIncoherentRecoveryPoints(w.db)).toEqual([]); // idempotent
    });

    it("upstream cleanup cron: the REAL cleanDeletedBackupsTask hard-deletes an expired soft-deleted backup ⇒ no error, RP downgraded", async () => {
        const s = await scenario("cron");
        await q("update backups set deleted_at = now() - interval '400 days' where id=$1", [s.backupId]);
        vi.resetModules();
        const prev = {...process.env};
        Object.assign(process.env, {DATABASE_URL: w.url, PROJECT_URL: "http://127.0.0.1:1", PROJECT_SECRET: "w04-secret-not-real-0123456789-0123456789", CLEANING_BACKUPS_RETENTION_DAYS: "30", CLEANING_BACKUPS_BATCH_SIZE: "50", SKIP_ENV_VALIDATION: "true"});
        try {
            const {cleanDeletedBackupsTask} = await import("@/lib/tasks/cleaning/backups-cleanup");
            await expect(cleanDeletedBackupsTask()).resolves.toBeUndefined();
        } finally {
            // close the app pool BEFORE the throw-away DB is dropped (else an unhandled 57P01 fails the run)
            const appDb = (await import("@/db").catch(() => null))?.db as unknown as {$client?: {end: () => Promise<void>}} | undefined;
            await appDb?.$client?.end().catch(() => undefined);
            process.env = prev;
        }
        expect((await q("select count(*)::int c from backups where id=$1", [s.backupId])).rows[0].c).toBe(0); // upstream really deleted it
        expect((await q("select backup_id from fork_recovery_point_artifact where id=$1", [s.art])).rows[0].backup_id).toBeNull();
        expect(await downgradeIncoherentRecoveryPoints(w.db)).toContainEqual({id: s.rp, reason: "fk_null"});
    });

    it("artifact presence ≠ present ⇒ artifact_missing; count mismatch ⇒ count_mismatch (precedence fk_null → missing → count)", async () => {
        const s1 = await scenario("miss");
        await q("update fork_recovery_point_artifact set presence='missing' where id=$1", [s1.art]);
        const s2 = await scenario("cnt");
        await q("update fork_recovery_point set required_artifact_count=2 where id=$1", [s2.rp]);
        const out = await downgradeIncoherentRecoveryPoints(w.db);
        expect(out).toContainEqual({id: s1.rp, reason: "artifact_missing"});
        expect(out).toContainEqual({id: s2.rp, reason: "count_mismatch"});
    });

    it("pending_verification is downgraded the same way; failed/incomplete/purged are left alone", async () => {
        const s = await scenario("pend");
        await q("update fork_recovery_point set status='pending_verification', verified_at=null where id=$1", [s.rp]);
        await q("delete from backups where id=$1", [s.backupId]);
        const failed = await seedRp(w.pool, s.stack, {status: "incomplete", seq: 50});
        const out = await downgradeIncoherentRecoveryPoints(w.db);
        expect(out).toContainEqual({id: s.rp, reason: "fk_null"});
        expect(out.find((x) => x.id === failed)).toBeUndefined();
    });

    it("deleting the stack's Project ⇒ stack.project_id NULL, project_name kept (D32); Arcane disconnect never deletes stacks or RPs", async () => {
        const s = await scenario("proj");
        await q("delete from projects where id=$1", [s.project]);
        expect((await q("select project_id, project_name from fork_stack where id=$1", [s.stack])).rows[0]).toEqual({project_id: null, project_name: "proj-proj"});
        await q("delete from fork_arcane_connection where id=$1", [s.conn]); // disconnect ⇒ environments cascade
        expect((await q("select count(*)::int c from fork_arcane_environment where id=$1", [s.env])).rows[0].c).toBe(0);
        expect((await q("select environment_id, environment_name from fork_stack where id=$1", [s.stack])).rows[0]).toEqual({environment_id: null, environment_name: "env"});
        expect((await rp(s.rp)).status).toBe("verified"); // RP untouched
    });

    it("fork→fork: removing a stack that has RPs is RESTRICTed (needs the explicit audited forget action); artifacts cascade with their RP", async () => {
        const s = await scenario("restrict");
        await expect(q("delete from fork_stack where id=$1", [s.stack])).rejects.toThrow(/fork_recovery_point_stack_id_fork_stack_id_fk/);
        await q("delete from fork_recovery_point where id=$1", [s.rp]);
        expect((await q("select count(*)::int c from fork_recovery_point_artifact where id=$1", [s.art])).rows[0].c).toBe(0);
        await expect(q("delete from fork_stack where id=$1", [s.stack])).resolves.toBeDefined();
    });

    it("FINDING (recorded): deleting an organization that still owns stacks WITH recovery points is blocked by the RESTRICT chain until stacks are forgotten; without RPs it cascades", async () => {
        const s = await scenario("orgdel");
        await expect(q("delete from organization where id=$1", [s.org])).rejects.toThrow(/fork_recovery_point_stack_id_fork_stack_id_fk/);
        await q("delete from fork_recovery_point where id=$1", [s.rp]);
        await expect(q("delete from organization where id=$1", [s.org])).resolves.toBeDefined();
        expect((await q("select count(*)::int c from fork_stack where id=$1", [s.stack])).rows[0].c).toBe(0);
    });
});
