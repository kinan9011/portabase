import {and, desc, eq} from "drizzle-orm";
import type {ForkPrincipal} from "@/fork/acl";
import {expireQueuedTask} from "@/fork/agent-channel/tasks";
import {recordAudit} from "@/fork/audit";
import {compileMirror, type MirrorSpecV1} from "@/fork/compose-compiler/compile";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkMirror, forkMirrorRevision, forkMirrorTask} from "@/fork/db/schema/mirror";
import {forkRecoveryPoint} from "@/fork/db/schema/recovery";
import {forkRunner} from "@/fork/db/schema/runner";
import {RULES_SHA256} from "@/fork/policy/rules";
import type {RawResult} from "@/fork/policy/raw";
import type {RestorePlanV1} from "@/fork/restore/schema";
import type {PlanRow} from "@/fork/restore/service";
import {checkProbe, checkStage} from "@/fork/restore-run/derive";
import {defaultManifestFetch, type ManifestBundle} from "@/fork/restore-run/manifest";
import {resolveManifest} from "@/fork/restore-tasks/enqueue";
import {latestRender} from "@/fork/restore-tasks/render";
import {adminTargetCount, runnerIsolation, startRunnerProbe, assertRunnerTarget} from "@/fork/runner/service";
import {done, fail, wait, type Handlers, type StepOutcome, type StepRecord} from "@/fork/runs/engine";
import {RP_STATUSES} from "@/fork/recovery/status";
import {checkDbStep, checkFinalView, checkHealth, checkKept, checkSmoke, type Check} from "./derive";
import {enabledOf, nowOf, type MirrorDeps} from "./deps";
import {addEvent} from "./events";
import {enqueueMirrorTask, TRANSIENT_ENQUEUE_CODES, type EnqueueArgs, type MirrorTaskDeps} from "./enqueue";
import {MirrorCheckResult, MirrorDbResult, MirrorFinalizeResult, MirrorUpResult} from "./payload-schema";
import type {MirrorPolicyV1} from "./policy";
import {GATES, MAX_EXPIRED_REENQUEUES, type Gate, type MirrorJournalStep, type MirrorStep, STEP_TASK_TYPE} from "./vocab";

/**
 * Step handlers of the W22a mirror orchestrator on the W12 engine. A handler is IDEMPOTENT: it derives "what to do" from the step journal (`fork_mirror_task`, written inside the
 * enqueue transaction) and the task row, never from memory. One agent task per step at a time. The `activate` handler only VERIFIES the gates; the READY transition itself
 * (with the start-tested fact) is `activateRevision` in tick.ts, in one locked transaction after the last step is done.
 */
export type RevRow = typeof forkMirrorRevision.$inferSelect;
export type MirrorRow = typeof forkMirror.$inferSelect;
export type RevCtx = {
    d: MirrorDeps; rev: RevRow; mirror: MirrorRow; plan: RestorePlanV1; planRow: PlanRow; policy: MirrorPolicyV1; principal: ForkPrincipal; now: Date;
    /** Per-tick memo of the signed manifest bytes (never persisted, never logged). */
    memo: {manifest?: ManifestBundle | null};
};
export const MANIFEST_FETCH_ATTEMPTS = 30;
const REASON_RE = /^[a-z_]{1,64}$/;

export type JournalRow = {revisionId: string; step: string; attempt: number; taskId: string | null; createdAt: Date; task: {status: string; attempts: number; result: unknown; notAfter: Date} | null};

export async function journalRows(db: ForkDb, revisionId: string, step: MirrorJournalStep): Promise<JournalRow[]> {
    const rows = await db.select({j: forkMirrorTask, t: {status: forkAgentTask.status, attempts: forkAgentTask.attempts, result: forkAgentTask.result, notAfter: forkAgentTask.notAfter}})
        .from(forkMirrorTask).leftJoin(forkAgentTask, eq(forkAgentTask.id, forkMirrorTask.taskId))
        .where(and(eq(forkMirrorTask.revisionId, revisionId), eq(forkMirrorTask.step, step))).orderBy(desc(forkMirrorTask.attempt));
    return rows.map((r) => ({revisionId, step, attempt: r.j.attempt, taskId: r.j.taskId, createdAt: r.j.createdAt, task: r.t && r.t.status ? r.t : null}));
}

