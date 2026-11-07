import {sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import {forkStackRun} from "@/fork/db/schema/runs";
import {withForkLock} from "@/fork/locks";
import {enqueueForkNotification} from "@/fork/notify";
import {touchScheduleState} from "@/fork/schedule-state";
import {cfgOf, modeOf, nowOf, type RunDeps} from "./deps";
import {initialSteps} from "./engine";
import {loadStackFacts, pausePolicy, reauthorize, type StackFacts} from "./reauth";
import {RUN_STEPS, type PauseReason, type RunTrigger} from "./vocab";

/**
 * Starts (or skips) a run. The run row is created ONLY after re-authorization (F7) and the capacity check; the step engine
 * (`service.ts`) does everything else. Idempotency is DB-enforced: ≤ 1 active run per stack (partial unique index) and one row per
 * scheduled slot — a double click, a second replica or a retried tick can only ever produce one run.
 */
export type StartRefusal = "off" | "not_found" | "not_active" | "paused" | "reauth_failed" | "capacity" | "already_running";
export type StartResult =
    | {kind: "started"; runId: string}
    | {kind: "exists"; runId: string} // the scheduled slot already has its row (retry)
    | {kind: "refused"; code: StartRefusal; reason?: PauseReason; scope?: "agent" | "org"};

const isUnique = (e: unknown, constraint: string): boolean => {
    const x = e as {code?: string; constraint?: string; cause?: {code?: string; constraint?: string}};
    const c = x?.cause ?? x;
    return c?.code === "23505" && (c.constraint === constraint || (x?.constraint ?? "") === constraint);
};

/** Active runs on the same host agent / in the same organization (the agent has unlimited parallelism, §13 A12). */
export async function capacityCheck(d: RunDeps, facts: StackFacts): Promise<{ok: true} | {ok: false; scope: "agent" | "org"}> {
    const cfg = cfgOf(d);
    const r = await d.db.execute(sql`
        select count(*) filter (where e.agent_id is not distinct from ${facts.agentId} and ${facts.agentId}::uuid is not null)::int as per_agent,
               count(*)::int as per_org
          from fork_stack_run r join fork_stack s on s.id = r.stack_id left join fork_arcane_environment e on e.id = s.environment_id
         where r.state in ('starting','running','finalizing') and s.organization_id = ${facts.organizationId}`);
    const row = r.rows[0] as {per_agent: number; per_org: number};
    if (Number(row.per_agent) >= cfg.maxPerAgent) return {ok: false, scope: "agent"};
    if (Number(row.per_org) >= cfg.maxPerOrg) return {ok: false, scope: "org"};
    return {ok: true};
}

export async function startRun(d: RunDeps, i: {stackId: string; trigger: RunTrigger; scheduledFor?: Date; userId?: string | null}): Promise<StartResult> {
    if ((await modeOf(d)) === "off") return {kind: "refused", code: "off"};
    const facts = await loadStackFacts(d.db, i.stackId);
    if (!facts) return {kind: "refused", code: "not_found"};
    const auth = await reauthorize(d, facts, "stacks.backup.manage");
    if (!auth.ok) {
        if (auth.kind === "denied") {
            await pausePolicy(d, facts, auth.reason);
            return {kind: "refused", code: "reauth_failed", reason: auth.reason};
        }
        return {kind: "refused", code: auth.kind};
    }
    const cap = await capacityCheck(d, facts);
    if (!cap.ok) return {kind: "refused", code: "capacity", scope: cap.scope};

    const now = nowOf(d);
    try {
        const runId = await withForkLock(d.db, `run-start:${i.stackId}`, async (tx) => {
            const [row] = await tx.insert(forkStackRun).values({
                stackId: i.stackId, trigger: i.trigger, state: "starting", scheduledFor: i.scheduledFor ?? null, triggeredBy: i.userId ?? null,
                steps: initialSteps(RUN_STEPS), startedAt: now, updatedAt: now, deadlineAt: new Date(now.getTime() + cfgOf(d).maxRunMs),
            }).returning({id: forkStackRun.id});
            await recordAudit(tx, {organizationId: facts.organizationId, actorUserId: i.userId ?? null, actorKind: i.userId ? "user" : "system", action: "fork.stack_run.start", resourceType: "stack_run", resourceId: row.id, result: "success", details: {trigger: i.trigger, stackId: i.stackId}, now});
            await touchScheduleState(tx, i.stackId, {lastRunStartedAt: now, lastRunStatus: "running", ...(i.scheduledFor ? {lastScheduledAt: i.scheduledFor} : {})});
            return row.id;
        });
        return {kind: "started", runId};
    } catch (e) {
        if (isUnique(e, "fork_stack_run_one_active_uq")) return {kind: "refused", code: "already_running"};
        if (isUnique(e, "fork_stack_run_slot_uq")) {
            const r = await d.db.execute(sql`select id from fork_stack_run where stack_id = ${i.stackId} and scheduled_for = ${i.scheduledFor ?? null} limit 1`);
            const id = (r.rows[0] as {id: string} | undefined)?.id;
            if (id) return {kind: "exists", runId: id};
        }
        throw e;
    }
}

/** ARCH-17: a slot that could not start is a ROW (idempotent per slot), audited and alerted — never a silent gap. Returns false if the slot was already recorded. */
export async function recordSkippedSlot(d: RunDeps, facts: StackFacts, slot: Date, reason: "overlap" | "missed"): Promise<boolean> {
    const now = nowOf(d);
    return withForkLock(d.db, `run-start:${facts.stackId}`, async (tx) => {
        const ins = await tx.insert(forkStackRun).values({
            stackId: facts.stackId, trigger: "schedule", state: "skipped", scheduledFor: slot, skipReason: reason, startedAt: now, finishedAt: now, updatedAt: now, steps: [],
        }).onConflictDoNothing().returning({id: forkStackRun.id});
        await touchScheduleState(tx, facts.stackId, {lastScheduledAt: slot});
        if (ins.length === 0) return false;
        await recordAudit(tx, {organizationId: facts.organizationId, actorKind: "system", action: "fork.stack_run.skipped", resourceType: "stack_run", resourceId: ins[0].id, result: "denied", details: {reason, slot: slot.toISOString()}, now});
        await enqueueForkNotification(tx, {kind: "run.skipped", dedupeKey: `run_skipped:${facts.stackId}:${slot.toISOString()}`, payload: {state: "skipped", reason, stackId: facts.stackId, link: `/dashboard/stacks/${facts.stackId}`}});
        return true;
    });
}
