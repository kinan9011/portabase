import {randomUUID} from "node:crypto";
import {and, eq, gte, inArray, isNotNull, isNull, sql} from "drizzle-orm";
import {z} from "zod";
import {actorIn, ForkForbiddenError, ForkNotFoundError, forkCan, type ForkPrincipal, type ForkResourceKind} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkMirror, forkMirrorEvent, forkMirrorRevision} from "@/fork/db/schema/mirror";
import {forkRecoveryPoint} from "@/fork/db/schema/recovery";
import {forkRestorePlan} from "@/fork/db/schema/restore";
import {forkStack} from "@/fork/db/schema/stack";
import {forkEnv} from "@/fork/env";
import {withForkLock} from "@/fork/locks";
import {assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkResource} from "@/fork/resource-scope";
import {RP_STATUSES} from "@/fork/recovery/status";
import {loadPlanInput} from "@/fork/restore/load";
import {planRestore, PlannerRefusal} from "@/fork/restore/plan";
import {EMPTY_MAPPINGS} from "@/fork/restore/schema";
import {PLAN_VERSION} from "@/fork/restore/vocab";
import {adminTargetCount, runnerIsolation, assertRunnerTarget} from "@/fork/runner/service";
import {initialSteps} from "@/fork/runs/engine";
import {allocatePort, deriveMirrorSteps} from "./derive";
import {maxRunMsOf, enabledOf, nowOf, type MirrorDeps} from "./deps";
import {addEvent} from "./events";
import {transition} from "./machine";
import {MirrorPolicyInput, resolvePolicy} from "./policy";
import {toMirrorView, type MirrorView} from "./view";
import {nextMirrorStatus, opOf} from "./lifecycle";
import {isWipeEligible} from "./wipe";
import {ACTIVE_REVISION_STATES, keepConfirmPhrase, PORT_RANGE, REFUSAL_MESSAGES, RUNNER_PRECHECK_MAX_AGE_MS, type RevisionState} from "./vocab";

/**
 * W22a services (plan A8). ONE pipeline like W18a: signed-in principal → strict input → config lock → resource-scoped capability (SEC-12: unknown and foreign resources are indistinguishable)
 * → feature flag (after the ACL, like W21) → rate limit → work → audit (`fork.mirror.*`, closed reasons, ids/hashes/codes/counts only: never a path, URL, manifest, payload, env key or value).
 */
export type MirrorRefusalCode = "forbidden" | "not_found" | "invalid_input" | "locked" | "rate_limited" | "mirrors_disabled" | "privacy_ack_required" | "confirmation_mismatch" | "runner_ineligible"
    | "runner_not_isolated" | "runner_busy" | "name_taken" | "port_unavailable" | "rp_not_verified" | "mirror_not_ready" | "plan_blocked" | "not_active" | "mirror_mode_invalid" | "mirror_target_not_runner"
    | "personal_data_no_mirror_opt_in" | "not_failed" | "rp_purged" | "mirror_busy" | "mirror_state_invalid" | "rp_not_newer" | "no_rollback_target";
export type MirrorRefusal = {ok: false; code: MirrorRefusalCode; message: string; retryAfterSeconds?: number; blockers?: string[]};
const refuse = (code: MirrorRefusalCode, extra: Partial<MirrorRefusal> = {}): MirrorRefusal => ({ok: false, code, message: REFUSAL_MESSAGES[code] ?? "Refused.", ...extra});
const allowed = (d: MirrorDeps): Promise<boolean> => (d.configAllowed ? d.configAllowed() : assertForkConfigAllowed().then(() => true, () => false));

type Audit = (result: "success" | "denied" | "failure", details: Record<string, unknown>, orgId?: string | null) => Promise<unknown>;
const auditor = (d: MirrorDeps, action: string, resourceType: string, resourceId: string | null): Audit => (result, details, orgId = null) =>
    recordAudit(d.db, {organizationId: orgId, actorUserId: d.principal?.userId ?? null, action, resourceType, resourceId, result, details, now: nowOf(d)});

async function gate(d: MirrorDeps, cap: string, kind: ForkResourceKind, id: string, audit: Audit): Promise<{ok: true; organizationId: string; principal: ForkPrincipal} | MirrorRefusal> {
    try {
        const {organizationId} = await assertForkResource(d.db, d.principal, cap, {kind, id});
        return {ok: true, organizationId, principal: d.principal as ForkPrincipal};
    } catch (e) {
        if (e instanceof ForkNotFoundError) { await audit("denied", {reason: "not_found"}); return refuse("not_found"); }
        if (e instanceof ForkForbiddenError) { await audit("denied", {reason: "forbidden"}); return refuse("forbidden"); }
        throw e;
    }
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const KeepConfirmations = z.record(z.string().max(300), z.string().max(320)).refine((r) => Object.keys(r).length <= 100, "too many");

// ---- opt-in (ADR-009 §4, OD-W22a-1) -------------------------------------------------------------------------------------------------------
export const SetMirrorOptInRequest = z.strictObject({stackId: z.uuid(), enabled: z.boolean()});
/** System admin only (`mirrors.manage` on the stack AND `host_role.manage`), audited, no step-up. */
export async function setStackMirrorOptIn(d: MirrorDeps, raw: unknown): Promise<{ok: true} | MirrorRefusal> {
    const input = SetMirrorOptInRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return refuse("forbidden");
    const audit = auditor(d, "fork.mirror.opt_in.set", "stack", input.success ? input.data.stackId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return refuse("invalid_input"); }
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return refuse("locked"); }
    const g = await gate(d, "mirrors.manage", "stack", input.data.stackId, audit);
    if (!g.ok) return g;
    if (!forkCan(actorIn(p, g.organizationId) ?? {systemRole: p.systemRole ?? null, orgRole: null}, "host_role.manage")) { await audit("denied", {reason: "forbidden", capability: "host_role.manage"}, g.organizationId); return refuse("forbidden"); }
    if (!enabledOf(d)) { await audit("denied", {reason: "mirrors_disabled"}, g.organizationId); return refuse("mirrors_disabled"); }
    const now = nowOf(d);
    await d.db.update(forkStack).set({mirrorOptInAt: input.data.enabled ? now : null, mirrorOptInBy: input.data.enabled ? p.userId : null, updatedAt: now}).where(eq(forkStack.id, input.data.stackId));
    await audit("success", {enabled: input.data.enabled}, g.organizationId);
    return {ok: true};
}

