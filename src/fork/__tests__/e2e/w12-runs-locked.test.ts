import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, describe, expect, it} from "vitest";
import type {ForkDb} from "@/fork/db/handle";
import {type App, boot} from "@/fork/__tests__/e2e/helpers";
import {mkWorld} from "@/fork/__tests__/w12-fixtures";

let app: App | undefined;
afterAll(async () => { await app?.stop(); });

describe("W12 degraded mode (ADR-010, §4.1) on the REAL production build: a failed self-check LOCKS configuration, scheduled runs keep running", () => {
    it("active policy + AUTH_SIGNUP_ENABLED left true ⇒ mode locked; a due schedule STILL starts a run, queues the member backups and finalises nothing as success", async () => {
        app = await boot({FORK_ARCANE_ENABLED: "true", FORK_RUN_TICK_SECONDS: "2"}, ["default-org", "active-policy"]);
        const {logs, db} = app;
        expect(logs()).toMatch(/"mode":"locked"/);
        expect(logs()).toMatch(/"started":\["fork-audit-retention","fork-restore-override-purge","fork-materialize-drift","fork-stack-runs","fork-notifications","fork-verify","fork-kit-watch"\]/);

        // upstream created the default admin on boot: make an ACTIVE, due stack policy owned by that admin (the same rows `activateStackPolicy` writes)
        const org = (await db.pool.query("select id from organization where slug='default'")).rows[0].id as string;
        const admin = (await db.pool.query("select u.id from \"user\" u join member m on m.user_id=u.id where m.organization_id=$1 order by u.created_at limit 1", [org])).rows[0].id as string;
        const minute = (new Date().getUTCMinutes() + 58) % 60; // the hourly slot two minutes ago: due now, inside the capture window
        const w = await mkWorld({...db, db: drizzle({client: db.pool}) as unknown as ForkDb}, {existing: {orgId: org, userId: admin}, schedule: {preset: "hourly", timezone: "UTC", minute, hour: 2, weekday: 0, monthday: 1}});
        await db.pool.query("update fork_stack_policy set activated_at = now() - interval '3 hours' where stack_id=$1", [w.stackId]);

        let run: {id: string; trigger: string; state: string; inventory_refresh: string | null} | undefined;
        for (let i = 0; i < 90 && !run; i++) {
            run = (await db.pool.query("select id, trigger, state, inventory_refresh from fork_stack_run where stack_id=$1", [w.stackId])).rows[0];
            if (!run) await new Promise((r) => setTimeout(r, 1000));
        }
        expect(run, `no run appeared; logs:\n${logs().slice(-1500)}`).toBeDefined();
        expect(run).toMatchObject({trigger: "schedule"});
        // let the real tracker queue the members
        let queued = 0;
        for (let i = 0; i < 30 && !queued; i++) {
            queued = Number((await db.pool.query("select count(*)::int n from fork_stack_run_item where run_id=$1 and state='queued'", [run!.id])).rows[0].n);
            if (!queued) await new Promise((r) => setTimeout(r, 1000));
        }
        expect(queued).toBeGreaterThan(0);
        expect(Number((await db.pool.query("select count(*)::int n from backups where status='waiting' and database_id = any($1::uuid[])", [w.members.map((m) => m.databaseId)])).rows[0].n)).toBe(queued);
        const r = (await db.pool.query("select inventory_refresh from fork_stack_run where id=$1", [run!.id])).rows[0];
        expect(r.inventory_refresh).toBe("skipped_locked"); // honest: discovery is configuration-plane and does not run while locked
        // nothing was finalised as success, the instance is still locked (the run did not unlock anything)
        expect(Number((await db.pool.query("select count(*)::int n from fork_recovery_point where status in ('pending_verification','verified') and stack_id=$1", [w.stackId])).rows[0].n)).toBe(0);
        expect(logs()).not.toMatch(/Stack runs tick failed/);
    }, 300_000);
});
