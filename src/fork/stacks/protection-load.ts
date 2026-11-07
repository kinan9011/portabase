import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {StackInventoryV1} from "@/fork/inventory/schema";
import type {ProtectionView} from "@/fork/completeness/view";
import {loadProtectionViews} from "@/fork/stacks/protection";

/**
 * The §4.6 protection view of ONE stack by id (latest readable inventory), or `null` when the stack has no readable inventory. Shared by the
 * "Am I safe?" strip and the alert evaluator (W13) so every consumer derives the primary state and facets from the SAME code path as the details page.
 * The caller scopes the id to an organization first (strip) or iterates fork-owned active policies (evaluator).
 */
export async function loadProtectionByStackId(db: ForkDb, stackId: string, o: {configLocked: boolean; now?: Date}): Promise<ProtectionView | null> {
    const res = await db.execute(sql`select s.id, s.stale_since, s.environment_id, s.protection_state from fork_stack s where s.id = ${stackId}`);
    const s = res.rows[0] as {id: string; stale_since: Date | null; environment_id: string | null; protection_state: string} | undefined;
    if (!s) return null;
    const inv = await db.execute(sql`select inventory, content_hash from fork_stack_inventory where stack_id = ${stackId} order by version desc limit 1`);
    const row = inv.rows[0] as {inventory: unknown; content_hash: string} | undefined;
    if (!row) return null;
    const parsed = StackInventoryV1.safeParse(row.inventory);
    if (!parsed.success) return null;
    const {protection} = await loadProtectionViews(
        db, {id: s.id, staleSince: s.stale_since ? new Date(s.stale_since).toISOString() : null, environmentId: s.environment_id, protectionState: s.protection_state},
        {stored: parsed.data, contentHash: row.content_hash}, {configLocked: o.configLocked, now: o.now},
    );
    return protection;
}
