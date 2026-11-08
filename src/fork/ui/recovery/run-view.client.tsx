"use client";

import Link from "next/link";
import * as React from "react";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {approveRestorePolicyAction, cancelRestoreRunAction, cleanupRestoreRunAction, getRestoreRunViewAction} from "@/fork/actions/restore-run.action";
import type {RestoreRunView} from "@/fork/restore-run/view";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";
import {SERVICE_STATE_LABELS} from "@/fork/ui/labels";
import {verdict} from "@/fork/ui/recovery/call";
import {CANCEL_REFUSAL_TEXT, CLEANUP_REFUSAL_TEXT, POLICY_REFUSAL_TEXT, RECOVERY, RULE_TEXT, R_PROD, STATE_CHIP, STEP_TEXT, UNKNOWN_RULE} from "@/fork/ui/recovery/labels";
import {elapsed, failureSentence, isActiveState, isPolling, runHeadline, stepStatus} from "@/fork/ui/recovery/model";
import {useAnnounce} from "@/fork/ui/status-announcer";
import {ToneBadge} from "@/fork/ui/tone-badge";
import type {Tone} from "@/fork/ui/tone";

export const POLL_MS = 5000;
const utcTime = (d: Date) => `${d.toISOString().slice(11, 19)} UTC`;
const textOf = <T extends Record<string, string>>(m: T, code: string): string => (Object.hasOwn(m, code) ? m[code as keyof T] as string : RECOVERY.page.loadError.body);
const ALERT_STATES = new Set(["failed", "incomplete", "awaiting_approval"]);

export type RunViewProps = {initial: RestoreRunView; appName: string; canExecute: boolean; canApproveProduction: boolean; locked: boolean; serverNowIso: string};

