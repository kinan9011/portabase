import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {declareDashboardDbSource, evaluateDashboardDbSource, listDeclarableSources} from "@/fork/dashboard-db/service";
import {freshForkDb, seedAgent, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let org: string;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; org = await seedOrg(pool); });
afterAll(async () => { await t?.drop(); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const NOW = new Date("2026-11-07T12:00:00Z");
const naive = (d: Date) => d.toISOString().slice(0, -1);
const admin = {userId: randomUUID(), systemRole: "admin", memberships: []};
const d = (principal: typeof admin | null) => ({db: t.db, principal, now: () => NOW, assertConfigAllowed: async () => undefined});
async function mkSource(agent: string, o: {cron?: string | null; channel?: string; lastSuccessHoursAgo?: number} = {}) {
    const db = (await q("insert into databases (name, dbms, agent_id, backup_policy) values ($1,'postgresql',$2,$3) returning id", [`dash-${randomUUID().slice(0, 6)}`, agent, o.cron === undefined ? "0 3 * * *" : o.cron]))[0].id as string;
    if (o.channel) await pool.query("insert into storage_policy (storage_channel_id, database_id, enabled) values ($1,$2,true)", [o.channel, db]);
    if (o.lastSuccessHoursAgo !== undefined) await pool.query("insert into backups (database_id, status, created_at) values ($1,'success',$2)", [db, naive(new Date(NOW.getTime() - o.lastSuccessHoursAgo * 3_600_000))]);
    return db;
}
const channel = async (provider: string) => (await q("insert into storage_channel (organization_id, provider, name, config, enabled) values ($1,$2,$3,'{}',true) returning id", [org, provider, `ch-${randomUUID().slice(0, 6)}`]))[0].id as string;

describe("D40 dashboard-DB source: declare + evaluate (honest verdicts from upstream's own tables)", () => {
    it("declaration is system-admin only, audited, strict, and refuses stack-managed / non-postgres / unknown sources", async () => {
        const agent = await seedAgent(pool, org);
        const s3 = await channel("s3");
        const src = await mkSource(agent, {channel: s3, lastSuccessHoursAgo: 2});
        expect(await declareDashboardDbSource(d({...admin, systemRole: "user"}), {databaseId: src})).toMatchObject({ok: false, code: "forbidden"});
        expect(await declareDashboardDbSource(d(null), {databaseId: src})).toMatchObject({ok: false, code: "forbidden"});
        expect(await declareDashboardDbSource(d(admin), {databaseId: "nope"})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await declareDashboardDbSource(d(admin), {databaseId: randomUUID()})).toMatchObject({ok: false, code: "not_found"});
        const mysql = (await q("insert into databases (name, dbms, agent_id) values ('m','mysql',$1) returning id", [agent]))[0].id;
        expect(await declareDashboardDbSource(d(admin), {databaseId: mysql})).toMatchObject({ok: false, code: "not_found"});
        expect((await listDeclarableSources(t.db)).map((c) => c.id)).toContain(src);
        const ok = await declareDashboardDbSource(d(admin), {databaseId: src});
        expect(ok).toMatchObject({ok: true, view: {verdict: "ok", hasSchedule: true}});
        expect((await q("select count(*)::int c from fork_audit_event where action='fork.dashboard_db.declare' and result='success'"))[0].c).toBe(1);
        expect((await q("select count(*)::int c from fork_audit_event where action='fork.dashboard_db.declare' and result='denied'"))[0].c).toBeGreaterThanOrEqual(3);
    });

    it("verdicts: not declared · no schedule · no channel · local only · shared with another host's agent · no success yet · stale · ok · source deleted", async () => {
        const agent = await seedAgent(pool, org); const other = await seedAgent(pool, org);
        const s3 = await channel("s3"); const local = await channel("local");
        const verdictOf = async (id: string | null) => { await declareDashboardDbSource(d(admin), {databaseId: id}); return (await evaluateDashboardDbSource(t.db, NOW)).verdict; };
        expect(await verdictOf(null)).toBe("not_declared");
        expect(await verdictOf(await mkSource(agent, {cron: null, channel: s3, lastSuccessHoursAgo: 1}))).toBe("no_schedule");
        expect(await verdictOf(await mkSource(agent, {lastSuccessHoursAgo: 1}))).toBe("no_channel");
        expect(await verdictOf(await mkSource(agent, {channel: local, lastSuccessHoursAgo: 1}))).toBe("local_only");
        const sharedCh = await channel("s3");
        await mkSource(other, {channel: sharedCh, lastSuccessHoursAgo: 1}); // ANOTHER host's source writes to the same channel
        expect(await verdictOf(await mkSource(agent, {channel: sharedCh, lastSuccessHoursAgo: 1}))).toBe("shared_channel");
        expect(await verdictOf(await mkSource(agent, {channel: await channel("s3")}))).toBe("no_success");
        expect(await verdictOf(await mkSource(agent, {channel: await channel("s3"), lastSuccessHoursAgo: 72}))).toBe("stale");
        const good = await mkSource(agent, {channel: await channel("s3"), lastSuccessHoursAgo: 3});
        expect(await verdictOf(good)).toBe("ok");
        await pool.query("delete from databases where id=$1", [good]); // FK SET NULL (D32): the declaration survives, the verdict says so
        expect((await evaluateDashboardDbSource(t.db, NOW)).verdict).toBe("source_missing");
    });
});