/** Task deps for one enqueue: acts as the revision's STARTER and writes the journal row in the enqueue transaction. */
export function taskDeps(d: MirrorDeps, a: {principal: ForkPrincipal | null; now: Date; revisionId: string; step: MirrorJournalStep; attempt: number}): MirrorTaskDeps {
    const {manifest: _m, principalOf: _p, maxRunMs: _x, owner: _o, mirrorsEnabled: _e, resolve: _r, portRange: _pr, ...channel} = d;
    return {
        ...channel, principal: a.principal, now: () => a.now,
        onTaskInserted: async (tx, t) => {
            await tx.insert(forkMirrorTask).values({revisionId: a.revisionId, step: a.step, attempt: a.attempt, taskType: t.type, taskId: t.taskId, createdAt: a.now});
        },
    };
}

const refusalOutcome = (code: string): StepOutcome => (TRANSIENT_ENQUEUE_CODES.includes(code) ? wait() : fail(code === "forbidden" ? "reauth_failed" : REASON_RE.test(code) ? code : "internal_error"));
export const agentReason = (result: unknown): string => {
    const r = (result as {reason?: unknown} | null)?.reason;
    return typeof r === "string" && REASON_RE.test(r) ? r : "execution_error";
};

async function manifestOf(ctx: RevCtx): Promise<ManifestBundle | null> {
    if (ctx.memo.manifest !== undefined) return ctx.memo.manifest;
    const [rp] = ctx.rev.rpId ? await ctx.d.db.select({manifestRefs: forkRecoveryPoint.manifestRefs}).from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, ctx.rev.rpId)) : [];
    if (!rp) { ctx.memo.manifest = null; return null; }
    const fetch = ctx.d.manifest ?? defaultManifestFetch(ctx.d.db);
    ctx.memo.manifest = await fetch({id: ctx.plan.rp.id, stackId: ctx.plan.rp.stack_id, manifestRefs: rp.manifestRefs});
    return ctx.memo.manifest;
}

const patchRev = async (ctx: RevCtx, patch: Partial<typeof forkMirrorRevision.$inferInsert>): Promise<void> => {
    await ctx.d.db.update(forkMirrorRevision).set({...patch, updatedAt: ctx.now}).where(eq(forkMirrorRevision.id, ctx.rev.id));
    ctx.rev = {...ctx.rev, ...(patch as Partial<RevRow>)};
};

export type GateRecord = {ok: boolean; code: string | null; at: string};
export const gatesOf = (rev: Pick<RevRow, "gates">): Partial<Record<Gate, GateRecord>> => (rev.gates && typeof rev.gates === "object" ? (rev.gates as Partial<Record<Gate, GateRecord>>) : {});

async function setGate(ctx: RevCtx, gate: Gate, ok: boolean, code: string | null = null): Promise<void> {
    const cur = gatesOf(ctx.rev)[gate];
    if (cur && cur.ok === ok && cur.code === code) return;
    await patchRev(ctx, {gates: {...gatesOf(ctx.rev), [gate]: {ok, code, at: ctx.now.toISOString()}}});
    await addEvent(ctx.d.db, {mirrorId: ctx.rev.mirrorId, revisionId: ctx.rev.id, kind: ok ? "gate_passed" : "gate_failed", at: ctx.now, code, details: {gate}});
}

type TaskStepOpts = {
    step: Exclude<MirrorJournalStep, "wipe" | "wipe_check" | "isolation">;
    /** the manifest bundle is fetched and passed when `manifest: true` */
    manifest: boolean;
    args: () => Partial<Omit<EnqueueArgs, "revision" | "plan" | "step" | "attempt" | "manifest">>;
    check?: (result: unknown, last: JournalRow) => Promise<Check | StepOutcome> | Check | StepOutcome;
};
const isOutcome = (x: Check | StepOutcome): x is StepOutcome => "kind" in x;

