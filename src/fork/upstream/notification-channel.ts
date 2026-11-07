import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";

/**
 * Copy-and-own adapter to the upstream notification channels (D31, W13). Fork notifications are sent through the SAME channel the operator
 * set as the instance default in the upstream settings (`setting.default_notification_channel_id`); the provider, its credentials and its
 * own guards stay upstream's. This module never reads or returns `notification_channel.config`. Existing event kinds only (no enum edit).
 */
export type DefaultChannel = {id: string; organizationId: string | null};

export async function defaultNotificationChannel(db: ForkDb): Promise<DefaultChannel | null> {
    const r = await db.execute(sql`
        select c.id, c.organization_id from settings s join notification_channel c on c.id = s.default_notification_channel_id
         where s.name = 'system' and c.enabled limit 1`);
    const row = r.rows[0] as {id: string; organization_id: string | null} | undefined;
    return row ? {id: row.id, organizationId: row.organization_id} : null;
}
