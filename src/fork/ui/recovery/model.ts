import type {RestorePlanView} from "@/fork/restore/service";
import type {RestoreRunView} from "@/fork/restore-run/view";
import {ACTIVE_RESTORE_RUN_STATES, MAX_EXPIRED_REENQUEUES, REASON_RE, restoreConfirmPhrase, type RestoreRunState} from "@/fork/restore-run/vocab";
import type {Tone} from "@/fork/ui/tone";
import {FAILURE_GROUPS, GENERIC_FAILURE_TEXT, HEADLINE, RECOVERY, R_PROD, R_ROLE, STEP_STATUS, STEP_TEXT} from "@/fork/ui/recovery/labels";

/**
 * PURE logic of the restore wizard UI (W18b): no clock, no env, no DB, no React. Every time helper takes `now` explicitly. Unit-tested with mutation proofs
 * (`w18b-recovery-model.test.ts`): success tone only for `succeeded`, Go disabled while blocked, production Go needs the typed phrase, steps that never ran are
 * "Not run", polling stops at a terminal state, the plan narrowing drops every host path.
 */

// ---- plan: the narrowed DTO the client may see (DD-W18b-3) ------------------------------------------------------------------------------------
export type PlanAction = {
    id: string; order: number; phase: "stage" | "data" | "db" | "start"; kind: RestorePlanView["actions"][number]["kind"]; op: RestorePlanView["actions"][number]["op"]; risk: string; reasons: string[];
    source: {member: string | null; service: string | null; dbms: string | null; role: string | null};
    destination: {kind: string; name: string | null; relativePath: string | null};
};
export type PlanUi = {
    id: string; planHash: string; expiresAt: string; freshness: RestorePlanView["freshness"]; outcome: RestorePlanView["outcome"];
    rp: RestorePlanView["rp"]; target: RestorePlanView["target"]; stackId: string; targetAgentId: string; totals: RestorePlanView["totals"];
    actions: PlanAction[]; preconditions: RestorePlanView["preconditions"]; approvalsRequired: RestorePlanView["approvalsRequired"]; approvalsGiven: RestorePlanView["approvalsGiven"];
    secrets: {service: string; key: string}[]; decisions: RestorePlanView["decisions"]; composeFindings: {rule_id: string; service: string}[]; blockers: string[];
};

/** Keeps per action only what the screens show. Drops `source.original_path`, `destination.path`, `artifact_ids`, `expect`, `resource_key` (host paths and backup internals never reach client code). */
export function toPlanUi(v: RestorePlanView): PlanUi {
    return {
        id: v.id, planHash: v.planHash, expiresAt: v.expiresAt, freshness: v.freshness, outcome: v.outcome, rp: v.rp, target: v.target, stackId: v.stackId, targetAgentId: v.targetAgentId, totals: v.totals,
        actions: v.actions.map((a) => ({
            id: a.id, order: a.order, phase: a.phase, kind: a.kind, op: a.op, risk: a.risk, reasons: [...a.reasons],
            source: {member: a.source.member, service: a.source.service, dbms: a.source.dbms, role: a.source.role},
            destination: {kind: a.destination.kind, name: a.destination.name, relativePath: a.destination.relative_path},
        })),
        preconditions: v.preconditions, approvalsRequired: v.approvalsRequired, approvalsGiven: v.approvalsGiven,
        secrets: v.secrets.map((s) => ({service: s.service, key: s.key})), decisions: v.decisions, composeFindings: v.composeFindings.map((f) => ({rule_id: f.rule_id, service: f.service})), blockers: [...v.blockers],
    };
}

// ---- DD-5 blocking items ----------------------------------------------------------------------------------------------------------------------
export type ItemKind = "blocked" | "needs_confirmation" | "approved" | "will_ask" | "values_missing";
export type Item = {kind: ItemKind; key: string; reasons: string[]; service?: string; rule?: string; count?: number};