/** Screen 6. The first render comes from the server (reload-safe); afterwards ONE poller reads the durable run view every 5 s (DD-W18b-7) until the run is over. */
export function RunView({initial, appName, canExecute, canApproveProduction, locked, serverNowIso}: RunViewProps) {
    const announce = useAnnounce();
    const [view, setView] = React.useState(initial);
    const [updated, setUpdated] = React.useState(() => new Date(serverNowIso));
    const [pollFailed, setPollFailed] = React.useState(false);
    const [alertText, setAlertText] = React.useState<string | null>(null);
    const machine = view.targetAgentName;
    const viewRef = React.useRef(view); viewRef.current = view;

    const poll = React.useCallback(async () => {
        try {
            const v = verdict(await getRestoreRunViewAction({runId: viewRef.current.id}));
            if (v.ok) { setView(v.data.view as RestoreRunView); setUpdated(new Date()); setPollFailed(false); } else setPollFailed(true);
        } catch { setPollFailed(true); }
    }, []);

    // the heading takes focus on arrival (router.push leaves it on <body>), like the wizard steps (W18b-f2 D5)
    React.useEffect(() => { document.getElementById("run-h")?.focus(); }, []);

    const active = isPolling(view);
    React.useEffect(() => {
        if (!active) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let stopped = false;
        const schedule = () => { timer = setTimeout(async () => { if (stopped) return; if (!document.hidden) await poll(); if (!stopped) schedule(); }, POLL_MS); };
        const onVis = () => { if (!document.hidden && timer === null) schedule(); };
        schedule();
        document.addEventListener("visibilitychange", onVis);
        return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
    }, [active, poll]);

    // announce only real changes (step / state / cleanup); the alert region only for transitions into failed / incomplete / awaiting approval
    const sig = `${view.state}|${view.steps.map((s) => `${s.name}:${s.status}`).join(",")}|${view.cleanup?.status ?? ""}`;
    const first = React.useRef(true); const prevState = React.useRef(view.state);
    // biome-ignore lint/correctness/useExhaustiveDependencies: fires on the change signature only (not on every poll tick); `view` is read as of that change
    React.useEffect(() => {
        if (first.current) { first.current = false; return; }
        const h = runHeadline(view);
        announce(h.text);
        if (prevState.current !== view.state) setAlertText(ALERT_STATES.has(view.state) ? h.text : null); // the alert never outlives its state (W18b-f2 D1)
        prevState.current = view.state;
    }, [sig]);

    const head = runHeadline(view);
    const startedAt = new Date(view.createdAt);
    const to = view.finishedAt ? new Date(view.finishedAt) : updated;
    const terminalBad = ["failed", "cancelled", "incomplete"].includes(view.state);
    const clean = view.cleanup;

    return (
        <section aria-labelledby="run-h" className="max-w-3xl space-y-6">
            <div>
                <h1 id="run-h" tabIndex={-1} className="mb-2 text-2xl font-bold break-words">{RECOVERY.run.title(appName, machine)}</h1>
                <p className="mb-2"><ToneBadge tone={head.tone} busy={view.state === "running"}>{STATE_CHIP[view.state as keyof typeof STATE_CHIP] ?? view.state}</ToneBadge></p>
                <p data-testid="run-headline" className="text-base break-words">{head.text}</p>
                <p className="text-muted-foreground mt-2 text-sm">{RECOVERY.run.started(`${startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`, elapsed(startedAt, to))}</p>
                {isActiveState(view.state) && <p className="text-muted-foreground text-sm">{RECOVERY.run.deadline(`${new Date(view.deadlineAt).toISOString().slice(0, 16).replace("T", " ")} UTC`)}</p>}
                <p className="text-muted-foreground text-sm">{RECOVERY.run.reference(view.id.slice(0, 8))} · <span data-testid="run-updated">{RECOVERY.run.updated(utcTime(updated))}</span></p>
                {pollFailed && <p role="note" data-testid="poll-error" className="mt-2 text-sm">{RECOVERY.run.pollError}</p>}
                {view.cancelRequested && isActiveState(view.state) && <p className="mt-2"><ToneBadge tone="warning">{RECOVERY.run.cancelling}</ToneBadge></p>}
            </div>
            {alertText && <div role="alert" data-testid="run-alert" className="rounded-md border p-3 text-sm">{alertText}</div>}

            {view.state === "awaiting_approval" && <AllowPanel view={view} canApprove={canApproveProduction} locked={locked} refreshNow={poll} onCancel={null}/>}

            <ol className="divide-y rounded-lg border" data-testid="run-steps">
                {view.steps.map((s) => {
                    const st = stepStatus(s, view.state, machine);
                    const tone: Tone = st.kind === "done" ? "success" : st.kind === "failed" ? "danger" : st.kind === "in_progress" || st.kind === "waiting_machine" || st.kind === "retrying" ? "active" : "neutral";
                    return (
                        <li key={s.name} data-testid="run-step" data-kind={st.kind} className="flex flex-wrap items-start gap-x-3 gap-y-1 p-3 text-sm">
                            <span className="min-w-0 flex-1 font-medium">{STEP_TEXT[s.name as keyof typeof STEP_TEXT] ?? s.name}</span>
                            <ToneBadge tone={tone} busy={st.kind === "in_progress" || st.kind === "waiting_machine"}>{st.text}</ToneBadge>
                            {st.reason && <span className="basis-full text-sm">{st.reason}{st.reference && <> Reference: {st.reference}</>}</span>}
                        </li>
                    );
                })}
            </ol>

            {view.services.length > 0 && (
                <section aria-labelledby="svc-h" data-testid="run-services">
                    <h2 id="svc-h" className="mb-2 text-lg font-semibold">{RECOVERY.run.services}</h2>
                    <ul className="flex flex-wrap gap-2">
                        {view.services.map((s) => { const d = SERVICE_STATE_LABELS[(Object.hasOwn(SERVICE_STATE_LABELS, s.state) ? s.state : "absent") as keyof typeof SERVICE_STATE_LABELS]; return <li key={s.service} className="flex items-center gap-2 text-sm"><span className="font-medium">{s.service}</span><ToneBadge tone={d.tone}>{d.label}</ToneBadge></li>; })}
                    </ul>
                </section>
            )}

            {isActiveState(view.state) && canExecute && !view.cancelRequested && <CancelControl runId={view.id} machine={machine} locked={locked} refreshNow={poll}/>}

            {terminalBad && canExecute && <CleanupControl view={view} locked={locked} refreshNow={poll}/>}
            {clean && (
                <p data-testid="cleanup-line" className="text-sm">
                    {["queued", "leased", "running"].includes(clean.status) ? RECOVERY.run.cleanupRunning
                        : clean.status === "succeeded" ? RECOVERY.run.cleanupDone
                        : clean.status === "cancelled" ? RECOVERY.run.cleanupCancelled
                        : RECOVERY.run.cleanupFailed(failureSentence(clean.reason, machine).text)}
                </p>
            )}

            {view.state === "succeeded" && (
                <section aria-labelledby="next-h" data-testid="run-next">
                    <h2 id="next-h" className="mb-2 text-lg font-semibold">{RECOVERY.run.next}</h2>
                    <ul className="list-disc space-y-1 pl-5 text-sm">{RECOVERY.run.nextItems.map((t) => <li key={t}>{t}</li>)}</ul>
                    <p className="mt-2 text-sm"><Link href="/dashboard/stacks" className="underline underline-offset-4">{RECOVERY.run.protectLink}</Link></p>
                </section>
            )}
            <p><Link href="/dashboard/recovery" className="text-sm underline underline-offset-4">{RECOVERY.run.openRecovery}</Link></p>
        </section>
    );
}

