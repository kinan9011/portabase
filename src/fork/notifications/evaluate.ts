import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {withForkLock} from "@/fork/locks";
import {enqueueForkNotification} from "@/fork/notify";
import {loadMaterializedContext} from "@/fork/materialize/context";
import {loadProtectionByStackId} from "@/fork/stacks/protection-load";
import {logger} from "@/lib/logger";
import {evaluateConditions, nextEpisode} from "./conditions";

const log = logger.child({module: "fork/notifications-evaluate"});
const HOUR = 3_600_000;

export type EvaluateDeps = {db: ForkDb; now?: () => Date; configLocked: boolean; minHours: number};
export type EvaluateResult = {stacks: number; fired: number; errors: number};

export async function evaluateAlerts(d: EvaluateDeps): Promise<EvaluateResult> {
    const now = d.now?.() ?? new Date();
    const out: EvaluateResult = {stacks: 0, fired: 0, errors: 0};
    const act = await d.db.execute(sql`
        select p.stack_id, p.activated_at, s.environment_id from fork_stack_policy p join fork_stack s on s.id = p.stack_id
         where p.activated_at is not null and p.deactivated_at is null order by p.stack_id limit 1000`);
    for (const a of act.rows as {stack_id: string; activated_at: Date; environment_id: string | null}[]) {
        try {
            const protection = await loadProtectionByStackId(d.db, a.stack_id, {configLocked: d.configLocked, now});
            if (!protection) continue;
            out.stacks++;
            const mat = await loadMaterializedContext(d.db, {id: a.stack_id, environmentId: a.environment_id}, now);
            const conditions = evaluateConditions({
                primary: protection.primary, hoursSinceVerified: protection.facets.lastGoodBackup.hoursAgo,
                hoursSinceActivation: Math.max(0, (now.getTime() - new Date(a.activated_at).getTime()) / HOUR), staleAfterHours: mat.staleAfterHours, minHours: d.minHours,
            });
            for (const c of conditions) {
                await withForkLock(d.db, `alert:${a.stack_id}:${c.kind}`, async (tx) => {
                    const cur = await tx.execute(sql`select active, epoch from fork_alert_state where stack_id = ${a.stack_id} and kind = ${c.kind}`);
                    const prev = cur.rows[0] as {active: boolean; epoch: number} | undefined;
                    const n = nextEpisode(prev, c.holds);
                    if (prev && prev.active === n.active && prev.epoch === n.epoch) return;
                    await tx.execute(sql`
                        insert into fork_alert_state (stack_id, kind, active, epoch, since, updated_at)
                        values (${a.stack_id}, ${c.kind}, ${n.active}, ${n.epoch}, ${n.active ? now.toISOString() : null}, ${now.toISOString()})
                        on conflict (stack_id, kind) do update set active = excluded.active, epoch = excluded.epoch, since = excluded.since, updated_at = excluded.updated_at`);
                    if (n.fire) {
                        const queued = await enqueueForkNotification(tx, {
                            kind: c.kind, dedupeKey: `${c.kind}:${a.stack_id}:${n.epoch}`,
                            payload: {state: c.kind === "stack.partial" ? "partial" : "no_good_backup", stackId: a.stack_id, link: `/dashboard/stacks/${a.stack_id}`, ...(c.hours !== null ? {hours: c.hours} : {})},
                        });
                        if (queued) out.fired++;
                    }
                });
            }
        } catch (error) {
            out.errors++;
            log.error({error: error instanceof Error ? error.name : "unknown"}, "Alert evaluation failed for one stack");
        }
    }
    return out;
}