// ---- plan helpers ---------------------------------------------------------------------------------------------------------------------------
async function mirrorPlan(d: MirrorDeps, db: ForkDb, a: {rpId: string; runnerAgentId: string; project: string; organizationId: string; now: Date}) {
    const loaded = await loadPlanInput(db, {rpId: a.rpId, targetAgentId: a.runnerAgentId, purpose: "mirror", mode: "new_stack",
        mappings: {...EMPTY_MAPPINGS, target_project: a.project, restore_root: forkEnv().FORK_MIRROR_ROOT}}, {principal: d.principal ?? null, organizationId: a.organizationId, now: a.now});
    if (!loaded.ok) return {ok: false as const, code: (loaded.code === "invalid_input" ? "invalid_input" : loaded.code) as MirrorRefusalCode};
    try {
        return {ok: true as const, loaded, result: planRestore(loaded.input)};
    } catch (e) {
        if (e instanceof PlannerRefusal) return {ok: false as const, code: e.code as MirrorRefusalCode};
        throw e;
    }
}

// ---- preview (W22b Review step: no write) -----------------------------------------------------------------------------------------------
export const PreviewMirrorRequest = z.strictObject({stackId: z.uuid(), rpId: z.uuid(), runnerAgentId: z.uuid()});
export async function previewMirrorPlan(d: MirrorDeps, raw: unknown): Promise<{ok: true; outcome: string; blockers: string[]; actions: number; containsPersonalData: boolean | null; optIn: boolean; runnerIsolation: string} | MirrorRefusal> {
    const input = PreviewMirrorRequest.safeParse(raw);
    if (!d.principal) return refuse("forbidden");
    const audit = auditor(d, "fork.mirror.preview", "stack", input.success ? input.data.stackId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return refuse("invalid_input"); }
    const g = await gate(d, "mirrors.manage", "stack", input.data.stackId, audit);
    if (!g.ok) return g;
    if (!enabledOf(d)) { await audit("denied", {reason: "mirrors_disabled"}, g.organizationId); return refuse("mirrors_disabled"); }
    const now = nowOf(d);
    const [stack] = await d.db.select().from(forkStack).where(eq(forkStack.id, input.data.stackId));
    const [rp] = await d.db.select({stackId: forkRecoveryPoint.stackId}).from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, input.data.rpId));
    if (!stack || !rp || rp.stackId !== stack.id) return refuse("not_found");
    const iso = await runnerIsolation(d.db, input.data.runnerAgentId, {now, maxAgeMs: RUNNER_PRECHECK_MAX_AGE_MS, serverUrl: d.serverUrl()});
    const plan = await mirrorPlan(d, d.db, {rpId: input.data.rpId, runnerAgentId: input.data.runnerAgentId, project: "pbm-preview-r1", organizationId: g.organizationId, now});
    if (!plan.ok) return refuse(plan.code);
    const p = plan.result.plan;
    return {ok: true, outcome: p.outcome, blockers: p.blockers.slice(0, 20), actions: p.actions.length, containsPersonalData: stack.containsPersonalData, optIn: stack.mirrorOptInAt !== null, runnerIsolation: iso.state};
}

// ---- create -------------------------------------------------------------------------------------------------------------------------------
export const CreateMirrorRequest = z.strictObject({
    stackId: z.uuid(), rpId: z.uuid(), runnerAgentId: z.uuid(), name: slug, policy: MirrorPolicyInput, keepConfirmations: KeepConfirmations, acknowledgePrivacy: z.boolean(),
});
export const CREATE_RATE = {limit: 5, windowMs: 60_000} as const;

