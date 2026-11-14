"use client";

import Link from "next/link";
import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import {Collapsible, CollapsibleContent, CollapsibleTrigger} from "@/components/ui/collapsible";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {createMirrorAction, previewMirrorPlanAction} from "@/fork/actions/mirror.action";
import {keepConfirmPhrase, PRIVACY_ACK} from "@/fork/mirror/vocab";
import type {MirrorSourceFacts} from "@/fork/mirror/wizard-view";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {BANNER, ENV_ACTION_TEXT, MIRRORS, type EnvActionKey, retryText} from "@/fork/ui/mirrors/labels";
import {BTN, Dropped, MirrorStepIndicator, newHref, } from "@/fork/ui/mirrors/wizard/common.client";
import {
    HTTP_PATH_RE_LOCAL, NAME_RE, actionOf, buildCreateInput, changedCount, createBlockReason, defaultAccess, defaultMirrorName, keepPending, keptKeys, type Access, type Actions, type PreviewUi, type ServiceFacts,
} from "@/fork/ui/mirrors/wizard/model";
import {PLAN_REASON_TEXT, type ReasonCtx} from "@/fork/ui/recovery/labels";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";
import {useAnnounce} from "@/fork/ui/status-announcer";

export type ConfigureProps = {
    stackId: string; stackName: string; rp: {id: string; sequence: number; label: string}; runner: {id: string; name: string}; source: MirrorSourceFacts; locked: boolean; dropped?: boolean;
};

type Step = 3 | 4 | 5;
const ENV_ACTIONS: EnvActionKey[] = ["keep", "rotate", "disable", "drop", "keep_exact"];
const dataOf = (r: unknown): Record<string, unknown> | null => { const d = (r as {data?: unknown} | undefined)?.data; return d && typeof d === "object" ? (d as Record<string, unknown>) : null; };
const blockerText = (b: string, machine: string): string => (Object.hasOwn(PLAN_REASON_TEXT, b) ? (PLAN_REASON_TEXT as Record<string, (c: ReasonCtx) => string>)[b]!({machine}) : MIRRORS.review.blockedGeneric);

type Refusal = {code: string; text: string; blockers: string[]};
type PreviewState = {kind: "idle"} | {kind: "loading"} | {kind: "error"; text: string} | {kind: "ok"; preview: PreviewUi};

