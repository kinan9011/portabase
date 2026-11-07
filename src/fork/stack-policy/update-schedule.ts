import {eq} from "drizzle-orm";
import {z} from "zod";
import {recordAudit} from "@/fork/audit";
import {forkStackPolicy} from "@/fork/db/schema/stack";
import {withForkLock} from "@/fork/locks";
import {authorizeMutation, type MaterializeDeps} from "@/fork/materialize/apply";
import {RetentionPolicySchema} from "@/fork/recovery/retention-policy";
import {nextRuns, ScheduleSchema, toCron} from "@/fork/schedule/schedule";
import {touchScheduleState} from "@/fork/schedule-state";

/**
 * Edit the schedule and retention of an ACTIVATED stack policy (W13, D31 controlled UI copies; nothing else is touched).
 *   strict input → principal → resource-scoped `stacks.backup.manage` (system admin; foreign/missing id ⇒ identical `not_found`) → D21 gate
 *   (`locked` while the self-check fails) → rate limit → active-policy check → ONE transaction under the per-stack materialize lock → audit.
 * It is NOT an activation: sources are not re-materialised, the D31 authorization record is not rewritten and a pause (F7) is NOT cleared — only a
 * full re-activation by an authorized user does that. The scheduler's reference is moved to the edit time so the new schedule never back-fills slots
 * that "would have been due" under it (ARCH-17: no backlog replay).
 */
/** Key-order-independent JSON (jsonb does not keep the order the object was written in). */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
const EditScheduleInputSchema = z.strictObject({stackId: z.uuid(), schedule: ScheduleSchema, retention: RetentionPolicySchema});

export type EditScheduleResult =
    | {ok: true; cron: string; nextRuns: string[]; noop: boolean; paused: boolean}
    | {ok: false; code: "forbidden" | "not_found" | "locked" | "rate_limited" | "invalid_input" | "refused"; reason?: "no_active_policy"; message: string; retryAfterSeconds?: number; fieldErrors?: {path: string; code: string}[]};

export async function updateStackSchedule(d: MaterializeDeps, raw: unknown): Promise<EditScheduleResult> {
    const parsed = EditScheduleInputSchema.safeParse(raw);
    if (!parsed.success) {
        // paths + codes only: never the offending value
        return {ok: false, code: "invalid_input", message: "Check the values you entered.", fieldErrors: parsed.error.issues.slice(0, 20).map((i) => ({path: i.path.join("."), code: i.code === "custom" ? i.message : i.code}))};
    }
    const input = parsed.data;
    const auth = await authorizeMutation(d, "fork.stack_policy.edit_schedule", input.stackId, "stack-schedule");
    if (!("organizationId" in auth)) return auth as EditScheduleResult;
    const {organizationId} = auth;
    const p = d.principal!;
    const now = d.now?.() ?? new Date();
    const audit = (result: "success" | "denied", details: Record<string, unknown>, db: MaterializeDeps["db"] = d.db) =>
        recordAudit(db, {organizationId, actorUserId: p.userId, action: "fork.stack_policy.edit_schedule", resourceType: "stack", resourceId: input.stackId, result, details, now});

    return withForkLock(d.db, `materialize:${input.stackId}`, async (tx): Promise<EditScheduleResult> => {
        const [cur] = await tx.select({activatedAt: forkStackPolicy.activatedAt, deactivatedAt: forkStackPolicy.deactivatedAt, schedule: forkStackPolicy.schedule, policy: forkStackPolicy.policy, pausedAt: forkStackPolicy.pausedAt})
            .from(forkStackPolicy).where(eq(forkStackPolicy.stackId, input.stackId));
        if (!cur?.activatedAt || cur.deactivatedAt) {
            await audit("denied", {reason: "no_active_policy"}, tx);
            return {ok: false, code: "refused", reason: "no_active_policy", message: "This stack has no active backup policy to edit. Configure and activate one first."};
        }
        const same = canon(cur.schedule) === canon(input.schedule) && canon(cur.policy) === canon(input.retention);
        const cron = toCron(input.schedule);
        const next = nextRuns(input.schedule, now, 3).map((x) => x.toISOString());
        if (same) return {ok: true, cron, nextRuns: next, noop: true, paused: cur.pausedAt !== null};
        await tx.update(forkStackPolicy).set({schedule: input.schedule, policy: input.retention, updatedAt: now}).where(eq(forkStackPolicy.stackId, input.stackId));
        await touchScheduleState(tx, input.stackId, {lastScheduledAt: now});
        // numbers and the preset name only: no free text can reach the audit chain
        await audit("success", {schedulePreset: input.schedule.preset, timezone: input.schedule.timezone, retentionKeepLast: input.retention.keep_last, daily: input.retention.daily, weekly: input.retention.weekly, monthly: input.retention.monthly, yearly: input.retention.yearly}, tx);
        return {ok: true, cron, nextRuns: next, noop: false, paused: cur.pausedAt !== null};
    });
}
