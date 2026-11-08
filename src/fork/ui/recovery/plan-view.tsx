import Link from "next/link";
import {PageHeader} from "@/features/layout/components/page";
import type {RestoreOverridesView} from "@/fork/config/view";
import {ToneBadge} from "@/fork/ui/tone-badge";
import {fmtBytes} from "@/fork/ui/stacks/format";
import {ACTION_KIND_TEXT, ACTION_OP_TEXT, PLAN_REASON_TEXT, PRECONDITION_TEXT, RECOVERY, RULE_TEXT, UNKNOWN_RULE} from "@/fork/ui/recovery/labels";
import {blockingItems, goState, groupByPhase, newPlanHref, type Item, type PlanUi} from "@/fork/ui/recovery/model";
import {ContinueButton, GoSection, PlanValues, UseNameButton} from "@/fork/ui/recovery/go.client";
import {StepIndicator} from "@/fork/ui/recovery/wizard-steps.client";
import type {Tone} from "@/fork/ui/tone";

const BACKUP_REASONS = new Set(["manifest_unbound", "inventory_missing", "inventory_mismatch", "required_artifact_missing", "compose_not_in_backup"]);
const MACHINE_REASONS = new Set(["target_agent_archived", "target_revoked", "target_not_enrolled", "target_channel_disabled", "target_capability_missing", "insufficient_disk", "arch_mismatch", "restore_root_required", "restore_root_rejected", "restore_root_outside_allowed_roots"]);
const CHIP: Record<Item["kind"], {tone: Tone; label: string}> = {
    blocked: {tone: "danger", label: RECOVERY.item.blocked}, needs_confirmation: {tone: "warning", label: RECOVERY.item.needsConfirm}, approved: {tone: "success", label: RECOVERY.item.approved},
    will_ask: {tone: "neutral", label: RECOVERY.item.willAsk}, values_missing: {tone: "warning", label: ""},
};

export type PlanViewProps = {
    plan: PlanUi; appName: string; backupLabel: string; validUntil: string; overrides: RestoreOverridesView | null; overridesRateLimited: boolean; locked: boolean;
    canExecute: boolean; canApproveProduction: boolean; canEditOverrides: boolean; usedRunId: string | null;
};

