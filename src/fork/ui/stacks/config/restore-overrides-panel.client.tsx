"use client";

import {useMutation} from "@tanstack/react-query";
import {AlertTriangle, CheckCircle2, Circle} from "lucide-react";
import * as React from "react";
import {clearRestoreOverridesAction, setRestoreOverridesAction} from "@/fork/actions/stack-config.action";
import type {OverrideFailure, RestoreOverridesView} from "@/fork/config/view";
import {Button} from "@/components/ui/button";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {SecretInput, SECRET_INPUT_PROPS, type SecretHandle} from "@/fork/ui/secret-input";
import {useAnnounce} from "@/fork/ui/status-announcer";
import {GENERIC_FAILURE, NOT_APPLICABLE_COPY, OVERRIDES, REFUSAL_COPY} from "./labels";

/**
 * Restore-time overrides panel (W16b, D28) — the component W18b embeds; there is no page or route here.
 * Values are UNCONTROLLED and write-only: every field (and the YAML box / file picker) lives only in its DOM node, is read ONCE at call time inside
 * `mutationFn` (which clears it) and never enters React state, props, the mutation variables / cache, the URL or storage. All inputs are cleared after
 * every submit, success or failure. The only data coming back is the names-and-states view (never a value). Nothing is shown as saved before the server said ok.
 */
export type RestoreOverridesPanelProps = {
    planId: string; planHash: string;
    /** From `getRestoreOverridesView` (server component of the host page). */
    view: RestoreOverridesView;
    /** The host computes `forkCan(actor, "restore.plan")` server-side; `false` ⇒ the form is aria-disabled with a visible reason. */
    canEdit: boolean;
    /** The host re-renders / refreshes. NEVER receives a value. */
    onChanged?: (v: RestoreOverridesView) => void;
};

type Out = {ok: true; view: RestoreOverridesView} | OverrideFailure;
type Step = {kind: "save"} | {kind: "unset"; service: string; key: string} | {kind: "clear_yml"} | {kind: "clear_all"};
type Result = {kind: "ok"; view: RestoreOverridesView; what: Step["kind"]} | {kind: "refused"; code: string; message: string; violations: {kind: string; service: string | null}[]} | {kind: "error"; message: string};
type SafeActionResult = {data?: Out; serverError?: unknown; validationErrors?: unknown} | undefined;

const MAX_YML = 64 * 1024;
const idOf = (f: {service: string; key: string}) => `${f.service}\u0000${f.key}`;
const local = (message: string): Result => ({kind: "refused", code: "local", message, violations: []});
const normalise = (r: SafeActionResult, what: Step["kind"]): Result => {
    if (!r || r.serverError || r.validationErrors || !r.data) return {kind: "error", message: r?.validationErrors ? REFUSAL_COPY.invalid_input : GENERIC_FAILURE};
    if (r.data.ok) return {kind: "ok", view: r.data.view, what};
    return {kind: "refused", code: r.data.code, message: REFUSAL_COPY[r.data.code] ?? GENERIC_FAILURE, violations: r.data.violations ?? []};
};
const readText = (f: File): Promise<string> => (typeof f.text === "function" ? f.text() : new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsText(f); }));