function AllowPanel({view, canApprove, locked, refreshNow}: {view: RestoreRunView; canApprove: boolean; locked: boolean; refreshNow: () => Promise<void>; onCancel: null}) {
    const announce = useAnnounce();
    const refs = React.useRef<Record<string, HTMLInputElement | null>>({});
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const [hard, setHard] = React.useState(false);
    const aw = view.awaiting;
    const machine = view.targetAgentName;
    if (!aw) return <p role="note" data-testid="awaiting-preparing" className="rounded-md border p-3 text-sm">{RECOVERY.run.awaitingPreparing}</p>;
    const reason = !canApprove ? R_PROD : locked ? RECOVERY.page.lockedBanner : null;
    const submit = async () => {
        if (busy || reason) return;
        setBusy(true); setErr(null);
        const confirmations: Record<string, string> = {};
        for (const s of aw.services) { const el = refs.current[s.service]; confirmations[s.service] = el?.value ?? ""; if (el) el.value = ""; } // read once, clear at once: the typed text never outlives the click
        try {
            const v = verdict(await approveRestorePolicyAction({runId: view.id, confirmations}));
            if (v.ok) { announce("Allowed. The restore continues."); await refreshNow(); document.getElementById("run-h")?.focus(); }
            else { const t = textOf(POLICY_REFUSAL_TEXT, v.code); setErr(t); announce(t); if (v.code === "hard_refusal") setHard(true); }
        } catch { setErr(RECOVERY.page.loadError.body); } finally { setBusy(false); }
    };
    return (
        <section aria-labelledby="allow-h" data-testid="allow-panel" className="space-y-4 rounded-lg border p-4">
            <h2 id="allow-h" className="text-lg font-semibold">{RECOVERY.run.awaitingTitle}</h2>
            {aw.services.map((s) => (
                <div key={s.service} className="space-y-2" data-testid="allow-service">
                    <p className="font-medium break-words">{s.service}</p>
                    <ul className="list-disc space-y-1 pl-5 text-sm">{s.rules.map((r) => <li key={r}>{Object.hasOwn(RULE_TEXT, r) ? RULE_TEXT[r as keyof typeof RULE_TEXT](s.service) : UNKNOWN_RULE(s.service)}</li>)}</ul>
                    <p className="text-muted-foreground text-sm">{RECOVERY.run.allowSuffix(machine)}</p>
                    <Label htmlFor={`allow-${s.service}`}>{RECOVERY.run.allowLabel(s.service)}</Label>
                    <Input id={`allow-${s.service}`} ref={(el) => { refs.current[s.service] = el; }} defaultValue="" spellCheck={false} autoComplete="off" data-gramm="false" data-1p-ignore
                        readOnly={reason !== null} aria-disabled={reason !== null ? true : undefined} aria-describedby={reason ? "allow-reason" : undefined}/>
                </div>
            ))}
            {reason && <p id="allow-reason" className="text-muted-foreground text-sm">{reason}</p>}
            {err && <p role="alert" data-testid="allow-error" className="text-sm">{err}</p>}
            {!hard && <ReasonButton className={PRIMARY_AA} reason={reason === null && busy ? RECOVERY.go.busy : reason} onClick={submit}>{RECOVERY.run.allowButton}</ReasonButton>}
        </section>
    );
}

