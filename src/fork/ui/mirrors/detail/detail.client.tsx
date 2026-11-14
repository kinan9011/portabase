"use client";

import Link from "next/link";
import * as React from "react";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs";
import type {MirrorDetailExtras, MirrorLogEntry} from "@/fork/mirror/list-view";
import type {MirrorView} from "@/fork/mirror/view";
import {ConfigurationTab} from "@/fork/ui/mirrors/detail/configuration";
import {HistoryTab} from "@/fork/ui/mirrors/detail/history";
import {LogsTab} from "@/fork/ui/mirrors/detail/logs.client";
import {BANNER, MIRRORS, reasonText} from "@/fork/ui/mirrors/labels";
import {DeleteMirrorButton} from "@/fork/ui/mirrors/lifecycle/delete-button.client";
import {StopStartButtons} from "@/fork/ui/mirrors/lifecycle/stop-start.client";
import {failedNewerRevision, MIRROR_TABS, type MirrorTab, mirrorActions, startTestedLabel} from "@/fork/ui/mirrors/model";
import {MirrorProgress} from "@/fork/ui/mirrors/progress/progress.client";
import {FOCUS_RING_AA} from "@/fork/ui/a11y/focus";
import {TONE_MAP} from "@/fork/ui/tone";
import {ToneBadge} from "@/fork/ui/tone-badge";

const D = MIRRORS.detail;

export type DetailProps = {
    initial: MirrorView; extras: MirrorDetailExtras; log: MirrorLogEntry[]; canManage: boolean; locked: boolean; flagOn: boolean; stopStart?: boolean; now: string; staleAfterDays: number; tab: MirrorTab;
};

/** 4-tab mirror detail (W23): persistent ADR-009 banner, URL-synced Radix tabs (`?tab=`), Overview = the W22b progress view with facet, alerts and lifecycle buttons. */
export function MirrorDetail({initial, extras, log, canManage, locked, flagOn, stopStart = true, now, staleAfterDays, tab: initialTab}: DetailProps) {
    const [tab, setTab] = React.useState<MirrorTab>(initialTab);
    const onTab = (t: string) => {
        const next = (MIRROR_TABS as readonly string[]).includes(t) ? (t as MirrorTab) : "overview";
        setTab(next);
        try { window.history.replaceState(null, "", next === "overview" ? window.location.pathname : `${window.location.pathname}?tab=${next}`); } catch { /* URL sync is a convenience */ }
    };
    const at = new Date(now);
    const danger = TONE_MAP.danger;
    const overviewExtra = (view: MirrorView, ctx: {poll: () => Promise<void>}) => {
        const rev = view.revisions[0];
        const fact = extras.facet ? startTestedLabel({readiedAt: extras.facet.readiedAt, now: at, staleAfterDays}) : null;
        const failed = failedNewerRevision(view);
        const actions = mirrorActions({status: view.mirror.status, hasActiveRevision: view.mirror.activeRevisionId !== null, activeCreation: rev ? ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting", "healthchecking"].includes(rev.state) : false,
            wipeFailed: false}, {manage: canManage, locked, flagOn, stopStart});
        return (
            <div className="space-y-3">
                {fact && extras.facet && (
                    <div data-testid="start-tested" className="space-y-1 text-sm">
                        <p className="flex flex-wrap items-center gap-2"><ToneBadge tone={fact.tone}>{fact.text}</ToneBadge><span className="text-muted-foreground">{MIRRORS.facet.fromRp(extras.facet.rpSequence)}</span></p>
                        <p className="text-muted-foreground">{MIRRORS.facet.meaning}</p>
                    </div>
                )}
                {failed && (
                    <div data-testid="failed-newer" className={`rounded-md border p-3 text-sm ${danger.panel}`}>
                        <p className={danger.body}>{D.failedNewer(failed.seq, failed.activeSeq, reasonText(failed.reason))}</p>
                    </div>
                )}
                {lastOpLine(view.mirror.status, extras.lastOp) && <p role="note" data-testid="last-op" className="text-sm">{lastOpLine(view.mirror.status, extras.lastOp)}</p>}
                {!("hidden" in actions.delete && "hidden" in actions.stop && "hidden" in actions.start) && (
                    <div className="flex flex-wrap items-start gap-2" data-testid="lifecycle-actions">
                        <StopStartButtons mirrorId={view.mirror.id} name={view.mirror.name} stop={actions.stop} start={actions.start} onDone={() => void ctx.poll()}/>
                        <DeleteMirrorButton mirrorId={view.mirror.id} name={view.mirror.name} runner={view.mirror.runnerName} action={actions.delete} onDone={() => void ctx.poll()}/>
                    </div>
                )}
            </div>
        );
    };
    return (
        <div className="max-w-4xl space-y-5">
            <nav aria-label="Breadcrumb"><Link href="/dashboard/mirrors" className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline">← {D.back}</Link></nav>
            <h1 id="mirror-h" tabIndex={-1} className="text-2xl font-bold break-words outline-none">{MIRRORS.progress.title} · {initial.mirror.name}</h1>
            <p role="note" data-testid="privacy-banner" className="rounded-lg border-2 p-3 text-sm font-medium">{BANNER(initial.mirror.runnerName)}</p>
            <Tabs value={tab} onValueChange={onTab}>
                <div className="max-w-full overflow-x-auto" data-testid="tabs-scroll">
                    <TabsList aria-label={D.tabs.label} className="w-max">
                        {TAB_LABELS.map(([v, label]) => <TabsTrigger key={v} value={v}>{label}</TabsTrigger>)}
                    </TabsList>
                </div>
                <TabsContent className={FOCUS_RING_AA} value="overview"><MirrorProgress initial={initial} canManage={canManage} locked={locked} embedded extra={overviewExtra}/></TabsContent>
                <TabsContent className={FOCUS_RING_AA} value="configuration"><ConfigurationTab view={initial} extras={extras} now={now}/></TabsContent>
                <TabsContent className={FOCUS_RING_AA} value="history"><HistoryTab view={initial} rpDates={extras.rpDates}/></TabsContent>
                <TabsContent className={FOCUS_RING_AA} value="logs"><LogsTab entries={log}/></TabsContent>
            </Tabs>
        </div>
    );
}
/** The outcome sentence of the last stop / start attempt, only while the mirror is still in the state that attempt ended in. */
function lastOpLine(status: string, op: MirrorDetailExtras["lastOp"]): string | null {
    if (!op || op.status !== status || !op.code) return null;
    return status === "stopped" ? MIRRORS.lifecycle.startFailedLine(reasonText(op.code)) : status === "failed" ? MIRRORS.lifecycle.lastStopFailed(reasonText(op.code)) : null;
}
const TAB_LABELS: readonly [MirrorTab, string][] = [["overview", D.tabs.overview], ["configuration", D.tabs.configuration], ["history", D.tabs.history], ["logs", D.tabs.logs]];
