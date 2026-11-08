import {and, eq, inArray, isNotNull, or, sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkStackRun} from "@/fork/db/schema/runs";
import {forkStack} from "@/fork/db/schema/stack";
import {enqueueForkNotification} from "@/fork/notify";
import {QuiesceResultSchema, type QuiesceResult} from "./payload";
import {QUIESCE_AGENT_CODES, QUIESCE_REASONS, type QuiesceReason, type QuiesceState} from "./vocab";

/**
 * W17b reconcile (D8): the agent's task result → the run's `quiesce_*` columns. Safe to call any number of times and after the run was finalized
 * (the evaluator does): every transition is written once (audit + notification dedupe keys carry the run id and state). Parsing is defensive on purpose:
 * `quiesce_result` is `redactDetails(agentResult + reason)`, possibly `{truncated:true}`; the top-level summary fields are authoritative over `containers`.
 */
type TaskRow = {status: string; result: unknown};
export type Interpreted = {state: QuiesceState; reason: QuiesceReason | null; windowIntact: boolean | null; result: QuiesceResult | null; notify: boolean};

const REFUSALS: readonly string[] = [...QUIESCE_AGENT_CODES.filter((c) => !["stop_failed", "restart_unverified", "quiesce_interrupted"].includes(c)), "protected_container", "docker_unavailable", "payload_invalid"];
const asReason = (s: string | undefined): QuiesceReason => ((QUIESCE_REASONS as readonly string[]).includes(s ?? "") ? s : "execution_error") as QuiesceReason;

export function interpretTask(t: TaskRow, kind: "quiesce" | "start"): Interpreted | "pending" {
    if (["queued", "leased", "running"].includes(t.status)) return "pending";
    const parsed = QuiesceResultSchema.safeParse(t.result ?? {});
    const r: QuiesceResult | null = parsed.success ? parsed.data : null;
    const reason = r?.reason;
    const known = r !== null && r.all_verified !== undefined; // a real summary (agent result or journal recovery)
    if (t.status === "succeeded") {
        if (kind === "start") return {state: "restarted", reason: null, windowIntact: null, result: r, notify: false};
        return known && r!.all_verified === false ? {state: "restart_failed", reason: "restart_unverified", windowIntact: r!.window_intact ?? null, result: r, notify: true}
            : {state: "restarted", reason: null, windowIntact: r?.window_intact ?? null, result: r, notify: r?.released_by === "deadline"};
    }
    if (t.status === "expired") return {state: "not_started", reason: "expired", windowIntact: null, result: r, notify: true};
    if (t.status === "cancelled") return {state: "not_started", reason: "agent_did_not_start", windowIntact: null, result: r, notify: true};
    if (t.status === "rejected") return {state: "refused", reason: reason === "capability_missing" ? "capability_missing_at_lease" : asReason(reason), windowIntact: null, result: r, notify: true};
    // failed
    if (reason === "restart_unverified") return {state: "restart_failed", reason: "restart_unverified", windowIntact: r?.window_intact ?? null, result: r, notify: true};
    if (reason === "stop_failed") return {state: "stop_failed", reason: "stop_failed", windowIntact: false, result: r, notify: true};
    if (reason === "quiesce_interrupted" || reason === "deadline_exceeded" || reason === "execution_error" || reason === "lease_lost") {
        if (known) return r!.all_verified ? {state: "restarted", reason: asReason(reason), windowIntact: false, result: r, notify: true} : {state: "restart_failed", reason: asReason(reason), windowIntact: false, result: r, notify: true};
        return {state: kind === "start" ? "restart_failed" : "unconfirmed", reason: asReason(reason), windowIntact: false, result: r, notify: true};
    }
    if (reason && REFUSALS.includes(reason)) return {state: "refused", reason: asReason(reason), windowIntact: null, result: r, notify: true};
    return {state: "unconfirmed", reason: asReason(reason), windowIntact: null, result: r, notify: true};
}

