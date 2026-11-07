import {eq, sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {forkArcaneConnection, forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {forkStack, forkStackInventory} from "@/fork/db/schema/stack";
import type {NormalizeResult} from "@/fork/inventory/normalize";
import {SYNC_ERROR_CODES, type SyncSummary} from "@/fork/discovery/sync-summary";

/**
 * Persistent state helpers of the discovery sync (W07). ARCH-10 semantics, in one place (documented in ADR-004 §10, reused by W12):
 *  - LOCK = a `fork_lock` lease per connection (`sync:<id>`, unique owner token per run, TTL 5 min, renewed between environments,
 *    stolen only after it expired). A transaction-scoped advisory lock cannot span minutes of network I/O; the lease can, and a
 *    crashed worker stops blocking others once the TTL passes.
 *  - OVERLAP = skip. A second trigger while a sync runs does not queue: the running one reads the same data.
 *  - REPLICAS = the same lease in Postgres: whichever replica takes it runs, the others skip.
 *  - MISSED RUNS = due-ness is derived from the persisted `last_sync_attempt_at`, never from an in-memory timer. After downtime the
 *    first tick runs ONE catch-up sync; there is no backlog replay.
 *  - CIRCUIT = persisted per connection (replica-safe): ≥ 5 consecutive connection-level failures open it with exponential back-off.
 * No logging in this directory (W05 static guard): results are returned and audited, the cron wrapper logs.
 */
export const SYNC_LEASE_TTL_MS = 5 * 60_000;
export const ENVIRONMENT_BUDGET_MS = 60_000; // ADR-004 §7: 60 s per environment sync
export const KEEP_INVENTORY_VERSIONS = 30; // ADR-004 §7
export const BREAKER = {threshold: 5, baseMs: 5 * 60_000, maxMs: 60 * 60_000} as const;
export const JITTER = 0.2; // ±20 % (ADR-004 §7)

export const leaseName = (connectionId: string) => `sync:${connectionId}`;

export async function isSyncRunning(db: ForkDb, connectionId: string, now: Date): Promise<boolean> {
    const r = await db.execute(sql`select 1 from fork_lock where name = ${leaseName(connectionId)} and expires_at > ${now} limit 1`);
    return r.rows.length > 0;
}

/** How long the circuit stays open after the `streak`-th consecutive failure (0 = closed). 5 → 5 min, 6 → 10, 7 → 20, … capped at 60 min. */
export function circuitOpenMs(streak: number): number {
    if (streak < BREAKER.threshold) return 0;
    return Math.min(BREAKER.maxMs, BREAKER.baseMs * 2 ** (streak - BREAKER.threshold));
}

/** Connections the CRON should try now: has an enabled environment, circuit closed (or its back-off elapsed = half-open probe), due by the jittered interval. */
export async function listDueConnections(db: ForkDb, o: {now: Date; intervalMs: number; random?: () => number}): Promise<string[]> {
    const rows = await db.execute(sql`
        select c.id, c.last_sync_attempt_at as last
          from fork_arcane_connection c
         where (c.circuit_open_until is null or c.circuit_open_until <= ${o.now})
           and exists (select 1 from fork_arcane_environment e where e.connection_id = c.id and e.enabled)
         order by c.created_at, c.id`);
    const rnd = o.random ?? Math.random;
    return (rows.rows as {id: string; last: Date | null}[])
        .filter((r) => !r.last || o.now.getTime() - new Date(r.last).getTime() >= o.intervalMs * (1 - JITTER + 2 * JITTER * rnd()))
        .map((r) => r.id);
}

export const toErrorCode = (c: string | null | undefined): (typeof SYNC_ERROR_CODES)[number] => ((SYNC_ERROR_CODES as readonly string[]).includes(c ?? "") ? (c as (typeof SYNC_ERROR_CODES)[number]) : "internal");

// ---- environment reconcile (W05/W06 carry-in) --------------------------------------------------------------------------------
export type VisibleEnvironment = {id: string; name: string};

/**
 * Brings `fork_arcane_environment` in line with what the key covers NOW. New covered environments become rows (`enabled=false`,
 * like Test connection does). Rows the key no longer covers / Arcane no longer lists are marked (`error` + `not_found`) and their stacks
 * `stale_since` — cached inventory is kept (D32: nothing is deleted). A row that is covered again loses the mark.
 */
export async function reconcileEnvironments(tx: ForkDb, connectionId: string, covered: readonly VisibleEnvironment[], now: Date): Promise<{gone: number; added: number}> {
    const rows = await tx.select({id: forkArcaneEnvironment.id, externalId: forkArcaneEnvironment.externalId, status: forkArcaneEnvironment.lastSyncStatus, cls: forkArcaneEnvironment.lastSyncErrorClass})
        .from(forkArcaneEnvironment).where(eq(forkArcaneEnvironment.connectionId, connectionId));
    const have = new Map(rows.map((r) => [r.externalId, r]));
    const live = new Set(covered.map((c) => c.id));
    let added = 0;
    let gone = 0;
    for (const c of covered) {
        const r = have.get(c.id);
        if (!r) {
            await tx.insert(forkArcaneEnvironment).values({connectionId, externalId: c.id, name: c.name.slice(0, 256)}).onConflictDoNothing();
            added++;
        } else {
            await tx.update(forkArcaneEnvironment).set({name: c.name.slice(0, 256), ...(r.status === "error" && r.cls === "not_found" ? {lastSyncStatus: null, lastSyncErrorClass: null} : {}), updatedAt: now}).where(eq(forkArcaneEnvironment.id, r.id));
        }
    }
    for (const r of rows) {
        if (live.has(r.externalId)) continue;
        gone++;
        await tx.update(forkArcaneEnvironment).set({lastSyncAt: now, lastSyncStatus: "error", lastSyncErrorClass: "not_found", updatedAt: now}).where(eq(forkArcaneEnvironment.id, r.id));
        await markStacksStale(tx, r.id, now);
    }
    return {gone, added};
}

export async function markStacksStale(tx: ForkDb, environmentId: string, now: Date): Promise<void> {
    await tx.execute(sql`update fork_stack set stale_since = coalesce(stale_since, ${now}), updated_at = ${now} where environment_id = ${environmentId}`);
}

// ---- writing one environment ----------------------------------------------------------------------------------------------------
export type WriteCounts = {found: number; created: number; changed: number; unchanged: number; absent: number; rejected: number; services: number; mounts: number; warnings: number};

/**
 * ONE transaction per environment (caller owns it): upsert stacks by (environment, compose_project), write a new inventory version ONLY
 * when the content hash changed (ADR-004 §4), clear `stale_since`, mark unseen stacks `absent` (the environment answered, the stack is not
 * there), mark stacks that could not be normalised `stale` (kept, never dropped), prune old versions.
 */
export async function writeEnvironmentSync(tx: ForkDb, o: {organizationId: string; environmentId: string; environmentName: string; result: NormalizeResult; now: Date}): Promise<WriteCounts> {
    const {result, now} = o;
    const existing = await tx.select({id: forkStack.id, composeProject: forkStack.composeProject, runtimeState: forkStack.runtimeState}).from(forkStack).where(eq(forkStack.environmentId, o.environmentId));
    const byProject = new Map(existing.map((s) => [s.composeProject, s]));
    const counts: WriteCounts = {found: result.stacks.length, created: 0, changed: 0, unchanged: 0, absent: 0, rejected: result.rejected.length, services: 0, mounts: 0, warnings: 0};
    const seen = new Set<string>();
    for (const s of result.stacks) {
        seen.add(s.composeProject);
        counts.services += s.counts.services; counts.mounts += s.counts.mounts; counts.warnings += s.counts.warnings;
        let id = byProject.get(s.composeProject)?.id;
        if (!id) {
            [{id}] = await tx.insert(forkStack).values({
                organizationId: o.organizationId, environmentId: o.environmentId, environmentName: o.environmentName.slice(0, 256), composeProject: s.composeProject,
                displayName: s.displayName, runtimeState: s.runtimeState,
            }).returning({id: forkStack.id});
            counts.created++;
        } else {
            await tx.update(forkStack).set({environmentName: o.environmentName.slice(0, 256), displayName: s.displayName, runtimeState: s.runtimeState, staleSince: null, updatedAt: now}).where(eq(forkStack.id, id));
        }
        const [latest] = await tx.select({version: forkStackInventory.version, hash: forkStackInventory.contentHash}).from(forkStackInventory)
            .where(eq(forkStackInventory.stackId, id)).orderBy(sql`${forkStackInventory.version} desc`).limit(1);
        if (latest && latest.hash === s.contentHash) { counts.unchanged++; continue; }
        await tx.insert(forkStackInventory).values({
            stackId: id, version: (latest?.version ?? 0) + 1, contentHash: s.contentHash, inventory: s.inventory, provenance: s.inventory.provenance, warnings: s.inventory.warnings, discoveredAt: now,
        });
        if (latest) counts.changed++;
        await tx.execute(sql`
            delete from fork_stack_inventory i
             where i.stack_id = ${id}
               and i.version <= (select max(version) from fork_stack_inventory where stack_id = ${id}) - ${KEEP_INVENTORY_VERSIONS}
               and not exists (select 1 from fork_recovery_point rp where rp.stack_id = i.stack_id and rp.inventory_version = i.version)`);
    }
    const known = new Set(result.rejected.map((r) => r.composeProject).filter((p): p is string => !!p));
    for (const e of existing) {
        if (seen.has(e.composeProject)) continue;
        if (known.has(e.composeProject)) { // present but not representable now: keep the cached inventory, say it is stale
            await tx.execute(sql`update fork_stack set stale_since = coalesce(stale_since, ${now}), updated_at = ${now} where id = ${e.id}`);
            continue;
        }
        counts.absent++;
        if (e.runtimeState !== "absent") await tx.update(forkStack).set({runtimeState: "absent", staleSince: null, updatedAt: now}).where(eq(forkStack.id, e.id));
    }
    return counts;
}

export async function recordEnvironmentOutcome(tx: ForkDb, o: {environmentId: string; now: Date; status: "ok" | "partial" | "error"; errorClass: string | null; summary: SyncSummary}): Promise<void> {
    await tx.update(forkArcaneEnvironment).set({lastSyncAt: o.now, lastSyncStatus: o.status, lastSyncErrorClass: o.errorClass, lastSyncSummary: o.summary, updatedAt: o.now})
        .where(eq(forkArcaneEnvironment.id, o.environmentId));
    if (o.status === "error") await markStacksStale(tx, o.environmentId, o.now);
}

export async function setConnectionSyncState(tx: ForkDb, connectionId: string, set: Partial<typeof forkArcaneConnection.$inferInsert>): Promise<void> {
    await tx.update(forkArcaneConnection).set(set).where(eq(forkArcaneConnection.id, connectionId));
}

/** Per-environment stack counts for the Integrations table: found (not absent), stale, protected (active policy — none exists before W11). */
export async function stackCountsByEnvironment(db: ForkDb, organizationId: string): Promise<Map<string, {found: number; stale: number; protectedCount: number}>> {
    const r = await db.execute(sql`
        select environment_id as id,
               count(*) filter (where runtime_state <> 'absent')::int as found,
               count(*) filter (where stale_since is not null)::int as stale,
               count(*) filter (where protection_state = 'active')::int as protected_count
          from fork_stack where organization_id = ${organizationId} and environment_id is not null group by environment_id`);
    return new Map((r.rows as {id: string; found: number; stale: number; protected_count: number}[]).map((x) => [x.id, {found: x.found, stale: x.stale, protectedCount: x.protected_count}]));
}