export function RestoreOverridesPanel({planId, planHash, view: viewProp, canEdit, onChanged}: RestoreOverridesPanelProps) {
    const announce = useAnnounce();
    const [view, setView] = React.useState(viewProp);
    React.useEffect(() => setView(viewProp), [viewProp]);
    const [result, setResult] = React.useState<Result | null>(null);
    const handles = React.useRef(new Map<string, SecretHandle>());
    const ymlRef = React.useRef<HTMLTextAreaElement>(null);
    const fileRef = React.useRef<HTMLInputElement>(null);
    const helpId = React.useId();

    const clearInputs = () => {
        for (const h of handles.current.values()) h.clear();
        if (ymlRef.current) ymlRef.current.value = "";
        if (fileRef.current) fileRef.current.value = "";
    };

    /** The ONLY place values are read: at call time, straight from the DOM, cleared in the same breath. Mutation variables carry names only. */
    const run = useMutation({
        mutationFn: async (step: Step): Promise<Result> => {
            if (step.kind === "clear_all") { clearInputs(); return normalise(await clearRestoreOverridesAction({planId, planHash}), step.kind); }
            if (step.kind === "unset") { clearInputs(); return normalise(await setRestoreOverridesAction({planId, planHash, unset: [{service: step.service, key: step.key}]}), step.kind); }
            if (step.kind === "clear_yml") { clearInputs(); return normalise(await setRestoreOverridesAction({planId, planHash, overrideYml: null}), step.kind); }
            const set: {service: string; key: string; value: string}[] = [];
            for (const f of view.fields) { const v = handles.current.get(idOf(f))?.take(); if (v) set.push({service: f.service, key: f.key, value: v}); }
            const file = fileRef.current?.files?.[0] ?? null;
            const text = ymlRef.current?.value ?? "";
            clearInputs();
            if (file && text.trim() !== "") return local(OVERRIDES.ymlBoth);
            if (file && file.size > MAX_YML) return local(OVERRIDES.ymlTooLarge);
            const yml = file ? await readText(file) : text.trim() !== "" ? text : undefined;
            if (yml !== undefined && new Blob([yml]).size > MAX_YML) return local(OVERRIDES.ymlTooLarge);
            if (set.length === 0 && yml === undefined) return local(OVERRIDES.nothingToSave);
            return normalise(await setRestoreOverridesAction({planId, planHash, set, ...(yml !== undefined ? {overrideYml: yml} : {})}), step.kind);
        },
        onSuccess: (r) => {
            setResult(r);
            if (r.kind === "ok") {
                setView(r.view);
                announce(r.what === "clear_all" ? OVERRIDES.cleared : r.what === "save" ? OVERRIDES.saved(r.view.revision) : OVERRIDES.removed);
                onChanged?.(r.view);
            } else announce(r.message);
        },
        onError: () => { clearInputs(); setResult({kind: "error", message: GENERIC_FAILURE}); announce(GENERIC_FAILURE); },
    });

    const lockReason = !canEdit ? OVERRIDES.readOnly : !view.applicable ? NOT_APPLICABLE_COPY[view.reason ?? "outcome"] : view.frozen ? OVERRIDES.frozen : null;
    const locked = lockReason !== null;
    const busy = run.isPending;

    return (
        <section aria-labelledby={`${helpId}-title`} className="flex flex-col gap-4" data-testid="restore-overrides-panel">
            <div>
                <h3 id={`${helpId}-title`} className="text-base font-semibold">{OVERRIDES.title}</h3>
                <p className="text-muted-foreground text-sm">{OVERRIDES.intro}</p>
            </div>
            {lockReason ? <p className="text-sm font-medium" data-testid="overrides-lock-reason">{lockReason}</p> : null}
            {view.missingRequired > 0 ? <p className="text-sm" data-testid="overrides-missing-required">{OVERRIDES.missingRequired(view.missingRequired)}</p> : null}
            <form onSubmit={(e) => { e.preventDefault(); if (!locked && !busy) run.mutate({kind: "save"}); }} className="flex flex-col gap-4" noValidate>
                <fieldset disabled={locked} aria-disabled={locked} className="flex flex-col gap-4">
                    <legend className="mb-1 text-sm font-medium">{OVERRIDES.fieldsTitle}</legend>
                    {view.fields.length === 0 ? <p className="text-muted-foreground text-sm">{OVERRIDES.noFields}</p> : null}
                    {view.fields.map((f, i) => {
                        const state = f.isSet ? OVERRIDES.state.set : f.class === "require_input" ? OVERRIDES.state.needsValue : OVERRIDES.state.notSet;
                        const Icon = f.isSet ? CheckCircle2 : f.class === "require_input" ? AlertTriangle : Circle;
                        const tone = f.isSet ? "text-emerald-700 dark:text-emerald-400" : f.class === "require_input" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground";
                        return (
                            <div key={idOf(f)} className="flex flex-col gap-1" data-testid={`override-field-${i}`}>
                                <SecretInput ref={(h) => { if (h) handles.current.set(idOf(f), h); else handles.current.delete(idOf(f)); }}
                                    label={OVERRIDES.fieldLabel(f.key, f.service)} name={`override-${i}`} maxLength={4096} describedBy={`${helpId}-f${i}`}/>
                                <p id={`${helpId}-f${i}`} className="flex items-center gap-2 text-sm">
                                    <span className={`inline-flex items-center gap-1 ${tone}`}><Icon aria-hidden="true" className="size-4"/>{state}</span>
                                    <span className="text-muted-foreground">{OVERRIDES.fieldHelp}</span>
                                </p>
                                {f.isSet ? <div><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run.mutate({kind: "unset", service: f.service, key: f.key})}>{OVERRIDES.removeValue}<span className="sr-only"> {f.key}</span></Button></div> : null}
                            </div>
                        );
                    })}
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${helpId}-yml`}>{OVERRIDES.ymlLabel}</Label>
                        <Textarea id={`${helpId}-yml`} ref={ymlRef} defaultValue="" rows={6} maxLength={MAX_YML} name="override-yml" aria-describedby={`${helpId}-yml-help ${helpId}-yml-state`} className="font-mono"
                            autoComplete={SECRET_INPUT_PROPS.autoComplete} spellCheck={SECRET_INPUT_PROPS.spellCheck} autoCapitalize={SECRET_INPUT_PROPS.autoCapitalize} autoCorrect={SECRET_INPUT_PROPS.autoCorrect}
                            data-gramm={SECRET_INPUT_PROPS["data-gramm"]} data-1p-ignore={SECRET_INPUT_PROPS["data-1p-ignore"]} data-lpignore={SECRET_INPUT_PROPS["data-lpignore"]} data-form-type={SECRET_INPUT_PROPS["data-form-type"]}/>
                        <Label htmlFor={`${helpId}-file`} className="text-sm font-normal">{OVERRIDES.ymlFile}</Label>
                        <input id={`${helpId}-file`} ref={fileRef} type="file" accept=".yml,.yaml" name="override-file" className="text-sm"/>
                        <p id={`${helpId}-yml-help`} className="text-muted-foreground text-sm">{OVERRIDES.ymlHelp}</p>
                        <p id={`${helpId}-yml-state`} className="text-sm" data-testid="override-yml-state">{view.yml.present ? OVERRIDES.ymlPresent(view.yml.bytes) : OVERRIDES.ymlAbsent}</p>
                        {view.yml.present ? <div><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run.mutate({kind: "clear_yml"})}>{OVERRIDES.removeYml}</Button></div> : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button className="bg-[#c2410c] text-white hover:bg-[#9a3412] dark:bg-[#c2410c] dark:hover:bg-[#9a3412]" type="submit" disabled={busy}>{busy ? OVERRIDES.working : OVERRIDES.save}</Button>
                        <Button type="button" variant="outline" disabled={busy || (view.revision === 0)} onClick={() => run.mutate({kind: "clear_all"})}>{OVERRIDES.clearAll}</Button>
                    </div>
                </fieldset>
            </form>
            {result && result.kind !== "ok" ? (
                <div role="alert" className="text-destructive text-sm" data-testid="override-result">
                    <p>{result.message}</p>
                    {result.kind === "refused" && result.violations.length > 0 ? <ul className="list-disc pl-5">{[...new Set(result.violations.map((v) => (v.service ? `${v.kind} · ${v.service}` : v.kind)))].map((text) => <li key={text}>{text}</li>)}</ul> : null}
                </div>
            ) : result ? <p className="text-sm" data-testid="override-result">{result.what === "clear_all" ? OVERRIDES.cleared : result.what === "save" ? OVERRIDES.saved(result.view.revision) : OVERRIDES.removed}</p> : null}
        </section>
    );
}
