"use client";

import Link from "next/link";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {cancelMirrorRevisionAction, getMirrorAccessAction, getMirrorViewAction, retryMirrorWipeAction} from "@/fork/actions/mirror.action";
import {ACTIVE_REVISION_STATES, GATES, WIPE_REVISION_STATES} from "@/fork/mirror/vocab";
import type {MirrorView} from "@/fork/mirror/view";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {BANNER, GATE_TEXT, MIRRORS, reasonText, refusalText, statusText, stepText} from "@/fork/ui/mirrors/labels";
import {groupSteps} from "@/fork/ui/mirrors/model";
import {settled} from "@/fork/ui/mirrors/wizard/model";
import {useAnnounce} from "@/fork/ui/status-announcer";
import type {Tone} from "@/fork/ui/tone";
import {ToneBadge} from "@/fork/ui/tone-badge";

export const MIRROR_POLL_MS = 3000;
type Rev = MirrorView["revisions"][number];
const P = MIRRORS.progress;
const dataOf = (r: unknown): Record<string, unknown> | null => { const d = (r as {data?: unknown} | undefined)?.data; return d && typeof d === "object" ? (d as Record<string, unknown>) : null; };
const isActive = (s: string) => (ACTIVE_REVISION_STATES as readonly string[]).includes(s);
const isWipeState = (s: string) => (WIPE_REVISION_STATES as readonly string[]).includes(s);

/** Headline + tone by state. READY says "isolated and health-checked" and nothing stronger (D43: start-tested is not restore-tested). */
export function headline(view: MirrorView): {text: string; tone: Tone} {
    const r = view.revisions[0];
    if (view.mirror.status === "deleting") return {text: MIRRORS.lifecycle.deletingLine, tone: "active"}; // W23
    if (view.mirror.status === "deleted") return {text: MIRRORS.detail.deleted, tone: "neutral"};
    switch (view.mirror.status) { // W23 Part B: stop / start states (the revision itself stays `ready`: the creation's evidence is never rewritten)
        case "stopping": return {text: MIRRORS.lifecycle.stoppingLine, tone: "active"};
        case "stopped": return {text: MIRRORS.lifecycle.stoppedLine, tone: "neutral"};
        case "starting": return {text: MIRRORS.lifecycle.startingLine, tone: "active"};
        case "failed": if (view.mirror.activeRevisionId) return {text: MIRRORS.lifecycle.stopFailedLine, tone: "danger"}; break;
        default: break;
    }
    if (!r) return {text: P.creating, tone: "active"};
    switch (r.state) {
        case "ready": return {text: P.ready(view.mirror.runnerName), tone: "success"};
        case "cancelled": return {text: P.cancelled, tone: "neutral"};
        case "blocked": return {text: `${P.blocked}. ${reasonText(r.reason)}`, tone: "danger"};
        case "failed": case "rolled_back": return {text: `${P.failed}. ${reasonText(r.reason)}`, tone: "danger"};
        default: {
            const cur = r.steps.find((s) => s.status !== "done");
            return {text: cur ? `${P.creating}: ${stepText(cur.name)}` : P.creating, tone: "active"};
        }
    }
}
const stepTone = (s: string): Tone => (s === "done" ? "success" : s === "failed" ? "danger" : s === "running" ? "active" : "neutral");
const wipeLine = (r: Rev, deleting: boolean): string | null => {
    if (!isWipeState(r.state) && !(deleting && r.state === "ready")) return null;
    return r.wipeState === "verified" ? P.wipe.verified : r.wipeState === "not_needed" ? P.wipe.not_needed : r.wipeState === "failed" ? P.wipe.failed : P.wipe.running;
};

/** `embedded` (W23 detail page): the page supplies the `<h1 id="mirror-h">` and the privacy banner; `extra` renders under the headline from the CURRENT (polled) view: facet, alerts, lifecycle buttons. */
export type ProgressProps = {initial: MirrorView; canManage: boolean; locked: boolean; embedded?: boolean; extra?: (view: MirrorView, ctx: {poll: () => Promise<void>}) => React.ReactNode};
type Access = {runnerName: string; hostPort: number; service: string; target: number; tunnelHint: string};

