import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {RetentionPolicySchema} from "@/fork/recovery/retention-policy";
import {nextRuns, ScheduleSchema, toCron} from "@/fork/schedule/schedule";
import {PolicyViewSchema, type PolicyView} from "./policy-schema";
import {channelsByIds} from "@/fork/upstream";

/** null = no ACTIVE policy (never configured, or deactivated). The caller has already authorised `stacks.view` for this stack. */
export async function loadPolicyView(db: ForkDb, stackId: string, now: Date = new Date()): Promise<PolicyView | null> {
    const r = await db.execute(sql`
        select p.activated_at, p.schedule, p.policy, p.storage_channel_ids, p.consistency_profile,
               (select count(*)::int from fork_stack_source l where l.stack_id = p.stack_id and l.status in ('active','canary')) as sources
          from fork_stack_policy p where p.stack_id = ${stackId} and p.activated_at is not null and p.deactivated_at is null`);
    const row = r.rows[0] as undefined | {activated_at: Date; schedule: unknown; policy: unknown; storage_channel_ids: string[] | null; consistency_profile: string; sources: number};
    if (!row) return null;
    const sched = ScheduleSchema.safeParse(row.schedule);
    const ret = RetentionPolicySchema.safeParse(row.policy);
    if (!sched.success || !ret.success) return null; // activated rows are always written with both; anything else is not shown as a policy
    const channels = await channelsByIds(db, row.storage_channel_ids ?? []);
    return PolicyViewSchema.parse({
        activatedAt: new Date(row.activated_at).toISOString(), schedule: sched.data, cron: toCron(sched.data),
        nextRuns: nextRuns(sched.data, now, 3).map((d) => d.toISOString()), retention: ret.data,
        channels: channels.map((c) => ({name: c.name, provider: c.provider, local: c.provider === "local"})),
        consistency: row.consistency_profile, sourceCount: row.sources,
    });
}
