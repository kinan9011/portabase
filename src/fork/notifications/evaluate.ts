import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {withForkLock} from "@/fork/locks";
import {enqueueForkNotification} from "@/fork/notify";
import {loadMaterializedContext} from "@/fork/materialize/context";
import {loadProtectionByStackId} from "@/fork/stacks/protection-load";
import {logger} from "@/lib/logger";
import {quiesceAlert} from "@/fork/quiesce/alert";
import {reconcileOpenQuiesces} from "@/fork/quiesce/reconcile";
import type {QuiesceState} from "@/fork/quiesce/vocab";
import {evaluateConditions, nextEpisode, type Condition} from "./conditions";

const log = logger.child({module: "fork/notifications-evaluate"});
const HOUR = 3_600_000;

export type EvaluateDeps = {db: ForkDb; now?: () => Date; configLocked: boolean; minHours: number};
export type EvaluateResult = {stacks: number; fired: number; errors: number};

export async function evaluateAlerts(d: EvaluateDeps): Promise<EvaluateResult> {
    const now = d.now?.() ?? new Date();
    const out: EvaluateResult = {stacks: 0, fired: 0, errors: 0};
    // W17b: late agent results / "Start now" retries are folded into the run rows BEFORE the alert condition is read
    try { await reconcileOpenQuiesces(d.db, now); } catch (error) { out.errors++; log.error({error: error instanceof Error ? error.name : "unknown"}, "Quiesce reconcile failed"); }
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
            // W17b (D15): "stopped since <t> — Start now": the latest run that used quiesce decides (pure `quiesceAlert`)
            const q = await d.db.execute(sql`
                select r.quiesce_state, r.quiesce_stopped_at, p.quiesce_max_stop_seconds from fork_stack_run r join fork_stack_policy p on p.stack_id = r.stack_id
                 where r.stack_id = ${a.stack_id} and r.quiesce_state is not null order by r.started_at desc limit 1`);
            const qr = q.rows[0] as {quiesce_state: QuiesceState; quiesce_stopped_at: Date | null; quiesce_max_stop_seconds: number} | undefined;
            const qa = quiesceAlert(qr ? {state: qr.quiesce_state, stoppedAt: qr.quiesce_stopped_at ? new Date(qr.quiesce_stopped_at) : null, maxStopSeconds: qr.quiesce_max_stop_seconds} : null, now);
            const all: Condition[] = [...conditions, {kind: "stack.quiesce_stopped", holds: qa.active, hours: null}];
            for (const c of all) {
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
                            payload: {state: c.kind === "stack.partial" ? "partial" : c.kind === "stack.quiesce_stopped" ? "stopped" : "no_good_backup", stackId: a.stack_id, link: `/dashboard/stacks/${a.stack_id}`, ...(c.hours !== null ? {hours: c.hours} : {}),
                                ...(c.kind === "stack.quiesce_stopped" && qa.since ? {since: new Date(Math.floor(qa.since.getTime() / 60_000) * 60_000).toISOString()} : {})},
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
