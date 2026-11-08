"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {disableQuiesceAction, enableQuiesceAction, previewQuiesceAction, startQuiesceNowAction} from "@/fork/actions/stack-quiesce.action";
import type {QuiesceViewDto} from "@/fork/quiesce/view";
import {MAX_STOP_CHOICES_S} from "@/fork/quiesce/vocab";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {GENERIC_FAILURE, QUIESCE as Q} from "@/fork/ui/labels";
import {useAnnounce} from "@/fork/ui/status-announcer";

const skipText = (r: string) => (Object.hasOwn(Q.skip, r) ? Q.skip[r as keyof typeof Q.skip] : GENERIC_FAILURE);

/**
 * Stop + copy control (W17b D10) on the Schedule tab. Mutations are real server actions answered by the server's own verdict (no optimistic success);
 * read-only for members; `aria-disabled` + a VISIBLE reason when unavailable; state is text + icon, never colour alone. All copy comes from `labels.ts`.
 */
export function QuiescePanel({dto, isAdmin}: {dto: QuiesceViewDto; isAdmin: boolean}) {
    const router = useRouter();
    const announce = useAnnounce();
    const [services, setServices] = React.useState<string[]>(dto.enabled ? dto.services : dto.defaults);
    const [maxStop, setMaxStop] = React.useState<number>(dto.maxStopSeconds);
    const [confirmName, setConfirmName] = React.useState("");
    const [view, setView] = React.useState<QuiesceViewDto>(dto);
    const [pending, setPending] = React.useState(false);
    const [msg, setMsg] = React.useState<{ok: boolean; text: string; manual?: string} | null>(null);
    const [dlg, setDlg] = React.useState<null | "enable" | "disable" | "start">(null);
    const production = view.hostRole !== "test";
    const unavailable = view.availability.state === "unavailable" ? view.availability.reason : null;
    const readOnly = !isAdmin ? Q.readOnly : null;
    const blockedReason = readOnly ?? (unavailable ? skipText(unavailable) : null);
    const status = view.enabled ? (unavailable ? "unavailable" : "on") : "off";

    const run = async (label: string, fn: () => Promise<unknown>) => {
        if (pending) return;
        setPending(true);
        try {
            const r = (await fn()) as {data?: {ok?: boolean; code?: string; message?: string; manual?: {containers: string[]}; mode?: string} } | undefined;
            const d = r?.data;
            if (d?.ok) {
                const text = d.mode ? Q.alert.requested : label;
                setMsg({ok: true, text}); announce(text); router.refresh();
            } else {
                const text = (d?.code && Q.errors[d.code]) || d?.message || GENERIC_FAILURE;
                setMsg({ok: false, text, manual: d?.manual?.containers?.length ? Q.alert.manual(d.manual.containers.join(" ")) : undefined});
                announce(text);
            }
        } catch { setMsg({ok: false, text: GENERIC_FAILURE}); } finally { setPending(false); setDlg(null); }
    };
    const toggle = async (name: string) => {
        const next = services.includes(name) ? services.filter((s) => s !== name) : [...services, name];
        setServices(next);
        const r = (await previewQuiesceAction({stackId: view.stackId, services: next})) as {data?: {ok: boolean; dto?: QuiesceViewDto}} | undefined;
        if (r?.data?.ok && r.data.dto) setView(r.data.dto);
    };
    const plan = view.plan;
    const mustType = production && dlg === "enable";
    return (
        <section aria-labelledby="quiesce-heading" data-testid="quiesce-panel" data-state={status} className="flex flex-col gap-3 rounded-xl border p-4">
            <h3 id="quiesce-heading" className="font-semibold">{Q.heading}</h3>
            <p className="text-muted-foreground max-w-prose text-sm">{Q.intro}</p>
            <p data-testid="quiesce-status" className="text-sm font-medium">
                <span aria-hidden="true">{status === "on" ? "●" : status === "off" ? "○" : "▲"} </span>{Q.status[status]}
                {unavailable && <span className="text-muted-foreground font-normal"> — {Q.unavailableBecause(skipText(unavailable))}</span>}
            </p>
            {view.alert.active && (
                <p role="alert" data-testid="quiesce-alert" className="text-destructive text-sm">
                    {Q.alert.line(view.alert.since ? view.alert.since.slice(11, 16) : "—")} <span aria-hidden="true">·</span> {Q.alert.mail}
                </p>
            )}
            <fieldset className="flex flex-col gap-2" disabled={false}>
                <legend className="text-sm font-medium">{Q.fields.services}</legend>
                <p className="text-muted-foreground text-xs">{Q.fields.servicesHint}</p>
                <ul className="flex flex-col gap-1">
                    {view.allServices.map((s) => (
                        <li key={s.name} className="flex items-center gap-2 text-sm">
                            <input id={`q-svc-${s.name}`} type="checkbox" checked={services.includes(s.name)} aria-disabled={!isAdmin || view.enabled || undefined}
                                onChange={() => { if (isAdmin && !view.enabled) void toggle(s.name); }} data-testid={`quiesce-service-${s.name}`}/>
                            <Label htmlFor={`q-svc-${s.name}`}>{s.name}{!s.running ? ` (${Q.preview.notRunning.toLowerCase()})` : ""}</Label>
                        </li>
                    ))}
                </ul>
                <div className="flex items-center gap-2 text-sm">
                    <Label htmlFor="q-max">{Q.fields.maxStop}</Label>
                    <select id="q-max" value={maxStop} onChange={(e) => setMaxStop(Number(e.target.value))} aria-disabled={!isAdmin || view.enabled || undefined} className="h-9 rounded-md border px-2" data-testid="quiesce-max-stop">
                        {MAX_STOP_CHOICES_S.map((n) => <option key={n} value={n}>{Q.fields.maxStopChoices[n]}</option>)}
                    </select>
                </div>
            </fieldset>
            {plan && (
                <div data-testid="quiesce-preview" className="text-sm">
                    <p className="font-medium">{Q.preview.heading}</p>
                    {plan.ok ? (
                        <ul className="list-disc pl-5">
                            <li>{Q.preview.stopOrder}: {plan.stopOrder.join(" → ")}</li>
                            <li>{Q.preview.startOrder}: {plan.startOrder.join(" → ")}</li>
                            <li>{Q.preview.during}: {plan.windowMembers.join(", ") || Q.preview.none}</li>
                            <li>{Q.preview.before}: {plan.preMembers.join(", ") || Q.preview.none}</li>
                            {plan.notRunning.length > 0 && <li>{Q.preview.notRunning}: {plan.notRunning.join(", ")}</li>}
                        </ul>
                    ) : (
                        <ul className="text-destructive list-disc pl-5" role="alert">
                            {plan.blockers.map((b, i) => <li key={`${b.code}-${i}`}>{Q.blockers[b.code]}{b.service ? ` (${b.service})` : ""}</li>)}
                        </ul>
                    )}
                </div>
            )}
            <div className="flex flex-wrap items-start gap-3">
                {!view.enabled
                    ? <ReasonButton type="button" reason={blockedReason ?? (plan && !plan.ok ? Q.errors.plan_blocked : null)} onClick={() => setDlg("enable")} data-testid="quiesce-enable">{Q.actions.enable}</ReasonButton>
                    : <ReasonButton type="button" variant="outline" reason={readOnly} onClick={() => setDlg("disable")} data-testid="quiesce-disable">{Q.actions.disable}</ReasonButton>}
                {view.alert.canStartNow && <ReasonButton type="button" reason={readOnly} onClick={() => setDlg("start")} data-testid="quiesce-start-now">{Q.alert.startNow}</ReasonButton>}
            </div>
            {view.last && (
                <div data-testid="quiesce-last" className="text-sm">
                    <p className="font-medium">{Q.lastResult.heading}</p>
                    <p>{view.last.state ? Q.states[view.last.state] : "—"}{view.last.reason ? ` — ${Q.agentCodes[view.last.reason] ?? skipText(view.last.reason)}` : ""}</p>
                    {view.last.downtimeMs !== null && <p>{Q.lastResult.paused(Q.duration(view.last.downtimeMs), view.last.containers.length)}</p>}
                    {view.last.containers.length > 0 && <ul className="list-disc pl-5">{view.last.containers.map((c) => <li key={c.service}>{c.service}: {Q.lastResult.outcome[c.outcome as keyof typeof Q.lastResult.outcome] ?? c.outcome}</li>)}</ul>}
                </div>
            )}
            {msg && <p role="status" data-testid="quiesce-outcome" className={`text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}{msg.manual ? ` ${msg.manual}` : ""}</p>}
            <DangerousActionConfirm open={dlg !== null} onOpenChange={(o) => { if (!o) setDlg(null); }} title={dlg === "enable" ? Q.confirm.enableTitle : dlg === "disable" ? Q.confirm.disableTitle : Q.confirm.startNowTitle}
                confirmLabel={dlg === "enable" ? Q.actions.enable : dlg === "disable" ? Q.actions.disable : Q.actions.startNow}
                description={<><p>{dlg === "enable" ? Q.confirm.enableBody : dlg === "disable" ? Q.confirm.disableBody : Q.confirm.startNowBody}</p>
                    {mustType && (<div className="flex flex-col gap-1.5"><Label htmlFor="q-confirm">{Q.fields.confirmName}</Label><p className="text-xs">{Q.fields.confirmNameHint}</p>
                        <Input id="q-confirm" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={view.stackName} data-testid="quiesce-confirm-name" autoComplete="off"/></div>)}</>}
                onConfirm={() => {
                    if (dlg === "enable") void run(Q.status.on, () => enableQuiesceAction({stackId: view.stackId, services, maxStopSeconds: maxStop, ...(production ? {confirmName} : {})}));
                    else if (dlg === "disable") void run(Q.status.off, () => disableQuiesceAction({stackId: view.stackId}));
                    else void run(Q.alert.started, () => startQuiesceNowAction({stackId: view.stackId}));
                }}/>
            <Button type="button" className="sr-only" aria-hidden="true" tabIndex={-1} onClick={() => undefined}>{pending ? "…" : ""}</Button>
        </section>
    );
}