export const revisionOf = (rev: RevRow) => ({id: rev.id, mirrorId: rev.mirrorId, organizationId: rev.organizationId, planId: rev.planId, planHash: rev.planHash, runnerAgentId: rev.runnerAgentId, startedBy: rev.startedBy, workspace: rev.workspace});

async function taskStep(ctx: RevCtx, o: TaskStepOpts): Promise<StepOutcome> {
    const rows = await journalRows(ctx.d.db, ctx.rev.id, o.step);
    const last = rows[0];
    // an OFFLINE agent never polls, so nothing else would ever expire its never-started task: do it here (the budget below then ends in `agent_offline`)
    if (last?.task?.status === "queued" && last.task.attempts === 0 && last.taskId && ctx.rev.runnerAgentId && last.task.notAfter.getTime() < ctx.now.getTime()
        && (await expireQueuedTask(ctx.d.db, {taskId: last.taskId, agentId: ctx.rev.runnerAgentId, now: ctx.now}))) last.task.status = "expired";
    const enqueue = async (): Promise<StepOutcome> => {
        let m: ManifestBundle | null = null;
        if (o.manifest) {
            m = await manifestOf(ctx);
            if (!m) return wait(); // storage unreachable right now: retry next tick (bounded by the revision deadline)
        }
        const attempt = (last?.attempt ?? 0) + 1;
        const res = await enqueueMirrorTask(taskDeps(ctx.d, {principal: ctx.principal, now: ctx.now, revisionId: ctx.rev.id, step: o.step, attempt}),
            {revision: revisionOf(ctx.rev), plan: ctx.plan, step: o.step, attempt, ...(m ? {manifest: {json: m.json, sigB64: m.sigB64}} : {}), ...o.args()});
        return res.ok ? wait() : refusalOutcome(res.code);
    };
    if (!last) return enqueue();
    if (!last.task) return fail("internal_error"); // the task row is gone (agent deleted): nothing to wait for
    switch (last.task.status) {
        case "queued": case "leased": case "running": return wait();
        case "succeeded": {
            const c = o.check ? await o.check(last.task.result, last) : ({ok: true} as Check);
            if (isOutcome(c)) return c;
            return c.ok ? done() : fail(c.code);
        }
        case "failed": case "rejected": return fail(agentReason(last.task.result));
        case "expired": {
            const expired = rows.filter((r) => r.task?.status === "expired").length;
            return expired >= MAX_EXPIRED_REENQUEUES ? fail("agent_offline") : enqueue();
        }
        case "cancelled": return fail("task_cancelled");
        default: return fail("internal_error");
    }
}

const accessOf = (ctx: RevCtx) => ({service: ctx.policy.access.service, target: ctx.policy.access.target, host_port: ctx.rev.hostPort});
const specOf = (rev: RevRow): MirrorSpecV1 | null => (rev.spec && typeof rev.spec === "object" ? (rev.spec as MirrorSpecV1) : null);
const dbsOf = (plan: RestorePlanV1) => plan.actions.filter((a) => a.op !== "skip" && a.kind === "restore_db_dump" && a.source.dbms === "postgresql" && a.destination.kind === "db_service").length;

/** Newest successful render of a type, only if it belongs to the journaled task of that step. */
async function ownRender(ctx: RevCtx, type: "mirror_render" | "mirror_finalize", taskId: string | null) {
    if (!ctx.rev.runnerAgentId) return null;
    const row = await latestRender(ctx.d.db, {restoreId: ctx.rev.id, agentId: ctx.rev.runnerAgentId, type});
    return row && row.taskId === taskId ? row : null;
}

