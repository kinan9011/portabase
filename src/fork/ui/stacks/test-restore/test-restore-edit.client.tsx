"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {setStackPrivacyAction} from "@/fork/actions/restore-plan.action";
import {runTestRestoreNowAction, setTestRestoreScheduleAction, wipeTestRestoreNowAction} from "@/fork/actions/test-restore.action";
import {ScheduleSchema, type Schedule} from "@/fork/schedule/schedule";
import {DEFAULT_TR_SCHEDULE} from "@/fork/test-restore/vocab";
import type {TestRestoreView} from "@/fork/test-restore/view";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {GENERIC_FAILURE} from "@/fork/ui/labels";
import {SchedulePicker} from "@/fork/ui/schedule-picker";
import {normalise} from "@/fork/ui/stacks/wizard/outcome";
import {A11Y_COPY} from "@/fork/ui/a11y/labels";
import {useAnnounce} from "@/fork/ui/status-announcer";
import {TR, refusalText} from "./labels";

const POLL_MS = 10_000;
type Msg = {ok: boolean; text: string} | null;
type Verdict = {ok: boolean; code?: string};

/** Server verdict → one visible sentence (no optimistic success: a click is reported only from what the server answered). */
async function verdict(call: () => Promise<unknown>, okText: string, failText: (code: string | undefined) => string): Promise<{ok: boolean; text: string}> {
    try {
        const r = normalise<Verdict>((await call()) as never);
        if (r.kind === "ok") return {ok: true, text: okText};
        return {ok: false, text: r.kind === "refused" ? failText(r.code) : GENERIC_FAILURE};
    } catch {
        return {ok: false, text: GENERIC_FAILURE};
    }
}

/** While the server says a test restore or its wipe is active, re-render every 10 s; stops by itself. */
// ponytail: polls until the server says inactive; a stuck wipe is bounded by the 24 h wipe deadline (D-6), upgrade to backoff if it matters.
export function TestRestorePoller({active, headline}: {active: boolean; headline: string | null}) {
    const router = useRouter();
    const announce = useAnnounce();
    const prev = React.useRef<boolean | null>(null);
    React.useEffect(() => {
        if (!active) return;
        const t = setInterval(() => router.refresh(), POLL_MS);
        return () => clearInterval(t);
    }, [active, router]);
    // 4.1.3: a result discovered by polling reaches the page's ONE status region (prev-ref: only the real active -> idle transition).
    React.useEffect(() => {
        const p = prev.current;
        prev.current = active;
        if (p === true && !active && headline) announce(headline);
    }, [active, headline, announce]);
    return null;
}