export async function createMirror(d: MirrorDeps, raw: unknown): Promise<{ok: true; mirrorId: string; revisionId: string; planHash: string; hostPort: number} | MirrorRefusal> {
    const input = CreateMirrorRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return refuse("forbidden");
    const audit = auditor(d, "fork.mirror.denied", "stack", input.success ? input.data.stackId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return refuse("invalid_input"); }
    const req = input.data;
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return refuse("locked"); }
    const g = await gate(d, "mirrors.manage", "stack", req.stackId, audit);
    if (!g.ok) return g;
    const orgId = g.organizationId;
    const deny = async (code: MirrorRefusalCode, details: Record<string, unknown> = {}, extra: Partial<MirrorRefusal> = {}): Promise<MirrorRefusal> => { await audit("denied", {reason: code, ...details}, orgId); return refuse(code, extra); };
    if (!enabledOf(d)) return deny("mirrors_disabled");
    const now = nowOf(d);
    const rl = (d.rate ?? checkRate)(`mirror-create:${p.userId}`, CREATE_RATE.limit, CREATE_RATE.windowMs, now.getTime());
    if (!rl.ok) return deny("rate_limited", {}, {retryAfterSeconds: rl.retryAfterSeconds});

    // the recovery point must belong to this stack (and org) and still be verified
    const [stack] = await d.db.select().from(forkStack).where(eq(forkStack.id, req.stackId));
    const [rp] = await d.db.select().from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, req.rpId));
    if (!stack || stack.organizationId !== orgId || !rp || rp.stackId !== stack.id) return deny("not_found");
    if (rp.purgedAt !== null) return deny("rp_purged");
    if (rp.status !== RP_STATUSES[2]) return deny("rp_not_verified");
    // privacy (ADR-009 §4): personal data true/unknown ⇒ the operator must acknowledge that the mirror holds a copy of production data
    if (stack.containsPersonalData !== false && !req.acknowledgePrivacy) return deny("privacy_ack_required");
    // every kept production value needs its typed phrase (`KEEP svc.KEY`); the confirmed keys are recorded (names only)
    const confirmed: string[] = [];
    for (const [svc, keys] of Object.entries(req.policy.env)) {
        for (const [key, action] of Object.entries(keys)) {
            if (action !== "keep_exact") continue;
            if (req.keepConfirmations[`${svc}.${key}`] !== keepConfirmPhrase(svc, key)) return deny("confirmation_mismatch");
            confirmed.push(`${svc}.${key}`);
        }
    }
    if (confirmed.length > 100) return deny("invalid_input");
    // the runner: eligible now AND isolated within the last 24 h (checked BEFORE any production data is staged; READY needs a second, fresh probe)
    const el = await assertRunnerTarget(d.db, req.runnerAgentId);
    if (!el.ok) return deny("runner_ineligible", {detail: el.code});
    const iso = await runnerIsolation(d.db, req.runnerAgentId, {now, maxAgeMs: RUNNER_PRECHECK_MAX_AGE_MS, serverUrl: d.serverUrl()});
    if (iso.state !== "isolated") return deny("runner_not_isolated", {isolation: iso.state});
    const [dup] = await d.db.select({id: forkMirror.id}).from(forkMirror).where(and(eq(forkMirror.organizationId, orgId), eq(forkMirror.name, req.name), isNull(forkMirror.deletedAt)));
    if (dup) return deny("name_taken");

    const project = `pbm-${req.name}-r1`;
    const root = forkEnv().FORK_MIRROR_ROOT;
    const policy = resolvePolicy(req.policy, confirmed);
    const plan = await mirrorPlan(d, d.db, {rpId: req.rpId, runnerAgentId: req.runnerAgentId, project, organizationId: orgId, now});
    if (!plan.ok) return deny(plan.code, {rpId: req.rpId});
    const {plan: pl, planHash, inputsDigest} = plan.result;
    const revisionId = randomUUID();
    const mirrorId = randomUUID();
    const workspace = `${root}/${project}`;

    type Created = {ok: true; hostPort: number} | {ok: false; code: MirrorRefusalCode; blockers?: string[]};
    const created = await withForkLock(d.db, `runner:${req.runnerAgentId}`, async (tx): Promise<Created> => {
        const [busy] = await tx.select({n: sql<number>`count(*)::int`}).from(forkMirrorRevision).where(and(eq(forkMirrorRevision.runnerAgentId, req.runnerAgentId), inArray(forkMirrorRevision.state, [...ACTIVE_REVISION_STATES])));
        if (Number(busy?.n ?? 0) > 0) return {ok: false, code: "runner_busy"};
        const used = await tx.select({port: forkMirrorRevision.hostPort}).from(forkMirrorRevision).where(and(eq(forkMirrorRevision.runnerAgentId, req.runnerAgentId), sql`coalesce(${forkMirrorRevision.wipeState}, '') NOT IN ('verified','not_needed')`));
        const port = allocatePort(used.map((u) => u.port), d.portRange ?? PORT_RANGE);
        if (port === null) return {ok: false, code: "port_unavailable"};
        const expiresAt = new Date(now.getTime() + forkEnv().FORK_RESTORE_PLAN_TTL_HOURS * 3_600_000);
        const [planRow] = await tx.insert(forkRestorePlan).values({
            organizationId: orgId, stackId: req.stackId, rpId: req.rpId, rpSequence: pl.rp.sequence, targetAgentId: req.runnerAgentId, targetAgentName: pl.target.agent_name, purpose: "mirror", mode: "new_stack",
            planVersion: PLAN_VERSION, mappings: {target_project: project, restore_root: root, volumes: null, select: null, sqlite: null}, plan: pl, planHash, inputsDigest, outcome: pl.outcome, approvals: [], createdBy: p.userId, createdAt: now, expiresAt,
        }).returning({id: forkRestorePlan.id});
        const blocked = pl.outcome !== "ready";
        await tx.insert(forkMirror).values({
            id: mirrorId, organizationId: orgId, stackId: req.stackId, runnerAgentId: req.runnerAgentId, runnerAgentName: pl.target.agent_name, name: req.name, policy, status: blocked ? "failed" : "creating",
            createdBy: p.userId, createdAt: now, updatedAt: now, ...(blocked ? {deletedAt: now} : {}), // a creation blocked by its plan staged nothing: its name is free again
        });
        const base = {
            id: revisionId, mirrorId, organizationId: orgId, stackId: req.stackId, seq: 1, rpId: req.rpId, rpSequence: pl.rp.sequence, planId: planRow.id, planHash, runnerAgentId: req.runnerAgentId,
            project, workspace, hostPort: port, startedBy: p.userId, createdAt: now, deadlineAt: new Date(now.getTime() + maxRunMsOf(d)), updatedAt: now,
        };
        if (blocked) {
            const next = transition("requested", "blocked");
            await tx.insert(forkMirrorRevision).values({...base, state: "requested"});
            await addEvent(tx, {mirrorId, revisionId, kind: "requested", at: now, toState: "requested", actor: {userId: p.userId}});
            await tx.update(forkMirrorRevision).set({state: next, reason: "plan_blocked", finishedAt: now, durationSeconds: 0, wipeState: "not_needed", wipeFinishedAt: now, updatedAt: now}).where(eq(forkMirrorRevision.id, revisionId));
            await addEvent(tx, {mirrorId, revisionId, kind: "blocked", at: now, fromState: "requested", toState: next, code: "plan_blocked", details: {blockers: pl.blockers.slice(0, 10)}});
            await recordAudit(tx, {organizationId: orgId, actorUserId: p.userId, action: "fork.mirror.finish", resourceType: "mirror", resourceId: mirrorId, result: "failure", now, details: {revisionId, planHash, state: next, reason: "plan_blocked", blockers: pl.blockers.slice(0, 20)}});
            return {ok: false, code: "plan_blocked", blockers: pl.blockers.slice(0, 20)};
        }
        // the ladder is complete in the events: requested → planning → validating (the tick never sees the first two)
        const planning = transition("requested", "planning");
        const next = transition(planning, "validating");
        await tx.insert(forkMirrorRevision).values({...base, state: next, steps: initialSteps(deriveMirrorSteps(pl))});
        await addEvent(tx, {mirrorId, revisionId, kind: "requested", at: now, toState: "requested", actor: {userId: p.userId}});
        await addEvent(tx, {mirrorId, revisionId, kind: "state_changed", at: now, fromState: "requested", toState: planning});
        await addEvent(tx, {mirrorId, revisionId, kind: "state_changed", at: now, fromState: planning, toState: next});
        await recordAudit(tx, {organizationId: orgId, actorUserId: p.userId, action: "fork.mirror.create", resourceType: "mirror", resourceId: mirrorId, result: "success", now,
            details: {revisionId, planHash, rpId: req.rpId, runnerAgentId: req.runnerAgentId, hostPort: port, kept: confirmed.length, limits: policy.limits}});
        return {ok: true, hostPort: port};
    });
    if (!created.ok) return created.code === "plan_blocked" ? refuse("plan_blocked", {blockers: created.blockers}) : deny(created.code);
    return {ok: true, mirrorId, revisionId, planHash, hostPort: created.hostPort};
}

// ---- cancel -------------------------------------------------------------------------------------------------------------------------------
export const RevisionIdRequest = z.strictObject({revisionId: z.uuid()});
export const MirrorIdRequest = z.strictObject({mirrorId: z.uuid()});

