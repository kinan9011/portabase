import {desc, eq} from "drizzle-orm";
import {z} from "zod";
import {buildOverridesView} from "@/fork/config/service";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkRestoreOverride} from "@/fork/db/schema/restore-override";
import {forkRestoreRun, forkRestoreRunTask} from "@/fork/db/schema/restore-run";
import {confirmationPhrase, groupOverrides} from "@/fork/policy/approval";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {soleOrganization} from "@/fork/arcane/connection-service";
import {assertForkResource} from "@/fork/resource-scope";
import {workspaceOf} from "@/fork/restore-tasks/build";
import {latestRender, renderVerdict} from "@/fork/restore-tasks/render";
import {loadPlanRow} from "@/fork/restore/service";
import type {StepRecord} from "@/fork/runs/engine";
import type {RestoreRunDeps} from "./deps";
import {parseServices} from "./derive";
import {REASON_RE, STEP_TASK_TYPE, type JournalStep} from "./vocab";

/**
 * Read model for the wizard (W18b). A strict allow-list: ids, hash, codes, states, timestamps, service NAMES + their running/exited state.
 * Never a path, URL, manifest, payload, raw task result, env key or value, user id or policy-view text (unit-tested with canaries).
 * `nextSteps` tells the UI what the operator still has to do by hand (re-attach backups on the new machine: guide Part 5; "Adopt" is deferred, OD-W18a-1).
 */
const iso = z.string();
const StepView = z.strictObject({
    name: z.string(), status: z.string(), startedAt: iso.nullable(), finishedAt: iso.nullable(), code: z.string().nullable(), attempts: z.number(),
    task: z.strictObject({status: z.string(), reason: z.string().nullable()}).nullable(),
});
export const RestoreRunView = z.strictObject({
    id: z.string(), planId: z.string(), planHash: z.string(), stackId: z.string(), rpSequence: z.number(), targetAgentName: z.string(), targetProject: z.string().nullable(), purpose: z.string(), mode: z.string(),
    state: z.string(), reason: z.string().nullable(), failedStep: z.string().nullable(), verification: z.string().nullable(),
    createdAt: iso, deadlineAt: iso, finishedAt: iso.nullable(), cancelRequested: z.boolean(),
    steps: z.array(StepView),
    awaiting: z.strictObject({kind: z.literal("policy_approval"), composeSha256: z.string(), services: z.array(z.strictObject({service: z.string(), rules: z.array(z.string()), phrase: z.string()}))}).nullable(),
    services: z.array(z.strictObject({service: z.string(), state: z.string()})),
    overrides: z.strictObject({applicable: z.boolean(), missingRequired: z.number(), frozen: z.boolean()}),
    cleanup: z.strictObject({status: z.string(), reason: z.string().nullable(), attempts: z.number()}).nullable(),
    nextSteps: z.array(z.enum(["reattach_backups"])),
});
export type RestoreRunView = z.infer<typeof RestoreRunView>;

export const RestoreRunSummary = z.strictObject({
    id: z.string(), stackId: z.string(), state: z.string(), createdAt: iso, finishedAt: iso.nullable(), targetAgentName: z.string(), rpSequence: z.number(), verification: z.string().nullable(),
});
export type RestoreRunSummary = z.infer<typeof RestoreRunSummary>;

export type RunRow = typeof forkRestoreRun.$inferSelect;
export type JournalView = {step: string; attempt: number; status: string | null; reason: string | null; attempts: number | null};

const reasonOf = (result: unknown): string | null => {
    const r = (result as {reason?: unknown} | null)?.reason;
    return typeof r === "string" && REASON_RE.test(r) ? r : null;
};

export async function journalOfRun(db: RestoreRunDeps["db"], runId: string): Promise<JournalView[]> {
    const rows = await db.select({j: forkRestoreRunTask, t: {status: forkAgentTask.status, attempts: forkAgentTask.attempts, result: forkAgentTask.result}})
        .from(forkRestoreRunTask).leftJoin(forkAgentTask, eq(forkAgentTask.id, forkRestoreRunTask.taskId)).where(eq(forkRestoreRunTask.runId, runId)).orderBy(desc(forkRestoreRunTask.attempt));
    return rows.map((r) => ({step: r.j.step, attempt: r.j.attempt, status: r.t?.status ?? null, reason: r.t?.status && (r.t.status === "failed" || r.t.status === "rejected") ? reasonOf(r.t.result) : null, attempts: r.t?.attempts ?? null}));
}