export function blockingItems(plan: PlanUi, overrides: {missingRequired: number} | null): Item[] {
    const out: Item[] = [];
    const reasons = new Set<string>(plan.blockers);
    for (const a of plan.actions) if (a.risk === "blocked") for (const r of a.reasons) reasons.add(r);
    if (plan.blockers.length > 0 || plan.actions.some((a) => a.risk === "blocked")) for (const r of reasons) out.push({kind: "blocked", key: `blocked:${r}`, reasons: [r]});
    if (plan.approvalsRequired.some((a) => a.kind === "production_target")) {
        out.push({kind: plan.approvalsGiven.some((a) => a.kind === "production_target") ? "approved" : "needs_confirmation", key: "production_target", reasons: []});
    }
    for (const f of plan.composeFindings) out.push({kind: "will_ask", key: `ask:${f.service}:${f.rule_id}`, reasons: [], service: f.service, rule: f.rule_id});
    if (overrides && overrides.missingRequired > 0) out.push({kind: "values_missing", key: "values", reasons: [], count: overrides.missingRequired});
    return out;
}

export const needsProduction = (plan: PlanUi) => plan.approvalsRequired.some((a) => a.kind === "production_target");

// ---- Go (Screen 5) ----------------------------------------------------------------------------------------------------------------------------
export type GoState = {enabled: boolean; reason: string | null; typed: string | null};
export function goState(i: {plan: PlanUi; overrides: {missingRequired: number} | null; canExecute: boolean; canApproveProduction: boolean; acceptMissing: boolean; locked?: boolean}): GoState {
    const prod = needsProduction(i.plan);
    const typed = prod ? restoreConfirmPhrase(i.plan.target.project) : null;
    const reason = !i.canExecute ? R_ROLE
        : i.locked ? RECOVERY.page.lockedBanner
        : i.plan.freshness === "expired" ? RECOVERY.plan.expired
        : i.plan.freshness === "stale" ? RECOVERY.plan.stale
        : i.plan.outcome === "blocked" ? RECOVERY.plan.blockedGo
        : prod && !i.canApproveProduction ? R_PROD
        : (i.overrides?.missingRequired ?? 0) > 0 && !i.acceptMissing ? RECOVERY.go.acceptMissing
        : null;
    return {enabled: reason === null, reason, typed};
}

// ---- run headline / tone ---------------------------------------------------------------------------------------------------------------------
export type RunUi = Pick<RestoreRunView, "id" | "state" | "reason" | "failedStep" | "verification" | "steps" | "services" | "cleanup" | "cancelRequested" | "createdAt" | "finishedAt" | "deadlineAt" | "targetAgentName">;

/** `succeeded` is the ONLY success tone: incomplete / failed / cancelled / awaiting never are. */
export function toneOf(state: string): Tone {
    switch (state) {
        case "succeeded": return "success";
        case "running": return "active";
        case "awaiting_approval": case "incomplete": return "warning";
        case "failed": return "danger";
        default: return "neutral";
    }
}

export function failureSentence(code: string | null, machine: string): {text: string; reference: string | null; tone: "danger" | "warning" | "neutral"} {
    const ref = code && REASON_RE.test(code) ? code : null;
    if (!code) return {text: GENERIC_FAILURE_TEXT(machine), reference: null, tone: "danger"};
    const grp = FAILURE_GROUPS.find((x) => (x.codes as readonly string[]).includes(code));
    if (!grp) return {text: GENERIC_FAILURE_TEXT(machine), reference: ref, tone: "danger"};
    return {text: grp.text(machine), reference: "reference" in grp && grp.reference ? ref : null, tone: grp.tone};
}

export function runHeadline(v: RunUi): {text: string; tone: Tone} {
    const machine = v.targetAgentName;
    switch (v.state as RestoreRunState) {
        case "running": return HEADLINE.running;
        case "awaiting_approval": return HEADLINE.awaiting_approval;
        case "succeeded": return v.verification === "started" ? HEADLINE.started : v.verification === "data_only" ? HEADLINE.data_only : HEADLINE.succeeded;
        case "incomplete": return HEADLINE.incomplete(v.services.filter((s) => s.state !== "running").map((s) => s.service));
        case "failed": {
            const f = failureSentence(v.reason, machine);
            return HEADLINE.failed(v.failedStep ? (STEP_TEXT[v.failedStep as keyof typeof STEP_TEXT] ?? null) : null, f.text + (f.reference ? ` Reference: ${f.reference}` : ""));
        }
        case "cancelled": return HEADLINE.cancelled;
        default: return {text: RECOVERY.run.recovered, tone: "neutral"};
    }
}