async function revisionGate(d: MirrorDeps, raw: unknown, action: string, cap: string) {
    const input = RevisionIdRequest.safeParse(raw);
    if (!d.principal) return {err: refuse("forbidden")};
    const audit = auditor(d, action, "mirror", null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return {err: refuse("invalid_input")}; }
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return {err: refuse("locked")}; } // D21 (the tick still cancels, times out and wipes on its own)
    const [rev] = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, input.data.revisionId));
    // unknown revision and foreign revision are the same answer (the gate runs on the owning mirror; a missing mirror id is `not_found`)
    const g = await gate(d, cap, "mirror", rev?.mirrorId ?? "00000000-0000-4000-8000-000000000000", auditor(d, action, "mirror", rev?.mirrorId ?? null));
    if (!g.ok || !rev) return {err: g.ok ? refuse("not_found") : g};
    return {rev, g, audit: auditor(d, action, "mirror", rev.mirrorId)};
}

/** Idempotent. A never-started task is cancelled by the next tick; one the runner may be executing is awaited (its truthful outcome), then the revision ends `cancelled` and its copy is wiped. */
export async function cancelMirrorRevision(d: MirrorDeps, raw: unknown): Promise<{ok: true} | MirrorRefusal> {
    const r = await revisionGate(d, raw, "fork.mirror.cancel", "mirrors.manage");
    if ("err" in r && r.err) return r.err;
    const {rev, g, audit} = r as Exclude<typeof r, {err: MirrorRefusal}>;
    if (rev.state === "cancelled") return {ok: true};
    if (!(ACTIVE_REVISION_STATES as readonly string[]).includes(rev.state)) { await audit("denied", {reason: "not_active", state: rev.state}, g.organizationId); return refuse("not_active"); }
    const now = nowOf(d);
    if (!rev.cancelRequestedAt) {
        await d.db.update(forkMirrorRevision).set({cancelRequestedAt: now, cancelRequestedBy: g.principal.userId, updatedAt: now}).where(and(eq(forkMirrorRevision.id, rev.id), isNull(forkMirrorRevision.cancelRequestedAt)));
        await addEvent(d.db, {mirrorId: rev.mirrorId, revisionId: rev.id, kind: "cancel_requested", at: now, actor: {userId: g.principal.userId}});
        await audit("success", {revisionId: rev.id}, g.organizationId);
    }
    return {ok: true};
}

/** A failed wipe (the runner copy may still exist) is retried only by an explicit, audited action. */
export async function retryMirrorWipe(d: MirrorDeps, raw: unknown): Promise<{ok: true} | MirrorRefusal> {
    const r = await revisionGate(d, raw, "fork.mirror.wipe_retry", "mirrors.manage");
    if ("err" in r && r.err) return r.err;
    const {rev, g, audit} = r as Exclude<typeof r, {err: MirrorRefusal}>;
    const [mir] = await d.db.select({status: forkMirror.status}).from(forkMirror).where(eq(forkMirror.id, rev.mirrorId));
    if (!isWipeEligible(rev.state, mir?.status) || rev.wipeState !== "failed") { await audit("denied", {reason: "not_failed", state: rev.state, wipeState: rev.wipeState}, g.organizationId); return refuse("not_failed"); }
    const now = nowOf(d);
    await d.db.update(forkMirrorRevision).set({wipeState: null, wipeReason: null, wipeStartedAt: null, wipeFinishedAt: null, updatedAt: now}).where(and(eq(forkMirrorRevision.id, rev.id), eq(forkMirrorRevision.wipeState, "failed")));
    await audit("success", {revisionId: rev.id}, g.organizationId);
    return {ok: true};
}

// ---- delete (W23, DD-6) -------------------------------------------------------------------------------------------------------------------
export const DeleteMirrorRequest = z.strictObject({mirrorId: z.uuid(), confirmName: z.string().max(40)});
export const MIRROR_OP_RATE = {limit: 10, windowMs: 60_000} as const;
/** Statuses a mirror can be deleted from; `creating` must be cancelled first, `stopping` / `starting` / `deleting` are in flight. */
const DELETABLE = ["ready", "failed", "cancelled", "stopped"] as const;

/**
 * Delete = a verified wipe of EVERY revision's runner copy (existing `mirror_wipe` + independent `mirror_probe`, ADR-009 §8), then `deleted_at` (name reusable, port freed). Allowed while configuration is locked and
 * with the flag off (OD-W23-2: removing a production-data copy is always allowed, like the wipe). This call only marks the mirror `deleting`; the tick does the work.
 */
export async function deleteMirror(d: MirrorDeps, raw: unknown): Promise<{ok: true} | MirrorRefusal> {
    const input = DeleteMirrorRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return refuse("forbidden");
    const audit = auditor(d, "fork.mirror.delete", "mirror", input.success ? input.data.mirrorId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return refuse("invalid_input"); }
    const g = await gate(d, "mirrors.manage", "mirror", input.data.mirrorId, audit);
    if (!g.ok) return g;
    const orgId = g.organizationId;
    const deny = async (code: MirrorRefusalCode, extra: Partial<MirrorRefusal> = {}): Promise<MirrorRefusal> => { await audit("denied", {reason: code}, orgId); return refuse(code, extra); };
    const now = nowOf(d);
    const rl = (d.rate ?? checkRate)(`mirror-op:${p.userId}`, MIRROR_OP_RATE.limit, MIRROR_OP_RATE.windowMs, now.getTime());
    if (!rl.ok) return deny("rate_limited", {retryAfterSeconds: rl.retryAfterSeconds});
    const [m] = await d.db.select().from(forkMirror).where(eq(forkMirror.id, input.data.mirrorId));
    if (!m) return refuse("not_found");
    if (m.status === "deleting" && m.routePort !== null && !m.deletedAt) {
        // W24: a route removal that FAILED for this delete request is re-requested by a new Delete click (a new op start; the failed row is then ignored)
        const op = await opOf(d.db, m.id, "deleting");
        const [failedEv] = op ? await d.db.select({id: forkMirrorEvent.id}).from(forkMirrorEvent).where(and(eq(forkMirrorEvent.mirrorId, m.id), eq(forkMirrorEvent.kind, "failed"), gte(forkMirrorEvent.at, op.at), sql`${forkMirrorEvent.details}->>'scope' = 'mirror'`)).limit(1) : [];
        if (failedEv && input.data.confirmName === m.name) {
            await addEvent(d.db, {mirrorId: m.id, revisionId: null, kind: "state_changed", at: now, fromState: "deleting", toState: "deleting", actor: {userId: p.userId}, details: {scope: "mirror", retry: true}});
            await audit("success", {phase: "retry"}, orgId);
        }
        return {ok: true};
    }
    if (m.status === "deleting" || m.status === "deleted" || m.deletedAt) return {ok: true}; // idempotent
    if (input.data.confirmName !== m.name) return deny("confirmation_mismatch");
    const revs = await d.db.select({id: forkMirrorRevision.id, state: forkMirrorRevision.state}).from(forkMirrorRevision).where(eq(forkMirrorRevision.mirrorId, m.id));
    if (m.status === "creating" || m.status === "stopping" || m.status === "starting" || m.status === "refreshing" || m.status === "rolling_back" || revs.some((r) => (ACTIVE_REVISION_STATES as readonly string[]).includes(r.state))) return deny("mirror_busy");
    if (!(DELETABLE as readonly string[]).includes(m.status)) return deny("mirror_state_invalid");
    const done = await withForkLock(d.db, `mirror:${m.id}`, async (tx) => {
        const rows = await tx.update(forkMirror).set({status: "deleting", updatedAt: now}).where(and(eq(forkMirror.id, m.id), eq(forkMirror.status, m.status))).returning({id: forkMirror.id});
        if (rows.length !== 1) return false;
        await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "state_changed", at: now, fromState: m.status, toState: "deleting", actor: {userId: p.userId}, details: {scope: "mirror"}});
        await recordAudit(tx, {organizationId: orgId, actorUserId: p.userId, action: "fork.mirror.delete", resourceType: "mirror", resourceId: m.id, result: "success", now, details: {phase: "requested", revisionIds: revs.map((r) => r.id)}});
        return true;
    });
    if (!done) return deny("mirror_busy");
    return {ok: true};
}

