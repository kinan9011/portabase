import {sql} from "drizzle-orm";
import {ScheduleSchema} from "@/fork/schedule/schedule";
import {cfgOf, modeOf, nowOf, type RunDeps} from "./deps";
import {loadStackFacts, isActivePolicy} from "./reauth";
import {decideSlot} from "./schedule-due";
import {recordSkippedSlot, startRun} from "./start";

/**
 * The dashboard-held stack schedule (D14): fork cron semantics over `fork_stack_policy.schedule` (timezone aware).
 * Due-ness comes from the DATABASE (`last_scheduled_at`, `activated_at`), never from an in-memory timer, so after downtime there is
 * ONE catch-up decision, never a backlog (ARCH-10). Every tick re-reads the cached mode: `locked` keeps running (ADR-010 degraded
 * mode: scheduled runs are protective work); only `off` stops. Never throws for one stack: a bad policy cannot stop the others.
 */
export type SchedulerResult = {considered: number; started: number; skipped: number; waiting: number; refused: number; failed: number};

export async function schedulerTick(d: RunDeps): Promise<SchedulerResult> {
    const out: SchedulerResult = {considered: 0, started: 0, skipped: 0, waiting: 0, refused: 0, failed: 0};
    if ((await modeOf(d)) === "off") return out;
    const now = nowOf(d);
    const rows = await d.db.execute(sql`
        select p.stack_id from fork_stack_policy p join fork_stack s on s.id = p.stack_id
         where p.activated_at is not null and p.deactivated_at is null and p.paused_at is null and s.protection_state = 'active'`);
    for (const r of rows.rows as {stack_id: string}[]) {
        out.considered++;
        try {
            const facts = await loadStackFacts(d.db, r.stack_id);
            if (!facts || !isActivePolicy(facts)) continue;
            const parsed = ScheduleSchema.safeParse(facts.schedule);
            if (!parsed.success) { out.failed++; continue; } // an invalid stored schedule never runs (and never throws)
            const last = await d.db.execute(sql`select last_scheduled_at from fork_schedule_state where stack_id = ${r.stack_id}`);
            const st = last.rows[0] as {last_scheduled_at: string | null} | undefined;
            const activeRun = (await d.db.execute(sql`select 1 from fork_stack_run where stack_id = ${r.stack_id} and state in ('starting','running','finalizing') limit 1`)).rows.length > 0;
            const from = new Date(Math.max(facts.activatedAt?.getTime() ?? 0, st?.last_scheduled_at ? new Date(st.last_scheduled_at).getTime() : 0));
            const decision = decideSlot({schedule: parsed.data, from, now, windowMs: cfgOf(d).captureWindowMs, activeRun});
            if (decision.kind === "none") continue;
            if (decision.kind === "skip") {
                if (await recordSkippedSlot(d, facts, decision.slot, decision.reason)) out.skipped++;
                continue;
            }
            const res = await startRun(d, {stackId: r.stack_id, trigger: "schedule", scheduledFor: decision.slot});
            if (res.kind === "started") out.started++;
            else if (res.kind === "refused" && res.code === "capacity") out.waiting++; // the slot stays eligible until the capture window ends, then it is a missed slot
            else if (res.kind === "refused") out.refused++;
        } catch {
            out.failed++;
        }
    }
    return out;
}