export const isActiveState = (s: string) => (ACTIVE_RESTORE_RUN_STATES as readonly string[]).includes(s);

/** DD-10: poll while the run is active or a cleanup is in flight; never after a terminal state. */
export const isPolling = (v: Pick<RunUi, "state" | "cleanup">): boolean => isActiveState(v.state) || (v.cleanup !== null && ["queued", "leased", "running"].includes(v.cleanup.status));

// ---- DD-9 step status ------------------------------------------------------------------------------------------------------------------------
export type StepUi = {kind: "done" | "waiting_machine" | "in_progress" | "retrying" | "failed" | "not_run" | "waiting"; text: string; reason: string | null; reference: string | null};
export function stepStatus(step: RunUi["steps"][number], runState: string, machine: string): StepUi {
    const none = {reason: null, reference: null};
    switch (step.status) {
        case "done": return {kind: "done", text: STEP_STATUS.done, ...none};
        case "running": {
            const t = step.task?.status ?? null;
            if (step.attempts > 1 && (t === null || t === "queued" || t === "expired")) return {kind: "retrying", text: STEP_STATUS.retrying(Math.min(step.attempts, MAX_EXPIRED_REENQUEUES), MAX_EXPIRED_REENQUEUES), ...none};
            if (t === "queued") return {kind: "waiting_machine", text: STEP_STATUS.waitingMachine(machine), ...none};
            return {kind: "in_progress", text: STEP_STATUS.inProgress, ...none};
        }
        case "failed": {
            if (!step.code) return {kind: "not_run", text: STEP_STATUS.notRun, ...none}; // `failRemaining` marks the steps after the failure failed WITHOUT a code: they never ran
            const f = failureSentence(step.code, machine);
            return {kind: "failed", text: STEP_STATUS.failed, reason: f.text, reference: f.reference};
        }
        default: return isActiveState(runState) ? {kind: "waiting", text: STEP_STATUS.waiting, ...none} : {kind: "not_run", text: STEP_STATUS.notRun, ...none};
    }
}

// ---- grouping / ordering / links -------------------------------------------------------------------------------------------------------------
export function groupByPhase(actions: readonly PlanAction[]): {phase: PlanAction["phase"]; actions: PlanAction[]}[] {
    return (["stage", "data", "db", "start"] as const).map((phase) => ({phase, actions: actions.filter((a) => a.phase === phase).sort((x, y) => x.order - y.order)})).filter((g) => g.actions.length > 0);
}
/** Active first, then newest first. */
export function orderRuns<T extends {state: string; createdAt: string}>(runs: readonly T[]): T[] {
    return [...runs].sort((a, b) => Number(isActiveState(b.state)) - Number(isActiveState(a.state)) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
export const newPlanHref = (p: Pick<PlanUi, "stackId" | "targetAgentId" | "rp">) => `/dashboard/recovery/new?step=machine&stack=${p.stackId}&point=${p.rp.sequence}&machine=${p.targetAgentId}`;
export const defaultRestoreFolder = (t: {lastRestoreRoot: string | null; environments: {allowedPathRoots: string[]}[]}): string => {
    if (t.lastRestoreRoot) return t.lastRestoreRoot;
    const root = t.environments.flatMap((e) => e.allowedPathRoots)[0];
    return root ? `${root.replace(/\/+$/, "")}/portabase-restore` : "";
};

// ---- time helpers (explicit `now`) -----------------------------------------------------------------------------------------------------------
export function relative(at: Date, now: Date): string {
    const s = Math.round((now.getTime() - at.getTime()) / 1000);
    if (s < 0) return "in the future";
    if (s < 60) return "just now";
    const m = Math.floor(s / 60); if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.floor(h / 24); return `${d} day${d === 1 ? "" : "s"} ago`;
}
export function elapsed(from: Date, to: Date): string {
    const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60); if (m < 60) return `${m} min ${s % 60} s`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export function formatInstant(at: Date, timezone: string): string {
    try { return new Intl.DateTimeFormat("en-GB", {timeZone: timezone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false}).format(at); }
    catch { return new Intl.DateTimeFormat("en-GB", {timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false}).format(at); }
}
