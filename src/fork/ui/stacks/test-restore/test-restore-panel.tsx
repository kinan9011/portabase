import * as React from "react";
import Link from "next/link";
import type {TestRestoreView} from "@/fork/test-restore/view";
import {SCHEDULE_PRESETS, type SchedulePreset} from "@/fork/schedule/schedule";
import {CONFIGURE} from "@/fork/ui/labels";
import {failureSentence} from "@/fork/ui/recovery/model";
import {fmtUtc} from "@/fork/ui/stacks/format";
import {PrivacyEditor, TestRestoreActions, TestRestoreEditor, TestRestorePoller} from "./test-restore-edit.client";
import {TR, skipText, wipeReasonText} from "./labels";

const presetLabel = (p: string) => CONFIGURE.schedule.presets[(SCHEDULE_PRESETS as readonly string[]).includes(p) ? (p as SchedulePreset) : "cron"];

/** A test restore or its wipe is still in motion (D-F5): keep polling. Wipe `null` on a terminal run = not yet armed. */
export const isTestRestoreActive = (v: TestRestoreView): boolean =>
    !!v.last && (v.last.state === "running" || v.last.state === "awaiting_approval" || v.last.wipe.state === "running" || v.last.wipe.state === null);

/** Pure copy of the "latest result" block: what was proven, what was not (D-F6). Never invents a success. */
export function lastResultLines(v: TestRestoreView, machine: string): {headline: string; tone: "success" | "danger" | "neutral"; integrity: string[]; wipe: string | null; duration: string | null} {
    const l = v.last;
    if (!l) return {headline: "", tone: "neutral", integrity: [], wipe: null, duration: null};
    const headline = l.state === "succeeded" ? TR.last.succeeded
        : l.state === "failed" || l.state === "incomplete" ? TR.last.failedPrefix + failureSentence(l.reason, machine).text
        : l.state === "cancelled" ? TR.last.cancelled : TR.last.running;
    const tone = l.state === "succeeded" ? "success" : l.state === "failed" || l.state === "incomplete" ? "danger" : "neutral";
    const integrity: string[] = [];
    if (l.integrity && l.integrity.checked > 0) integrity.push(TR.integrity.checked(l.integrity.checked));
    if (l.integrity && l.integrity.notSupported > 0) integrity.push(TR.integrity.notSupported(l.integrity.notSupported));
    if (l.state === "succeeded" && l.integrity === null) integrity.push(TR.integrity.none);
    const w = l.wipe.state;
    const wipe = w === null ? (l.state === "running" || l.state === "awaiting_approval" ? null : TR.wipe.pending)
        : w === "running" ? TR.wipe.running : w === "verified" ? TR.wipe.verified : w === "not_needed" ? TR.wipe.not_needed : TR.wipe.failed(wipeReasonText(l.wipe.reason));
    const duration = l.durationSeconds !== null && l.state !== "running" ? TR.last.duration(l.durationSeconds) : null;
    return {headline, tone, integrity, wipe, duration};
}

