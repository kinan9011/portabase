"use client";

import Link from "next/link";
import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Collapsible, CollapsibleContent, CollapsibleTrigger} from "@/components/ui/collapsible";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {RadioGroup, RadioGroupItem} from "@/components/ui/radio-group";
import {createRestorePlanAction} from "@/fork/actions/restore-plan.action";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {AGENT_STATUS_LABELS, HOST_ROLE_LABELS, RP_STATUS_LABELS, RUNTIME_LABELS, type RuntimeStateKey} from "@/fork/ui/labels";
import {CHOICE_GONE, PLAN_REFUSAL_TEXT, RECOVERY, R_LOCKED} from "@/fork/ui/recovery/labels";
import {verdict} from "@/fork/ui/recovery/call";
import {useAnnounce} from "@/fork/ui/status-announcer";

export type ChoiceUi = {stackId: string; name: string; environmentName: string; runtime: string; verifiedCount: number; pendingCount: number; lastGood: string; testRestore: string};
export type PointUi = {sequence: number; status: string; label: string; relative: string; size: string | null; consistency: string | null; destinations: string[]};
export type TargetUi = {id: string; name: string; status: "online" | "degraded" | "offline"; readiness: keyof typeof RECOVERY.machine.notReady; hostRole: "production" | "test"; hostRoleSource: "environment" | "default"; wasSource: boolean; folder: string};
export type WizardData = {
    step: "app" | "backup" | "machine"; dropped: boolean; pointGone: boolean; locked: boolean; canCompose: boolean;
    stackId: string | null; stackName: string | null; rpId: string | null; rpSequence: number | null; machineId: string | null;
    choices?: ChoiceUi[]; points?: PointUi[]; targets?: TargetUi[]; isSysAdmin?: boolean;
};

const STEPS = ["app", "backup", "machine", "plan", "go"] as const;
const CARD = "flex items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:ring-2 has-[[data-state=checked]]:border-primary";
const BTN = "w-full sm:w-auto";

/** Back-only links: earlier steps are links (when the page knows where to send you), later steps are plain text. */
export function StepIndicator({current, links}: {current: 1 | 2 | 3 | 4 | 5; links: Partial<Record<(typeof STEPS)[number], string>>}) {
    return (
        <nav aria-label={RECOVERY.steps.indicator} className="mb-4">
            <p className="text-muted-foreground text-sm sm:hidden" data-testid="step-short">{RECOVERY.steps.of(current, RECOVERY.steps.short[STEPS[current - 1]!])}</p>
            <ol className="hidden items-center gap-3 text-sm sm:flex">
                {STEPS.map((s, i) => {
                    const n = i + 1; const isCur = n === current; const link = n < current ? links[s] : undefined;
                    return (
                        <li key={s} aria-current={isCur ? "step" : undefined} className={isCur ? "font-semibold" : "text-muted-foreground"}>
                            {link ? <Link href={link} className="underline underline-offset-4">{n}. {RECOVERY.steps.short[s]}</Link> : <span>{n}. {RECOVERY.steps.short[s]}</span>}
                        </li>
                    );
                })}
            </ol>
            <ol className="sr-only sm:hidden">{STEPS.map((s, i) => <li key={s} aria-current={i + 1 === current ? "step" : undefined}>{RECOVERY.steps.short[s]}</li>)}</ol>
        </nav>
    );
}
const wizardLinks = (d: WizardData) => ({app: "/dashboard/recovery/new?step=app", backup: d.stackId ? `/dashboard/recovery/new?step=backup&stack=${d.stackId}` : undefined});

function useHeadingFocus() {
    const ref = React.useRef<HTMLHeadingElement>(null);
    React.useEffect(() => { ref.current?.focus(); }, []);
    return ref;
}

function Dropped() { return <p role="note" data-testid="choice-gone" className="mb-3 rounded-md border p-3 text-sm">{CHOICE_GONE}</p>; }

