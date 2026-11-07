import {eq} from "drizzle-orm";
import {z} from "zod";
import {ForkForbiddenError, ForkNotFoundError, type ForkPrincipal} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {forkStackRun} from "@/fork/db/schema/runs";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkResource} from "@/fork/resource-scope";
import {nowOf, type RunDeps} from "./deps";
import {cancelRun} from "./service";
import {startRun, type StartRefusal} from "./start";
import type {PauseReason} from "./vocab";

/**
 * Operator entry points for runs (W12): "Back up now" / "Run first backup" and "Cancel run". ONE pipeline, same guarantees as the other
 * fork actions: signed-in principal → resource-scoped capability `backup.run` (organization owner/admin; a foreign or missing id is the
 * identical `not_found`, SEC-12) → rate limit → the service (which re-authorizes the ACTIVATION record, F7) → audit. A manual run is NOT
 * a configuration change, so it is allowed while configuration is locked (degraded mode keeps protecting); only mode `off` refuses.
 */
export type RunDepsWithPrincipal = RunDeps & {principal: ForkPrincipal | null; rate?: typeof checkRate};
export const START_RATE = {limit: 6, windowMs: 60_000} as const;
const StartInput = z.strictObject({stackId: z.uuid()});
const CancelInput = z.strictObject({runId: z.uuid()});

export type RunActionResult =
    | {ok: true; runId: string}
    | {ok: false; code: StartRefusal | "forbidden" | "rate_limited" | "invalid_input" | "busy" | "not_active"; reason?: PauseReason; retryAfterSeconds?: number};

export async function startStackRun(d: RunDepsWithPrincipal, raw: unknown): Promise<RunActionResult> {
    const input = StartInput.safeParse(raw);
    if (!input.success) return {ok: false, code: "invalid_input"};
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const audit = (organizationId: string | null, result: "denied", details: Record<string, unknown>) =>
        recordAudit(d.db, {organizationId, actorUserId: p.userId, action: "fork.stack_run.start", resourceType: "stack", resourceId: input.data.stackId, result, details, now: nowOf(d)});
    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(d.db, p, "backup.run", {kind: "stack", id: input.data.stackId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) { await audit(null, "denied", {reason: "not-found"}); return {ok: false, code: "not_found"}; }
        if (e instanceof ForkForbiddenError) { await audit(null, "denied", {reason: "forbidden"}); return {ok: false, code: "forbidden"}; }
        throw e;
    }
    const rate = (d.rate ?? checkRate)(`${p.userId}:run-start`, START_RATE.limit, START_RATE.windowMs, nowOf(d).getTime());
    if (!rate.ok) { await audit(organizationId, "denied", {reason: "rate-limited"}); return {ok: false, code: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds}; }
    const r = await startRun(d, {stackId: input.data.stackId, trigger: "manual", userId: p.userId});
    if (r.kind === "started" || r.kind === "exists") return {ok: true, runId: r.runId};
    await audit(organizationId, "denied", {reason: r.code, ...(r.reason ? {pause: r.reason} : {})});
    return {ok: false, code: r.code, ...(r.reason ? {reason: r.reason} : {})};
}

export async function cancelStackRun(d: RunDepsWithPrincipal, raw: unknown): Promise<{ok: true; cancelledWaiting: number} | {ok: false; code: "not_found" | "forbidden" | "invalid_input" | "busy" | "not_active"}> {
    const input = CancelInput.safeParse(raw);
    if (!input.success) return {ok: false, code: "invalid_input"};
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(d.db, p, "backup.run", {kind: "stack_run", id: input.data.runId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found"};
        if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden"};
        throw e;
    }
    const [run] = await d.db.select({id: forkStackRun.id}).from(forkStackRun).where(eq(forkStackRun.id, input.data.runId));
    if (!run) return {ok: false, code: "not_found"};
    const r = await cancelRun(d, input.data.runId, {userId: p.userId, organizationId});
    return r.ok ? r : {ok: false, code: r.code === "not_found" ? "not_found" : r.code};
}
