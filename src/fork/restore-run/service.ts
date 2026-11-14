import {randomUUID} from "node:crypto";
import {and, eq, inArray} from "drizzle-orm";
import {z} from "zod";
import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {TASK_REQUIRES} from "@/fork/agent-channel/vocab";
import {buildOverridesView} from "@/fork/config/service";
import {recordAudit} from "@/fork/audit";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {forkRestoreOverride} from "@/fork/db/schema/restore-override";
import {forkRestoreRun} from "@/fork/db/schema/restore-run";
import {withForkLock} from "@/fork/locks";
import {assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {buildPolicyApproval, groupOverrides, type BuildFailure} from "@/fork/policy/approval";
import {assertForkResource} from "@/fork/resource-scope";
import {workspaceOf} from "@/fork/restore-tasks/build";
import {approvalsOf, enqueueRestoreTask, type RestoreRefusalCode} from "@/fork/restore-tasks/enqueue";
import {latestRender, renderVerdict} from "@/fork/restore-tasks/render";
import {loadFreshPlan, loadPlanRow} from "@/fork/restore/service";
import {initialSteps} from "@/fork/runs/engine";
import {deriveSteps} from "./derive";
import {maxRunMsOf, nowOf, type RestoreRunDeps} from "./deps";
import {ACTIVE, journalRows, taskDeps} from "./steps";
import {restoreConfirmPhrase, STEP_TASK_TYPE, type JournalStep} from "./vocab";

/**
 * W18a services. ONE pipeline (like W16 / W17): signed-in principal → strict input → config lock → resource-scoped capability (SEC-12: unknown and
 * foreign resources are indistinguishable) → rate limit → work → audit. Denials are audited as `fork.restore_run.denied` with a closed `reason`.
 * Audit details hold ids, hashes, codes and counts: never a path, URL, manifest, payload, override value or service name.
 */
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const StartRestoreRunRequest = z.strictObject({planId: z.uuid(), planHash: hex64, confirm: z.string().max(200).optional(), acceptMissingInputs: z.boolean().optional()});
export const RunIdRequest = z.strictObject({runId: z.uuid()});
export const ApprovePolicyRequest = z.strictObject({
    runId: z.uuid(),
    confirmations: z.record(z.string().min(1).max(128), z.string().max(160)).refine((r) => Object.keys(r).length <= 500),
});

export const START_RATE = {limit: 10, windowMs: 60_000} as const;
export const POLICY_RATE = {limit: 20, windowMs: 60_000} as const;

export type StartRefusal = "forbidden" | "invalid_input" | "locked" | "rate_limited" | "not_found" | "stale" | "expired" | "hash_mismatch" | "plan_tampered" | "plan_blocked" | "approval_missing"
    | "mode_unsupported" | "confirmation_required" | "confirmation_mismatch" | "inputs_missing" | "not_enrolled" | "agent_disabled" | "capability_missing" | "already_running" | "plan_used";
export type ServiceRefusal<C extends string> = {ok: false; code: C; retryAfterSeconds?: number};

const allowed = (d: RestoreRunDeps): Promise<boolean> => (d.configAllowed ? d.configAllowed() : assertForkConfigAllowed().then(() => true, () => false));

type Gate = {ok: true; organizationId: string} | {ok: false; code: "not_found" | "forbidden"};
async function gate(d: RestoreRunDeps, cap: string, kind: "restore_plan" | "restore_run", id: string): Promise<Gate> {
    try {
        return {ok: true, organizationId: (await assertForkResource(d.db, d.principal, cap, {kind, id})).organizationId};
    } catch (e) {
        if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found"};
        if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden"};
        throw e;
    }
}

const denied = (d: RestoreRunDeps, resourceType: "restore_plan" | "restore_run", resourceId: string | null, orgId: string | null, reason: string, extra: Record<string, unknown> = {}) =>
    recordAudit(d.db, {organizationId: orgId, actorUserId: d.principal?.userId ?? null, action: "fork.restore_run.denied", resourceType, resourceId, result: "denied", details: {reason, ...extra}, now: nowOf(d)});

/** Postgres unique violation → constraint name (drizzle wraps the driver error in `cause`). */
function uniqueViolation(e: unknown): string | null {
    for (const x of [e, (e as {cause?: unknown} | null)?.cause]) {
        const o = x as {code?: unknown; constraint?: unknown} | null;
        if (o && o.code === "23505") return typeof o.constraint === "string" ? o.constraint : "";
    }
    return null;
}

// ---- start ----------------------------------------------------------------------------------------------------------------------------

/** `o` is INTERNAL (never parsed from `raw`): the W-TR scheduler / run-now service say who triggered the run and for which slot. */
export async function startRestoreRun(d: RestoreRunDeps, raw: unknown, o: {trigger?: "manual" | "schedule"; scheduledFor?: Date} = {}): Promise<{ok: true; runId: string} | ServiceRefusal<StartRefusal>> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const parsed = StartRestoreRunRequest.safeParse(raw);
    if (!parsed.success) { await denied(d, "restore_plan", null, null, "invalid_input"); return {ok: false, code: "invalid_input"}; }
    const {planId, planHash, confirm, acceptMissingInputs} = parsed.data;
    const refuse = async (code: StartRefusal, orgId: string | null, extra: Record<string, unknown> = {}): Promise<ServiceRefusal<StartRefusal>> => {
        await denied(d, "restore_plan", planId, orgId, code, {planHash, ...extra});
        return {ok: false, code};
    };
    if (!(await allowed(d))) return refuse("locked", null);
    const g = await gate(d, "restore.execute", "restore_plan", planId);
    if (!g.ok) return refuse(g.code, null);
    const now = nowOf(d);
    const rl = (d.rate ?? checkRate)(`restore-run-start:${p.userId}`, START_RATE.limit, START_RATE.windowMs, now.getTime());
    if (!rl.ok) { await denied(d, "restore_plan", planId, g.organizationId, "rate_limited", {planHash}); return {ok: false, code: "rate_limited", retryAfterSeconds: rl.retryAfterSeconds}; }

    const [used] = await d.db.select({id: forkRestoreRun.id}).from(forkRestoreRun).where(eq(forkRestoreRun.planId, planId)).limit(1);
    if (used) return refuse("plan_used", g.organizationId);
    const loaded = await loadFreshPlan({db: d.db, now: d.now, principal: p}, planId, planHash);
    if (!loaded.ok) return refuse((loaded.code === "forbidden" || loaded.code === "not_found" || loaded.code === "stale" || loaded.code === "expired" || loaded.code === "hash_mismatch" || loaded.code === "plan_tampered" ? loaded.code : "stale"), g.organizationId);
    const {row, plan} = loaded;
    if (plan.purpose === "mirror") return refuse("mode_unsupported", g.organizationId); // W22a: a mirror plan is only ever run by the mirror orchestrator
    if (plan.outcome !== "ready") return refuse("plan_blocked", g.organizationId);
    const approved = approvalsOf(row);
    if (!plan.approvals_required.every((a) => approved.includes(a.kind))) return refuse("approval_missing", g.organizationId);
    if (plan.mode === "existing_stack") return refuse("mode_unsupported", g.organizationId); // #145: in-place restore stays refused
    // D-10: the typed confirmation is bound to THIS plan hash (checked against the plan freshly loaded in this very request)
    const confirmation: "typed" | "not_required" = plan.approvals_required.length > 0 ? "typed" : "not_required";
    if (confirmation === "typed") {
        const typed = (confirm ?? "").trim();
        if (typed === "") return refuse("confirmation_required", g.organizationId);
        if (typed !== restoreConfirmPhrase(plan.target.project)) return refuse("confirmation_mismatch", g.organizationId);
    }
    // D-12: required inputs left empty are refused unless the operator accepted that explicitly (audited)
    const [ov] = await d.db.select().from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, row.id));
    const ovView = buildOverridesView(plan, ov);
    if (ovView.applicable && ovView.missingRequired > 0 && !acceptMissingInputs) return refuse("inputs_missing", g.organizationId, {missing: ovView.missingRequired});

    const steps = deriveSteps(plan);
    const needed = new Set<string>();
    for (const s of steps) if (s in STEP_TASK_TYPE) for (const c of TASK_REQUIRES[STEP_TASK_TYPE[s as JournalStep]]) needed.add(c);
    const [e] = await d.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, plan.target.agent_id));
    if (!e || e.revokedAt) return refuse("not_enrolled", g.organizationId);
    if (!e.enabled) return refuse("agent_disabled", g.organizationId);
    if (![...needed].every((c) => e.capabilities.includes(c))) return refuse("capability_missing", g.organizationId);

    const runId = randomUUID();
    const deadlineAt = new Date(Math.min(now.getTime() + maxRunMsOf(d), row.expiresAt.getTime()));
    try {
        const outcome = await withForkLock(d.db, `restore-run-start:${plan.target.agent_id}`, async (tx): Promise<"ok" | "already_running"> => {
            const [active] = await tx.select({id: forkRestoreRun.id}).from(forkRestoreRun).where(and(eq(forkRestoreRun.targetAgentId, plan.target.agent_id), inArray(forkRestoreRun.state, [...ACTIVE]))).limit(1);
            if (active) return "already_running";
            await tx.insert(forkRestoreRun).values({
                id: runId, organizationId: g.organizationId, stackId: row.stackId, planId: row.id, planHash: row.planHash, rpId: row.rpId, rpSequence: row.rpSequence,
                targetAgentId: row.targetAgentId, targetAgentName: row.targetAgentName, purpose: row.purpose, mode: row.mode, state: "running", steps: initialSteps(steps),
                confirmation, acceptMissingInputs: acceptMissingInputs === true, startedBy: p.userId, createdAt: now, deadlineAt, updatedAt: now,
                trigger: o.trigger ?? "manual", scheduledFor: o.scheduledFor ?? null,
            });
            await recordAudit(tx, {
                organizationId: g.organizationId, actorUserId: p.userId, action: "fork.restore_run.start", resourceType: "restore_run", resourceId: runId, result: "success", now,
                details: {runId, planId: row.id, planHash: row.planHash, purpose: row.purpose, mode: row.mode, targetAgentId: plan.target.agent_id, steps, confirmation, acceptMissingInputs: acceptMissingInputs === true, trigger: o.trigger ?? "manual"},
            });
            return "ok";
        });
        if (outcome === "already_running") return refuse("already_running", g.organizationId);
    } catch (err) {
        const c = uniqueViolation(err);
        if (c === null) throw err;
        return refuse(c.includes("plan_id") ? "plan_used" : "already_running", g.organizationId);
    }
    return {ok: true, runId};
}

