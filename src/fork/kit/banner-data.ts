import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {loadKitView, type KitView} from "./service";

/** Inputs of the instance banner: the kit state and whether ANY stack has an active policy (the banner is about stacks that claim protection, §4.2). */
export async function loadKitBanner(db: ForkDb, organizationId: string, now = new Date()): Promise<{view: KitView; hasActivePolicy: boolean}> {
    const [view, p] = await Promise.all([
        loadKitView(db, now),
        db.execute(sql`select 1 from fork_stack_policy p join fork_stack s on s.id = p.stack_id where s.organization_id = ${organizationId} and p.activated_at is not null and p.deactivated_at is null limit 1`),
    ]);
    return {view, hasActivePolicy: p.rows.length > 0};
}
