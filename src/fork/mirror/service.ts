import {randomUUID} from "node:crypto";
import {and, eq, inArray, isNull, sql} from "drizzle-orm";
import {z} from "zod";
import {actorIn, ForkForbiddenError, ForkNotFoundError, forkCan, type ForkPrincipal, type ForkResourceKind} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkMirror, forkMirrorRevision} from "@/fork/db/schema/mirror";
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
import {runnerIsolation, assertRunnerTarget} from "@/fork/runner/service";
import {initialSteps} from "@/fork/runs/engine";
import {allocatePort, deriveMirrorSteps} from "./derive";
import {maxRunMsOf, enabledOf, nowOf, type MirrorDeps} from "./deps";
import {addEvent} from "./events";
import {transition} from "./machine";
import {MirrorPolicyInput, resolvePolicy} from "./policy";
import {toMirrorView, type MirrorView} from "./view";
import {ACTIVE_REVISION_STATES, keepConfirmPhrase, PORT_RANGE, REFUSAL_MESSAGES, RUNNER_PRECHECK_MAX_AGE_MS, WIPE_REVISION_STATES, type RevisionState} from "./vocab";

/**
 * W22a services (plan A8). ONE pipeline like W18a: signed-in principal → strict input → config lock → resource-scoped capability (SEC-12: unknown and foreign resources are indistinguishable)
 * → feature flag (after the ACL, like W21) → rate limit → work → audit (`fork.mirror.*`, closed reasons, ids/hashes/codes/counts only: never a path, URL, manifest, payload, env key or value).
 */
export type MirrorRefusalCode = "forbidden" | "not_found" | "invalid_input" | "locked" | "rate_limited" | "mirrors_disabled" | "privacy_ack_required" | "confirmation_mismatch" | "runner_ineligible"
    | "runner_not_isolated" | "runner_busy" | "name_taken" | "port_unavailable" | "rp_not_verified" | "mirror_not_ready" | "plan_blocked" | "not_active" | "mirror_mode_invalid" | "mirror_target_not_runner"
    | "personal_data_no_mirror_opt_in" | "not_failed" | "rp_purged";
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
    if (!(WIPE_REVISION_STATES as readonly string[]).includes(rev.state) || rev.wipeState !== "failed") { await audit("denied", {reason: "not_failed", state: rev.state, wipeState: rev.wipeState}, g.organizationId); return refuse("not_failed"); }
    const now = nowOf(d);
    await d.db.update(forkMirrorRevision).set({wipeState: null, wipeReason: null, wipeStartedAt: null, wipeFinishedAt: null, updatedAt: now}).where(and(eq(forkMirrorRevision.id, rev.id), eq(forkMirrorRevision.wipeState, "failed")));
    await audit("success", {revisionId: rev.id}, g.organizationId);
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
    return {ok: true, view: toMirrorView(m, revs, {containsPersonalData: stack?.pd ?? null, optIn: (stack?.opt ?? null) !== null})};
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
    if (!m || m.status !== "ready" || !m.activeRevisionId) { await audit("denied", {reason: "mirror_not_ready"}, g.organizationId); return refuse("mirror_not_ready"); }
    const [rev] = await d.db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, m.activeRevisionId));
    const pol = m.policy as {access?: {service?: string; target?: number}};
    if (!rev || rev.state !== ("ready" satisfies RevisionState) || !pol.access?.service || typeof pol.access.target !== "number") { await audit("denied", {reason: "mirror_not_ready"}, g.organizationId); return refuse("mirror_not_ready"); }
    await audit("success", {revisionId: rev.id, hostPort: rev.hostPort}, g.organizationId);
    return {ok: true, access: {runnerName: m.runnerAgentName, hostPort: rev.hostPort, service: pol.access.service, target: pol.access.target,
        tunnelHint: `ssh -L ${rev.hostPort}:127.0.0.1:${rev.hostPort} <your-user>@<address of ${m.runnerAgentName}>, then open http://127.0.0.1:${rev.hostPort}/`}};
}
