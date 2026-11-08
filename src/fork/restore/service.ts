import {and, eq, inArray} from "drizzle-orm";
import {z} from "zod";
import {assertForkResource} from "@/fork/resource-scope";
import {ForkForbiddenError, ForkNotFoundError, type ForkPrincipal} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkRestorePlan} from "@/fork/db/schema/restore";
import {forkRestoreRun} from "@/fork/db/schema/restore-run";
import {forkStack} from "@/fork/db/schema/stack";
import {forkEnv, type ForkEnv} from "@/fork/env";
import {withForkLock} from "@/fork/locks";
import {assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {loadPlanInput} from "./load";
import {hashPlan, planRestore, PlannerRefusal} from "./plan";
import {
    Action, ApprovalRecord, ApproveRequest, CreatePlanRequest, MappingsV1, PlanIdRequest, PrivacyRequest, RestorePlanV1, type CreatePlanRequest as CreateReq,
} from "./schema";
import {APPROVAL_CAPABILITY, PLAN_VERSION, type ApprovalKind, type PlanOutcome, type Refusal as RefusalCode} from "./vocab";

/**
 * Restore plan services (W16, ADR-014): create / approve / freshness / view / privacy. ONE pipeline like `startStackRun`: signed-in principal →
 * mode gate → resource-scoped capability (SEC-12, no existence oracle) → rate limit → load (DB only) → pure planner → persist → audit.
 * It writes NOTHING except `fork_restore_plan` (and `fork_stack` privacy columns in `setStackPrivacy`) and `fork_audit_event`: no task is
 * enqueued, no host / storage / Arcane call is made. Audit details = ids, hashes, codes and counts only (no path, no key name, no mapping value).
 */
export type RestoreDeps = {
    db: ForkDb;
    principal: ForkPrincipal | null;
    now?: () => Date;
    rate?: typeof checkRate;
    env?: Pick<ForkEnv, "FORK_RESTORE_PLAN_TTL_HOURS">;
    /** `true` when fork configuration may change (mode `on`). Default: the real mode (`assertForkConfigAllowed`). */
    configAllowed?: () => Promise<boolean>;
};
export type Refusal = {ok: false; code: RefusalCode; retryAfterSeconds?: number};
export type PlanRow = typeof forkRestorePlan.$inferSelect;
export type Freshness = {fresh: true} | {fresh: false; code: "expired" | "stale"; reason: string};

export const CREATE_RATE = {limit: 10, windowMs: 60_000} as const;
export const APPROVE_RATE = {limit: 20, windowMs: 60_000} as const;
const nowOf = (d: Pick<RestoreDeps, "now">): Date => d.now?.() ?? new Date();
const allowed = async (d: RestoreDeps): Promise<boolean> => (d.configAllowed ? d.configAllowed() : assertForkConfigAllowed().then(() => true, () => false));
const iso = (t: Date) => t.toISOString();

type Audit = (result: "success" | "denied" | "failure", details: Record<string, unknown>, orgId?: string | null) => Promise<unknown>;
const auditor = (d: RestoreDeps, action: string, resourceType: string, resourceId: string | null): Audit => (result, details, orgId = null) =>
    recordAudit(d.db, {organizationId: orgId, actorUserId: d.principal?.userId ?? null, action, resourceType, resourceId, result, details, now: nowOf(d)});

/** Resource gate → refusal (audited as `denied`), or the owning organization. */
async function gate(d: RestoreDeps, cap: string, kind: "recovery_point" | "restore_plan" | "stack", id: string, audit: Audit): Promise<{ok: true; organizationId: string} | Refusal> {
    try {
        const {organizationId} = await assertForkResource(d.db, d.principal, cap, {kind, id});
        return {ok: true, organizationId};
    } catch (e) {
        if (e instanceof ForkNotFoundError) { await audit("denied", {reason: "not_found"}); return {ok: false, code: "not_found"}; }
        if (e instanceof ForkForbiddenError) { await audit("denied", {reason: "forbidden"}); return {ok: false, code: "forbidden"}; }
        throw e;
    }
}

// ---- create -------------------------------------------------------------------------------------------------------------------------

export async function createRestorePlan(d: RestoreDeps, raw: unknown): Promise<{ok: true; planId: string; planHash: string; outcome: PlanOutcome; expiresAt: string} | Refusal> {
    const input = CreatePlanRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const audit = auditor(d, "fork.restore_plan.create", "recovery_point", input.success ? input.data.rpId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return {ok: false, code: "invalid_input"}; }
    const req: CreateReq = input.data;
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return {ok: false, code: "locked"}; }
    const g = await gate(d, "restore.plan", "recovery_point", req.rpId, audit);
    if (!g.ok) return g;
    const now = nowOf(d);
    const rate = (d.rate ?? checkRate)(`${p.userId}:restore-plan`, CREATE_RATE.limit, CREATE_RATE.windowMs, now.getTime());
    if (!rate.ok) { await audit("denied", {reason: "rate_limited"}, g.organizationId); return {ok: false, code: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds}; }

    const loaded = await loadPlanInput(d.db, {rpId: req.rpId, targetAgentId: req.targetAgentId, purpose: req.purpose, mode: req.mode, mappings: req.mappings}, {principal: p, organizationId: g.organizationId, now});
    if (!loaded.ok) { await audit("denied", {reason: loaded.code}, g.organizationId); return {ok: false, code: loaded.code}; }
    let result: ReturnType<typeof planRestore>;
    try {
        result = planRestore(loaded.input);
    } catch (e) {
        if (e instanceof PlannerRefusal) { await audit("denied", {reason: e.code, purpose: req.purpose, mode: req.mode, target_agent_id: req.targetAgentId}, g.organizationId); return {ok: false, code: e.code}; }
        await audit("failure", {reason: "planner_error", error: (e as Error).name}, g.organizationId);
        return {ok: false, code: "invalid_input"};
    }
    const {plan, planHash, inputsDigest} = result;
    const ttl = (d.env ?? forkEnv()).FORK_RESTORE_PLAN_TTL_HOURS;
    const expiresAt = new Date(now.getTime() + ttl * 3_600_000);
    let planId: string;
    try {
        const [row] = await d.db.insert(forkRestorePlan).values({
            organizationId: g.organizationId, stackId: loaded.stackId, rpId: req.rpId, rpSequence: plan.rp.sequence, targetAgentId: req.targetAgentId, targetAgentName: plan.target.agent_name,
            purpose: plan.purpose, mode: plan.mode, planVersion: PLAN_VERSION, mappings: req.mappings, plan, planHash, inputsDigest, outcome: plan.outcome, approvals: [],
            createdBy: p.userId, createdAt: now, expiresAt,
        }).returning({id: forkRestorePlan.id});
        planId = row.id;
    } catch {
        await audit("failure", {reason: "persist_failed", plan_hash: planHash}, g.organizationId); // e.g. the 1 MiB CHECK
        return {ok: false, code: "invalid_input"};
    }
    await recordAudit(d.db, {
        organizationId: g.organizationId, actorUserId: p.userId, action: "fork.restore_plan.create", resourceType: "restore_plan", resourceId: planId, result: "success", now,
        details: {rp_id: req.rpId, rp_sequence: plan.rp.sequence, purpose: plan.purpose, mode: plan.mode, target_agent_id: req.targetAgentId, plan_hash: planHash, outcome: plan.outcome,
            blockers: plan.blockers.slice(0, 20), actions: plan.actions.length, approvals_required: plan.approvals_required.map((a) => a.kind)},
    });
    return {ok: true, planId, planHash, outcome: plan.outcome, expiresAt: iso(expiresAt)};
}