// ---- stop / start (W23 Part B, DD-9) ------------------------------------------------------------------------------------------------------
/** Statuses Stop can start from: a running mirror, or one whose last stop failed while it still has its revision (retry the stop). */
const STOPPABLE = ["ready", "failed"] as const;

/**
 * Stop: allowed while configuration is locked and with the flag off (OD-W23-2: it reduces exposure of a production-data copy, like Delete). Marks the mirror `stopping`;
 * the tick enqueues `mirror_stop` (no principal, like the wipe) and moves it to `stopped` only after the runner confirms nothing of the revision is running.
 */
export async function stopMirror(d: MirrorDeps, raw: unknown): Promise<{ok: true} | MirrorRefusal> {
    const input = MirrorIdRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return refuse("forbidden");
    const audit = auditor(d, "fork.mirror.stop", "mirror", input.success ? input.data.mirrorId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return refuse("invalid_input"); }
    const g = await gate(d, "mirrors.manage", "mirror", input.data.mirrorId, audit);
    if (!g.ok) return g;
    const orgId = g.organizationId;
    const deny = async (code: MirrorRefusalCode, extra: Partial<MirrorRefusal> = {}): Promise<MirrorRefusal> => { await audit("denied", {reason: code}, orgId); return refuse(code, extra); };
    const now = nowOf(d);
    const rl = (d.rate ?? checkRate)(`mirror-op:${p.userId}`, MIRROR_OP_RATE.limit, MIRROR_OP_RATE.windowMs, now.getTime());
    if (!rl.ok) return deny("rate_limited", {retryAfterSeconds: rl.retryAfterSeconds});
    const [m] = await d.db.select().from(forkMirror).where(eq(forkMirror.id, input.data.mirrorId));
    if (!m || m.deletedAt) return refuse("not_found");
    if (m.status === "stopping" || m.status === "stopped") return {ok: true}; // idempotent
    if (m.status === "creating" || m.status === "starting" || m.status === "deleting" || m.status === "refreshing" || m.status === "rolling_back") return deny("mirror_busy");
    if (!(STOPPABLE as readonly string[]).includes(m.status) || !m.activeRevisionId) return deny("mirror_state_invalid");
    const to = nextMirrorStatus(m.status as "ready" | "failed", "stop_requested");
    const done = await withForkLock(d.db, `mirror:${m.id}`, async (tx) => {
        const rows = await tx.update(forkMirror).set({status: to, updatedAt: now}).where(and(eq(forkMirror.id, m.id), eq(forkMirror.status, m.status))).returning({id: forkMirror.id});
        if (rows.length !== 1) return false;
        await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "state_changed", at: now, fromState: m.status, toState: to, actor: {userId: p.userId}, details: {scope: "mirror"}});
        await recordAudit(tx, {organizationId: orgId, actorUserId: p.userId, action: "fork.mirror.stop", resourceType: "mirror", resourceId: m.id, result: "success", now, details: {phase: "requested", revisionId: m.activeRevisionId}});
        return true;
    });
    if (!done) return deny("mirror_busy");
    return {ok: true};
}

/**
 * Start (from `stopped`): refused while configuration is locked or the flag is off, and unless the runner is still an eligible, freshly isolated runner. Marks the mirror `starting`;
 * the tick re-gates (own isolation probe BEFORE anything runs, `mirror_up`, `mirror_check` health + app smoke) before the mirror is `ready` again.
 */
export async function startMirror(d: MirrorDeps, raw: unknown): Promise<{ok: true} | MirrorRefusal> {
    const input = MirrorIdRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return refuse("forbidden");
    const audit = auditor(d, "fork.mirror.start", "mirror", input.success ? input.data.mirrorId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return refuse("invalid_input"); }
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return refuse("locked"); }
    const g = await gate(d, "mirrors.manage", "mirror", input.data.mirrorId, audit);
    if (!g.ok) return g;
    const orgId = g.organizationId;
    const deny = async (code: MirrorRefusalCode, extra: Partial<MirrorRefusal> = {}): Promise<MirrorRefusal> => { await audit("denied", {reason: code}, orgId); return refuse(code, extra); };
    if (!enabledOf(d)) return deny("mirrors_disabled");
    const now = nowOf(d);
    const rl = (d.rate ?? checkRate)(`mirror-op:${p.userId}`, MIRROR_OP_RATE.limit, MIRROR_OP_RATE.windowMs, now.getTime());
    if (!rl.ok) return deny("rate_limited", {retryAfterSeconds: rl.retryAfterSeconds});
    const [m] = await d.db.select().from(forkMirror).where(eq(forkMirror.id, input.data.mirrorId));
    if (!m || m.deletedAt) return refuse("not_found");
    if (m.status === "starting") return {ok: true}; // idempotent
    if (m.status === "creating" || m.status === "stopping" || m.status === "deleting" || m.status === "refreshing" || m.status === "rolling_back") return deny("mirror_busy");
    if (m.status !== "stopped" || !m.activeRevisionId) return deny("mirror_state_invalid");
    if (!m.runnerAgentId) return deny("runner_ineligible");
    const el = await assertRunnerTarget(d.db, m.runnerAgentId);
    if (!el.ok) return deny("runner_ineligible");
    const iso = await runnerIsolation(d.db, m.runnerAgentId, {now, maxAgeMs: RUNNER_PRECHECK_MAX_AGE_MS, serverUrl: d.serverUrl()});
    if (iso.state !== "isolated" || (await adminTargetCount(d.db, m.runnerAgentId)) < 1) return deny("runner_not_isolated");
    const to = nextMirrorStatus("stopped", "start_requested");
    const done = await withForkLock(d.db, `mirror:${m.id}`, async (tx) => {
        const rows = await tx.update(forkMirror).set({status: to, updatedAt: now}).where(and(eq(forkMirror.id, m.id), eq(forkMirror.status, "stopped"))).returning({id: forkMirror.id});
        if (rows.length !== 1) return false;
        await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "state_changed", at: now, fromState: "stopped", toState: to, actor: {userId: p.userId}, details: {scope: "mirror"}});
        await recordAudit(tx, {organizationId: orgId, actorUserId: p.userId, action: "fork.mirror.start", resourceType: "mirror", resourceId: m.id, result: "success", now, details: {phase: "requested", revisionId: m.activeRevisionId}});
        return true;
    });
    if (!done) return deny("mirror_busy");
    return {ok: true};
}

