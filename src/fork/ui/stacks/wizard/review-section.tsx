"use client";

import Link from "next/link";
import * as React from "react";
import {Checkbox} from "@/components/ui/checkbox";
import {Label} from "@/components/ui/label";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {CONFIGURE} from "@/fork/ui/labels";
import {fmtBytes, stackHref} from "@/fork/ui/stacks/format";
import {TONE_MAP} from "@/fork/ui/tone";
import type {PreviewView} from "@/fork/stack-policy/preview";
import type {ActivateResult} from "@/fork/stack-policy/activate";
import type {BlockerCode} from "./model";

const V = CONFIGURE.review;
export type Outcome = {kind: "success"; result: Extract<ActivateResult, {ok: true}>} | {kind: "failure"; message: string} | null;

export function ReviewSection({stackId, preview, blockerList, extraReasons, pending, active, dockerGate, confirmDocker, setConfirmDocker, onActivate, outcome, timezone}: {
    stackId: string; preview: PreviewView; blockerList: readonly BlockerCode[]; extraReasons: readonly string[]; pending: boolean; active: boolean; dockerGate: boolean;
    confirmDocker: boolean; setConfirmDocker: (v: boolean) => void; onActivate: () => void; outcome: Outcome; timezone: string;
}) {
    const id = React.useId();
    const included = preview.items.filter((i) => i.plan === "backed_up").length;
    const reasons = [...blockerList.map((b) => V.blockers[b]), ...extraReasons];
    const reason = pending ? V.activating : reasons[0] ?? null;
    const run = (iso: string) => { try { return new Intl.DateTimeFormat("en-GB", {timeZone: timezone, dateStyle: "medium", timeStyle: "short"}).format(new Date(iso)); } catch { return iso; } };
    return (
        <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">{V.intro}</p>
            <div role="group" aria-label={V.summaryLabel} className="flex flex-col gap-1 text-sm" data-testid="review-summary">
                <p>{V.included(included)}</p>
                <p data-testid="review-gaps">{preview.gaps > 0 ? V.gaps(preview.gaps) : V.complete}</p>
                <p className="text-muted-foreground text-xs">{V.readability}</p>
                {preview.size.bytes !== null && <p className="text-xs">{CONFIGURE.storage.size.known(fmtBytes(preview.size.bytes) ?? "", preview.size.counted)}</p>}
            </div>
            <section aria-labelledby={`${id}-src`} className="flex flex-col gap-1">
                <h4 id={`${id}-src`} className="font-medium">{V.sources}</h4>
                {preview.sources.length === 0 ? <p className="text-sm">{V.sourcesNone}</p> : (
                    <ul className="text-sm" data-testid="review-sources">{preview.sources.map((s) => <li key={s.name} className="break-all">{s.name}</li>)}</ul>
                )}
                {preview.skipped.length > 0 && <p className="text-muted-foreground text-xs">{V.skipped}: {preview.skipped.length}</p>}
            </section>

            {dockerGate && (
                <div className="flex flex-col gap-2 rounded-lg border p-3" data-testid="docker-confirm">
                    <div className="flex items-start gap-2">
                        <Checkbox id={`${id}-docker`} checked={confirmDocker} onCheckedChange={(v) => setConfirmDocker(v === true)} aria-describedby={`${id}-docker-note`} className="mt-0.5"/>
                        <Label htmlFor={`${id}-docker`} className="text-sm">{V.dockerConfirm}</Label>
                    </div>
                    <p id={`${id}-docker-note`} className="text-muted-foreground text-xs">{V.dockerNote}</p>
                </div>
            )}

            {reasons.length > 0 && (
                <section aria-labelledby={`${id}-blk`} data-testid="review-blockers" className={`rounded-lg border p-3 text-sm ${TONE_MAP.warning.panel}`}>
                    <h4 id={`${id}-blk`} className="font-medium">{V.blockersHeading}</h4>
                    <ul className="list-disc pl-5">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                </section>
            )}
            {active && <p className="text-muted-foreground text-sm">{V.activeNote}</p>}

            <div className="flex flex-wrap items-start gap-3">
                <ReasonButton type="button" onClick={onActivate} reason={reason} data-testid="activate">{active ? V.edit : V.activate}</ReasonButton>
                <ReasonButton type="button" variant="outline" reason={V.runFirstReason} data-testid="run-first">{V.runFirst}</ReasonButton>
            </div>

            {outcome?.kind === "success" && (
                <section role="status" aria-labelledby={`${id}-ok`} data-testid="activate-success" className={`rounded-lg border p-4 text-sm ${TONE_MAP.success.panel}`}>
                    <h4 id={`${id}-ok`} className="font-medium">{V.success.title}</h4>
                    <p>{V.success.body(outcome.result.sources.filter((s) => s.status !== "planned").length, outcome.result.nextRuns[0] ? run(outcome.result.nextRuns[0]) : "—")}</p>
                    {outcome.result.deferred.length > 0 && <p>{V.success.deferred(outcome.result.deferred.length)}</p>}
                    {outcome.result.skipped.length > 0 && <p>{V.success.skipped(outcome.result.skipped.length)}</p>}
                    <Link href={stackHref(stackId, "schedule")} className="mt-2 inline-block font-medium underline underline-offset-4">{V.success.view}</Link>
                </section>
            )}
            {outcome?.kind === "failure" && (
                <section role="alert" aria-labelledby={`${id}-fail`} data-testid="activate-failure" className={`rounded-lg border p-4 text-sm ${TONE_MAP.danger.panel}`}>
                    <h4 id={`${id}-fail`} className="font-medium">{V.failure.title}</h4>
                    <p>{outcome.message}</p>
                </section>
            )}
        </div>
    );
}
