"use client";

import Link from "next/link";
import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Label} from "@/components/ui/label";
import {RadioGroup, RadioGroupItem} from "@/components/ui/radio-group";
import {setStackMirrorOptInAction} from "@/fork/actions/mirror.action";
import {requestRunnerProbeAction} from "@/fork/actions/runner.action";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {AGENT_STATUS_LABELS} from "@/fork/ui/labels";
import {MIRRORS, RUNNER_REASON_TEXT, isolationUnknownText} from "@/fork/ui/mirrors/labels";
import {BTN, CARD, Dropped, MirrorStepIndicator, newHref, useHeadingFocus} from "@/fork/ui/mirrors/wizard/common.client";
import {ConfigureSteps, type ConfigureProps} from "@/fork/ui/mirrors/wizard/configure.client";
import {runnerBlock, type RunnerUi} from "@/fork/ui/mirrors/wizard/model";
import {verdict} from "@/fork/ui/recovery/call";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";
import {relative} from "@/fork/ui/recovery/model";
import {useAnnounce} from "@/fork/ui/status-announcer";

export type PointUi = {id: string; sequence: number; verified: boolean; label: string; relative: string; size: string | null; statusText: string};
export type WizardData = {
    step: "source" | "runner" | "configure"; dropped: boolean; locked: boolean; nowIso: string;
    stackId: string | null; stackName: string | null; points: PointUi[]; pointSeq: number | null;
    privacy: {containsPersonalData: boolean | null; optIn: boolean} | null;
    isSysAdmin: boolean; canProbe: boolean; runners: RunnerUi[]; runnerId: string | null;
    configure: ConfigureProps | null;
};

const links = (d: Pick<WizardData, "stackId" | "pointSeq">) => ({source: newHref({step: "source", stack: d.stackId}), runner: d.pointSeq ? newHref({step: "runner", stack: d.stackId, point: d.pointSeq}) : undefined});

function SourceStep({data}: {data: WizardData}) {
    const router = useRouter();
    const announce = useAnnounce();
    const h1 = useHeadingFocus();
    const ok = data.points.filter((p) => p.verified);
    const rest = data.points.filter((p) => !p.verified);
    const [sel, setSel] = React.useState<string | null>(data.pointSeq && ok.some((p) => p.sequence === data.pointSeq) ? String(data.pointSeq) : ok[0] ? String(ok[0].sequence) : null);
    const [confirm, setConfirm] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const pr = data.privacy;
    const needsOptIn = pr !== null && pr.containsPersonalData !== false && !pr.optIn;
    const P = MIRRORS.source.privacy;
    const reason = !sel ? MIRRORS.steps.chooseBackup : needsOptIn ? (data.isSysAdmin ? P.needsOptIn : P.adminOnly) : null;

    const allow = async () => {
        if (busy || !data.stackId) return;
        setBusy(true); setErr(null);
        try {
            const v = verdict(await setStackMirrorOptInAction({stackId: data.stackId, enabled: true}));
            if (v.ok) { announce(P.allowDone); router.refresh(); } else { setErr(P.failed); announce(P.failed); }
        } catch { setErr(P.failed); } finally { setBusy(false); setConfirm(false); }
    };
    if (!data.stackId) {
        return (
            <section aria-labelledby="wiz-h">
                <h1 id="wiz-h" ref={h1} tabIndex={-1} className="mb-4 text-2xl font-bold outline-none">{MIRRORS.page.title}</h1>
                {data.dropped && <Dropped/>}
                <p data-testid="no-stack" className="text-muted-foreground text-sm">{MIRRORS.noStack} <Link href="/dashboard/stacks" className="underline underline-offset-4">{MIRRORS.noStackLink}</Link></p>
            </section>
        );
    }
    return (
        <section aria-labelledby="wiz-h">
            <MirrorStepIndicator current={1} links={links(data)}/>
            <h1 id="wiz-h" ref={h1} tabIndex={-1} className="mb-1 text-2xl font-bold outline-none">{MIRRORS.steps.title.source}</h1>
            <p className="text-muted-foreground mb-4 font-medium break-words">{data.stackName}</p>
            {data.dropped && <Dropped/>}
            {ok.length === 0 ? (
                <p data-testid="source-empty" className="text-muted-foreground text-sm">{MIRRORS.source.none}</p>
            ) : (
                <RadioGroup value={sel ?? ""} onValueChange={setSel} aria-labelledby="wiz-h" className="max-w-2xl">
                    {ok.map((p, i) => {
                        const id = `pt-${p.sequence}`;
                        return (
                            <div key={p.sequence} className={CARD}>
                                <RadioGroupItem id={id} value={String(p.sequence)} aria-describedby={`${id}-d`} className="mt-1"/>
                                <div className="min-w-0 space-y-0.5 text-sm">
                                    <Label htmlFor={id} className="font-medium">{p.label} <span className="text-muted-foreground font-normal">· {p.relative}</span>{i === 0 && <span className="text-muted-foreground font-normal"> · {MIRRORS.source.newest}</span>}</Label>
                                    <div id={`${id}-d`} className="text-muted-foreground flex flex-col">{p.size && <span>{p.size}</span>}</div>
                                </div>
                            </div>
                        );
                    })}
                </RadioGroup>
            )}
            {rest.length > 0 && (
                <ul className="text-muted-foreground mt-4 max-w-2xl space-y-2 text-sm" data-testid="source-unavailable">
                    {rest.map((p) => <li key={p.sequence} aria-disabled="true" className="rounded-lg border border-dashed p-3"><span className="font-medium">{p.label}</span> — {p.statusText}. {MIRRORS.source.verifiedOnly}</li>)}
                </ul>
            )}
            {pr && (
                <div className="mt-6 max-w-2xl space-y-2 rounded-lg border p-3 text-sm" data-testid="privacy-block">
                    <h2 className="font-semibold">{P.heading}</h2>
                    <p>{pr.containsPersonalData === true ? P.yes : pr.containsPersonalData === null ? P.unknown : P.no}</p>
                    {pr.containsPersonalData !== false && <p data-testid="optin-state">{pr.optIn ? P.optedIn : P.needsOptIn}</p>}
                    {needsOptIn && data.isSysAdmin && (
                        <>
                            <Button type="button" variant="outline" disabled={data.locked} onClick={() => setConfirm(true)} data-testid="optin-allow">{P.allow}</Button>
                            <DangerousActionConfirm title={P.allowTitle} description={P.allowBody} confirmLabel={P.allowConfirm} open={confirm} onOpenChange={setConfirm} onConfirm={allow}/>
                        </>
                    )}
                    {needsOptIn && !data.isSysAdmin && <p data-testid="optin-admin-only">{P.adminOnly}</p>}
                    {err && <p role="alert" data-testid="optin-error">{err}</p>}
                </div>
            )}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start">
                {ok.length > 0 && <ReasonButton className={`${BTN} ${PRIMARY_AA}`} reason={reason} onClick={() => sel && router.push(newHref({step: "runner", stack: data.stackId, point: Number(sel)}))}>{MIRRORS.steps.next.runner}</ReasonButton>}
                <Link href={`/dashboard/stacks/${data.stackId}`} className="inline-flex h-9 items-center text-sm font-medium underline underline-offset-4">{MIRRORS.steps.back}</Link>
            </div>
        </section>
    );
}