export function ConfigureSteps({stackId, stackName, rp, runner, source, locked, dropped}: ConfigureProps) {
    const router = useRouter();
    const announce = useAnnounce();
    const services: ServiceFacts[] = source.services;
    const [step, setStep] = React.useState<Step>(3);
    const [access, setAccess] = React.useState<Access | null>(() => defaultAccess(services));
    const [portText, setPortText] = React.useState("");
    const [httpPath, setHttpPath] = React.useState("/");
    const [noHttp, setNoHttp] = React.useState(false);
    const [actions, setActions] = React.useState<Actions>({});
    const [typed, setTyped] = React.useState<Record<string, string>>({});
    const [name, setName] = React.useState(() => defaultMirrorName(stackName, rp.sequence));
    const [ack, setAck] = React.useState(false);
    const [preview, setPreview] = React.useState<PreviewState>({kind: "idle"});
    const [busy, setBusy] = React.useState(false);
    const [refusal, setRefusal] = React.useState<Refusal | null>(null);
    const h1 = React.useRef<HTMLHeadingElement>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: focus the heading whenever the step changes
    React.useEffect(() => { h1.current?.focus(); }, [step]);

    const pending = keepPending(actions, typed, services);
    const pd = source.privacy.containsPersonalData;
    const needsAck = pd !== false;
    const svc = access ? services.find((s) => s.name === access.service) : undefined;
    const tcpPorts = svc ? svc.ports.filter((p) => p.protocol === "tcp") : [];
    const pathOk = noHttp || HTTP_PATH_RE_LOCAL.test(httpPath);
    const portOk = access !== null && Number.isInteger(access.target) && access.target >= 1 && access.target <= 65535;
    const links = {source: newHref({step: "source", stack: stackId}), runner: newHref({step: "runner", stack: stackId, point: rp.sequence})};

    const runPreview = React.useCallback(async () => {
        setPreview({kind: "loading"}); setRefusal(null);
        try {
            const d = dataOf(await previewMirrorPlanAction({stackId, rpId: rp.id, runnerAgentId: runner.id}));
            if (d?.ok === true) setPreview({kind: "ok", preview: {outcome: String(d.outcome), blockers: Array.isArray(d.blockers) ? d.blockers.map(String) : [], actions: Number(d.actions ?? 0), containsPersonalData: (d.containsPersonalData ?? null) as boolean | null, optIn: d.optIn === true, runnerIsolation: String(d.runnerIsolation)}});
            else setPreview({kind: "error", text: d ? retryText(d.code, d.retryAfterSeconds) : MIRRORS.review.previewError});
        } catch { setPreview({kind: "error", text: MIRRORS.review.previewError}); }
    }, [stackId, rp.id, runner.id]);
    React.useEffect(() => { if (step === 5 && preview.kind === "idle") void runPreview(); }, [step, preview.kind, runPreview]);

    const setAction = (s: string, k: string, a: EnvActionKey) => setActions((m) => ({...m, [s]: {...m[s], [k]: a}}));
    const previewUi = preview.kind === "ok" ? preview.preview : null;
    const nameInvalid = !NAME_RE.test(name) || refusal?.code === "name_taken";
    const createReason = createBlockReason({preview: previewUi, ack, needsAck, name, locked, keepPending: pending.length, busy});

    const create = async () => {
        if (createReason || !access) return;
        setBusy(true); setRefusal(null); announce(MIRRORS.review.creating);
        try {
            const r = await createMirrorAction(buildCreateInput({stackId, rpId: rp.id, runnerAgentId: runner.id, name, access, httpPath: noHttp ? null : httpPath, actions, typed, ack}, services));
            const d = dataOf(r);
            if (d?.ok === true) { announce(MIRRORS.review.created); router.push(`/dashboard/mirrors/${String(d.mirrorId)}`); return; }
            const text = d ? retryText(d.code, d.retryAfterSeconds) : MIRRORS.review.previewError;
            const blockers = Array.isArray(d?.blockers) ? (d.blockers as unknown[]).map(String) : [];
            setRefusal({code: String(d?.code ?? "failed"), text, blockers}); announce(text);
        } catch { setRefusal({code: "failed", text: MIRRORS.review.previewError, blockers: []}); } finally { setBusy(false); }
    };

    const changed = changedCount(actions, services);
    const kept = keptKeys(actions, services);

    return (
        <section aria-labelledby="wiz-h">
            <MirrorStepIndicator current={step} links={links}/>
            <h1 id="wiz-h" ref={h1} tabIndex={-1} className="mb-1 text-2xl font-bold outline-none">{step === 3 ? MIRRORS.steps.title.access : step === 4 ? MIRRORS.steps.title.data : MIRRORS.steps.title.review}</h1>
            <p className="text-muted-foreground mb-4 font-medium break-words">{stackName} · {MIRRORS.review.source(rp.sequence)} · {runner.name}</p>
            {dropped && <Dropped/>}

            {step === 3 && (
                <div className="max-w-2xl space-y-4" data-testid="step-access">
                    <p className="text-sm" data-testid="isolation-fact">{MIRRORS.access.isolation}</p>
                    <p className="text-sm">{MIRRORS.access.reach}</p>
                    {services.length === 0 || access === null ? <p data-testid="no-service" className="text-sm">{MIRRORS.access.noService}</p> : (
                        <>
                            <div className="space-y-1">
                                <Label htmlFor="acc-service" className="font-medium">{MIRRORS.access.service}</Label>
                                <Select value={access.service} onValueChange={(v) => { const s = services.find((x) => x.name === v); const t = s?.ports.find((p) => p.protocol === "tcp"); setAccess({service: v, target: t ? t.target : 0}); setPortText(""); }}>
                                    <SelectTrigger id="acc-service" aria-label={MIRRORS.access.service} className="w-full sm:w-72"><SelectValue/></SelectTrigger>
                                    <SelectContent>{services.map((s) => <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>)}</SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor={tcpPorts.length > 0 ? "acc-port" : "acc-port-free"} className="font-medium">{tcpPorts.length > 0 ? MIRRORS.access.port : MIRRORS.access.portFree}</Label>
                                {tcpPorts.length > 0 ? (
                                    <Select value={String(access.target)} onValueChange={(v) => setAccess({service: access.service, target: Number(v)})}>
                                        <SelectTrigger id="acc-port" aria-label={MIRRORS.access.port} className="w-full sm:w-72"><SelectValue/></SelectTrigger>
                                        <SelectContent>{tcpPorts.map((p) => <SelectItem key={p.target} value={String(p.target)}>{p.target}</SelectItem>)}</SelectContent>
                                    </Select>
                                ) : (
                                    <Input id="acc-port-free" inputMode="numeric" value={portText} aria-invalid={portText !== "" && !portOk || undefined} autoComplete="off" spellCheck={false}
                                        onChange={(e) => { setPortText(e.target.value); setAccess({service: access.service, target: Number(e.target.value)}); }}/>
                                )}
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="acc-path" className="font-medium">{MIRRORS.access.path}</Label>
                                <Input id="acc-path" value={httpPath} disabled={noHttp} onChange={(e) => setHttpPath(e.target.value)} aria-invalid={!pathOk || undefined} aria-describedby="acc-path-h" autoComplete="off" spellCheck={false}/>
                                <p id="acc-path-h" className={`text-sm ${pathOk ? "text-muted-foreground" : ""}`}>{pathOk ? MIRRORS.access.pathHelp : MIRRORS.access.pathInvalid}</p>
                                <div className="flex items-center gap-2 pt-1">
                                    <Checkbox id="acc-nohttp" checked={noHttp} onCheckedChange={(c) => setNoHttp(c === true)}/>
                                    <Label htmlFor="acc-nohttp" className="font-normal">{MIRRORS.access.noHttp}</Label>
                                </div>
                            </div>
                        </>
                    )}
                    <p className="text-muted-foreground text-sm">{MIRRORS.access.limits}</p>
                </div>
            )}

            {step === 4 && (
                <div className="max-w-3xl space-y-4" data-testid="step-data">
                    <p className="text-sm">{MIRRORS.data.intro}</p>
                    {services.map((s, i) => (
                        <Collapsible key={s.name} defaultOpen={i === 0} className="rounded-lg border">
                            <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="h-auto w-full justify-between rounded-b-none p-3 text-left font-semibold">{MIRRORS.data.service(s.name)} · {MIRRORS.data.keys(s.env.length)}</Button></CollapsibleTrigger>
                            <CollapsibleContent className="space-y-3 p-3">
                                {s.env.length === 0 && <p className="text-muted-foreground text-sm">{MIRRORS.data.noEnv}</p>}
                                {s.env.map((e) => {
                                    const id = `env-${s.name}-${e.key}`;
                                    const cur = actionOf(actions, s.name, e.key, e.recommended);
                                    const phrase = keepConfirmPhrase(s.name, e.key);
                                    const t = typed[`${s.name}.${e.key}`] ?? "";
                                    return (
                                        <div key={e.key} className="grid gap-1 sm:grid-cols-[1fr_16rem] sm:items-center" data-testid="env-row">
                                            <Label htmlFor={id} className="font-mono text-sm break-all">{e.key}</Label>
                                            <Select value={cur} onValueChange={(v) => setAction(s.name, e.key, v as EnvActionKey)}>
                                                <SelectTrigger id={id} aria-label={`${s.name} ${e.key}`} className="w-full"><SelectValue/></SelectTrigger>
                                                <SelectContent>{ENV_ACTIONS.map((a) => <SelectItem key={a} value={a}>{ENV_ACTION_TEXT[a]}{a === e.recommended ? ` ${MIRRORS.data.recommended}` : ""}</SelectItem>)}</SelectContent>
                                            </Select>
                                            {cur === "keep_exact" && (
                                                <div className="space-y-1 sm:col-span-2">
                                                    <Label htmlFor={`${id}-t`} className="text-sm font-medium">{MIRRORS.data.typed(phrase)}</Label>
                                                    <Input id={`${id}-t`} value={t} onChange={(ev) => setTyped((m) => ({...m, [`${s.name}.${e.key}`]: ev.target.value}))} aria-describedby={`${id}-th`} aria-invalid={t !== phrase || undefined} autoComplete="off" spellCheck={false}/>
                                                    <p id={`${id}-th`} className="text-muted-foreground text-sm">{MIRRORS.data.typedHelp}</p>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </CollapsibleContent>
                        </Collapsible>
                    ))}
                    <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">{MIRRORS.data.facts.map((f) => <li key={f}>{f}</li>)}</ul>
                </div>
            )}

            {step === 5 && (
                <div className="max-w-2xl space-y-5" data-testid="step-review">
                    <p role="note" data-testid="privacy-banner" className="rounded-lg border-2 p-3 text-sm font-medium">{BANNER(runner.name)}</p>
                    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]" aria-label={MIRRORS.review.summary}>
                        <dt className="text-muted-foreground">{MIRRORS.steps.short.source}</dt><dd>{MIRRORS.review.source(rp.sequence)} · {rp.label}</dd>
                        <dt className="text-muted-foreground">{MIRRORS.review.runner}</dt><dd className="break-words">{runner.name}</dd>
                        <dt className="text-muted-foreground">{MIRRORS.review.access}</dt><dd>{access ? `${access.service}:${access.target}` : "-"}{noHttp ? "" : ` ${httpPath}`}</dd>
                        <dt className="text-muted-foreground">{MIRRORS.steps.short.data}</dt><dd>{MIRRORS.review.changed(changed)}</dd>
                        <dt className="text-muted-foreground">{MIRRORS.review.kept}</dt><dd data-testid="kept-list">{kept.length === 0 ? MIRRORS.review.none : kept.map((k) => `${k.svc}.${k.key}`).join(", ")}</dd>
                    </dl>
                    <div className="space-y-1">
                        <Label htmlFor="mirror-name" className="font-medium">{MIRRORS.review.name}</Label>
                        <Input id="mirror-name" value={name} onChange={(e) => { setName(e.target.value); if (refusal?.code === "name_taken") setRefusal(null); }} aria-invalid={nameInvalid || undefined} aria-describedby="mirror-name-h" autoComplete="off" spellCheck={false}/>
                        <p id="mirror-name-h" className="text-sm">{refusal?.code === "name_taken" ? refusal.text : NAME_RE.test(name) ? MIRRORS.review.nameHelp : MIRRORS.review.nameInvalid}</p>
                    </div>
                    <div className="space-y-2 rounded-lg border p-3 text-sm" data-testid="preview">
                        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{MIRRORS.review.preview}</h2>
                            <Button type="button" variant="outline" size="sm" disabled={preview.kind === "loading"} onClick={() => void runPreview()} data-testid="preview-again">{MIRRORS.review.again}</Button></div>
                        {preview.kind === "loading" && <p data-testid="preview-loading">{MIRRORS.review.previewLoading}</p>}
                        {preview.kind === "error" && <p role="alert" data-testid="preview-error">{preview.text}</p>}
                        {preview.kind === "ok" && (
                            <>
                                {preview.preview.outcome === "ready" ? <p data-testid="preview-ready">{MIRRORS.review.ready}</p> : (
                                    <div data-testid="preview-blocked"><p>{MIRRORS.review.blocked}</p>
                                        <ul className="list-disc pl-5">{preview.preview.blockers.length === 0 ? <li>{MIRRORS.review.blockedGeneric}</li> : [...new Set(preview.preview.blockers)].map((b) => <li key={b}>{blockerText(b, runner.name)}</li>)}</ul></div>
                                )}
                                <p data-testid="preview-isolation">{preview.preview.runnerIsolation === "isolated" ? MIRRORS.review.isolationOk : MIRRORS.review.isolationNo}</p>
                            </>
                        )}
                    </div>
                    {needsAck && (
                        <div className="flex items-start gap-2">
                            <Checkbox id="privacy-ack" checked={ack} onCheckedChange={(c) => setAck(c === true)} className="mt-0.5"/>
                            <Label htmlFor="privacy-ack" className="font-normal">{PRIVACY_ACK}</Label>
                        </div>
                    )}
                    {refusal && refusal.code !== "name_taken" && (
                        <div role="alert" data-testid="create-refusal" className="rounded-md border p-3 text-sm">
                            <p>{refusal.text}</p>
                            {refusal.blockers.length > 0 && <ul className="list-disc pl-5">{[...new Set(refusal.blockers)].map((b) => <li key={b}>{blockerText(b, runner.name)}</li>)}</ul>}
                        </div>
                    )}
                </div>
            )}

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start">
                {step === 3 && <ReasonButton className={`${BTN} ${PRIMARY_AA}`} reason={access === null ? MIRRORS.access.noService : !portOk ? MIRRORS.access.portFree : !pathOk ? MIRRORS.access.pathInvalid : null} onClick={() => setStep(4)}>{MIRRORS.steps.next.data}</ReasonButton>}
                {step === 4 && <ReasonButton className={`${BTN} ${PRIMARY_AA}`} reason={pending.length > 0 ? MIRRORS.review.reasons.keep : null} onClick={() => { setPreview({kind: "idle"}); setStep(5); }}>{MIRRORS.steps.next.review}</ReasonButton>}
                {step === 5 && <ReasonButton className={`${BTN} ${PRIMARY_AA}`} reason={createReason} aria-busy={busy || undefined} onClick={create} data-testid="create-mirror">{busy ? MIRRORS.review.creating : MIRRORS.steps.next.create}</ReasonButton>}
                {step === 3 ? <Link href={links.runner} className="inline-flex h-9 items-center text-sm font-medium underline underline-offset-4">{MIRRORS.steps.back}</Link>
                    : <Button type="button" variant="ghost" className="h-9 px-0 font-medium underline underline-offset-4 hover:bg-transparent" onClick={() => setStep((step - 1) as Step)}>{MIRRORS.steps.back}</Button>}
            </div>
        </section>
    );
}