export function handlers(ctx0: RevCtx): Handlers<MirrorStep, RevCtx> {
    const on = (h: (c: RevCtx) => Promise<StepOutcome>) => async (c: RevCtx): Promise<StepOutcome> => (enabledOf(c.d) ? h(c) : wait()); // flag off ⇒ no forward step (the deadline + the wipe still run)
    void ctx0;
    return {
        verify_manifest: on(async (c) => {
            const m = await manifestOf(c);
            if (!m) {
                const attempts = (c.rev.steps as {name: string; attempts: number}[]).find((s) => s.name === "verify_manifest")?.attempts ?? 0;
                return attempts >= MANIFEST_FETCH_ATTEMPTS ? fail("manifest_unavailable") : wait();
            }
            const r = await resolveManifest({...c.d, principal: c.principal} as never, c.plan, m);
            return "code" in r ? fail(r.code) : done();
        }),
        probe: on((c) => taskStep(c, {step: "probe", manifest: false, args: () => ({}), check: (result) => checkProbe(result, c.plan, RULES_SHA256)})),
        stage: on((c) => taskStep(c, {step: "stage", manifest: true, args: () => ({}), check: (result) => checkStage(result, c.plan)})),
        apply: on((c) => taskStep(c, {step: "apply", manifest: true, args: () => ({})})),
        render: on((c) => taskStep(c, {
            step: "render", manifest: true, args: () => ({}),
            check: async (_r, last) => {
                const row = await ownRender(c, "mirror_render", last.taskId);
                if (!row) return fail("render_missing");
                await patchRev(c, {sourceViewSha256: row.renderedSha256});
                return {ok: true};
            },
        })),
        // no task: the W20 compiler turns the value-free pass-1 view + the operator's policy into a hash-bound spec. Hard policy findings are compile refusals (blocked, never started).
        compile: on(async (c) => {
            if (!c.rev.runnerAgentId) return fail("runner_ineligible");
            const [last] = await journalRows(c.d.db, c.rev.id, "render");
            const row = await ownRender(c, "mirror_render", last?.taskId ?? null);
            if (!row) return fail("render_missing");
            const r = compileMirror({view: row.policyView, raw: row.raw as RawResult, options: {project: c.plan.target.project, workspace: c.rev.workspace, access: accessOf(c), env: c.policy.env}});
            if (!r.ok) {
                const refusals = r.refusals.slice(0, 20).map((x) => ({code: x.code, service: x.service ?? null, detail: String(x.detail ?? "").slice(0, 128)}));
                await patchRev(c, {refusals});
                await recordAudit(c.d.db, {organizationId: c.rev.organizationId, actorKind: "system", action: "fork.mirror.compiled", resourceType: "mirror", resourceId: c.rev.mirrorId, result: "denied", now: c.now,
                    details: {revisionId: c.rev.id, refusals: refusals.map((x) => x.code).slice(0, 20)}});
                return fail("compile_refused");
            }
            if (!checkKept(r.spec, c.policy.kept_confirmed)) { await patchRev(c, {refusals: [{code: "kept_secret_unconfirmed", service: null, detail: ""}]}); return fail("kept_secret_unconfirmed"); }
            if (Buffer.byteLength(JSON.stringify(r.spec)) > 262144) return fail("payload_too_large"); // honest: a spec this large cannot travel in one task (R-6)
            await patchRev(c, {spec: r.spec, specSha256: r.spec_sha256});
            await recordAudit(c.d.db, {organizationId: c.rev.organizationId, actorKind: "system", action: "fork.mirror.compiled", resourceType: "mirror", resourceId: c.rev.mirrorId, result: "success", now: c.now,
                details: {revisionId: c.rev.id, specSha256: r.spec_sha256, kept: r.spec.kept_production_secrets.length, resets: r.spec.credential_resets.length, diffLines: r.diff.length}});
            return done();
        }),
        finalize: on((c) => taskStep(c, {
            step: "finalize", manifest: true,
            args: () => ({spec: specOf(c.rev) ?? undefined, specSha256: c.rev.specSha256 ?? undefined, policy: c.policy}),
            check: async (result, last) => {
                const res = MirrorFinalizeResult.safeParse(result);
                const fin = await ownRender(c, "mirror_finalize", last.taskId);
                const [pass1] = await journalRows(c.d.db, c.rev.id, "render");
                const src = await ownRender(c, "mirror_render", pass1?.taskId ?? null);
                if (!res.success || !fin || !src || fin.renderedSha256 !== res.data.view_sha256) return fail(!res.success || !fin ? "final_view_invalid" : "render_missing");
                const v = checkFinalView(fin.policyView, {project: c.plan.target.project, workspace: c.rev.workspace, access: accessOf(c), sourceViewText: src.policyView, limits: c.policy.limits});
                if (!v.ok) { await setGate(c, "side_effects", false, v.code); return fail(v.code); }
                await patchRev(c, {finalViewSha256: fin.renderedSha256});
                await setGate(c, "side_effects", true);
                return {ok: true};
            },
        })),
        restore_db: on(async (c) => {
            const spec = specOf(c.rev);
            if (!spec) return fail("internal_error");
            const dbs = dbsOf(c.plan), resets = spec.credential_resets.length;
            if (dbs + resets === 0) { await setGate(c, "expected_data", true); return done(); }
            return taskStep(c, {
                step: "restore_db", manifest: true, args: () => ({spec, finalSha256: c.rev.finalViewSha256 ?? undefined}),
                check: async (result) => {
                    const chk = checkDbStep(result, dbs, resets);
                    if (chk.ok && MirrorDbResult.safeParse(result).success) await setGate(c, "expected_data", true);
                    return chk;
                },
            });
        }),
        up: on((c) => taskStep(c, {
            step: "up", manifest: false, args: () => ({finalSha256: c.rev.finalViewSha256 ?? undefined}),
            check: async (result) => {
                const r = MirrorUpResult.safeParse(result);
                if (!r.success) return fail("execution_error");
                await patchRev(c, {services: r.data.services});
                return {ok: true};
            },
        })),
        check: on((c) => taskStep(c, {
            step: "check", manifest: false, args: () => ({finalSha256: c.rev.finalViewSha256 ?? undefined, policy: c.policy}),
            check: async (result, last) => {
                const fin = await ownRender(c, "mirror_finalize", (await journalRows(c.d.db, c.rev.id, "finalize"))[0]?.taskId ?? null);
                const expected = fin ? Object.keys(((JSON.parse(fin.policyView) as {services?: Record<string, unknown>}).services) ?? {}) : [];
                void last;
                const parsed = MirrorCheckResult.safeParse(result);
                if (parsed.success) await patchRev(c, {services: parsed.data.services.map((s) => ({service: s.service, state: s.state, health: s.health}))});
                const health = checkHealth(result, expected);
                await setGate(c, "db_health", health.ok, health.ok ? null : health.code);
                if (!health.ok) return health;
                const smoke = checkSmoke(result, c.policy);
                await setGate(c, "app_smoke", smoke.ok, smoke.ok ? null : smoke.code);
                return smoke;
            },
        })),
        isolation: on((c) => isolationStep(c)),
        activate: on(async (c) => {
            const g = await evaluateGates(c.d.db, c.d, c.rev, c.now);
            return g.ok ? done() : fail(g.code);
        }),
    };
}