// ---- freshness / the consumer entry point ------------------------------------------------------------------------------------------------

/** Expired by clock, else stale when a re-run of the loader + planner (same stored request) yields a different inputs digest or a refusal. Derived, never written back. */
export async function checkPlanFresh(d: Pick<RestoreDeps, "db" | "now">, row: PlanRow): Promise<Freshness> {
    const now = nowOf(d);
    if (now.getTime() >= row.expiresAt.getTime()) return {fresh: false, code: "expired", reason: "expired"};
    if (row.planVersion !== PLAN_VERSION) return {fresh: false, code: "stale", reason: "plan_version"};
    const m = MappingsV1.safeParse(row.mappings);
    if (!row.rpId || !row.targetAgentId || !m.success) return {fresh: false, code: "stale", reason: "not_found"};
    // W18a D-8: `restore_db` creates this restore's own compose project on the target before `compose_up` is enqueued; while a run of THIS plan is active that project is
    // excluded from the collision facts (otherwise an Arcane sync between the two steps would turn the plan `stale` after data was written). Exact project name only.
    const [active] = await d.db.select({id: forkRestoreRun.id}).from(forkRestoreRun).where(and(eq(forkRestoreRun.planId, row.id), inArray(forkRestoreRun.state, ["running", "awaiting_approval"]))).limit(1);
    const ignoreProject = active ? RestorePlanV1.safeParse(row.plan).data?.target.project : undefined;
    const l = await loadPlanInput(d.db, {rpId: row.rpId, targetAgentId: row.targetAgentId, purpose: row.purpose as "restore", mode: row.mode as "new_stack", mappings: m.data}, {principal: null, skipAgentAcl: true, organizationId: row.organizationId, now, ignoreProject});
    if (!l.ok) return {fresh: false, code: "stale", reason: l.code};
    try {
        const r = planRestore(l.input);
        return r.inputsDigest === row.inputsDigest ? {fresh: true} : {fresh: false, code: "stale", reason: "inputs_changed"};
    } catch (e) {
        if (e instanceof PlannerRefusal) return {fresh: false, code: "stale", reason: e.code};
        throw e;
    }
}