export async function reconcileQuiesce(db: ForkDb, runId: string, now: Date): Promise<"pending" | "updated" | "unchanged"> {
    const [run] = await db.select().from(forkStackRun).where(eq(forkStackRun.id, runId));
    if (!run?.quiesceTaskId || !run.quiesceState) return "unchanged";
    const ids = [run.quiesceTaskId, ...(run.quiesceStartTaskId ? [run.quiesceStartTaskId] : [])];
    const tasks = await db.select({id: forkAgentTask.id, status: forkAgentTask.status, result: forkAgentTask.result}).from(forkAgentTask).where(inArray(forkAgentTask.id, ids));
    const main = tasks.find((t) => t.id === run.quiesceTaskId);
    const start = run.quiesceStartTaskId ? tasks.find((t) => t.id === run.quiesceStartTaskId) : undefined;
    if (!main) return "unchanged";
    let it = interpretTask(main, "quiesce");
    // a finished "Start now" retry supersedes a restart failure / unconfirmed outcome of the original task (keeps its window_intact)
    if (it !== "pending" && start && ["restart_failed", "unconfirmed", "stop_failed"].includes(it.state)) {
        const s = interpretTask(start, "start");
        if (s !== "pending" && s.state === "restarted") it = {...it, state: "restarted", reason: null, notify: false};
    }
    if (it === "pending") return "pending";
    // idempotent: the final outcome is already stored (a stored result without `containers_reported` is the agent's final one)
    const stored = run.quiesceResult as Record<string, unknown> | null;
    if (run.quiesceState === it.state && run.quiesceReason === it.reason && stored !== null && !("containers_reported" in stored)) return "unchanged";
    const [stack] = await db.select({organizationId: forkStack.organizationId}).from(forkStack).where(eq(forkStack.id, run.stackId));
    const result = it.result ? {...it.result} : {};
    await db.update(forkStackRun).set({quiesceState: it.state, quiesceReason: it.reason, quiesceResult: result, updatedAt: now}).where(eq(forkStackRun.id, runId));
    await recordAudit(db, {organizationId: stack?.organizationId ?? null, actorKind: "system", action: "fork.quiesce.result", resourceType: "stack_run", resourceId: runId, result: it.state === "restarted" ? "success" : "denied", now,
        details: {runId, stackId: run.stackId, taskId: run.quiesceTaskId, state: it.state, reason: it.reason, releasedBy: it.result?.released_by ?? null, windowIntact: it.windowIntact, downtimeMs: it.result?.downtime_ms ?? null,
            containers: (it.result?.containers ?? []).map((c) => ({service: c.service, outcome: c.outcome}))}});
    if (it.notify) await notifyQuiesce(db, run.stackId, runId, it.state === "restarted" ? "deadline" : it.state, it.reason);
    return "updated";
}

export async function notifyQuiesce(db: ForkDb, stackId: string, runId: string, state: string, reason: string | null): Promise<void> {
    await enqueueForkNotification(db, {kind: "quiesce.failed", dedupeKey: `quiesce.failed:${runId}:${state}`, payload: {state, ...(reason ? {reason} : {}), stackId, link: `/dashboard/stacks/${stackId}`}});
}

/** Runs whose quiesce outcome may still change: waiting for the agent, unconfirmed / failed (a late result or a Start now retry may follow). */
export async function reconcileOpenQuiesces(db: ForkDb, now: Date): Promise<number> {
    const rows = await db.select({id: forkStackRun.id}).from(forkStackRun).where(and(isNotNull(forkStackRun.quiesceTaskId),
        or(inArray(forkStackRun.quiesceState, ["requested", "stopped", "unconfirmed", "restart_failed", "stop_failed"]), sql`${forkStackRun.quiesceStartTaskId} IS NOT NULL AND ${forkStackRun.quiesceState} <> 'restarted'`)));
    let n = 0;
    for (const r of rows) if ((await reconcileQuiesce(db, r.id, now)) === "updated") n++;
    return n;
}