/** READY isolation (ADR-016 / OD-W22a-7): a probe enqueued BY THIS revision's isolation step, evaluated after the step started, with ≥ 1 admin target. */
async function isolationStep(c: RevCtx): Promise<StepOutcome> {
    const agentId = c.rev.runnerAgentId;
    if (!agentId) return fail("runner_ineligible");
    const rows = await journalRows(c.d.db, c.rev.id, "isolation");
    const last = rows[0];
    const startedAt = (c.rev.steps as StepRecord<MirrorStep>[]).find((s) => s.name === "isolation")?.startedAt;
    const stepStart = startedAt ? new Date(startedAt) : c.now;
    const enqueue = async (): Promise<StepOutcome> => {
        if ((await adminTargetCount(c.d.db, agentId)) < 1) { await setGate(c, "isolation", false, "no_admin_targets"); return fail("runner_not_isolated"); }
        const attempt = (last?.attempt ?? 0) + 1;
        const r = await startRunnerProbe({...c.d, mirrorsEnabled: () => true} as never, {
            agentId, agentName: c.rev.runnerAgentId ? c.mirror.runnerAgentName : "", actorUserId: c.rev.startedBy, organizationId: c.rev.organizationId, trigger: "mirror",
            onInserted: async (tx, taskId) => {
                await tx.insert(forkMirrorTask).values({revisionId: c.rev.id, step: "isolation", attempt, taskType: STEP_TASK_TYPE.isolation, taskId, createdAt: c.now});
                await tx.update(forkMirrorRevision).set({probeTaskId: taskId, updatedAt: c.now}).where(eq(forkMirrorRevision.id, c.rev.id));
            },
        });
        if (r.ok) return wait();
        if (r.code === "probe_in_progress" || r.code === "signing_unavailable") return wait();
        return fail(REASON_RE.test(r.code) ? r.code : "internal_error");
    };
    if (!last) return enqueue();
    if (!last.task) return fail("internal_error");
    switch (last.task.status) {
        case "queued": case "leased": case "running": return wait();
        case "failed": case "rejected": return fail(agentReason(last.task.result));
        case "cancelled": return fail("task_cancelled");
        case "expired": return rows.filter((r) => r.task?.status === "expired").length >= MAX_EXPIRED_REENQUEUES ? fail("agent_offline") : enqueue();
        case "succeeded": break;
        default: return fail("internal_error");
    }
    const iso = await runnerIsolation(c.d.db, agentId, {now: c.now, maxAgeMs: Math.max(0, c.now.getTime() - stepStart.getTime()) + 60_000, serverUrl: c.d.serverUrl()});
    const [fr] = await c.d.db.select({taskId: forkRunner.lastProbeTaskId}).from(forkRunner).where(eq(forkRunner.agentId, agentId));
    if (iso.state === "isolated") {
        if (fr?.taskId !== c.rev.probeTaskId || iso.probedAt.getTime() < stepStart.getTime() - 1000) { await setGate(c, "isolation", false, "probe_stale"); return fail("probe_stale"); }
        await setGate(c, "isolation", true);
        return done();
    }
    if (iso.state === "not_isolated") { await setGate(c, "isolation", false, "not_isolated"); return fail("runner_not_isolated"); }
    if (iso.reason === "probe_pending") return wait();
    await setGate(c, "isolation", false, iso.reason);
    return fail("probe_stale");
}

