import {eq, sql} from "drizzle-orm";
import {z} from "zod";
import {forkCan, type ForkPrincipal} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkDashboardDbSource} from "@/fork/db/schema/kit";
import {assertForkConfigAllowed, ForkLockedError} from "@/fork/mode";

/**
 * D40 — the dashboard's own database is backed up as an ORDINARY Portabase source (an upstream `postgresql` source on an agent that can reach it), to a
 * channel that no OTHER host's agent shares. The fork neither creates that source nor holds the dashboard DB credentials: a system administrator DECLARES which
 * existing source it is, and the fork EVALUATES it from upstream's own tables and says plainly what is missing. Restore runbook (revoke sessions, rotate API
 * keys + storage credentials after restoring the dashboard DB): ADR-006 §D40 + the copy below.
 */
export const DB_VERDICTS = ["not_declared", "ok", "source_missing", "no_schedule", "no_channel", "local_only", "shared_channel", "no_success", "stale"] as const;
export type DbVerdict = (typeof DB_VERDICTS)[number];
export const STALE_HOURS = 48;

export type DashboardDbView = {
    verdict: DbVerdict; sourceName: string | null; hasSchedule: boolean; lastSuccessAt: string | null;
    channels: {name: string; provider: string; local: boolean; sharedWithOtherHosts: boolean}[];
};
export type Candidate = {id: string; name: string; agentName: string | null};

export async function listDeclarableSources(db: ForkDb): Promise<Candidate[]> {
    const r = await db.execute(sql`
        select d.id, d.name, a.name as agent_name from databases d left join agents a on a.id = d.agent_id
         where d.dbms = 'postgresql' and d.deleted_at is null and not exists (select 1 from fork_stack_source s where s.database_id = d.id)
         order by lower(d.name) limit 100`);
    return (r.rows as {id: string; name: string; agent_name: string | null}[]).map((x) => ({id: x.id, name: x.name, agentName: x.agent_name}));
}

export async function evaluateDashboardDbSource(db: ForkDb, now = new Date()): Promise<DashboardDbView> {
    const empty: DashboardDbView = {verdict: "not_declared", sourceName: null, hasSchedule: false, lastSuccessAt: null, channels: []};
    const [decl] = await db.select().from(forkDashboardDbSource);
    if (!decl) return empty;
    if (!decl.databaseId) return {...empty, verdict: "source_missing"};
    const d = (await db.execute(sql`
        select d.name, d.agent_id, coalesce(d.backup_policy, p.backup_policy) as cron,
               (select max(b.created_at) at time zone 'UTC' from backups b where b.database_id = d.id and b.status = 'success' and b.deleted_at is null) as last_success
          from databases d left join projects p on p.id = d.project_id where d.id = ${decl.databaseId} and d.deleted_at is null`)).rows[0] as {name: string; agent_id: string | null; cron: string | null; last_success: Date | null} | undefined;
    if (!d) return {...empty, verdict: "source_missing"};
    const ch = (await db.execute(sql`
        with eff as (
            select x.id as database_id, x.agent_id, sp.storage_channel_id from databases x join storage_policy sp on sp.database_id = x.id and sp.enabled where x.deleted_at is null
            union
            select x.id, x.agent_id, sp.storage_channel_id from databases x join storage_policy sp on sp.project_id = x.project_id and sp.enabled
             where x.deleted_at is null and not exists (select 1 from storage_policy o where o.database_id = x.id and o.enabled)
        )
        select c.name, c.provider::text as provider,
               exists (select 1 from eff e2 where e2.storage_channel_id = c.id and e2.agent_id is distinct from ${d.agent_id}) as shared
          from eff e join storage_channel c on c.id = e.storage_channel_id and c.deleted_at is null and c.enabled
         where e.database_id = ${decl.databaseId} order by c.name`)).rows as {name: string; provider: string; shared: boolean}[];
    const channels = ch.map((c) => ({name: c.name, provider: c.provider, local: c.provider === "local", sharedWithOtherHosts: c.shared}));
    const last = d.last_success ? new Date(d.last_success) : null; // `at time zone 'UTC'` above: upstream stores naive UTC wall time
    const base = {sourceName: d.name, hasSchedule: !!d.cron, lastSuccessAt: last?.toISOString() ?? null, channels};
    const good = channels.filter((c) => !c.local && !c.sharedWithOtherHosts);
    const verdict: DbVerdict = !d.cron ? "no_schedule" : channels.length === 0 ? "no_channel" : channels.every((c) => c.local) ? "local_only" : good.length === 0 ? "shared_channel"
        : !last ? "no_success" : now.getTime() - last.getTime() > STALE_HOURS * 3_600_000 ? "stale" : "ok";
    return {verdict, ...base};
}

export type DeclareDeps = {db: ForkDb; principal: ForkPrincipal | null; now?: () => Date; assertConfigAllowed?: () => Promise<void>};
export type DeclareResult = {ok: true; view: DashboardDbView} | {ok: false; code: "forbidden" | "locked" | "invalid_input" | "not_found"; message: string};
const Schema = z.strictObject({databaseId: z.uuid().nullable()});

/** Declares (or clears with `null`) which upstream source backs up the dashboard database. System admin only, D21 gate, audited (ids only). */
export async function declareDashboardDbSource(d: DeclareDeps, raw: unknown): Promise<DeclareResult> {
    const p = d.principal;
    const now = d.now?.() ?? new Date();
    const denied = (details: Record<string, unknown>) => recordAudit(d.db, {actorUserId: p?.userId ?? null, action: "fork.dashboard_db.declare", resourceType: "dashboard_db_source", result: "denied", details, now});
    if (!p) return {ok: false, code: "forbidden", message: "You must be signed in."};
    if (!forkCan({systemRole: p.systemRole ?? null}, "recovery.kit.manage")) { await denied({reason: "forbidden"}); return {ok: false, code: "forbidden", message: "Only a system administrator can do this."}; }
    try { await (d.assertConfigAllowed ?? assertForkConfigAllowed)(); }
    catch (e) { if (e instanceof ForkLockedError) { await denied({reason: "locked"}); return {ok: false, code: "locked", message: "Configuration is locked until the single-organization check passes."}; } throw e; }
    const parsed = Schema.safeParse(raw);
    if (!parsed.success) return {ok: false, code: "invalid_input", message: "Choose a source from the list."};
    const {databaseId} = parsed.data;
    if (databaseId) {
        const ok = (await listDeclarableSources(d.db)).some((c) => c.id === databaseId);
        if (!ok) { await denied({reason: "not-declarable"}); return {ok: false, code: "not_found", message: "That source cannot be used (it must be an existing PostgreSQL source that no stack manages)."}; }
        await d.db.insert(forkDashboardDbSource).values({singleton: true, databaseId, declaredBy: p.userId, declaredAt: now}).onConflictDoUpdate({target: forkDashboardDbSource.singleton, set: {databaseId, declaredBy: p.userId, declaredAt: now}});
    } else {
        await d.db.delete(forkDashboardDbSource).where(eq(forkDashboardDbSource.singleton, true));
    }
    await recordAudit(d.db, {actorUserId: p.userId, action: "fork.dashboard_db.declare", resourceType: "dashboard_db_source", resourceId: databaseId, result: "success", details: {cleared: databaseId === null}, now});
    return {ok: true, view: await evaluateDashboardDbSource(d.db, now)};
}