export function TestRestoreActions({view, stackId, configLocked, active}: {view: TestRestoreView; stackId: string; configLocked: boolean; active: boolean}) {
    const router = useRouter();
    const announce = useAnnounce();
    const [pending, setPending] = React.useState(false);
    const [msg, setMsg] = React.useState<Msg>(null);
    const last = view.last;
    const noOptIn = view.privacy.containsPersonalData !== false && !view.privacy.optIn;
    const runReason = !view.can.runNow ? (view.schedule.configured ? TR.reasons.member : TR.reasons.notConfigured) : configLocked ? TR.reasons.locked
        : active ? TR.reasons.active : last?.wipe.state === "failed" ? TR.reasons.wipeFirst : noOptIn ? TR.refusal.personal_data_no_opt_in : null;
    const act = async (call: () => Promise<unknown>, okText: string) => {
        if (pending) return;
        setPending(true);
        const r = await verdict(call, okText, refusalText);
        setMsg(r);
        announce(r.text);
        setPending(false);
        if (r.ok) router.refresh();
    };
    const showRun = view.can.runNow || view.schedule.configured;
    const showWipe = view.can.wipeNow && last?.wipe.state === "failed";
    if (!showRun && !showWipe && !msg) return <></>;
    return (
        <div className="flex flex-col gap-2" data-testid="tr-actions">
            <div className="flex flex-wrap items-start gap-3">
                {showRun && <ReasonButton type="button" className={PRIMARY_AA} reason={runReason} aria-busy={pending || undefined} data-testid="tr-run-now" onClick={() => void act(() => runTestRestoreNowAction({stackId}), TR.actions.started)}>{TR.actions.runNow}</ReasonButton>}
                {showWipe && last && <ReasonButton type="button" variant="outline" reason={configLocked ? TR.reasons.locked : null} data-testid="tr-wipe-now" onClick={() => void act(() => wipeTestRestoreNowAction({runId: last.runId}), TR.actions.wipeArmed)}>{TR.actions.wipeNow}</ReasonButton>}
            </div>
            {msg && <p data-testid="tr-outcome" className={`max-w-prose text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</p>}
        </div>
    );
}

export function TestRestoreEditor({view, stackId, reason}: {view: TestRestoreView; stackId: string; reason: string | null}) {
    const router = useRouter();
    const announce = useAnnounce();
    const ids = React.useId();
    const admin = view.admin;
    const [open, setOpen] = React.useState(false);
    const [enabled, setEnabled] = React.useState(false);
    const [sched, setSched] = React.useState<Schedule>(DEFAULT_TR_SCHEDULE);
    const [cronOk, setCronOk] = React.useState(true);
    const [target, setTarget] = React.useState("");
    const [root, setRoot] = React.useState("");
    const [stale, setStale] = React.useState(String(view.schedule.staleAfterDays));
    const [pending, setPending] = React.useState(false);
    const [msg, setMsg] = React.useState<Msg>(null);
    const opener = React.useRef<HTMLButtonElement | null>(null);
    const staleN = Number(stale);
    const staleOk = Number.isInteger(staleN) && staleN >= 1 && staleN <= 90;
    const schedOk = ScheduleSchema.safeParse(sched).success && cronOk;
    const needTarget = enabled && (!target || root.trim() === "");
    const blocked = needTarget || !staleOk || !schedOk;
    const noCandidates = (admin?.candidates.length ?? 0) === 0;
    // keyboard users keep their place: opening moves focus into the form, closing returns it to the opener (the opener is a new node after the form unmounts)
    const firstRef = React.useRef<HTMLInputElement | null>(null);
    const refocusOpener = React.useRef(false);
    React.useEffect(() => {
        if (open) firstRef.current?.focus();
        else if (refocusOpener.current) { refocusOpener.current = false; opener.current?.focus(); }
    }, [open]);
    const close = () => { refocusOpener.current = true; setOpen(false); };
    const save = async () => {
        if (pending || blocked) return;
        setPending(true);
        const r = await verdict(() => setTestRestoreScheduleAction({stackId, enabled, schedule: sched, targetAgentId: target || null, restoreRoot: root.trim() || null, staleAfterDays: staleN}), TR.edit.saved, refusalText);
        setMsg(r);
        announce(r.text);
        setPending(false);
        if (r.ok) { close(); router.refresh(); }
    };
    return (
        <div className="flex flex-col gap-3" data-testid="tr-editor">
            {!open && (
                <div className="flex flex-wrap items-start gap-3">
                    <ReasonButton ref={opener} type="button" variant="outline" reason={reason} data-testid="tr-edit-open" onClick={() => {
                        setEnabled(view.schedule.enabled); setSched(admin?.schedule ?? DEFAULT_TR_SCHEDULE); setTarget(admin?.targetAgentId ?? ""); setRoot(admin?.restoreRoot ?? "");
                        setStale(String(view.schedule.staleAfterDays)); setMsg(null); setOpen(true);
                    }}>{TR.edit.open}</ReasonButton>
                    {msg && <span data-testid="tr-edit-outcome" className={`max-w-prose text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</span>}
                </div>
            )}
            {open && admin && (
                <form className="flex flex-col gap-4 rounded-xl border p-4" aria-labelledby={`${ids}-h`} data-testid="tr-edit-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
                    <h4 id={`${ids}-h`} className="font-semibold">{TR.edit.heading}</h4>
                    <div className="flex items-center gap-2">
                        <input id={`${ids}-en`} type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="tr-enabled" ref={firstRef} className="size-6 shrink-0"/>
                        <Label htmlFor={`${ids}-en`}>{TR.edit.enabled}</Label>
                    </div>
                    <SchedulePicker value={sched} onChange={setSched} onCronValidity={setCronOk}/>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${ids}-tg`}>{TR.edit.target}</Label>
                        <select id={`${ids}-tg`} data-testid="tr-target" className="border-input bg-background h-9 rounded-md border px-3 text-sm" value={target} onChange={(e) => setTarget(e.target.value)}
                            aria-disabled={noCandidates || undefined} aria-describedby={noCandidates ? `${ids}-nc` : undefined}>
                            <option value="">{TR.edit.chooseTarget}</option>
                            {admin.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {noCandidates && <p id={`${ids}-nc`} className="text-muted-foreground max-w-prose text-xs">{TR.edit.noCandidates}</p>}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${ids}-rt`}>{TR.edit.root}</Label>
                        <Input id={`${ids}-rt`} data-testid="tr-root" value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} autoComplete="off" aria-describedby={`${ids}-rh`}/>
                        <span id={`${ids}-rh`} className="text-muted-foreground max-w-prose text-xs">{TR.edit.rootHint}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${ids}-st`}>{TR.edit.stale}</Label>
                        <Input id={`${ids}-st`} data-testid="tr-stale" type="number" min={1} max={90} value={stale} onChange={(e) => setStale(e.target.value)} className="w-28"/>
                    </div>
                    {needTarget && <p id={`${ids}-nt`} className="text-muted-foreground text-sm">{TR.edit.needTargetRoot}</p>}
                    {msg && !msg.ok && <p role="alert" data-testid="tr-edit-error" className="text-destructive text-sm">{msg.text}</p>}
                    <div className="flex flex-wrap gap-3">
                        <Button type="submit" className={PRIMARY_AA} aria-busy={pending || undefined} aria-disabled={blocked || undefined} aria-describedby={needTarget ? `${ids}-nt` : undefined} data-testid="tr-edit-save">{pending ? TR.edit.saving : TR.edit.save}</Button>
                        <Button type="button" variant="outline" onClick={close} data-testid="tr-edit-cancel">{TR.edit.cancel}</Button>
                    </div>
                </form>
            )}
        </div>
    );
}

type Pd = "yes" | "no" | "unset";
const pdOf = (v: boolean | null): Pd => (v === true ? "yes" : v === false ? "no" : "unset");

export function PrivacyEditor({view, stackId, reason}: {view: TestRestoreView; stackId: string; reason: string | null}) {
    const router = useRouter();
    const announce = useAnnounce();
    const ids = React.useId();
    const [pd, setPd] = React.useState<Pd>(pdOf(view.privacy.containsPersonalData));
    const [optIn, setOptIn] = React.useState(view.privacy.optIn);
    const [dlg, setDlg] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [msg, setMsg] = React.useState<Msg>(null);
    const blocked = !!reason;
    const noNeed = pd === "no";
    const save = async () => {
        if (blocked || pending) return;
        setPending(true);
        const r = await verdict(() => setStackPrivacyAction({stackId, containsPersonalData: pd === "yes" ? true : pd === "no" ? false : null, testRestoreOptIn: noNeed ? false : optIn}), TR.privacy.saved, (c) => (c && Object.hasOwn(TR.privacyRefusal, c) ? TR.privacyRefusal[c] : GENERIC_FAILURE));
        setMsg(r);
        announce(r.text);
        setPending(false);
        if (r.ok) router.refresh();
    };
    return (
        <form className="flex flex-col gap-2" data-testid="tr-privacy-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <fieldset className="flex flex-col gap-1.5" aria-describedby={blocked ? `${ids}-r` : undefined}>
                <legend className="text-sm font-medium">{TR.privacy.question}</legend>
                {([["yes", TR.privacy.yes], ["no", TR.privacy.no], ["unset", TR.privacy.unset]] as const).map(([v, label]) => (
                    <div key={v} className="flex items-center gap-2">
                        <input id={`${ids}-${v}`} type="radio" name={`${ids}-pd`} value={v} checked={pd === v} aria-disabled={blocked || undefined} data-testid={`tr-pd-${v}`} className="size-6 shrink-0"
                            onChange={() => { if (!blocked) { setPd(v); if (v === "no") setOptIn(false); } }}/>
                        <Label htmlFor={`${ids}-${v}`}>{label}</Label>
                    </div>
                ))}
            </fieldset>
            <div className="flex items-center gap-2">
                <input id={`${ids}-oi`} type="checkbox" checked={noNeed ? false : optIn} aria-disabled={blocked || noNeed || undefined} aria-describedby={[`${ids}-oh`, noNeed ? `${ids}-nn` : null, blocked ? `${ids}-r` : null].filter(Boolean).join(" ")} data-testid="tr-optin" className="size-6 shrink-0"
                    onChange={(e) => { if (blocked || noNeed) return; if (e.target.checked) setDlg(true); else setOptIn(false); }}/>
                <Label htmlFor={`${ids}-oi`}>{TR.privacy.optIn}</Label>
            </div>
            <p id={`${ids}-oh`} className="text-muted-foreground text-xs">{A11Y_COPY.optInConfirmHint}</p>
            {noNeed && <p id={`${ids}-nn`} className="text-muted-foreground text-xs">{TR.privacy.optInNeedsYes}</p>}
            {blocked && <p id={`${ids}-r`} className="text-muted-foreground max-w-prose text-xs">{reason}</p>}
            <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="outline" aria-disabled={blocked || undefined} aria-describedby={blocked ? `${ids}-r` : undefined} aria-busy={pending || undefined} data-testid="tr-privacy-save">{TR.privacy.save}</Button>
                {msg && <span data-testid="tr-privacy-outcome" className={`max-w-prose text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</span>}
            </div>
            <DangerousActionConfirm open={dlg} onOpenChange={setDlg} title={TR.privacy.confirmTitle} confirmLabel={TR.privacy.confirm} description={<p>{TR.privacy.d44}</p>} onConfirm={() => { setOptIn(true); setDlg(false); }}/>
        </form>
    );
}
