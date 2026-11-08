import {and, eq} from "drizzle-orm";
import {z} from "zod";
import type {Enrollment} from "@/fork/agent-channel/auth";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkStackRun} from "@/fork/db/schema/runs";
import {withForkLock} from "@/fork/locks";
import {isActiveRunState} from "@/fork/runs/vocab";
import {MAX_TARGETS} from "./vocab";

const Body = z.strictObject({
    lease_id: z.uuid(),
    phase: z.enum(["stopped", "waiting"]),
    containers: z.array(z.strictObject({service: z.string().max(128), id12: z.string().regex(/^[0-9a-f]{12}$/), was_running: z.boolean()})).max(MAX_TARGETS).optional(),
});

export type QuiesceProgressResult = {ok: true; release: boolean} | {ok: false; status: 400 | 404 | 409; code: string};

/**
 * The agent's window progress call (D7). Bound to the task AND its lease (409 otherwise), renews the lease like a heartbeat, records the FIRST `stopped`
 * (dashboard receive time = "stopped since", no agent clock) and answers `release`. Fail-safe: no run / run no longer waiting ⇒ `release: true`, so the
 * containers always come back. Runs on the runtime plane: it keeps working while the fork is locked.
 */
export async function reportQuiesceProgress(db: ForkDb, e: Enrollment, a: {taskId: string; body: unknown; leaseSeconds: number; now?: Date}): Promise<QuiesceProgressResult> {
    const now = a.now ?? new Date();
    const parsed = Body.safeParse(a.body);
    if (!parsed.success || !z.uuid().safeParse(a.taskId).success) return {ok: false, status: 400, code: "invalid_input"};
    const b = parsed.data;
    return withForkLock(db, `agent-task:${e.agentId}`, async (tx) => {
        const [t] = await tx.select().from(forkAgentTask).where(and(eq(forkAgentTask.id, a.taskId), eq(forkAgentTask.agentId, e.agentId!), eq(forkAgentTask.enrollId, e.enrollId)));
        if (!t || t.type !== "quiesce") return {ok: false as const, status: 404 as const, code: "not_found"};
        if (!["leased", "running"].includes(t.status) || t.leaseId !== b.lease_id || !t.leaseUntil || t.leaseUntil < now) return {ok: false as const, status: 409 as const, code: "lease_mismatch"};
        await tx.update(forkAgentTask).set({status: "running", leaseUntil: new Date(now.getTime() + a.leaseSeconds * 1000)}).where(eq(forkAgentTask.id, t.id));
        const [run] = await tx.select().from(forkStackRun).where(eq(forkStackRun.quiesceTaskId, t.id));
        if (!run) return {ok: true as const, release: true}; // fail-safe
        if (b.phase === "stopped" && run.quiesceState === "requested") {
            await tx.update(forkStackRun).set({quiesceState: "stopped", quiesceStoppedAt: now, quiesceResult: {containers_reported: b.containers ?? []}, updatedAt: now}).where(eq(forkStackRun.id, run.id));
        }
        const waiting = run.quiesceState === "requested" || run.quiesceState === "stopped";
        return {ok: true as const, release: !waiting || run.quiesceReleaseAt !== null || !isActiveRunState(run.state)};
    });
}