export function MirrorProgress({initial, canManage, locked, embedded = false, extra}: ProgressProps) {
    const announce = useAnnounce();
    const [view, setView] = React.useState(initial);
    const [pollFailed, setPollFailed] = React.useState(false);
    const [alertText, setAlertText] = React.useState<string | null>(null);
    const [confirm, setConfirm] = React.useState(false);
    const [note, setNote] = React.useState<string | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [access, setAccess] = React.useState<Access | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [cancelAsked, setCancelAsked] = React.useState(false);
    const mirrorId = view.mirror.id;
    const rev = view.revisions[0];

    const poll = React.useCallback(async () => {
        try {
            const d = dataOf(await getMirrorViewAction({mirrorId}));
            if (d?.ok === true && d.view) { setView(d.view as MirrorView); setPollFailed(false); } else setPollFailed(true);
        } catch { setPollFailed(true); }
    }, [mirrorId]);

    React.useEffect(() => { document.getElementById("mirror-h")?.focus(); }, []);

    const active = !settled(view);
    React.useEffect(() => {
        if (!active) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let stopped = false;
        const schedule = () => { timer = setTimeout(async () => { timer = null; if (stopped) return; if (!document.hidden) await poll(); if (!stopped) schedule(); }, MIRROR_POLL_MS); };
        const onVis = () => { if (!document.hidden && timer === null && !stopped) schedule(); };
        schedule();
        document.addEventListener("visibilitychange", onVis);
        return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
    }, [active, poll]);

    // announce only real changes (state / step statuses / wipe), the alert only for transitions into blocked / failed
    const head = headline(view);
    const sig = `${view.mirror.status}|${rev?.state ?? ""}|${(rev?.steps ?? []).map((s) => `${s.name}:${s.status}`).join(",")}|${rev?.wipeState ?? ""}`;
    const first = React.useRef(true); const prev = React.useRef(rev?.state ?? "");
    // biome-ignore lint/correctness/useExhaustiveDependencies: fires on the change signature only (not on every poll tick)
    React.useEffect(() => {
        if (first.current) { first.current = false; return; }
        announce(head.text);
        if (prev.current !== rev?.state) setAlertText(rev && (rev.state === "blocked" || rev.state === "failed") ? head.text : null);
        prev.current = rev?.state ?? "";
        if (!document.activeElement || document.activeElement === document.body) document.getElementById("mirror-h")?.focus();
    }, [sig]);

    const act = async (run: () => Promise<unknown>, okText: string) => {
        if (busy) return;
        setBusy(true); setErr(null);
        try {
            const d = dataOf(await run());
            if (d?.ok === true) { setNote(okText); announce(okText); await poll(); } else { const t = d ? refusalText(d.code) : P.actionFailed; setErr(t); announce(t); }
        } catch { setErr(P.actionFailed); } finally { setBusy(false); setConfirm(false); }
    };
    const showAccess = async () => {
        setErr(null); setBusy(true);
        try {
            const d = dataOf(await getMirrorAccessAction({mirrorId})); // once per click: every read is audited, the poll never calls it
            if (d?.ok === true && d.access) setAccess(d.access as Access); else { setErr(P.accessFailed); announce(P.accessFailed); }
        } catch { setErr(P.accessFailed); } finally { setBusy(false); }
    };
    const copy = async () => { try { await navigator.clipboard.writeText(access?.tunnelHint ?? ""); announce(P.accessCopied); } catch { announce(P.actionFailed); } };

    const deleting = view.mirror.status === "deleting";
    const deleted = view.mirror.status === "deleted";
    const wipe = rev ? wipeLine(rev, deleting) : null;
    const lifecycleStatus = ["stopping", "stopped", "starting"].includes(view.mirror.status) || (view.mirror.status === "failed" && view.mirror.activeRevisionId !== null);
    const ready = rev?.state === "ready" && !deleting && !deleted && !lifecycleStatus;
    return (
        <section aria-labelledby="mirror-h" className="max-w-3xl space-y-6">
            <div>
                {!embedded && <h1 id="mirror-h" tabIndex={-1} className="mb-2 text-2xl font-bold break-words outline-none">{P.title} · {view.mirror.name}</h1>}
                <p className="mb-2"><ToneBadge tone={head.tone} busy={active}>{deleted ? "Deleted" : deleting ? "Deleting" : lifecycleStatus ? statusText(view.mirror.status) : ready ? "Ready" : rev?.state === "cancelled" ? "Cancelled" : rev && !isActive(rev.state) ? (rev.state === "blocked" ? "Blocked" : "Failed") : "Creating"}</ToneBadge></p>
                <p data-testid="mirror-headline" className="text-base break-words">{head.text}</p>
                {ready && <p data-testid="ready-note" className="text-muted-foreground mt-1 text-sm">{P.readyNote}</p>}
                {rev && <p className="text-muted-foreground mt-2 text-sm">Backup #{rev.rpSequence} · {view.mirror.runnerName}</p>}
                {pollFailed && <p role="note" data-testid="poll-error" className="mt-2 text-sm">{P.pollError}</p>}
            </div>
            {!embedded && <p role="note" data-testid="privacy-banner" className="rounded-lg border-2 p-3 text-sm font-medium">{BANNER(view.mirror.runnerName)}</p>}
            {extra?.(view, {poll})}
            {alertText && <div role="alert" data-testid="mirror-alert" className="rounded-md border p-3 text-sm">{alertText}</div>}

            {rev && (
                <>
                    <section aria-labelledby="steps-h"><h2 id="steps-h" className="mb-2 text-lg font-semibold">{P.steps}</h2>
                        <ol className="divide-y rounded-lg border" data-testid="mirror-steps">
                            {groupSteps(rev.steps, stepText).map((s) => (
                                <li key={s.text} data-testid="mirror-step" data-status={s.status} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                                    <span className="min-w-0 flex-1 font-medium">{s.text}</span>
                                    <ToneBadge tone={stepTone(s.status)} busy={s.status === "running"}>{P.step.status[s.status] ?? s.status}</ToneBadge>
                                </li>
                            ))}
                        </ol></section>
                    <section aria-labelledby="gates-h"><h2 id="gates-h" className="mb-2 text-lg font-semibold">{P.gates}</h2>
                        <ul className="divide-y rounded-lg border" data-testid="mirror-gates">
                            {GATES.map((g) => {
                                const v = rev.gates[g];
                                return (
                                    <li key={g} data-testid="mirror-gate" data-gate={g} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                                        <span className="min-w-0 flex-1 font-medium">{GATE_TEXT[g]}</span>
                                        <ToneBadge tone={v === null ? "neutral" : v.ok ? "success" : "danger"}>{v === null ? P.gate.notReached : v.ok ? P.gate.ok : P.gate.failed(v.code ?? "unknown")}</ToneBadge>
                                    </li>
                                );
                            })}
                        </ul></section>
                    {rev.services.length > 0 && (
                        <section aria-labelledby="svc-h" data-testid="mirror-services"><h2 id="svc-h" className="mb-2 text-lg font-semibold">{P.services}</h2>
                            <ul className="flex flex-wrap gap-2">
                                {rev.services.map((s) => (
                                    <li key={s.service} className="flex items-center gap-2 text-sm"><span className="font-medium">{s.service}</span>
                                        <ToneBadge tone={s.state === "running" && (s.health === null || s.health === "none" || s.health === "healthy") ? "success" : "warning"}>{s.state}{s.health && s.health !== "none" ? ` · ${s.health}` : ""}</ToneBadge></li>
                                ))}
                            </ul></section>
                    )}
                    {rev.refusals.length > 0 && (
                        <section aria-labelledby="ref-h" data-testid="mirror-refusals"><h2 id="ref-h" className="mb-2 text-lg font-semibold">{P.refusals}</h2>
                            <ul className="list-disc space-y-1 pl-5 text-sm">{[...new Set(rev.refusals.map((r) => r.text))].map((t) => <li key={t}>{t}</li>)}</ul></section>
                    )}
                    {wipe && <p data-testid="wipe-line" className="text-sm">{wipe}</p>}
                </>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
                {rev && isActive(rev.state) && canManage && !cancelAsked && (
                    <>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(true)} data-testid="mirror-cancel">{P.cancel}</Button>
                        <DangerousActionConfirm title={P.cancelTitle} description={P.cancelBody} confirmLabel={P.cancelConfirm} open={confirm} onOpenChange={setConfirm}
                            onConfirm={() => void act(() => cancelMirrorRevisionAction({revisionId: rev.id}), P.cancelRequested).then(() => setCancelAsked(true))}/>
                    </>
                )}
                {rev && (isWipeState(rev.state) || (deleting && rev.state === "ready")) && rev.wipeState === "failed" && (canManage
                    ? <Button type="button" variant="outline" disabled={busy || locked} onClick={() => void act(() => retryMirrorWipeAction({revisionId: rev.id}), P.retryDone)} data-testid="mirror-retry-wipe">{P.retry}</Button>
                    : <p data-testid="wipe-admin" className="text-sm">{P.wipeAdmin}</p>)}
                {ready && <Button type="button" variant="outline" disabled={busy} onClick={() => void showAccess()} data-testid="mirror-access">{P.access}</Button>}
            </div>
            {note && <p role="note" data-testid="mirror-note" className="text-sm">{note}</p>}
            {err && <p role="alert" data-testid="mirror-error" className="text-sm">{err}</p>}
            {access && (
                <section aria-labelledby="acc-h" data-testid="mirror-access-panel" className="space-y-2 rounded-lg border p-3 text-sm">
                    <h2 id="acc-h" className="font-semibold">{P.accessTitle}</h2>
                    <p>{access.runnerName} · 127.0.0.1:{access.hostPort} · {access.service}:{access.target}</p>
                    <code className="block rounded-md border p-2 break-words" data-testid="tunnel-hint">{access.tunnelHint}</code>
                    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>{P.accessCopy}</Button>
                    <p className="text-muted-foreground">{P.accessNote}</p>
                </section>
            )}
            <p><Link href={`/dashboard/stacks/${view.mirror.stackId}`} className="text-sm underline underline-offset-4">Back to the app</Link></p>
        </section>
    );
}