/** The row-only part of verification: version, schema + hash tamper check, requested hash. No freshness (cleanup of an aged-out plan must still work). */
function untamperedPlan(row: PlanRow, planHash: string): {ok: true; row: PlanRow; plan: RestorePlanV1} | Refusal {
    if (row.planVersion !== PLAN_VERSION) return {ok: false, code: "stale"};
    const plan = RestorePlanV1.safeParse(row.plan);
    if (!plan.success || hashPlan(plan.data) !== row.planHash || plan.data.inputs_digest !== row.inputsDigest) return {ok: false, code: "plan_tampered"};
    if (row.planHash !== planHash) return {ok: false, code: "hash_mismatch"};
    return {ok: true, row, plan: plan.data};
}

async function verifiedPlan(d: Pick<RestoreDeps, "db" | "now">, row: PlanRow, planHash: string): Promise<{ok: true; row: PlanRow; plan: RestorePlanV1} | Refusal> {
    const u = untamperedPlan(row, planHash);
    if (!u.ok) return u;
    const f = await checkPlanFresh(d, row);
    if (!f.fresh) return {ok: false, code: f.code};
    return {ok: true, row, plan: u.plan};
}

/** W17-i: the plan row + tamper/hash checks WITHOUT freshness and without a capability gate (the caller authorises). Only `restore_cleanup` may use it. */
export async function loadPlanRow(d: Pick<RestoreDeps, "db">, planId: string, planHash: string): Promise<{ok: true; row: PlanRow; plan: RestorePlanV1} | Refusal> {
    const [row] = await d.db.select().from(forkRestorePlan).where(eq(forkRestorePlan.id, planId));
    if (!row) return {ok: false, code: "not_found"};
    return untamperedPlan(row, planHash);
}

/** The single entry point for W16b / W18a: the plan exists, its capability gate passes, it is untampered, the hash matches, it is not expired and its inputs did not change. */
export async function loadFreshPlan(d: Pick<RestoreDeps, "db" | "now" | "principal">, planId: string, planHash: string): Promise<{ok: true; row: PlanRow; plan: RestorePlanV1} | Refusal> {
    try { await assertForkResource(d.db, d.principal, "restore.plan", {kind: "restore_plan", id: planId}); } catch (e) {
        if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found"};
        if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden"};
        throw e;
    }
    const [row] = await d.db.select().from(forkRestorePlan).where(eq(forkRestorePlan.id, planId));
    if (!row) return {ok: false, code: "not_found"};
    return verifiedPlan(d, row, planHash);
}

