import {z} from "zod";
import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {RpStatusSchema} from "@/fork/recovery/status";
import {ITEM_STATES, REFRESH_OUTCOMES, RUN_REASONS, RUN_STATES, RUN_STEPS, RUN_TRIGGERS, SKIP_REASONS, STEP_STATES} from "@/fork/runs/vocab";

/**
 * Read model of the Activity tab (W13): the stack's recent runs from DURABLE rows only (a reload shows exactly the same, UX-13), each with its
 * persisted engine steps and member items. Everything is a closed code or a time: sentences live in `ui/labels.ts`, so no raw error, path, key or
 * upstream id can appear. The run id is the reference id shown for support (no HTTP request id exists; the audit chain stays server-side).
 */
export const ACTIVITY_LIMIT = 20;

export const ActivityRunSchema = z.strictObject({
    id: z.uuid(),
    trigger: z.enum(RUN_TRIGGERS),
    state: z.enum(RUN_STATES),
    skipReason: z.enum(SKIP_REASONS).nullable(),
    reason: z.enum(RUN_REASONS).nullable(),
    validatorBlocked: z.boolean(),
    inventoryRefresh: z.enum(REFRESH_OUTCOMES).nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    steps: z.array(z.strictObject({
        name: z.enum(RUN_STEPS), status: z.enum(STEP_STATES), attempts: z.number().int().min(0),
        startedAt: z.string().nullable(), finishedAt: z.string().nullable(), code: z.enum(RUN_REASONS).nullable(),
    })).max(20),
    items: z.array(z.strictObject({
        source: z.string().max(255), dbms: z.string().max(64), state: z.enum(ITEM_STATES), reason: z.enum(RUN_REASONS).nullable(),
        startedAt: z.string().nullable(), finishedAt: z.string().nullable(), required: z.boolean(),
    })).max(500),
    rp: z.strictObject({sequence: z.number().int(), status: RpStatusSchema}).nullable(),
});
export type ActivityRun = z.infer<typeof ActivityRunSchema>;

export const ActivityViewSchema = z.strictObject({
    runs: z.array(ActivityRunSchema).max(ACTIVITY_LIMIT),
    total: z.number().int().min(0),
    /** The step the active run is on (for the single status region), or null. */
    activeStage: z.enum(RUN_STEPS).nullable(),
});
export type ActivityView = z.infer<typeof ActivityViewSchema>;

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const known = <T extends readonly string[]>(list: T, v: unknown): T[number] | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? v : null);

type StepJson = {name?: unknown; status?: unknown; attempts?: unknown; startedAt?: unknown; finishedAt?: unknown; code?: unknown};

export async function loadActivityView(db: ForkDb, organizationId: string, stackId: string): Promise<ActivityView | null> {
    const own = await db.execute(sql`select 1 from fork_stack where id = ${stackId} and organization_id = ${organizationId}`);
    if (own.rows.length === 0) return null;
    const runs = (await db.execute(sql`
        select r.id, r.trigger, r.state, r.skip_reason, r.reason, r.validator_blocked, r.inventory_refresh, r.started_at, r.finished_at, r.steps, p.sequence, p.status as rp_status
          from fork_stack_run r left join fork_recovery_point p on p.run_id = r.id
         where r.stack_id = ${stackId} order by r.started_at desc, r.id desc limit ${ACTIVITY_LIMIT}`)).rows as Record<string, any>[];
    const total = ((await db.execute(sql`select count(*)::int as n from fork_stack_run where stack_id = ${stackId}`)).rows[0] as {n: number}).n;
    const ids = runs.map((r) => r.id as string);
    const items = ids.length === 0 ? [] : (await db.execute(sql`
        select run_id, source_name, dbms, state, reason, started_at, finished_at, required from fork_stack_run_item
         where run_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) order by queued_at nulls last, source_name, id`)).rows as Record<string, any>[];

    const out = runs.map((r) => {
        const stepsRaw = Array.isArray(r.steps) ? (r.steps as StepJson[]) : [];
        return ActivityRunSchema.parse({
            id: r.id, trigger: r.trigger, state: r.state, skipReason: r.skip_reason ?? null, reason: r.reason ?? null, validatorBlocked: r.validator_blocked, inventoryRefresh: r.inventory_refresh ?? null,
            startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
            steps: stepsRaw.flatMap((s) => {
                const name = known(RUN_STEPS, s.name); const status = known(STEP_STATES, s.status);
                if (!name || !status) return [];
                return [{name, status, attempts: typeof s.attempts === "number" ? Math.max(0, Math.floor(s.attempts)) : 0, startedAt: typeof s.startedAt === "string" ? iso(s.startedAt) : null, finishedAt: typeof s.finishedAt === "string" ? iso(s.finishedAt) : null, code: known(RUN_REASONS, s.code)}];
            }),
            items: items.filter((i) => i.run_id === r.id).map((i) => ({source: i.source_name, dbms: i.dbms, state: i.state, reason: i.reason ?? null, startedAt: iso(i.started_at), finishedAt: iso(i.finished_at), required: i.required})),
            rp: r.sequence !== null && r.sequence !== undefined ? {sequence: Number(r.sequence), status: r.rp_status} : null,
        });
    });
    const active = out.find((r) => r.state === "starting" || r.state === "running" || r.state === "finalizing");
    const activeStage = active ? (active.steps.find((s) => s.status !== "done")?.name ?? null) : null;
    return ActivityViewSchema.parse({runs: out, total, activeStage});
}