export function TestRestorePanel({view, stackId, isAdmin, configLocked}: {view: TestRestoreView; stackId: string; isAdmin: boolean; configLocked: boolean}) {
    const s = view.schedule;
    const state = s.paused ? "paused" : !s.configured ? "not_configured" : s.enabled ? "on" : "off";
    const statusText = state === "paused" ? `${TR.status.paused} — ${TR.pause[s.paused?.reason ?? ""] ?? TR.pause.paused}` : state === "not_configured" ? TR.status.notConfigured : state === "on" ? TR.status.on : TR.status.off;
    const machine = s.targetAgentName ?? "The test machine";
    const res = lastResultLines(view, machine);
    const f = view.facet;
    const noOptIn = view.privacy.containsPersonalData !== false && !view.privacy.optIn;
    const editReason = !view.admin || !view.can.configure ? TR.reasons.configure : configLocked ? TR.reasons.locked : null;
    const privacyReason = !isAdmin ? TR.reasons.privacy : configLocked ? TR.reasons.locked : null;
    const pd = view.privacy.containsPersonalData;
    const rows: [string, React.ReactNode][] = [
        [TR.rows.status, statusText],
        [TR.rows.schedule, s.preset ? `${presetLabel(s.preset)}${s.cron ? ` (${s.cron})` : ""}` : "—"],
        [TR.rows.timezone, s.timezone ?? "—"],
        [TR.rows.next, s.nextRuns.length ? <ul key="n">{s.nextRuns.map((r) => <li key={r}>{fmtUtc(r, "")}</li>)}</ul> : "—"],
        [TR.rows.target, s.targetAgentName ?? "—"],
        [TR.rows.staleAfter, TR.days(s.staleAfterDays)],
        [TR.rows.lastSchedule, s.lastOutcome ? `${TR.outcome[s.lastOutcome.kind] ?? s.lastOutcome.kind}${s.lastOutcome.kind === "skipped" ? ` — ${skipText(s.lastOutcome.reason)}` : ""} · ${fmtUtc(s.lastOutcome.at, "")}` : "—"],
    ];
    return (
        <section aria-labelledby="tr-heading" data-testid="tr-panel" data-state={state} className="flex flex-col gap-3 rounded-xl border p-4">
            <h3 id="tr-heading" className="font-semibold">{TR.heading}</h3>
            <p className="text-muted-foreground max-w-prose text-sm">{TR.intro}</p>
            <div data-testid="tr-facet" className="text-sm">
                <span className="font-medium">{TR.facet.label}: </span>
                <span><span aria-hidden="true">{f.daysAgo === null ? "○" : f.stale ? "▲" : "●"} </span>{f.daysAgo === null ? TR.facet.none : TR.facet.ago(Math.floor(f.daysAgo))}{f.daysAgo !== null && f.stale ? ` · ${TR.facet.stale}` : ""}</span>
                {f.daysAgo !== null && f.stale && <p className="text-muted-foreground">{TR.facet.staleNote(s.staleAfterDays)}</p>}
            </div>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
                {rows.map(([k, v]) => <React.Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></React.Fragment>)}
            </dl>
            <div data-testid="tr-privacy" className="flex flex-col gap-2 text-sm">
                <p className="font-medium">{TR.privacy.heading}</p>
                <p>{pd === true ? TR.privacy.yes : pd === false ? TR.privacy.no : TR.privacy.unset}. {view.privacy.optIn ? TR.privacy.optedIn : TR.privacy.notOptedIn}</p>
                {noOptIn && <p role="note" className="max-w-prose">{TR.privacy.refusedLine}</p>}
                <PrivacyEditor view={view} stackId={stackId} reason={privacyReason}/>
            </div>
            {view.last && (
                <div data-testid="tr-last" data-tone={res.tone} className="flex flex-col gap-1 text-sm">
                    <p className="font-medium">{TR.last.heading}</p>
                    <p className="text-muted-foreground">{TR.last.trigger[view.last.trigger] ?? view.last.trigger} · {TR.last.started}: {fmtUtc(view.last.startedAt, "—")}{view.last.finishedAt ? ` · ${TR.last.finished}: ${fmtUtc(view.last.finishedAt, "—")}` : ""}</p>
                    <p>{res.headline}</p>
                    {res.duration && <p data-testid="tr-duration">{res.duration}</p>}
                    {res.integrity.length > 0 && <ul data-testid="tr-integrity" className="list-disc pl-5">{res.integrity.map((x) => <li key={x}>{x}</li>)}</ul>}
                    {res.wipe && (view.last.wipe.state === "failed" ? <p data-testid="tr-wipe" role="alert" className="text-destructive">{res.wipe}</p> : <p data-testid="tr-wipe">{res.wipe}</p>)}
                    <Link href={`/dashboard/recovery/runs/${view.last.runId}`} className="w-fit font-medium underline underline-offset-4">{TR.last.link}</Link>
                </div>
            )}
            <TestRestorePoller active={isTestRestoreActive(view)}/>
            <TestRestoreActions view={view} stackId={stackId} configLocked={configLocked} active={isTestRestoreActive(view)}/>
            <TestRestoreEditor view={view} stackId={stackId} reason={editReason}/>
        </section>
    );
}