// ---- refresh / rollback (W24, DD-1/2/9/10/11) ---------------------------------------------------------------------------------------------
export const RefreshMirrorRequest = z.strictObject({mirrorId: z.uuid(), rpId: z.uuid(), confirmName: z.string().max(40), acknowledgePrivacy: z.boolean()});
export const RollbackMirrorRequest = z.strictObject({mirrorId: z.uuid(), revisionId: z.uuid(), confirmName: z.string().max(40)});
const OP_BUSY = ["creating", "stopping", "starting", "deleting"] as const;
const isUniqueViolation = (e: unknown, name: string): boolean => {
    const x = e as {constraint?: string; message?: string; cause?: {constraint?: string; message?: string}};
    return x?.constraint === name || x?.cause?.constraint === name || (x?.message ?? "").includes(name) || (x?.cause?.message ?? "").includes(name);
};
class CasLost extends Error {}

/** Ports in use on a runner: revision loopback ports whose copy may still exist + the stable route ports of live mirrors (one number space, no accidental overlap). */
async function usedPorts(tx: ForkDb, runnerAgentId: string): Promise<number[]> {
    const rev = await tx.select({port: forkMirrorRevision.hostPort}).from(forkMirrorRevision).where(and(eq(forkMirrorRevision.runnerAgentId, runnerAgentId), sql`coalesce(${forkMirrorRevision.wipeState}, '') NOT IN ('verified','not_needed')`));
    const route = await tx.select({port: forkMirror.routePort}).from(forkMirror).where(and(eq(forkMirror.runnerAgentId, runnerAgentId), isNull(forkMirror.deletedAt), isNotNull(forkMirror.routePort)));
    return [...rev.map((r) => r.port), ...route.map((r) => r.port as number)];
}

/**
 * Refresh (plan v1.1 §8.4): build an INDEPENDENT new revision of a READY mirror from a strictly newer verified recovery point, with the full W22a pipeline, while the active revision keeps serving. The status CAS
 * `ready → refreshing` is the per-mirror lock (a second click is idempotent); the stored policy is reused (never re-sent). The route switch + commit are done by the lifecycle tick only after the new
 * revision passed every READY gate. A refused plan writes nothing (no revision row).
 */
