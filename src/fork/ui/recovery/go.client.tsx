"use client";

import Link from "next/link";
import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import {Collapsible, CollapsibleContent, CollapsibleTrigger} from "@/components/ui/collapsible";
import {Label} from "@/components/ui/label";
import {approveRestorePlanAction, createRestorePlanAction} from "@/fork/actions/restore-plan.action";
import {listRestoreRunsAction, startRestoreRunAction} from "@/fork/actions/restore-run.action";
import type {RestoreOverridesView} from "@/fork/config/view";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";
import {HOST_ROLE_LABELS} from "@/fork/ui/labels";
import {verdict} from "@/fork/ui/recovery/call";
import {PLAN_REFUSAL_TEXT, RECOVERY, START_REFUSAL_TEXT} from "@/fork/ui/recovery/labels";
import {goState, needsProduction, type PlanUi} from "@/fork/ui/recovery/model";
import {RestoreOverridesPanel} from "@/fork/ui/stacks/config/restore-overrides-panel.client";
import {useAnnounce} from "@/fork/ui/status-announcer";

const text = (code: string, project: string, machine: string) => Object.hasOwn(START_REFUSAL_TEXT, code) ? START_REFUSAL_TEXT[code as keyof typeof START_REFUSAL_TEXT]({machine, project}) : Object.hasOwn(PLAN_REFUSAL_TEXT, code) ? PLAN_REFUSAL_TEXT[code as keyof typeof PLAN_REFUSAL_TEXT] : RECOVERY.page.loadError.body;

/** "Continue": moves focus and the viewport to the Go section of the same page (Step 5). */
/** Moves focus to the heading `id` when the page arrives by router.push (it would stay on <body>); W18b-f2 D5. */
export function FocusOnMount({id}: {id: string}) {
    React.useEffect(() => { document.getElementById(id)?.focus(); }, [id]);
    return null;
}

export function ContinueButton({reason}: {reason: string | null}) {
    return (
        <ReasonButton reason={reason} className={`w-full sm:w-auto ${PRIMARY_AA}`} onClick={() => { const el = document.getElementById("go-h"); el?.scrollIntoView?.({block: "start"}); el?.focus(); }}>{RECOVERY.plan.continue}</ReasonButton>
    );
}

/** "Use the name <suggestion>": a NEW plan with the same backup, machine and folder under another project name. */
export function UseNameButton({plan, name}: {plan: PlanUi; name: string}) {
    const router = useRouter();
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const go = async () => {
        if (busy) return; setBusy(true); setErr(null);
        try {
            const v = verdict(await createRestorePlanAction({rpId: plan.rp.id, targetAgentId: plan.targetAgentId, purpose: "restore", mode: "new_stack", mappings: {target_project: name, restore_root: plan.target.restoreRoot, volumes: null, select: null, sqlite: null}}));
            if (v.ok) { router.push(`/dashboard/recovery/plans/${String(v.data.planId)}`); return; }
            setErr(text(v.code, name, plan.target.agentName));
        } catch { setErr(RECOVERY.page.loadError.body); } finally { setBusy(false); }
    };
    return (
        <span className="inline-flex flex-col gap-1">
            <ReasonButton variant="outline" size="sm" reason={busy ? RECOVERY.steps.preparing : null} onClick={go}>{RECOVERY.plan.useName(name)}</ReasonButton>
            {err && <span role="alert" className="text-sm">{err}</span>}
        </span>
    );
}

/** The embedded W16b panel, unmodified, inside a collapsed section. `onChanged` only refreshes the page (approvals are re-read there); it never receives a value. */
export function PlanValues({planId, planHash, view, canEdit, rateLimited}: {planId: string; planHash: string; view: RestoreOverridesView | null; canEdit: boolean; rateLimited: boolean}) {
    const router = useRouter();
    // a save / clear re-renders the panel and drops focus on <body>: bring it back to the toggle once the refresh is done (W18b-f2 K1)
    const [pending, start] = React.useTransition(); const was = React.useRef(false);
    React.useEffect(() => { if (was.current && !pending) document.querySelector<HTMLElement>("[data-testid=values-toggle]")?.focus(); was.current = pending; }, [pending]);
    return (
        <Collapsible>
            <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm" data-testid="values-toggle">{RECOVERY.plan.values}</Button></CollapsibleTrigger>
            <CollapsibleContent className="mt-3">
                {view ? <RestoreOverridesPanel planId={planId} planHash={planHash} view={view} canEdit={canEdit} onChanged={() => start(() => router.refresh())}/>
                    : <p role="note" className="text-sm">{rateLimited ? RECOVERY.plan.valuesRateLimited : RECOVERY.plan.valuesLocked}</p>}
            </CollapsibleContent>
        </Collapsible>
    );
}

export type GoProps = {plan: PlanUi; appName: string; backupLabel: string; missingRequired: number; canExecute: boolean; canApproveProduction: boolean; locked: boolean};

