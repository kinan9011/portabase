import {sql, type SQL} from "drizzle-orm";
import {isSyncRunning} from "@/fork/discovery/sync-state";
import type {ForkDb} from "@/fork/db/handle";
import {PAGE_SIZE, escapeLike, type StackListParams} from "@/fork/stacks/params";
import {StackInventoryV1} from "@/fork/inventory/schema";
import {loadPolicyView} from "@/fork/stack-policy/policy-view";
import {loadRunView} from "@/fork/runs/view";
import {loadActivityView} from "@/fork/stacks/activity-view";
import {loadBackupsView} from "@/fork/stacks/backups-view";
import {StackDetailSchema, StackListSchema, inventoryViewFrom, type StackDetail, type StackList} from "@/fork/stacks/dto";
import {loadProtectionViews, type ProtectionInputs} from "@/fork/stacks/protection";

/**
 * Read side of the Docker Stacks UI (W08). Every query is scoped by `organization_id` (the caller passes the organization the
 * principal was authorised for — never a value from the request), uses bind parameters only, and returns DTOs, not rows.
 * List counts are computed IN SQL from the latest inventory version so the list never ships or parses whole inventories.
 */
const arrLen = (expr: string) => sql.raw(`case when jsonb_typeof(${expr}) = 'array' then jsonb_array_length(${expr}) else 0 end`);
const arr = (expr: string) => `(case when jsonb_typeof(${expr}) = 'array' then ${expr} else '[]'::jsonb end)`;

function whereClause(organizationId: string, p: StackListParams): SQL {
    const parts: SQL[] = [sql`s.organization_id = ${organizationId}`];
    if (p.q) {
        const like = `%${escapeLike(p.q)}%`;
        parts.push(sql`(s.display_name ilike ${like} escape '\\' or s.compose_project ilike ${like} escape '\\')`);
    }
    if (p.environment) parts.push(sql`s.environment_name = ${p.environment}`);
    if (p.runtime) parts.push(sql`s.runtime_state = ${p.runtime}`);
    if (p.protection) parts.push(sql`s.protection_state = ${p.protection}`);
    return sql.join(parts, sql` and `);
}

function orderClause(sort: StackListParams["sort"]): SQL {
    switch (sort) {
        case "attention":
            // gone first, then stale, then unprotected, then the rest; name breaks ties
            return sql`case when s.runtime_state = 'absent' then 0 when s.stale_since is not null then 1 when s.protection_state = 'unprotected' then 2 else 3 end, lower(s.display_name), s.id`;
        case "updated":
            return sql`s.updated_at desc, s.id`;
        default:
            return sql`lower(s.display_name), s.id`;
    }
}

type ListRow = {
    id: string; display_name: string; compose_project: string; environment_name: string; runtime_state: string; protection_state: string;
    stale_since: Date | null; updated_at: Date; version: number | null; discovered_at: Date | null;
    services: number | null; volumes: number | null; binds: number | null; networks: number | null; databases: number | null; shared: number | null;
};

export async function loadStackList(db: ForkDb, organizationId: string, params: StackListParams, now: Date = new Date()): Promise<StackList> {
    const where = whereClause(organizationId, params);
    const totalRes = await db.execute(sql`select count(*)::int as n from fork_stack s where ${where}`);
    const total = (totalRes.rows[0] as {n: number}).n;
    const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(params.page, maxPage);

    const rows = await db.execute(sql`
        select s.id, s.display_name, s.compose_project, s.environment_name, s.runtime_state, s.protection_state, s.stale_since, s.updated_at,
               li.version, li.discovered_at,
               case when li.inventory is null then null else ${arrLen("li.inventory->'services'")} end as services,
               case when li.inventory is null then null else ${arrLen("li.inventory->'volumes'")} end as volumes,
               case when li.inventory is null then null else ${arrLen("li.inventory->'networks'")} end as networks,
               case when li.inventory is null then null else (select count(*)::int from jsonb_array_elements(${sql.raw(arr("li.inventory->'mounts'"))}) m where m->>'kind' = 'bind') end as binds,
               case when li.inventory is null then null else (select count(*)::int from jsonb_array_elements(${sql.raw(arr("li.inventory->'services'"))}) x where x->'database_hint' is not null) end as databases,
               case when li.inventory is null then null else
                   (select count(*)::int from jsonb_array_elements(${sql.raw(arr("li.inventory->'networks'"))}) x where x->>'classification' = 'shared_external' or x->>'external' = 'true')
                 + (select count(*)::int from jsonb_array_elements(${sql.raw(arr("li.inventory->'volumes'"))}) x where x->>'ownership' = 'external_shared') end as shared
          from fork_stack s
          left join lateral (select i.version, i.discovered_at, i.inventory from fork_stack_inventory i where i.stack_id = s.id order by i.version desc limit 1) li on true
         where ${where}
         order by ${orderClause(params.sort)}
         limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`);

    const sumRes = await db.execute(sql`
        select count(*)::int as total,
               count(*) filter (where protection_state = 'unprotected')::int as unprotected,
               count(*) filter (where stale_since is not null or runtime_state = 'absent')::int as stale_or_gone
          from fork_stack where organization_id = ${organizationId}`);
    const sum = sumRes.rows[0] as {total: number; unprotected: number; stale_or_gone: number};
    const envRes = await db.execute(sql`select distinct environment_name as n from fork_stack where organization_id = ${organizationId} order by 1 limit 200`);

    const connRes = await db.execute(sql`
        select c.id, c.circuit_open_until,
               (select count(*)::int from fork_arcane_environment e where e.connection_id = c.id and e.enabled) as enabled_envs
          from fork_arcane_connection c where c.organization_id = ${organizationId} order by c.created_at, c.id`);
    const conns = connRes.rows as {id: string; circuit_open_until: Date | null; enabled_envs: number}[];
    const syncing = conns[0] ? await isSyncRunning(db, conns[0].id, now) : false;

    return StackListSchema.parse({
        items: (rows.rows as ListRow[]).map((r) => ({
            id: r.id, name: r.display_name, composeProject: r.compose_project, environmentName: r.environment_name,
            runtime: r.runtime_state, protection: r.protection_state, staleSince: r.stale_since ? new Date(r.stale_since).toISOString() : null,
            updatedAt: new Date(r.updated_at).toISOString(),
            inventory: r.version === null || r.discovered_at === null ? null : {
                version: r.version, capturedAt: new Date(r.discovered_at).toISOString(),
                counts: {services: r.services ?? 0, volumes: r.volumes ?? 0, binds: r.binds ?? 0, networks: r.networks ?? 0, databases: r.databases ?? 0, shared: r.shared ?? 0},
            },
        })),
        total, page, pageSize: PAGE_SIZE,
        summary: {total: sum.total, unprotected: sum.unprotected, staleOrGone: sum.stale_or_gone},
        environments: (envRes.rows as {n: string}[]).map((x) => x.n),
        syncing,
        circuitOpen: conns.some((c) => c.circuit_open_until !== null && new Date(c.circuit_open_until).getTime() > now.getTime()),
        setup: {connected: conns.length > 0, enabledEnvironments: conns.reduce((a, c) => a + c.enabled_envs, 0)},
    });
}

