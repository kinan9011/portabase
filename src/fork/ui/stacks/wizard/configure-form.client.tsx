"use client";

import {useMutation} from "@tanstack/react-query";
import Link from "next/link";
import {useRouter} from "next/navigation";
import * as React from "react";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {activateStackPolicyAction, previewStackPolicyAction} from "@/fork/actions/stack-policy.action";
import {normalise, type UiResult} from "./outcome";
import {CONFIGURE, GENERIC_FAILURE} from "@/fork/ui/labels";
import {SchedulePicker} from "@/fork/ui/schedule-picker";
import {type SecretHandle} from "@/fork/ui/secret-input";
import {StorageChannelSelect} from "@/fork/ui/storage-channel-select";
import {fmtBytes, stackHref} from "@/fork/ui/stacks/format";
import {useAnnounce} from "@/fork/ui/status-announcer";
import type {ActivateResult} from "@/fork/stack-policy/activate";
import type {ConfigureView} from "@/fork/stack-policy/configure-view";
import type {PreviewResult} from "@/fork/stack-policy/preview-service";
import {RetentionPolicySchema} from "@/fork/recovery/retention-policy";
import {checkChannelRule} from "@/fork/stack-policy/channels";
import {ConsistencySection} from "./consistency-section";
import {blockers, dbFieldErrors, initialState, toActivateInput, toSelection, type WizardState} from "./model";
import {ResourcesSection, type ServerIssue} from "./resources-section";
import {ReviewSection, type Outcome} from "./review-section";

const T = CONFIGURE;
const RETENTION_KEYS = ["keep_last", "daily", "weekly", "monthly", "yearly"] as const;

function Section({id, title, children}: {id: string; title: string; children: React.ReactNode}) {
    return (
        <section aria-labelledby={`sec-${id}`} data-testid={`section-${id}`} className="flex flex-col gap-3 rounded-xl border p-4 sm:p-5">
            <h2 id={`sec-${id}`} className="text-lg font-semibold">{title}</h2>
            {children}
        </section>
    );
}

/**
 * Configure Backup — ONE page, five sections (UX-04: choices live only in this component's state until Activate). Preview and activation go
 * through server actions that re-validate everything; success is shown only for an `ok: true` answer, partial outcomes are listed, refusals are
 * explained with their reason. Passwords stay in uncontrolled inputs, are read once at submit and cleared after every submit.
 */