// ---- approve ------------------------------------------------------------------------------------------------------------------------

export async function approveRestorePlan(d: RestoreDeps, raw: unknown): Promise<{ok: true; approvals: {kind: ApprovalKind; approvedAt: string}[]} | Refusal> {
    const input = ApproveRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const audit = auditor(d, "fork.restore_plan.approve", "restore_plan", input.success ? input.data.planId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return {ok: false, code: "invalid_input"}; }
    const {planId, planHash, kind} = input.data;
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return {ok: false, code: "locked"}; }
    // The approval capability itself is the resource gate: `restore.production.approve` = org owner OR system admin, so a system admin passes without a membership.
    const g = await gate(d, APPROVAL_CAPABILITY[kind], "restore_plan", planId, audit);
    if (!g.ok) return g;
    const now = nowOf(d);
    const rate = (d.rate ?? checkRate)(`${p.userId}:restore-approve`, APPROVE_RATE.limit, APPROVE_RATE.windowMs, now.getTime());
    if (!rate.ok) { await audit("denied", {reason: "rate_limited", kind}, g.organizationId); return {ok: false, code: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds}; }
    const [row] = await d.db.select().from(forkRestorePlan).where(eq(forkRestorePlan.id, planId));
    if (!row) { await audit("denied", {reason: "not_found"}); return {ok: false, code: "not_found"}; }
    const v = await verifiedPlan(d, row, planHash);
    const refuse = async (code: RefusalCode): Promise<Refusal> => { await audit("denied", {reason: code, kind, plan_hash: planHash}, g.organizationId); return {ok: false, code}; };
    if (!v.ok) return refuse(v.code);
    if (v.plan.outcome === "blocked") return refuse("plan_blocked");
    if (!v.plan.approvals_required.some((a) => a.kind === kind)) return refuse("approval_not_required");

    const approvals = await withForkLock(d.db, `restore-plan:${planId}`, async (tx) => {
        const [cur] = await tx.select({approvals: forkRestorePlan.approvals}).from(forkRestorePlan).where(eq(forkRestorePlan.id, planId));
        const list = parseApprovals(cur?.approvals);
        if (list.some((a) => a.kind === kind && a.plan_hash === row.planHash)) return {list, added: false};
        const rec: ApprovalRecord = {kind, capability: APPROVAL_CAPABILITY[kind], plan_hash: row.planHash, approved_by: p.userId, approved_at: iso(now)};
        const next = [...list, rec];
        await tx.update(forkRestorePlan).set({approvals: next}).where(eq(forkRestorePlan.id, planId));
        return {list: next, added: true};
    });
    await audit("success", {plan_hash: row.planHash, kind, idempotent: !approvals.added}, g.organizationId);
    return {ok: true, approvals: approvals.list.map((a) => ({kind: a.kind, approvedAt: a.approved_at}))};
}

const parseApprovals = (raw: unknown): ApprovalRecord[] => (Array.isArray(raw) ? raw.flatMap((x) => { const r = ApprovalRecord.safeParse(x); return r.success ? [r.data] : []; }) : []);

// ---- view ---------------------------------------------------------------------------------------------------------------------------

/** The user-facing read model: an explicit allowlist (strict), flagged secrets / decisions ONLY (§3.2 row 21), no mappings echo, no inputs digest, no user ids. */
export const RestorePlanView = z.strictObject({
    id: z.string(), planHash: z.string(), createdAt: z.string(), expiresAt: z.string(), freshness: z.enum(["fresh", "stale", "expired"]),
    outcome: z.enum(["ready", "blocked"]), purpose: z.string(), mode: z.string(),
    rp: z.strictObject({id: z.string(), sequence: z.number(), verifiedAt: z.string().nullable()}),
    target: z.strictObject({agentName: z.string(), hostRole: z.string(), hostRoleSource: z.string(), project: z.string(), restoreRoot: z.string().nullable()}),
    actions: z.array(Action),
    preconditions: RestorePlanV1.shape.preconditions,
    approvalsRequired: z.array(z.strictObject({kind: z.string(), capability: z.string()})),
    approvalsGiven: z.array(z.strictObject({kind: z.string(), approvedAt: z.string()})),
    secrets: z.array(z.strictObject({service: z.string(), key: z.string(), origin: z.string(), class: z.string(), reason: z.string().nullable()})),
    decisions: z.array(z.strictObject({code: z.string(), subject: z.string(), suggestion: z.string().nullable()})),
    composeFindings: RestorePlanV1.shape.compose_findings,
    composeFindingsBasis: z.string(),
    blockers: z.array(z.string()),
});
export type RestorePlanView = z.infer<typeof RestorePlanView>;