// ---- policy approval (W20a D-6/D-7, per run) ------------------------------------------------------------------------------------------------

export type PolicyRefusal = "forbidden" | "invalid_input" | "locked" | "rate_limited" | "not_found" | "not_awaiting" | "render_missing" | "render_stale" | "plan_tampered" | "hash_mismatch" | "stale" | BuildFailure;

/**
 * The run waits in `awaiting_approval` because its render needs an explicit per-service override. A `restore.production.approve` holder (org owner / system admin)
 * types `ALLOW <service>` for every flagged service; the token is built against a FRESH verdict of the render the run is waiting on and stored on the run (data, no secret).
 * It binds the exact compose bytes, the rule set, the roots and the context; enqueue and the agent re-check it right before `restore_db` / `compose_up`.
 */
export async function approveRestorePolicy(d: RestoreRunDeps, raw: unknown): Promise<{ok: true; approvalSha256: string; services: number} | ServiceRefusal<PolicyRefusal>> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const parsed = ApprovePolicyRequest.safeParse(raw);
    if (!parsed.success) { await denied(d, "restore_run", null, null, "invalid_input"); return {ok: false, code: "invalid_input"}; }
    const {runId, confirmations} = parsed.data;
    const refuse = async (code: PolicyRefusal, orgId: string | null): Promise<ServiceRefusal<PolicyRefusal>> => { await denied(d, "restore_run", runId, orgId, code); return {ok: false, code}; };
    if (!(await allowed(d))) return refuse("locked", null);
    const g = await gate(d, "restore.production.approve", "restore_run", runId);
    if (!g.ok) return refuse(g.code, null);
    const now = nowOf(d);
    const rl = (d.rate ?? checkRate)(`restore-run-policy:${p.userId}`, POLICY_RATE.limit, POLICY_RATE.windowMs, now.getTime());
    if (!rl.ok) { await denied(d, "restore_run", runId, g.organizationId, "rate_limited"); return {ok: false, code: "rate_limited", retryAfterSeconds: rl.retryAfterSeconds}; }
    const [run] = await d.db.select().from(forkRestoreRun).where(eq(forkRestoreRun.id, runId));
    if (!run) return refuse("not_found", null);
    if (run.state !== "awaiting_approval") return refuse("not_awaiting", g.organizationId);
    const loaded = await loadPlanRow(d, run.planId, run.planHash);
    if (!loaded.ok) return refuse(loaded.code === "plan_tampered" || loaded.code === "hash_mismatch" || loaded.code === "not_found" ? loaded.code : "stale", g.organizationId);
    const {plan} = loaded;
    const [last] = await journalRows(d.db, run.id, "render");
    const render = await latestRender(d.db, {restoreId: run.id, agentId: plan.target.agent_id});
    if (!render || !last || render.taskId !== last.taskId) return refuse("render_missing", g.organizationId);
    const [ov] = await d.db.select({revision: forkRestoreOverride.revision}).from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, run.planId));
    if ((last.overrideRevision ?? 0) !== (ov?.revision ?? 0)) return refuse("render_stale", g.organizationId); // the overrides changed after this render: a fresh render is coming
    let ws: string;
    try { ws = workspaceOf(plan); } catch { return refuse("invalid_input", g.organizationId); }
    const verdict = renderVerdict(render, ws);
    const built = buildPolicyApproval({verdict, confirmations, context: {stack_id: plan.rp.stack_id, rp_id: plan.rp.id, target_agent_id: plan.target.agent_id}});
    if (!built.ok) return refuse(built.code, g.organizationId);
    const rows = await d.db.update(forkRestoreRun).set({policyApproval: built.token, policyApprovalSha256: built.approval_sha256, policyApprovedBy: p.userId, policyApprovedAt: now, updatedAt: now})
        .where(and(eq(forkRestoreRun.id, run.id), eq(forkRestoreRun.state, "awaiting_approval"))).returning({id: forkRestoreRun.id});
    if (rows.length !== 1) return refuse("not_awaiting", g.organizationId);
    const overridden = groupOverrides(verdict);
    await recordAudit(d.db, {
        organizationId: g.organizationId, actorUserId: p.userId, action: "fork.restore.policy_override", resourceType: "restore_run", resourceId: run.id, result: "success", now,
        details: {runId: run.id, composeSha256: verdict.compose_sha256, approvalSha256: built.approval_sha256, services: overridden.length, rules: [...new Set(overridden.flatMap((o) => o.rules))]},
    });
    return {ok: true, approvalSha256: built.approval_sha256, services: overridden.length};
}