const PROBE_REFRESH_MS = 5000;
const PROBE_MAX_MS = 3 * 60_000;

function RunnerFacts({r, now}: {r: RunnerUi; now: Date}) {
    const F = MIRRORS.runner.facts;
    const iso = r.isolation === "isolated" ? F.isolated(r.probedAt ? relative(new Date(r.probedAt), now) : "") : r.isolation === "not_isolated" ? F.notIsolated(r.reachableCount) : isolationUnknownText(r.isolationUnknown);
    return (
        <>
            <span>{AGENT_STATUS_LABELS[r.status]} · {iso}</span>
            <span>{F.targets(r.targetCount)} · {F.held(r.mirrorsHeld)} · {F.ports(r.freePorts)}</span>
            <span>{F.limits}</span>
            <span>{F.disk}</span>
            {r.busy && <span>{F.busy}</span>}
        </>
    );
}

function RunnerStep({data}: {data: WizardData}) {
    const router = useRouter();
    const announce = useAnnounce();
    const h1 = useHeadingFocus();
    const now = new Date(data.nowIso);
    const ok = data.runners.filter((r) => runnerBlock(r) === null);
    const rest = data.runners.filter((r) => runnerBlock(r) !== null);
    const [sel, setSel] = React.useState<string | null>(data.runnerId && ok.some((r) => r.id === data.runnerId) ? data.runnerId : null);
    const [probing, setProbing] = React.useState<string | null>(null);
    const sig0 = React.useRef<{sig: string; seenPending: boolean}>({sig: "", seenPending: false});
    const sigOf = (r: RunnerUi | undefined) => (r ? `${r.isolation}|${r.probedAt ?? ""}|${r.isolationUnknown ?? ""}` : "");
    const [err, setErr] = React.useState<string | null>(null);
    const pending = probing !== null || data.runners.some((r) => r.probePending);

    // refresh the server data every 5 s (≤ 3 min) while an isolation check runs; it settles when `probePending` clears
    React.useEffect(() => {
        if (!pending) return;
        const t0 = Date.now();
        const t = setInterval(() => { if (Date.now() - t0 > PROBE_MAX_MS) { clearInterval(t); setProbing(null); return; } if (!document.hidden) router.refresh(); }, PROBE_REFRESH_MS);
        return () => clearInterval(t);
    }, [pending, router]);
    // the check is over when a refresh shows the runner's isolation facts changed, or it was seen pending and is not any more (never right after the click: the server data is still the old one)
    // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to fresh server data only
    React.useEffect(() => {
        if (!probing) return;
        const r = data.runners.find((x) => x.id === probing);
        if (r?.probePending) sig0.current.seenPending = true;
        else if (sig0.current.seenPending || sigOf(r) !== sig0.current.sig) setProbing(null);
    }, [data.runners, probing]);

    const check = async (id: string) => {
        setErr(null); sig0.current = {sig: sigOf(data.runners.find((x) => x.id === id)), seenPending: false}; setProbing(id); announce(MIRRORS.runner.checking);
        try {
            const v = verdict(await requestRunnerProbeAction({agentId: id}));
            if (v.ok) announce(MIRRORS.runner.checkRequested);
            else { setProbing(null); setErr(MIRRORS.runner.checkFailed); announce(MIRRORS.runner.checkFailed); }
        } catch { setProbing(null); setErr(MIRRORS.runner.checkFailed); }
    };
    const reasonOf = (r: RunnerUi) => { const k = runnerBlock(r)!; return k === "isolation_unknown" ? isolationUnknownText(r.isolationUnknown) : RUNNER_REASON_TEXT[k]; };

    return (
        <section aria-labelledby="wiz-h">
            <MirrorStepIndicator current={2} links={links(data)}/>
            <h1 id="wiz-h" ref={h1} tabIndex={-1} className="mb-1 text-2xl font-bold outline-none">{MIRRORS.steps.title.runner}</h1>
            <p className="text-muted-foreground mb-4 font-medium break-words">{data.stackName}</p>
            {data.dropped && <Dropped/>}
            {data.runners.length === 0 && <p data-testid="runner-empty" className="text-muted-foreground text-sm">{MIRRORS.runner.empty} {data.isSysAdmin ? MIRRORS.runner.emptyAdmin : MIRRORS.runner.emptyMember}</p>}
            {ok.length > 0 && (
                <RadioGroup value={sel ?? ""} onValueChange={setSel} aria-labelledby="wiz-h" className="max-w-2xl">
                    {ok.map((r) => {
                        const id = `rn-${r.id}`;
                        return (
                            <div key={r.id} className={CARD} data-testid="runner-option">
                                <RadioGroupItem id={id} value={r.id} aria-describedby={`${id}-d`} className="mt-1"/>
                                <div className="min-w-0 space-y-0.5 text-sm">
                                    <Label htmlFor={id} className="font-medium break-words">{r.name}</Label>
                                    <div id={`${id}-d`} className="text-muted-foreground flex flex-col"><RunnerFacts r={r} now={now}/></div>
                                </div>
                            </div>
                        );
                    })}
                </RadioGroup>
            )}
            {rest.length > 0 && (
                <ul className="mt-4 max-w-2xl space-y-2 text-sm" data-testid="runner-unavailable">
                    {rest.map((r) => (
                        <li key={r.id} aria-disabled="true" className="rounded-lg border border-dashed p-3" data-testid="runner-disabled">
                            <span className="font-medium break-words">{r.name}</span> — <span data-testid="runner-reason">{reasonOf(r)}</span>
                            <div className="text-muted-foreground mt-1 flex flex-col"><RunnerFacts r={r} now={now}/></div>
                            {data.isSysAdmin && data.canProbe && r.eligible && (
                                <Button type="button" variant="outline" size="sm" className="mt-2" aria-busy={probing === r.id || undefined} disabled={pending} onClick={() => check(r.id)} data-testid="runner-check">{probing === r.id || r.probePending ? MIRRORS.runner.checking : MIRRORS.runner.check}</Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {ok.length > 0 && data.isSysAdmin && data.canProbe && (
                <Button type="button" variant="outline" size="sm" className="mt-3" disabled={pending} onClick={() => sel && check(sel)} data-testid="runner-check-selected">{MIRRORS.runner.check}</Button>
            )}
            {err && <p role="alert" data-testid="runner-error" className="mt-3 max-w-2xl rounded-md border p-3 text-sm">{err}</p>}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start">
                {data.runners.length > 0 && <ReasonButton className={`${BTN} ${PRIMARY_AA}`} reason={sel ? null : MIRRORS.steps.chooseRunner} onClick={() => sel && router.push(newHref({step: "configure", stack: data.stackId, point: data.pointSeq, runner: sel}))}>{MIRRORS.steps.next.access}</ReasonButton>}
                <Link href={newHref({step: "source", stack: data.stackId})} className="inline-flex h-9 items-center text-sm font-medium underline underline-offset-4">{MIRRORS.steps.back}</Link>
            </div>
        </section>
    );
}

export function MirrorWizardSteps({data}: {data: WizardData}) {
    if (data.step === "configure" && data.configure) return <ConfigureSteps {...data.configure}/>;
    return data.step === "runner" ? <RunnerStep data={data}/> : <SourceStep data={data}/>;
}