export type GateVerdict = {ok: true} | {ok: false; code: string};
/** All five READY gates, re-checked from the stored facts (used by the `activate` handler AND inside the READY transaction). */
export async function evaluateGates(db: ForkDb, d: Pick<MirrorDeps, "serverUrl">, rev: RevRow, now: Date): Promise<GateVerdict> {
    const [fresh] = await db.select().from(forkMirrorRevision).where(eq(forkMirrorRevision.id, rev.id));
    if (!fresh) return {ok: false, code: "internal_error"};
    const g = gatesOf(fresh);
    for (const gate of GATES) if (g[gate]?.ok !== true) return {ok: false, code: gate === "isolation" ? "runner_not_isolated" : gate === "expected_data" ? "expected_data_failed" : gate === "db_health" ? "service_unhealthy" : gate === "app_smoke" ? "smoke_failed" : "final_view_invalid"};
    if (!fresh.finalViewSha256 || !fresh.specSha256 || !fresh.probeTaskId || !fresh.runnerAgentId) return {ok: false, code: "internal_error"};
    if (!fresh.rpId) return {ok: false, code: "rp_not_verified"};
    const [rp] = await db.select({status: forkRecoveryPoint.status, purgedAt: forkRecoveryPoint.purgedAt}).from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, fresh.rpId));
    if (!rp || rp.purgedAt !== null || rp.status !== RP_STATUSES[2]) return {ok: false, code: "expected_data_failed"};
    if (!(await assertRunnerTarget(db, fresh.runnerAgentId)).ok) return {ok: false, code: "runner_ineligible"};
    const [fr] = await db.select({taskId: forkRunner.lastProbeTaskId}).from(forkRunner).where(eq(forkRunner.agentId, fresh.runnerAgentId));
    if (fr?.taskId !== fresh.probeTaskId) return {ok: false, code: "probe_stale"};
    const iso = await runnerIsolation(db, fresh.runnerAgentId, {now, maxAgeMs: 3600e3, serverUrl: d.serverUrl()});
    if (iso.state !== "isolated") return {ok: false, code: "runner_not_isolated"};
    return {ok: true};
}

export {nowOf};