export async function refreshMirror(d: MirrorDeps, raw: unknown): Promise<{ok: true; revisionId: string; already?: true} | MirrorRefusal> {
    const input = RefreshMirrorRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return refuse("forbidden");
    const audit = auditor(d, "fork.mirror.refresh", "mirror", input.success ? input.data.mirrorId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return refuse("invalid_input"); }
    const req = input.data;
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return refuse("locked"); }
    const g = await gate(d, "mirrors.manage", "mirror", req.mirrorId, audit);
    if (!g.ok) return g;
    const orgId = g.organizationId;
    const deny = async (code: MirrorRefusalCode, details: Record<string, unknown> = {}, extra: Partial<MirrorRefusal> = {}): Promise<MirrorRefusal> => { await audit("denied", {reason: code, ...details}, orgId); return refuse(code, extra); };
    if (!enabledOf(d)) return deny("mirrors_disabled");
    const now = nowOf(d);
    const rl = (d.rate ?? checkRate)(`mirror-op:${p.userId}`, MIRROR_OP_RATE.limit, MIRROR_OP_RATE.windowMs, now.getTime());
    if (!rl.ok) return deny("rate_limited", {}, {retryAfterSeconds: rl.retryAfterSeconds});
    const [m] = await d.db.select().from(forkMirror).where(eq(forkMirror.id, req.mirrorId));
    if (!m || m.deletedAt) return refuse("not_found");
    if (m.status === "refreshing" && m.opRevisionId) return {ok: true, revisionId: m.opRevisionId, already: true}; // idempotent: one refresh at a time
    if ((OP_BUSY as readonly string[]).includes(m.status) || m.status === "rolling_back" || m.status === "refreshing") return deny("mirror_busy");
    if (m.status !== "ready" || !m.activeRevisionId || !m.runnerAgentId) return deny("mirror_state_invalid");
    if (req.confirmName !== m.name) return deny("confirmation_mismatch");
    const [activeRev] = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, m.activeRevisionId));
    const [stack] = await d.db.select().from(forkStack).where(eq(forkStack.id, m.stackId));
    const [rp] = await d.db.select().from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, req.rpId));
    if (!activeRev || !stack || stack.organizationId !== orgId || !rp || rp.stackId !== m.stackId) return deny("not_found");
    if (rp.purgedAt !== null) return deny("rp_purged");
    if (rp.status !== RP_STATUSES[2]) return deny("rp_not_verified");
    if (!(Number(rp.sequence) > Number(activeRev.rpSequence))) return deny("rp_not_newer"); // OD-W24-2: strictly newer only
    if (stack.containsPersonalData !== false && !req.acknowledgePrivacy) return deny("privacy_ack_required");
    const runnerId = m.runnerAgentId;
    const el = await assertRunnerTarget(d.db, runnerId);
    if (!el.ok) return deny("runner_ineligible", {detail: el.code});
    const iso = await runnerIsolation(d.db, runnerId, {now, maxAgeMs: RUNNER_PRECHECK_MAX_AGE_MS, serverUrl: d.serverUrl()});
    if (iso.state !== "isolated" || (await adminTargetCount(d.db, runnerId)) < 1) return deny("runner_not_isolated", {isolation: iso.state});

    const [{seq: maxSeq}] = await d.db.select({seq: sql<number>`coalesce(max(${forkMirrorRevision.seq}), 0)::int`}).from(forkMirrorRevision).where(eq(forkMirrorRevision.mirrorId, m.id)) as [{seq: number}];
    const seq = Number(maxSeq) + 1;
    const project = `pbm-${m.name}-r${seq}`;
    const root = forkEnv().FORK_MIRROR_ROOT;
    const plan = await mirrorPlan(d, d.db, {rpId: req.rpId, runnerAgentId: runnerId, project, organizationId: orgId, now});
    if (!plan.ok) return deny(plan.code, {rpId: req.rpId});
    const {plan: pl, planHash, inputsDigest} = plan.result;
    if (pl.outcome !== "ready") return deny("plan_blocked", {rpId: req.rpId}, {blockers: pl.blockers.slice(0, 20)}); // nothing is written for a refused refresh
    const revisionId = randomUUID();
    const workspace = `${root}/${project}`;

    type Created = {ok: true; hostPort: number; routePort: number} | {ok: true; already: string} | {ok: false; code: MirrorRefusalCode};
    let created: Created;
    try {
        created = await withForkLock(d.db, `runner:${runnerId}`, async (tx): Promise<Created> => {
            // a concurrent refresh of THIS mirror that got the lock first: idempotent answer (same revision), nothing new is written
            const [cur] = await tx.select({status: forkMirror.status, op: forkMirror.opRevisionId}).from(forkMirror).where(eq(forkMirror.id, m.id));
            if (cur?.status === "refreshing" && cur.op) return {ok: true, already: cur.op};
            const [busy] = await tx.select({n: sql<number>`count(*)::int`}).from(forkMirrorRevision).where(and(eq(forkMirrorRevision.runnerAgentId, runnerId), inArray(forkMirrorRevision.state, [...ACTIVE_REVISION_STATES])));
            if (Number(busy?.n ?? 0) > 0) return {ok: false, code: "runner_busy"};
            const used = await usedPorts(tx, runnerId);
            const port = allocatePort(used, d.portRange ?? PORT_RANGE);
            if (port === null) return {ok: false, code: "port_unavailable"};
            const routePort = m.routePort ?? allocatePort([...used, port], d.portRange ?? PORT_RANGE);
            if (routePort === null) return {ok: false, code: "port_unavailable"};
            const expiresAt = new Date(now.getTime() + forkEnv().FORK_RESTORE_PLAN_TTL_HOURS * 3_600_000);
            const [planRow] = await tx.insert(forkRestorePlan).values({
                organizationId: orgId, stackId: m.stackId, rpId: req.rpId, rpSequence: pl.rp.sequence, targetAgentId: runnerId, targetAgentName: pl.target.agent_name, purpose: "mirror", mode: "new_stack",
                planVersion: PLAN_VERSION, mappings: {target_project: project, restore_root: root, volumes: null, select: null, sqlite: null}, plan: pl, planHash, inputsDigest, outcome: pl.outcome, approvals: [], createdBy: p.userId, createdAt: now, expiresAt,
            }).returning({id: forkRestorePlan.id});
            // the per-mirror lock: only a READY mirror moves to `refreshing` (0 rows ⇒ somebody else got there first ⇒ the whole transaction rolls back, nothing is left behind).
            // The revision row goes first: `op_revision_id` is a foreign key checked immediately.
            const planning = transition("requested", "planning");
            const next = transition(planning, "validating");
            await tx.insert(forkMirrorRevision).values({
                id: revisionId, mirrorId: m.id, organizationId: orgId, stackId: m.stackId, seq, rpId: req.rpId, rpSequence: pl.rp.sequence, planId: planRow.id, planHash, runnerAgentId: runnerId,
                project, workspace, hostPort: port, startedBy: p.userId, createdAt: now, deadlineAt: new Date(now.getTime() + maxRunMsOf(d)), updatedAt: now, state: next, steps: initialSteps(deriveMirrorSteps(pl)),
            });
            const cas = await tx.update(forkMirror).set({status: nextMirrorStatus("ready", "refresh_requested"), opRevisionId: revisionId, routePort, updatedAt: now}).where(and(eq(forkMirror.id, m.id), eq(forkMirror.status, "ready"))).returning({id: forkMirror.id});
            if (cas.length !== 1) throw new CasLost();
            await addEvent(tx, {mirrorId: m.id, revisionId, kind: "requested", at: now, toState: "requested", actor: {userId: p.userId}});
            await addEvent(tx, {mirrorId: m.id, revisionId, kind: "state_changed", at: now, fromState: "requested", toState: planning});
            await addEvent(tx, {mirrorId: m.id, revisionId, kind: "state_changed", at: now, fromState: planning, toState: next});
            await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "state_changed", at: now, fromState: "ready", toState: "refreshing", actor: {userId: p.userId}, details: {scope: "mirror", revisionId}});
            await recordAudit(tx, {organizationId: orgId, actorUserId: p.userId, action: "fork.mirror.refresh", resourceType: "mirror", resourceId: m.id, result: "success", now,
                details: {phase: "requested", revisionId, fromRevisionId: m.activeRevisionId, rpId: req.rpId, rpSequence: pl.rp.sequence, hostPort: port, routePort}});
            return {ok: true, hostPort: port, routePort};
        });
    } catch (e) {
        if (e instanceof CasLost || isUniqueViolation(e, "fork_mirror_revision_one_active_mirror_uq")) return deny("mirror_busy");
        throw e;
    }
    if (!created.ok) return deny(created.code);
    if ("already" in created) return {ok: true, revisionId: created.already, already: true};
    return {ok: true, revisionId};
}

/**
 * Rollback: re-activate the previous retained revision (an earlier READY, stopped, not retired one that was active before). The lifecycle tick re-gates it (own isolation probe, `mirror_up`,
 * health + app smoke), switches the route back, commits, and the rolled-back revision is wiped (verified). The active revision keeps serving until the commit.
 */
