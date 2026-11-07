import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";

/**
 * Storage channels the organization may select (W11), SAME availability as `channelsAvailableTo`: enabled, not deleted, org-owned,
 * global or shared with it. Selects `id, name, provider, enabled` ONLY: `config` holds channel credentials and never leaves this function.
 */
export type ChannelRow = {id: string; name: string; provider: string; enabled: boolean};

export async function listAvailableChannels(db: ForkDb, organizationId: string): Promise<ChannelRow[]> {
    const r = await db.execute(sql`
        select c.id, c.name, c.provider::text as provider, c.enabled from storage_channel c
         where c.deleted_at is null and c.enabled
           and (c.organization_id = ${organizationId} or c.organization_id is null
                or exists (select 1 from organization_storage_channels os where os.storage_channel_id = c.id and os.organization_id = ${organizationId}))
         order by c.name, c.id limit 200`);
    return (r.rows as {id: string; name: string; provider: string; enabled: boolean}[]).map((x) => ({id: x.id, name: x.name, provider: x.provider, enabled: x.enabled}));
}

/** id/name/provider of specific channels (names only; never `config`). Used to label an activated policy. */
export async function channelsByIds(db: ForkDb, ids: readonly string[]): Promise<ChannelRow[]> {
    if (ids.length === 0) return [];
    const r = await db.execute(sql`select c.id, c.name, c.provider::text as provider, c.enabled from storage_channel c where c.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) order by c.name, c.id`);
    return (r.rows as ChannelRow[]).map((x) => ({id: x.id, name: x.name, provider: x.provider, enabled: x.enabled}));
}