export function toRestoreRunView(run: RunRow, journal: readonly JournalView[], extra: {awaiting: RestoreRunView["awaiting"]; overrides: RestoreRunView["overrides"]; targetProject: string | null}): RestoreRunView {
    const newest = (step: string) => journal.find((j) => j.step === step) ?? null; // journal is newest-attempt first
    const steps = (run.steps as StepRecord[]).map((s) => {
        const j = s.name in STEP_TASK_TYPE ? newest(s.name) : null;
        return {name: s.name, status: s.status, startedAt: s.startedAt ?? null, finishedAt: s.finishedAt ?? null, code: s.code ?? null, attempts: s.attempts, task: j?.status ? {status: j.status, reason: j.reason} : null};
    });
    const c = newest("cleanup" satisfies JournalStep);
    return RestoreRunView.parse({
        id: run.id, planId: run.planId, planHash: run.planHash, stackId: run.stackId, rpSequence: run.rpSequence, targetAgentName: run.targetAgentName, targetProject: extra.targetProject, purpose: run.purpose, mode: run.mode,
        state: run.state, reason: run.reason, failedStep: run.failedStep, verification: run.verification,
        createdAt: run.createdAt.toISOString(), deadlineAt: run.deadlineAt.toISOString(), finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null, cancelRequested: run.cancelRequestedAt !== null,
        steps, awaiting: extra.awaiting, services: parseServices({services: run.services}) ?? [], overrides: extra.overrides,
        cleanup: c?.status ? {status: c.status, reason: c.reason, attempts: c.attempts ?? 0} : null,
        nextSteps: run.state === "succeeded" ? ["reattach_backups"] : [],
    });
}

type Refusal = {ok: false; code: "forbidden" | "not_found" | "invalid_input"};
const IdReq = z.strictObject({runId: z.uuid()});

export async function getRestoreRunView(d: RestoreRunDeps, raw: unknown): Promise<{ok: true; view: RestoreRunView} | Refusal> {
    const input = IdReq.safeParse(raw);
    if (!input.success) return {ok: false, code: "invalid_input"};
    try { await assertForkResource(d.db, d.principal, "restore.plan", {kind: "restore_run", id: input.data.runId}); } catch (e) {
        if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found"};
        if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden"};
        throw e;
    }
    const [run] = await d.db.select().from(forkRestoreRun).where(eq(forkRestoreRun.id, input.data.runId));
    if (!run) return {ok: false, code: "not_found"};
    const journal = await journalOfRun(d.db, run.id);
    let awaiting: RestoreRunView["awaiting"] = null;
    let overrides: RestoreRunView["overrides"] = {applicable: false, missingRequired: 0, frozen: false};
    const plan = await loadPlanRow(d, run.planId, run.planHash);
    const targetProject = plan.ok ? plan.plan.target.project : null; // W18b B4: from the hash-checked plan; null when the plan fails its check
    if (plan.ok) {
        const [ov] = await d.db.select().from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, run.planId));
        const v = buildOverridesView(plan.plan, ov);
        overrides = {applicable: v.applicable, missingRequired: v.missingRequired, frozen: v.frozen};
        if (run.state === "awaiting_approval") {
            const render = await latestRender(d.db, {restoreId: run.id, agentId: plan.plan.target.agent_id});
            if (render) {
                try {
                    const verdict = renderVerdict(render, workspaceOf(plan.plan));
                    awaiting = {kind: "policy_approval", composeSha256: verdict.compose_sha256, services: groupOverrides(verdict).map((o) => ({service: o.service, rules: o.rules, phrase: confirmationPhrase(o.service)}))};
                } catch { awaiting = null; }
            }
        }
    }
    return {ok: true, view: toRestoreRunView(run, journal, {awaiting, overrides, targetProject})};
}

/** `{stackId}` / `{planId}`: resource-gated as before. Neither: org-wide (single org, D21), `restore.plan` holders only, filtered by organization in SQL. */
export async function listRestoreRuns(d: RestoreRunDeps, raw: unknown): Promise<{ok: true; runs: RestoreRunSummary[]} | Refusal> {
    const input = z.strictObject({stackId: z.uuid().optional(), planId: z.uuid().optional()}).refine((x) => !(x.stackId && x.planId)).safeParse(raw);
    if (!input.success) return {ok: false, code: "invalid_input"};
    const {stackId, planId} = input.data;
    let where;
    if (stackId || planId) {
        try { await assertForkResource(d.db, d.principal, "restore.plan", stackId ? {kind: "stack", id: stackId} : {kind: "restore_plan", id: planId as string}); } catch (e) {
            if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found"};
            if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden"};
            throw e;
        }
        where = stackId ? eq(forkRestoreRun.stackId, stackId) : eq(forkRestoreRun.planId, planId as string);
    } else {
        const org = await soleOrganization(d.db);
        if (!org) return {ok: false, code: "not_found"};
        if (!forkCan(actorIn(d.principal, org), "restore.plan")) return {ok: false, code: "forbidden"};
        where = eq(forkRestoreRun.organizationId, org);
    }
    const rows = await d.db.select().from(forkRestoreRun).where(where).orderBy(desc(forkRestoreRun.createdAt)).limit(20);
    return {ok: true, runs: rows.map((r) => RestoreRunSummary.parse({id: r.id, stackId: r.stackId, state: r.state, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null, targetAgentName: r.targetAgentName, rpSequence: r.rpSequence, verification: r.verification}))};
}