function CancelControl({runId, machine, locked, refreshNow}: {runId: string; machine: string; locked: boolean; refreshNow: () => Promise<void>}) {
    const announce = useAnnounce();
    const [open, setOpen] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const go = async () => {
        setErr(null);
        try {
            const v = verdict(await cancelRestoreRunAction({runId}));
            if (v.ok) { announce(RECOVERY.run.cancelling); await refreshNow(); document.getElementById("run-h")?.focus(); } else { const t = textOf(CANCEL_REFUSAL_TEXT, v.code); setErr(t); announce(t); }
        } catch { setErr(RECOVERY.page.loadError.body); }
    };
    return (
        <div className="space-y-2">
            <ReasonButton variant="outline" reason={locked ? RECOVERY.page.lockedBanner : null} onClick={() => setOpen(true)} data-testid="cancel-run">{RECOVERY.run.cancel}</ReasonButton>
            {err && <p role="alert" className="text-sm">{err}</p>}
            <DangerousActionConfirm open={open} onOpenChange={setOpen} title={RECOVERY.run.cancelTitle} description={<p>{RECOVERY.run.cancelBody(machine)}</p>} confirmLabel={RECOVERY.run.cancelConfirm} onConfirm={() => { void go(); }}/>
        </div>
    );
}

function CleanupControl({view, locked, refreshNow}: {view: RestoreRunView; locked: boolean; refreshNow: () => Promise<void>}) {
    const announce = useAnnounce();
    const [open, setOpen] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const c = view.cleanup;
    const inFlight = c !== null && ["queued", "leased", "running"].includes(c.status);
    const done = c?.status === "succeeded";
    if (done) return null;
    const go = async () => {
        setErr(null);
        try {
            const v = verdict(await cleanupRestoreRunAction({runId: view.id}));
            if (v.ok) { announce(RECOVERY.run.cleanupRunning); await refreshNow(); document.getElementById("run-h")?.focus(); } else { const t = textOf(CLEANUP_REFUSAL_TEXT, v.code); setErr(t); announce(t); }
        } catch { setErr(RECOVERY.page.loadError.body); }
    };
    const retry = c !== null;
    return (
        <div className="space-y-2" data-testid="cleanup-control">
            <ReasonButton variant="outline" reason={locked ? RECOVERY.page.lockedBanner : inFlight ? RECOVERY.run.cleanupRunning : null} onClick={() => setOpen(true)}>{retry ? RECOVERY.run.cleanupRetry : RECOVERY.run.cleanupButton}</ReasonButton>
            {err && <p role="alert" className="text-sm">{err}</p>}
            <DangerousActionConfirm open={open} onOpenChange={setOpen} title={RECOVERY.run.cleanupTitle} description={<p>{RECOVERY.run.cleanupBody(view.targetAgentName, view.state === "incomplete")}</p>} confirmLabel={RECOVERY.run.cleanupConfirm} onConfirm={() => { void go(); }}/>
        </div>
    );
}