/** One stack of ONE organization, or `null` (missing or another organization's: identical, no oracle). The caller authorises first. */
export type DetailOptions = {now?: Date; rp?: number | null; configLocked?: boolean; ctxOverride?: ProtectionInputs["ctxOverride"]; staleAfterHours?: number | null};

export async function loadStackDetail(db: ForkDb, organizationId: string, stackId: string, o: DetailOptions = {}): Promise<StackDetail | null> {
    const now = o.now ?? new Date();
    const res = await db.execute(sql`
        select s.id, s.display_name, s.compose_project, s.environment_name, s.runtime_state, s.protection_state, s.stale_since, s.environment_id,
               e.last_sync_at, e.connection_id
          from fork_stack s
          left join fork_arcane_environment e on e.id = s.environment_id
         where s.id = ${stackId} and s.organization_id = ${organizationId}`);
    const s = res.rows[0] as {id: string; display_name: string; compose_project: string; environment_name: string; runtime_state: string; protection_state: string; stale_since: Date | null; environment_id: string | null; last_sync_at: Date | null; connection_id: string | null} | undefined;
    if (!s) return null;

    const inv = await db.execute(sql`select version, discovered_at, inventory, content_hash from fork_stack_inventory where stack_id = ${s.id} order by version desc limit 1`);
    const row = inv.rows[0] as {version: number; discovered_at: Date; inventory: unknown; content_hash: string} | undefined;
    let inventory: StackDetail["inventory"] = {state: "none"};
    if (row) {
        const parsed = StackInventoryV1.safeParse(row.inventory);
        if (!parsed.success) inventory = {state: "unreadable"};
        else {
            const view = inventoryViewFrom(parsed.data, {version: row.version, capturedAt: new Date(row.discovered_at)});
            const {protection, configuration} = await loadProtectionViews(
                db, {id: s.id, staleSince: s.stale_since ? new Date(s.stale_since).toISOString() : null, environmentId: s.environment_id, protectionState: s.protection_state},
                {stored: parsed.data, contentHash: row.content_hash}, {configLocked: o.configLocked ?? false, now, ctxOverride: o.ctxOverride, staleAfterHours: o.staleAfterHours},
            );
            inventory = {state: "ok", view, protection, configuration};
        }
    }
    return StackDetailSchema.parse({
        id: s.id, name: s.display_name, composeProject: s.compose_project, environmentName: s.environment_name,
        runtime: s.runtime_state, protection: s.protection_state,
        staleSince: s.stale_since ? new Date(s.stale_since).toISOString() : null,
        lastSyncAt: s.last_sync_at ? new Date(s.last_sync_at).toISOString() : null,
        syncing: s.connection_id ? await isSyncRunning(db, s.connection_id, now) : false,
        policy: await loadPolicyView(db, s.id, now),
        runs: await loadRunView(db, s.id),
        backups: await loadBackupsView(db, organizationId, s.id, {sequence: o.rp ?? null}),
        activity: await loadActivityView(db, organizationId, s.id),
        inventory,
    });
}