export function toRestorePlanView(row: PlanRow, plan: RestorePlanV1, fresh: Freshness): RestorePlanView {
    return RestorePlanView.parse({
        id: row.id, planHash: row.planHash, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt),
        freshness: fresh.fresh ? "fresh" : fresh.code === "expired" ? "expired" : "stale",
        outcome: plan.outcome, purpose: plan.purpose, mode: plan.mode,
        rp: {id: plan.rp.id, sequence: plan.rp.sequence, verifiedAt: plan.rp.verified_at},
        target: {agentName: plan.target.agent_name, hostRole: plan.target.host_role, hostRoleSource: plan.target.host_role_source, project: plan.target.project, restoreRoot: plan.target.restore_root},
        actions: plan.actions, preconditions: plan.preconditions,
        approvalsRequired: plan.approvals_required,
        approvalsGiven: parseApprovals(row.approvals).map((a) => ({kind: a.kind, approvedAt: a.approved_at})),
        secrets: plan.secrets.filter((s) => s.flagged).map(({service, key, origin, class: c, reason}) => ({service, key, origin, class: c, reason})),
        decisions: plan.decisions.filter((x) => x.flagged).map(({code, subject, suggestion}) => ({code, subject, suggestion})),
        composeFindings: plan.compose_findings, composeFindingsBasis: plan.compose_findings_basis, blockers: plan.blockers,
    });
}

export async function getRestorePlanView(d: RestoreDeps, raw: unknown): Promise<{ok: true; view: RestorePlanView} | Refusal> {
    const input = PlanIdRequest.safeParse(raw);
    if (!input.success) return {ok: false, code: "invalid_input"};
    try { await assertForkResource(d.db, d.principal, "restore.plan", {kind: "restore_plan", id: input.data.planId}); } catch (e) {
        if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found"};
        if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden"};
        throw e;
    }
    const [row] = await d.db.select().from(forkRestorePlan).where(eq(forkRestorePlan.id, input.data.planId));
    if (!row) return {ok: false, code: "not_found"};
    const plan = RestorePlanV1.safeParse(row.plan);
    if (!plan.success || hashPlan(plan.data) !== row.planHash) return {ok: false, code: "plan_tampered"};
    return {ok: true, view: toRestorePlanView(row, plan.data, await checkPlanFresh(d, row))};
}

// ---- privacy (D44, §4.8) ----------------------------------------------------------------------------------------------------------------

/** Declares whether a stack contains personal data and records/clears the explicit per-stack opt-in to data-only test restores. System admin only (D21), locked-mode refused, audited. */
export async function setStackPrivacy(d: RestoreDeps, raw: unknown): Promise<{ok: true} | Refusal> {
    const input = PrivacyRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const audit = auditor(d, "fork.stack.privacy.set", "stack", input.success ? input.data.stackId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return {ok: false, code: "invalid_input"}; }
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return {ok: false, code: "locked"}; }
    const g = await gate(d, "stacks.backup.manage", "stack", input.data.stackId, audit);
    if (!g.ok) return g;
    const now = nowOf(d);
    const {containsPersonalData, testRestoreOptIn} = input.data;
    await d.db.update(forkStack).set({
        containsPersonalData, testRestoreOptInAt: testRestoreOptIn ? now : null, testRestoreOptInBy: testRestoreOptIn ? p.userId : null, updatedAt: now,
    }).where(eq(forkStack.id, input.data.stackId));
    await audit("success", {contains_personal_data: containsPersonalData, test_restore_opt_in: testRestoreOptIn}, g.organizationId);
    return {ok: true};
}
