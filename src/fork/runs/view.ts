import {z} from "zod";
import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {RpStatusSchema} from "@/fork/recovery/status";
import {runConfig, type RunConfig} from "./config";
import {ACTIVE_RUN_STATES, PAUSE_REASONS, REFRESH_OUTCOMES, RUN_REASONS, RUN_STATES, RUN_TRIGGERS, SKIP_REASONS} from "./vocab";

/**
 * Read model of the stack's runs for the Schedule tab and the actions (W12). Strict DTO: states, codes, times and the RP sequence/status only —
 * never an id of an upstream row, a path, a name, a key or a raw error (the sentences live in `ui/labels.ts`). Polling-only (CH-32).
 */
export const RunViewSchema = z.strictObject({
    limits: z.strictObject({waitMinutes: z.number().int().min(1), stallMinutes: z.number().int().min(1)}),
    active: z.strictObject({id: z.uuid(), state: z.enum(RUN_STATES), startedAt: z.string()}).nullable(),
    latest: z.strictObject({
        state: z.enum(RUN_STATES), trigger: z.enum(RUN_TRIGGERS), startedAt: z.string(), finishedAt: z.string().nullable(),
        reason: z.enum(RUN_REASONS).nullable(), skipReason: z.enum(SKIP_REASONS).nullable(), validatorBlocked: z.boolean(), inventoryRefresh: z.enum(REFRESH_OUTCOMES).nullable(),
        rp: z.strictObject({sequence: z.number().int(), status: RpStatusSchema, reason: z.string().nullable()}).nullable(),
    }).nullable(),
    paused: z.strictObject({reason: z.enum(PAUSE_REASONS), at: z.string()}).nullable(),
});
export type RunView = z.infer<typeof RunViewSchema>;

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function loadRunView(db: ForkDb, stackId: string, cfg: RunConfig = runConfig()): Promise<RunView> {
    const act = await db.execute(sql`select id, state, started_at from fork_stack_run where stack_id = ${stackId} and state in ('starting','running','finalizing') limit 1`);
    const last = await db.execute(sql`
        select r.state, r.trigger, r.started_at, r.finished_at, r.reason, r.skip_reason, r.validator_blocked, r.inventory_refresh,
               p.sequence, p.status as rp_status, p.downgrade_reason
          from fork_stack_run r left join fork_recovery_point p on p.run_id = r.id
         where r.stack_id = ${stackId} order by r.started_at desc, r.scheduled_for desc nulls last limit 1`);
    const pol = await db.execute(sql`select paused_at, pause_reason from fork_stack_policy where stack_id = ${stackId} and paused_at is not null`);
    const a = act.rows[0] as {id: string; state: string; started_at: string} | undefined;
    const l = last.rows[0] as Record<string, unknown> | undefined;
    const p = pol.rows[0] as {paused_at: string; pause_reason: string} | undefined;
    return RunViewSchema.parse({
        limits: {waitMinutes: Math.max(1, Math.round(cfg.waitTimeoutMs / 60_000)), stallMinutes: Math.max(1, Math.round(cfg.stallTimeoutMs / 60_000))},
        active: a && (ACTIVE_RUN_STATES as readonly string[]).includes(a.state) ? {id: a.id, state: a.state, startedAt: iso(a.started_at)} : null,
        latest: l ? {
            state: l.state, trigger: l.trigger, startedAt: iso(l.started_at), finishedAt: iso(l.finished_at), reason: l.reason ?? null, skipReason: l.skip_reason ?? null,
            validatorBlocked: l.validator_blocked, inventoryRefresh: l.inventory_refresh ?? null,
            rp: l.sequence !== null && l.sequence !== undefined ? {sequence: Number(l.sequence), status: l.rp_status, reason: l.downgrade_reason ?? null} : null,
        } : null,
        paused: p ? {reason: p.pause_reason, at: iso(p.paused_at)} : null,
    });
}