/** Screens 4 + 5. Server-rendered from the NARROWED plan (no host path, no backup internals); the only client islands are Continue, the name fix, the values panel and Go. */
export function PlanScreen(p: PlanViewProps) {
    const {plan} = p;
    const machine = plan.target.agentName;
    const missing = p.overrides?.missingRequired ?? 0;
    const items = blockingItems(plan, p.overrides ? {missingRequired: missing} : null);
    const g = goState({plan, overrides: {missingRequired: missing}, canExecute: p.canExecute, canApproveProduction: p.canApproveProduction, acceptMissing: false, locked: p.locked});
    const continueReason = !p.canExecute || p.locked || plan.freshness !== "fresh" || plan.outcome === "blocked" ? g.reason : null;
    const stackBack = `/dashboard/recovery/new?step=backup&stack=${plan.stackId}`;
    const blockedN = items.filter((i) => i.kind === "blocked").length;
    const suggestion = (code: string) => plan.decisions.find((d) => d.code === code)?.suggestion ?? null;
    const ctx = (code: string) => ({machine, name: plan.decisions.find((d) => d.code === code)?.subject});

    return (
        <div>
            <StepIndicator current={4} links={{app: "/dashboard/recovery/new?step=app", backup: stackBack, machine: newPlanHref(plan)}}/>
            <PageHeader><h1 className="mb-4 text-2xl font-bold">{RECOVERY.steps.plan}</h1></PageHeader>
            <p data-testid="plan-summary" className="mb-4 max-w-3xl text-sm break-words">{RECOVERY.plan.summary(p.appName, p.backupLabel, machine, plan.target.project, plan.target.restoreRoot)}</p>

            {p.usedRunId && <p role="note" data-testid="plan-used" className="mb-3 rounded-md border p-3 text-sm">{RECOVERY.plan.used} <Link href={`/dashboard/recovery/runs/${p.usedRunId}`} className="underline underline-offset-4">{RECOVERY.plan.usedLink}</Link></p>}
            {plan.freshness === "fresh"
                ? <p data-testid="plan-fresh" className="text-muted-foreground mb-3 text-sm">{RECOVERY.plan.validUntil(p.validUntil)}</p>
                : <div role="alert" data-testid="plan-stale" className="mb-3 rounded-md border p-3 text-sm"><p>{plan.freshness === "expired" ? RECOVERY.plan.expired : RECOVERY.plan.stale}</p><Link href={newPlanHref(plan)} className="underline underline-offset-4">{RECOVERY.plan.makeNew}</Link></div>}
            <p className="mb-6"><ToneBadge tone={plan.outcome === "ready" ? "success" : "danger"}>{plan.outcome === "ready" ? RECOVERY.plan.ready : RECOVERY.plan.blocked(blockedN)}</ToneBadge></p>

            <section aria-labelledby="list-h" className="mb-8 max-w-3xl" data-testid="plan-items">
                <h2 id="list-h" className="mb-2 text-lg font-semibold">{RECOVERY.plan.list}</h2>
                {items.length === 0 ? <p className="text-muted-foreground text-sm">Nothing stands in the way.</p> : (
                    <ul className="space-y-2">
                        {items.map((it) => {
                            const c = CHIP[it.kind];
                            const sentence = it.kind === "blocked" ? (Object.hasOwn(PLAN_REASON_TEXT, it.reasons[0]!) ? PLAN_REASON_TEXT[it.reasons[0] as keyof typeof PLAN_REASON_TEXT](ctx(it.reasons[0]!)) : RECOVERY.plan.blockedGo)
                                : it.kind === "needs_confirmation" || it.kind === "approved" ? RECOVERY.item.production(machine, plan.target.hostRoleSource === "default")
                                : it.kind === "will_ask" ? `${Object.hasOwn(RULE_TEXT, it.rule!) ? RULE_TEXT[it.rule as keyof typeof RULE_TEXT](it.service!) : UNKNOWN_RULE(it.service!)} ${RECOVERY.item.willAskSuffix}`
                                : RECOVERY.item.valuesNeeded;
                            const sug = it.kind === "blocked" && it.reasons[0] === "project_name_conflict" ? suggestion("project_name_conflict") : null;
                            const fix = it.kind === "blocked" && BACKUP_REASONS.has(it.reasons[0]!) ? {href: stackBack, label: RECOVERY.plan.fixBackup} : it.kind === "blocked" && MACHINE_REASONS.has(it.reasons[0]!) ? {href: newPlanHref(plan), label: RECOVERY.plan.fixMachine} : null;
                            return (
                                <li key={it.key} data-testid="plan-item" data-kind={it.kind} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border p-3 text-sm">
                                    <ToneBadge tone={c.tone}>{it.kind === "values_missing" ? RECOVERY.item.valuesMissing(it.count ?? 0) : c.label}</ToneBadge>
                                    <span className="min-w-0 flex-1 break-words">{sentence}</span>
                                    {fix && <Link href={fix.href} className="underline underline-offset-4">{fix.label}</Link>}
                                    {sug && <UseNameButton plan={plan} name={sug}/>}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <section aria-labelledby="what-h" className="mb-8 max-w-3xl" data-testid="plan-what">
                <h2 id="what-h" className="mb-2 text-lg font-semibold">{RECOVERY.plan.what}</h2>
                {groupByPhase(plan.actions).map((grp) => (
                    <div key={grp.phase} className="mb-4">
                        <h3 className="text-muted-foreground mb-1 text-sm font-medium">{RECOVERY.plan.phases[grp.phase]}</h3>
                        <ul className="divide-y rounded-lg border">
                            {grp.actions.map((a) => {
                                const name = a.destination.name ?? a.source.member ?? "";
                                const where = a.destination.relativePath ?? a.destination.name;
                                const reason = a.op === "skip" && a.reasons[0] && Object.hasOwn(PLAN_REASON_TEXT, a.reasons[0]) ? PLAN_REASON_TEXT[a.reasons[0] as keyof typeof PLAN_REASON_TEXT](ctx(a.reasons[0])) : null;
                                return (
                                    <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                                        <ToneBadge tone={a.op === "create" ? "neutral" : "warning"}>{ACTION_OP_TEXT[a.op]}</ToneBadge>
                                        <span className="min-w-0 flex-1 break-words">{ACTION_KIND_TEXT[a.kind](name)}{where && a.kind !== "compose_up" ? <span className="text-muted-foreground"> → {where}</span> : null}</span>
                                        {reason && <span className="text-muted-foreground basis-full text-xs">{reason}</span>}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                ))}
                {plan.totals.plaintextBytes !== null && <p className="text-muted-foreground text-sm">{RECOVERY.plan.size(fmtBytes(plan.totals.plaintextBytes) ?? "")}</p>}
            </section>

            {plan.preconditions.some((c) => c.state === "deferred") && (
                <section aria-labelledby="def-h" className="mb-8 max-w-3xl" data-testid="plan-deferred">
                    <h2 id="def-h" className="mb-2 text-lg font-semibold">{RECOVERY.plan.deferredTitle}</h2>
                    <ul className="list-disc space-y-1 pl-5 text-sm">{plan.preconditions.filter((c) => c.state === "deferred").map((c) => <li key={c.code}>{PRECONDITION_TEXT[c.code]}</li>)}</ul>
                </section>
            )}

            <section aria-label={RECOVERY.plan.values} className="mb-8 max-w-3xl">
                <PlanValues planId={plan.id} planHash={plan.planHash} view={p.overrides} canEdit={p.canEditOverrides && !p.locked} rateLimited={p.overridesRateLimited}/>
            </section>

            <div className="mb-2"><ContinueButton reason={continueReason}/></div>
            {!p.usedRunId && <GoSection plan={plan} appName={p.appName} backupLabel={p.backupLabel} missingRequired={missing} canExecute={p.canExecute} canApproveProduction={p.canApproveProduction} locked={p.locked}/>}
        </div>
    );
}