// ---- cancel / cleanup --------------------------------------------------------------------------------------------------------------------

export type CancelRefusal = "forbidden" | "invalid_input" | "locked" | "not_found" | "not_active";

/** Idempotent. The tick stops enqueuing, cancels a never-started task and waits for one the agent may be executing, then ends the run `cancelled`. */
export async function cancelRestoreRun(d: RestoreRunDeps, raw: unknown): Promise<{ok: true} | ServiceRefusal<CancelRefusal>> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const parsed = RunIdRequest.safeParse(raw);
    if (!parsed.success) { await denied(d, "restore_run", null, null, "invalid_input"); return {ok: false, code: "invalid_input"}; }
    const {runId} = parsed.data;
    const refuse = async (code: CancelRefusal, orgId: string | null): Promise<ServiceRefusal<CancelRefusal>> => { await denied(d, "restore_run", runId, orgId, code); return {ok: false, code}; };
    if (!(await allowed(d))) return refuse("locked", null);
    const g = await gate(d, "restore.execute", "restore_run", runId);
    if (!g.ok) return refuse(g.code, null);
    const now = nowOf(d);
    const [run] = await d.db.select().from(forkRestoreRun).where(eq(forkRestoreRun.id, runId));
    if (!run || !(ACTIVE as readonly string[]).includes(run.state)) return refuse("not_active", g.organizationId);
    if (!run.cancelRequestedAt) {
        await d.db.update(forkRestoreRun).set({cancelRequestedAt: now, cancelRequestedBy: p.userId, updatedAt: now}).where(and(eq(forkRestoreRun.id, runId), inArray(forkRestoreRun.state, [...ACTIVE])));
        await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: p.userId, action: "fork.restore_run.cancel", resourceType: "restore_run", resourceId: runId, result: "success", now, details: {runId, planHash: run.planHash, state: run.state}});
    }
    return {ok: true};
}