/** Screen 5. One confirm, two calls (DD-6): approve (production, if not yet given) THEN start. The server stays authoritative; every refusal is shown in words. */
export function GoSection({plan, appName, backupLabel, missingRequired, canExecute, canApproveProduction, locked}: GoProps) {
    const router = useRouter();
    const announce = useAnnounce();
    const [accept, setAccept] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<{text: string; runId: string | null} | null>(null);
    const overrides = missingRequired > 0 ? {missingRequired} : {missingRequired: 0};
    const g = goState({plan, overrides, canExecute, canApproveProduction, acceptMissing: accept, locked});
    const prod = needsProduction(plan);
    const machine = plan.target.agentName;
    const byDefault = plan.target.hostRoleSource === "default";
    const roleLabel = byDefault ? RECOVERY.machine.noRole : HOST_ROLE_LABELS[plan.target.hostRole as keyof typeof HOST_ROLE_LABELS]?.label ?? plan.target.hostRole;

    const start = async (typed?: string) => {
        if (busy) return;
        setBusy(true); setErr(null); announce(RECOVERY.go.busy);
        try {
            if (prod && !plan.approvalsGiven.some((a) => a.kind === "production_target")) {
                const a = verdict(await approveRestorePlanAction({planId: plan.id, planHash: plan.planHash, kind: "production_target"}));
                if (!a.ok) { const t = text(a.code, plan.target.project, machine); setErr({text: t, runId: null}); announce(t); router.refresh(); return; }
            }
            const req: Record<string, unknown> = {planId: plan.id, planHash: plan.planHash};
            if (prod) req.confirm = typed ?? "";
            if (accept) req.acceptMissingInputs = true;
            const s = verdict(await startRestoreRunAction(req));
            if (s.ok) { router.push(`/dashboard/recovery/runs/${String(s.data.runId)}`); return; }
            let runId: string | null = null;
            if (s.code === "already_running") {
                const l = (await listRestoreRunsAction({})) as {data?: {ok?: boolean; runs?: {id: string; state: string; targetAgentName: string}[]}} | undefined;
                runId = l?.data?.runs?.find((r) => (r.state === "running" || r.state === "awaiting_approval") && r.targetAgentName === machine)?.id ?? null;
            }
            const t = text(s.code, plan.target.project, machine); setErr({text: t, runId}); announce(t); router.refresh();
        } catch { setErr({text: RECOVERY.page.loadError.body, runId: null}); } finally { setBusy(false); }
    };

    return (
        <section id="go" aria-labelledby="go-h" data-testid="go" className="mt-10 max-w-2xl space-y-4 border-t pt-6">
            <h2 id="go-h" tabIndex={-1} className="text-2xl font-bold outline-none">{RECOVERY.steps.go}</h2>
            <ul className="space-y-1 text-sm">
                <li>{RECOVERY.go.recapApp(appName, backupLabel)}</li>
                <li>{RECOVERY.go.recapMachine(machine, roleLabel)}</li>
                {plan.target.restoreRoot && <li className="break-words">{RECOVERY.go.recapFolder(plan.target.restoreRoot)}</li>}
            </ul>
            <p className="text-muted-foreground text-sm">{RECOVERY.go.next}</p>
            {missingRequired > 0 && (
                <div className="flex items-start gap-2">
                    <Checkbox id="accept-missing" checked={accept} onCheckedChange={(c) => setAccept(c === true)} disabled={!canExecute || locked} className="mt-0.5"/>
                    <Label htmlFor="accept-missing" className="text-sm leading-snug">{RECOVERY.go.acceptMissing}</Label>
                </div>
            )}
            <div>
                <ReasonButton data-testid="go-button" className={`w-full sm:w-auto ${PRIMARY_AA}`} reason={g.reason} aria-busy={busy || undefined} onClick={() => setOpen(true)}>
                    {prod ? RECOVERY.go.prodButton(machine) : RECOVERY.go.testButton}
                </ReasonButton>
            </div>
            {err && (
                <div role="alert" data-testid="go-error" className="rounded-md border p-3 text-sm">
                    <p>{err.text}</p>
                    {err.runId && <Link href={`/dashboard/recovery/runs/${err.runId}`} className="underline underline-offset-4">{RECOVERY.go.openActive}</Link>}
                </div>
            )}
            {prod ? (
                <DangerousActionConfirm
                    open={open} onOpenChange={setOpen} title={RECOVERY.go.prodTitle} confirmLabel={RECOVERY.go.prodConfirm(machine)}
                    description={<><p>{RECOVERY.go.prodBody(machine, byDefault)}</p><p>{RECOVERY.go.typePhrase} <code className="bg-muted rounded px-1 py-0.5 font-mono">{g.typed}</code></p></>}
                    typedPhrase={g.typed ?? undefined} inputLabel={RECOVERY.go.typedLabel} typedReason={RECOVERY.go.typedReason} onConfirm={(t) => { void start(t); }}
                />
            ) : (
                <DangerousActionConfirm open={open} onOpenChange={setOpen} title={RECOVERY.go.testTitle(machine)} confirmLabel={RECOVERY.go.testConfirm} description={<p>{RECOVERY.go.testBody}</p>} onConfirm={() => { void start(); }}/>
            )}
        </section>
    );
}