export function ConfigureForm({view, locked}: {view: ConfigureView; locked: boolean}) {
    const router = useRouter();
    const announce = useAnnounce();
    const [st, setSt] = React.useState<WizardState>(() => initialState(view));
    const [preview, setPreview] = React.useState(view.preview);
    const [serverIssues, setServerIssues] = React.useState<ServerIssue[]>([]);
    const [outcome, setOutcome] = React.useState<Outcome>(null);
    const [cronValid, setCronValid] = React.useState(true);
    const [secretPresent, setSecretPresent] = React.useState<Record<string, boolean>>({});
    const secretRefs = React.useRef<Record<string, SecretHandle | null>>({});
    const set = React.useCallback((p: Partial<WizardState>) => setSt((cur) => ({...cur, ...p})), []);
    const setPresent = React.useCallback((service: string, has: boolean) => setSecretPresent((cur) => (cur[service] === has ? cur : {...cur, [service]: has})), []);

    // ---- read-only preview of the pending selection (debounced; stale answers are dropped) ----
    const seq = React.useRef(0);
    const stackId = view.stack.id;
    const selectionKey = JSON.stringify([toSelection(st, view), st.accepted]);
    React.useEffect(() => {
        const mine = ++seq.current;
        const [selection, acceptedExclusions] = JSON.parse(selectionKey) as [unknown, string[]];
        const timer = setTimeout(async () => {
            try {
                const r = normalise<PreviewResult>(await previewStackPolicyAction({stackId, selection, acceptedExclusions}));
                if (mine !== seq.current) return;
                if (r.kind === "ok" && r.outcome.ok) setPreview(r.outcome.preview);
            } catch { /* keep the previous preview: it is labelled as a preview, nothing is claimed */ }
        }, 350);
        return () => clearTimeout(timer);
    }, [selectionKey, stackId]);

    const dbErrors = dbFieldErrors(st, view);
    const blockerList = blockers({view, state: st, preview, locked, dbErrors, cronInvalid: !cronValid});
    const chosen = view.channels.filter((c) => st.channelIds.includes(c.id));
    const rule = checkChannelRule(chosen);
    const extraReasons: string[] = [];
    for (const d of view.databases) {
        const f = st.databases[d.service];
        const fieldsMissing = dbErrors.some((e) => e.service === d.service);
        const secretMissing = f?.mode === "dump" && d.secret && !secretPresent[d.service] && !(view.existing.active && view.existing.selection.databases[d.service]?.kind === "dump");
        if (fieldsMissing || secretMissing) extraReasons.push(T.review.dbIncomplete(d.service)); // one line per database, not one per field
    }

    const activate = useMutation({
        mutationFn: async (): Promise<UiResult<ActivateResult>> => {
            const secrets: Record<string, string> = {};
            for (const [service, h] of Object.entries(secretRefs.current)) { const v = h?.take(); if (v) secrets[service] = v; } // read once, cleared in the same breath
            return normalise<ActivateResult>(await activateStackPolicyAction(toActivateInput(st, view, secrets)));
        },
        onSuccess: (r) => {
            setServerIssues([]);
            if (r.kind === "ok" && r.outcome.ok) {
                setOutcome({kind: "success", result: r.outcome});
                announce(T.review.success.title);
                router.refresh();
                return;
            }
            const o = r.kind === "refused" ? r.outcome : null;
            const reason = o && !o.ok ? o.reason ?? o.code : "refused";
            const msg = T.review.failure[reason] ?? T.review.failure[o && !o.ok ? o.code : "refused"] ?? (r.kind === "error" ? r.message : GENERIC_FAILURE);
            if (o && !o.ok && o.issues) setServerIssues(o.issues);
            setOutcome({kind: "failure", message: o && !o.ok && o.services?.length ? `${msg} (${o.services.join(", ")})` : msg});
            announce(msg);
        },
        onError: () => { setOutcome({kind: "failure", message: T.review.transport}); announce(T.review.transport); },
    });
    const clearPasswords = () => { for (const h of Object.values(secretRefs.current)) h?.clear(); };
    const onActivate = () => { setOutcome(null); activate.mutate(undefined, {onSettled: clearPasswords}); };

    const setRetention = (k: (typeof RETENTION_KEYS)[number], raw: string) => { const n = Number(raw); if (Number.isInteger(n)) set({retention: {...st.retention, [k]: n}}); };
    const retentionOk = RetentionPolicySchema.safeParse(st.retention).success;

    return (
        <div className="flex flex-col gap-5" data-testid="configure-form">
            <header className="flex flex-col gap-1">
                <Link href={stackHref(view.stack.id)} className="text-muted-foreground w-fit text-sm underline underline-offset-4">{T.back}</Link>
                <h1 className="text-2xl font-semibold">{T.title}: {view.stack.name}</h1>
                <p className="text-muted-foreground text-sm">{T.intro} {T.requiredNote}</p>
                {locked && <p role="note" className="mt-1 text-sm" data-testid="configure-locked">{T.locked}</p>}
            </header>

            <Section id="resources" title={T.sections.resources}><ResourcesSection view={view} st={st} set={set} preview={preview} serverIssues={serverIssues}/></Section>
            <Section id="consistency" title={T.sections.consistency}><ConsistencySection view={view} st={st} set={set} preview={preview} dbErrors={dbErrors} serverIssues={serverIssues} secretRefs={secretRefs} secretPresent={secretPresent} setPresent={setPresent}/></Section>

            <Section id="schedule" title={T.sections.schedule}>
                <p className="text-muted-foreground text-sm">{T.schedule.intro}</p>
                <SchedulePicker value={st.schedule} onChange={(schedule) => set({schedule})} onCronValidity={setCronValid}/>
                <fieldset className="flex flex-col gap-3 rounded-lg border p-3" data-testid="retention">
                    <legend className="px-1 font-medium">{T.schedule.retention.heading}</legend>
                    <p className="text-muted-foreground text-xs">{T.schedule.retention.intro}</p>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        {RETENTION_KEYS.map((k) => (
                            <div key={k} className="flex flex-col gap-1.5">
                                <Label htmlFor={`ret-${k}`}>{T.schedule.retention[k]}</Label>
                                <Input id={`ret-${k}`} type="number" min={k === "keep_last" ? 1 : 0} value={st.retention[k]} onChange={(e) => setRetention(k, e.target.value)} aria-describedby={`ret-${k}-unit`}/>
                                <span id={`ret-${k}-unit`} className="text-muted-foreground text-xs">{T.schedule.retention.unit[k]}</span>
                            </div>
                        ))}
                    </div>
                    {!retentionOk && <p role="alert" className="text-destructive text-sm">{T.review.blockers.invalid_retention}</p>}
                </fieldset>
            </Section>

            <Section id="storage" title={T.sections.storage}>
                <p className="text-muted-foreground text-sm">{T.storage.intro}</p>
                {!view.encryptionOn && <p role="note" className="rounded-md border p-3 text-sm" data-testid="encryption-off">{T.storage.encryptionOff}</p>}
                <StorageChannelSelect channels={view.channels} value={st.channelIds} onChange={(channelIds) => set({channelIds})}/>
                {!rule.ok && view.channels.length > 0 && <p id="channel-rule" role="note" className="text-sm" data-testid="channel-rule">{T.storage.rule[rule.reason]}</p>}
                <p className="text-muted-foreground text-xs">{T.storage.deletableNote}</p>
                <div data-testid="size-estimate">
                    <h3 className="text-sm font-medium">{T.storage.size.heading}</h3>
                    <p className="text-sm">{preview.size.bytes !== null ? T.storage.size.known(fmtBytes(preview.size.bytes) ?? "", preview.size.counted) : T.storage.size.unknown}</p>
                    {preview.size.bytes !== null && preview.size.unknown > 0 && <p className="text-muted-foreground text-xs">{T.storage.size.unknownSome(preview.size.unknown)}</p>}
                </div>
            </Section>

            <Section id="review" title={T.sections.review}>
                <ReviewSection stackId={view.stack.id} preview={preview} blockerList={blockerList} extraReasons={extraReasons} pending={activate.isPending} active={view.existing.active} dockerGate={preview.dockerGate}
                    confirmDocker={st.confirmDocker} setConfirmDocker={(v) => set({confirmDocker: v})} onActivate={onActivate} outcome={outcome} timezone={st.schedule.timezone}/>
            </Section>
        </div>
    );
}