export async function rollbackMirror(d: MirrorDeps, raw: unknown): Promise<{ok: true; already?: true} | MirrorRefusal> {
    const input = RollbackMirrorRequest.safeParse(raw);
    const p = d.principal;
    if (!p) return refuse("forbidden");
    const audit = auditor(d, "fork.mirror.rollback", "mirror", input.success ? input.data.mirrorId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return refuse("invalid_input"); }
    const req = input.data;
    if (!(await allowed(d))) { await audit("denied", {reason: "locked"}); return refuse("locked"); }
    const g = await gate(d, "mirrors.manage", "mirror", req.mirrorId, audit);
    if (!g.ok) return g;
    const orgId = g.organizationId;
    const deny = async (code: MirrorRefusalCode, extra: Partial<MirrorRefusal> = {}): Promise<MirrorRefusal> => { await audit("denied", {reason: code}, orgId); return refuse(code, extra); };
    if (!enabledOf(d)) return deny("mirrors_disabled");
    const now = nowOf(d);
    const rl = (d.rate ?? checkRate)(`mirror-op:${p.userId}`, MIRROR_OP_RATE.limit, MIRROR_OP_RATE.windowMs, now.getTime());
    if (!rl.ok) return deny("rate_limited", {retryAfterSeconds: rl.retryAfterSeconds});
    const [m] = await d.db.select().from(forkMirror).where(eq(forkMirror.id, req.mirrorId));
    if (!m || m.deletedAt) return refuse("not_found");
    if (m.status === "rolling_back") return {ok: true, already: true}; // idempotent
    if ((OP_BUSY as readonly string[]).includes(m.status) || m.status === "refreshing") return deny("mirror_busy");
    if (m.status !== "ready" || !m.activeRevisionId || !m.runnerAgentId) return deny("mirror_state_invalid");
    if (req.confirmName !== m.name) return deny("confirmation_mismatch");
    const [t] = await d.db.select().from(forkMirrorRevision).where(and(eq(forkMirrorRevision.id, req.revisionId), eq(forkMirrorRevision.mirrorId, m.id)));
    if (!t || t.id === m.activeRevisionId || t.state !== "ready" || t.activatedAt === null || t.retiredAt !== null || t.wipeState !== null) return deny("no_rollback_target");
    const runnerId = m.runnerAgentId;
    const el = await assertRunnerTarget(d.db, runnerId);
    if (!el.ok) return deny("runner_ineligible");
    const iso = await runnerIsolation(d.db, runnerId, {now, maxAgeMs: RUNNER_PRECHECK_MAX_AGE_MS, serverUrl: d.serverUrl()});
    if (iso.state !== "isolated" || (await adminTargetCount(d.db, runnerId)) < 1) return deny("runner_not_isolated");
    // lock order: runner, then the mirror CAS (the route port is allocated under the runner lock when the mirror has none yet)
    const done = await withForkLock(d.db, `runner:${runnerId}`, async (tx) => {
        const routePort = m.routePort ?? allocatePort(await usedPorts(tx, runnerId), d.portRange ?? PORT_RANGE);
        if (routePort === null) return "port" as const;
        const rows = await tx.update(forkMirror).set({status: nextMirrorStatus("ready", "rollback_requested"), opRevisionId: t.id, routePort, updatedAt: now}).where(and(eq(forkMirror.id, m.id), eq(forkMirror.status, "ready"))).returning({id: forkMirror.id});
        if (rows.length !== 1) return "lost" as const;
        await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "state_changed", at: now, fromState: "ready", toState: "rolling_back", actor: {userId: p.userId}, details: {scope: "mirror", revisionId: t.id}});
        await recordAudit(tx, {organizationId: orgId, actorUserId: p.userId, action: "fork.mirror.rollback", resourceType: "mirror", resourceId: m.id, result: "success", now, details: {phase: "requested", revisionId: t.id, fromRevisionId: m.activeRevisionId, routePort}});
        return "ok" as const;
    });
    if (done === "port") return deny("port_unavailable");
    if (done === "lost") return deny("mirror_busy");
    return {ok: true};
}

// ---- read model + access ------------------------------------------------------------------------------------------------------------------
export async function getMirrorView(d: MirrorDeps, raw: unknown): Promise<{ok: true; view: MirrorView} | MirrorRefusal> {
    const input = MirrorIdRequest.safeParse(raw);
    if (!d.principal) return refuse("forbidden");
    if (!input.success) return refuse("invalid_input");
    const audit = auditor(d, "fork.mirror.view", "mirror", input.data.mirrorId);
    const g = await gate(d, "mirrors.view", "mirror", input.data.mirrorId, audit);
    if (!g.ok) return g;
    const [m] = await d.db.select().from(forkMirror).where(eq(forkMirror.id, input.data.mirrorId));
    if (!m) return refuse("not_found");
    const revs = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.mirrorId, m.id));
    const [stack] = await d.db.select({pd: forkStack.containsPersonalData, opt: forkStack.mirrorOptInAt}).from(forkStack).where(eq(forkStack.id, m.stackId));
    return {ok: true, view: toMirrorView(m, revs, {containsPersonalData: stack?.pd ?? null, optIn: (stack?.opt ?? null) !== null}, nowOf(d))};
}

/** Loopback + SSH tunnel info: only for a READY mirror, audited on every read (the port is the only way in; there is no proxy, ADR-009 §9). */
export async function getMirrorAccess(d: MirrorDeps, raw: unknown): Promise<{ok: true; access: {runnerName: string; hostPort: number; service: string; target: number; tunnelHint: string}} | MirrorRefusal> {
    const input = MirrorIdRequest.safeParse(raw);
    if (!d.principal) return refuse("forbidden");
    if (!input.success) return refuse("invalid_input");
    const audit = auditor(d, "fork.mirror.access_view", "mirror", input.data.mirrorId);
    const g = await gate(d, "mirrors.view", "mirror", input.data.mirrorId, audit);
    if (!g.ok) return g;
    const [m] = await d.db.select().from(forkMirror).where(eq(forkMirror.id, input.data.mirrorId));
    // W24: the active revision keeps serving while a refresh / rollback runs
    if (!m || !["ready", "refreshing", "rolling_back"].includes(m.status) || !m.activeRevisionId) { await audit("denied", {reason: "mirror_not_ready"}, g.organizationId); return refuse("mirror_not_ready"); }
    const [rev] = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, m.activeRevisionId));
    const pol = m.policy as {access?: {service?: string; target?: number}};
    if (!rev || rev.state !== ("ready" satisfies RevisionState) || !pol.access?.service || typeof pol.access.target !== "number") { await audit("denied", {reason: "mirror_not_ready"}, g.organizationId); return refuse("mirror_not_ready"); }
    // W24 (DD-4): the stable route port, but ONLY while the runner confirmed the route points at the ACTIVE revision; otherwise the revision's own loopback port
    const viaRoute = m.routePort !== null && m.routeRevisionId === m.activeRevisionId;
    const port = viaRoute ? (m.routePort as number) : rev.hostPort;
    await audit("success", {revisionId: rev.id, hostPort: port, via: viaRoute ? "route" : "revision"}, g.organizationId);
    return {ok: true, access: {runnerName: m.runnerAgentName, hostPort: port, service: pol.access.service, target: pol.access.target,
        tunnelHint: `ssh -L ${port}:127.0.0.1:${port} <your-user>@<address of ${m.runnerAgentName}>, then open http://127.0.0.1:${port}/`}};
}