export type CleanupRefusal = RestoreRefusalCode | "not_allowed" | "already_queued" | "invalid_input" | "not_found";

/**
 * Explicit, owned-resources-only cleanup of a run that did not finish (OD-W18a-3: never automatic). The agent removes only what carries THIS restore id AND its own agent id;
 * foreign look-alikes are kept and counted. Refused for `succeeded` (it would delete the restored stack) and while a cleanup task is in flight.
 */
export async function cleanupRestoreRun(d: RestoreRunDeps, raw: unknown): Promise<{ok: true; taskId: string} | ServiceRefusal<CleanupRefusal>> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const parsed = RunIdRequest.safeParse(raw);
    if (!parsed.success) { await denied(d, "restore_run", null, null, "invalid_input"); return {ok: false, code: "invalid_input"}; }
    const {runId} = parsed.data;
    const refuse = async (code: CleanupRefusal, orgId: string | null): Promise<ServiceRefusal<CleanupRefusal>> => { await denied(d, "restore_run", runId, orgId, code); return {ok: false, code}; };
    if (!(await allowed(d))) return refuse("locked", null);
    const g = await gate(d, "restore.execute", "restore_run", runId);
    if (!g.ok) return refuse(g.code, null);
    const [run] = await d.db.select().from(forkRestoreRun).where(eq(forkRestoreRun.id, runId));
    if (!run) return refuse("not_found", null);
    if (!["failed", "cancelled", "incomplete"].includes(run.state)) return refuse("not_allowed", g.organizationId);
    const rows = await journalRows(d.db, run.id, "cleanup");
    if (rows[0]?.task && ["queued", "leased", "running"].includes(rows[0].task.status)) return refuse("already_queued", g.organizationId);
    const now = nowOf(d);
    // the cleanup task is built by the ONE enqueue path, as the CALLER (not the starter), with its journal row in the same transaction
    const res = await enqueueRestoreTask(taskDeps({d, run, principal: p, now}, {step: "cleanup", attempt: (rows[0]?.attempt ?? 0) + 1}), {
        type: "restore_cleanup", planId: run.planId, planHash: run.planHash, restoreId: run.id, cleanup: {workspace: true, volumes: true, networks: true, containers: true},
    });
    if (!res.ok) return {ok: false, code: res.code, ...(res.retryAfterSeconds ? {retryAfterSeconds: res.retryAfterSeconds} : {})};
    await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: p.userId, action: "fork.restore_run.cleanup", resourceType: "restore_run", resourceId: run.id, result: "success", now, details: {runId: run.id, taskId: res.taskId, attempt: (rows[0]?.attempt ?? 0) + 1}});
    return {ok: true, taskId: res.taskId};
}