function AppStep({data}: {data: WizardData}) {
    const router = useRouter();
    const h1 = useHeadingFocus();
    const [sel, setSel] = React.useState<string | null>(null);
    const ok = (data.choices ?? []).filter((c) => c.verifiedCount > 0);
    const rest = (data.choices ?? []).filter((c) => c.verifiedCount === 0);
    return (
        <section aria-labelledby="wiz-h">
            <StepIndicator current={1} links={wizardLinks(data)}/>
            <h1 id="wiz-h" ref={h1} tabIndex={-1} className="mb-4 text-2xl font-bold outline-none">{RECOVERY.steps.app}</h1>
            {data.dropped && <Dropped/>}
            {ok.length === 0 ? (
                <p data-testid="app-empty" className="text-muted-foreground text-sm">{RECOVERY.app.empty} <Link href="/dashboard/stacks" className="underline underline-offset-4">{RECOVERY.app.emptyLink}</Link></p>
            ) : (
                <RadioGroup value={sel ?? ""} onValueChange={setSel} aria-labelledby="wiz-h" className="max-w-2xl">
                    {ok.map((c) => {
                        const id = `app-${c.stackId}`; const rt = RUNTIME_LABELS[(Object.hasOwn(RUNTIME_LABELS, c.runtime) ? c.runtime : "unknown") as RuntimeStateKey];
                        return (
                            <div key={c.stackId} className={CARD}>
                                <RadioGroupItem id={id} value={c.stackId} aria-describedby={`${id}-d`} className="mt-1"/>
                                <div className="min-w-0 space-y-0.5 text-sm">
                                    <Label htmlFor={id} className="font-medium break-words">{c.name}</Label>
                                    <div id={`${id}-d`} className="text-muted-foreground flex flex-col">
                                        <span>{RECOVERY.page.ranOn(c.environmentName)} · {rt.label}</span>
                                        {c.runtime === "absent" && <span>{rt.description}</span>}
                                        <span>Last good backup: {c.lastGood}</span>
                                        <span>Data verified by test restore · {c.testRestore}</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </RadioGroup>
            )}
            {rest.length > 0 && (
                <div className="mt-6 max-w-2xl" data-testid="not-restorable">
                    <h2 className="mb-2 text-sm font-semibold">{RECOVERY.app.notRestorable}</h2>
                    <ul className="text-muted-foreground space-y-1 text-sm">
                        {rest.map((c) => <li key={c.stackId} aria-disabled="true"><span className="font-medium">{c.name}</span> — {c.pendingCount > 0 ? RP_STATUS_LABELS.pending_verification.label : RECOVERY.page.noVerified}</li>)}
                    </ul>
                </div>
            )}
            {ok.length > 0 && (
                <div className="mt-6">
                    <ReasonButton className={BTN} reason={sel ? null : RECOVERY.steps.chooseFirst} onClick={() => sel && router.push(`/dashboard/recovery/new?step=backup&stack=${sel}`)}>{RECOVERY.steps.nextBackup}</ReasonButton>
                </div>
            )}
        </section>
    );
}

function BackupStep({data}: {data: WizardData}) {
    const router = useRouter();
    const h1 = useHeadingFocus();
    const pts = data.points ?? [];
    const ok = pts.filter((p) => p.status === "verified");
    const rest = pts.filter((p) => p.status !== "verified");
    const [sel, setSel] = React.useState<string | null>(ok[0] ? String(ok[0].sequence) : null);
    return (
        <section aria-labelledby="wiz-h">
            <StepIndicator current={2} links={wizardLinks(data)}/>
            <h1 id="wiz-h" ref={h1} tabIndex={-1} className="mb-1 text-2xl font-bold outline-none">{RECOVERY.steps.backup}</h1>
            <p className="text-muted-foreground mb-4 font-medium break-words">{data.stackName}</p>
            {data.dropped && <Dropped/>}
            {ok.length === 0 ? (
                <p data-testid="backup-empty" className="text-muted-foreground text-sm">{RECOVERY.backup.noneLeft}</p>
            ) : (
                <RadioGroup value={sel ?? ""} onValueChange={setSel} aria-labelledby="wiz-h" className="max-w-2xl">
                    {ok.map((p, i) => {
                        const id = `pt-${p.sequence}`;
                        return (
                            <div key={p.sequence} className={CARD}>
                                <RadioGroupItem id={id} value={String(p.sequence)} aria-describedby={`${id}-d`} className="mt-1"/>
                                <div className="min-w-0 space-y-0.5 text-sm">
                                    <Label htmlFor={id} className="font-medium">{p.label} <span className="text-muted-foreground font-normal">· {p.relative}</span>{i === 0 && <span className="text-muted-foreground font-normal"> · {RECOVERY.backup.newest}</span>}</Label>
                                    <div id={`${id}-d`} className="text-muted-foreground flex flex-col">
                                        {(p.size || p.consistency) && <span>{[p.size, p.consistency].filter(Boolean).join(" · ")}</span>}
                                        {p.destinations.length > 0 && <span>{RECOVERY.backup.stored(p.destinations)}</span>}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </RadioGroup>
            )}
            {rest.length > 0 && (
                <ul className="text-muted-foreground mt-4 max-w-2xl space-y-2 text-sm" data-testid="backup-unavailable">
                    {rest.map((p) => {
                        const st = RP_STATUS_LABELS[(Object.hasOwn(RP_STATUS_LABELS, p.status) ? p.status : "incomplete") as keyof typeof RP_STATUS_LABELS];
                        return <li key={p.sequence} aria-disabled="true" className="rounded-lg border border-dashed p-3"><span className="font-medium">{p.label}</span> — {st.label}. {st.description}</li>;
                    })}
                </ul>
            )}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start">
                {ok.length > 0 && <ReasonButton className={BTN} reason={sel ? null : RECOVERY.steps.chooseBackupFirst} onClick={() => sel && router.push(`/dashboard/recovery/new?step=machine&stack=${data.stackId}&point=${sel}`)}>{RECOVERY.steps.nextMachine}</ReasonButton>}
                <Link href="/dashboard/recovery/new?step=app" className="inline-flex h-9 items-center text-sm font-medium underline underline-offset-4">{RECOVERY.steps.back}</Link>
            </div>
        </section>
    );
}

function MachineStep({data}: {data: WizardData}) {
    const router = useRouter();
    const announce = useAnnounce();
    const h1 = useHeadingFocus();
    const targets = data.targets ?? [];
    const ready = targets.filter((t) => t.readiness === "ready");
    const notReady = targets.filter((t) => t.readiness !== "ready");
    const [sel, setSel] = React.useState<string | null>(data.machineId && ready.some((t) => t.id === data.machineId) ? data.machineId : null);
    const chosen = ready.find((t) => t.id === sel) ?? null;
    const [folders, setFolders] = React.useState<Record<string, string>>({});
    const [name, setName] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const folder = chosen ? (folders[chosen.id] ?? chosen.folder) : "";
    const reason = data.locked ? R_LOCKED : !chosen ? RECOVERY.steps.chooseMachineFirst : folder.trim() === "" ? RECOVERY.machine.folderRequired : busy ? RECOVERY.steps.preparing : null;

    const next = async () => {
        if (!chosen || !data.rpId || busy) return;
        setBusy(true); setErr(null); announce(RECOVERY.steps.preparing);
        try {
            const payload = {rpId: data.rpId, targetAgentId: chosen.id, purpose: "restore", mode: "new_stack", mappings: {target_project: name.trim() === "" ? null : name.trim(), restore_root: folder.trim() === "" ? null : folder.trim(), volumes: null, select: null, sqlite: null}};
            const v = verdict(await createRestorePlanAction(payload));
            if (v.ok) { router.push(`/dashboard/recovery/plans/${String(v.data.planId)}`); return; }
            const text = Object.hasOwn(PLAN_REFUSAL_TEXT, v.code) ? PLAN_REFUSAL_TEXT[v.code as keyof typeof PLAN_REFUSAL_TEXT] : RECOVERY.page.loadError.body;
            setErr(text); announce(text);
        } catch { setErr(RECOVERY.page.loadError.body); } finally { setBusy(false); }
    };
    return (
        <section aria-labelledby="wiz-h">
            <StepIndicator current={3} links={wizardLinks(data)}/>
            <h1 id="wiz-h" ref={h1} tabIndex={-1} className="mb-1 text-2xl font-bold outline-none">{RECOVERY.steps.machine}</h1>
            <p className="text-muted-foreground mb-4 font-medium break-words">{data.stackName}</p>
            {data.dropped && <Dropped/>}
            {targets.length === 0 && <p data-testid="machine-empty" className="text-muted-foreground text-sm">{RECOVERY.machine.empty} {data.isSysAdmin && <Link href="/dashboard/integrations/agent-channel" className="underline underline-offset-4">{RECOVERY.machine.fixLink}</Link>}</p>}
            {ready.length > 0 && (
                <RadioGroup value={sel ?? ""} onValueChange={setSel} aria-labelledby="wiz-h" className="max-w-2xl">
                    {ready.map((t) => {
                        const id = `m-${t.id}`;
                        const role = t.hostRoleSource === "default" ? RECOVERY.machine.noRole : HOST_ROLE_LABELS[t.hostRole].label;
                        return (
                            <div key={t.id} className={CARD} data-testid="machine-option">
                                <RadioGroupItem id={id} value={t.id} aria-describedby={`${id}-d`} className="mt-1"/>
                                <div className="min-w-0 space-y-0.5 text-sm">
                                    <Label htmlFor={id} className="font-medium break-words">{t.name}</Label>
                                    <div id={`${id}-d`} className="text-muted-foreground flex flex-col">
                                        <span>{AGENT_STATUS_LABELS[t.status]} · {role}</span>
                                        {t.wasSource && <span>{RECOVERY.machine.wasSource}</span>}
                                        <span>{RECOVERY.machine.ready}</span>
                                        {t.status === "offline" && <span role="note">{RECOVERY.machine.offlineWarning}</span>}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </RadioGroup>
            )}
            {notReady.length > 0 && (
                <ul className="text-muted-foreground mt-4 max-w-2xl space-y-2 text-sm" data-testid="machine-not-ready">
                    {notReady.map((t) => (
                        <li key={t.id} aria-disabled="true" className="rounded-lg border border-dashed p-3">
                            <span className="font-medium">{t.name}</span> — {AGENT_STATUS_LABELS[t.status]}. {RECOVERY.machine.notReady[t.readiness]} {RECOVERY.machine.fixHint}
                            {data.isSysAdmin && <> <Link href="/dashboard/integrations/agent-channel" className="underline underline-offset-4">{RECOVERY.machine.fixLink}</Link></>}
                        </li>
                    ))}
                </ul>
            )}
            {chosen && (
                <div className="mt-6 max-w-2xl space-y-4">
                    <div className="space-y-1">
                        <Label htmlFor="restore-folder" className="font-medium">{RECOVERY.machine.folder}</Label>
                        <Input id="restore-folder" value={folder} onChange={(e) => setFolders((f) => ({...f, [chosen.id]: e.target.value}))} aria-describedby="restore-folder-h" autoComplete="off" spellCheck={false}/>
                        <p id="restore-folder-h" className="text-muted-foreground text-sm">{RECOVERY.machine.folderHelp}</p>
                    </div>
                    <Collapsible>
                        <CollapsibleTrigger asChild><Button type="button" variant="link" className="h-auto p-0">{RECOVERY.machine.more}</Button></CollapsibleTrigger>
                        <CollapsibleContent className="mt-2 space-y-1">
                            <Label htmlFor="restore-name" className="font-medium">{RECOVERY.machine.name}</Label>
                            <Input id="restore-name" value={name} onChange={(e) => setName(e.target.value)} aria-describedby="restore-name-h" autoComplete="off" spellCheck={false}/>
                            <p id="restore-name-h" className="text-muted-foreground text-sm">{RECOVERY.machine.nameHelp}</p>
                        </CollapsibleContent>
                    </Collapsible>
                </div>
            )}
            {err && <p role="alert" data-testid="plan-error" className="mt-4 max-w-2xl rounded-md border p-3 text-sm">{err}</p>}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start">
                {ready.length > 0 && <ReasonButton className={BTN} reason={reason} aria-busy={busy || undefined} onClick={next}>{busy ? RECOVERY.steps.preparing : RECOVERY.steps.nextPlan}</ReasonButton>}
                <Link href={`/dashboard/recovery/new?step=backup&stack=${data.stackId}`} className="inline-flex h-9 items-center text-sm font-medium underline underline-offset-4">{RECOVERY.steps.back}</Link>
            </div>
        </section>
    );
}

export function WizardSteps({data}: {data: WizardData}) {
    return data.step === "app" ? <AppStep data={data}/> : data.step === "backup" ? <BackupStep data={data}/> : <MachineStep data={data}/>;
}
