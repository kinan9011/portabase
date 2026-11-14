"use client";

import {TriangleAlert} from "lucide-react";
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
import {useRouter} from "next/navigation";
import {MirrorProgress} from "@/fork/ui/mirrors/progress/progress.client";
import {rollbackTargets} from "@/fork/ui/mirrors/refresh/model";
import {RefreshMirrorButton} from "@/fork/ui/mirrors/refresh/refresh-dialog.client";
import {RollbackMirrorButton} from "@/fork/ui/mirrors/rollback/rollback-dialog.client";
import {FOCUS_RING_AA} from "@/fork/ui/a11y/focus";
import {TONE_MAP} from "@/fork/ui/tone";
import {ToneBadge} from "@/fork/ui/tone-badge";

const D = MIRRORS.detail;

export type DetailProps = {
    initial: MirrorView; extras: MirrorDetailExtras; log: MirrorLogEntry[]; canManage: boolean; locked: boolean; flagOn: boolean; stopStart?: boolean; now: string; staleAfterDays: number; tab: MirrorTab;
    /** W25: strictly newer verified backups (the Refresh button's enable rule); optional so older callers compile (0 ⇒ "no newer backup" reason) */
    refreshFacts?: {newerVerifiedCount: number};
};

/** 4-tab mirror detail (W23): persistent ADR-009 banner, URL-synced Radix tabs (`?tab=`), Overview = the W22b progress view with facet, alerts and lifecycle buttons. */
export function MirrorDetail({initial, extras, log, canManage, locked, flagOn, stopStart = true, now, staleAfterDays, tab: initialTab, refreshFacts}: DetailProps) {
    const router = useRouter();
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
            wipeFailed: false, newerVerifiedCount: refreshFacts?.newerVerifiedCount ?? 0, rollbackTargetCount: rollbackTargets(view).length}, {manage: canManage, locked, flagOn, stopStart}); // targets from the POLLED view: the badge / button follow a commit without reload
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
                {view.mirror.retentionDue && (
                    <p role="note" data-testid="retention-due" className={`flex items-start gap-2 rounded-md border p-3 text-sm ${TONE_MAP.warning.panel}`}>
                        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0"/><span className={TONE_MAP.warning.body}>{MIRRORS.refresh.retention}</span>
                    </p>
                )}
                {lastOpLine(view, extras.lastOp, failed !== null) && <p role="note" data-testid="last-op" className="text-sm">{lastOpLine(view, extras.lastOp, failed !== null)}</p>}
                {!(["delete", "stop", "start", "refresh", "rollback"] as const).every((k) => "hidden" in actions[k]) && (
                    <div className="flex flex-wrap items-start gap-2" data-testid="lifecycle-actions">
                        <RefreshMirrorButton view={view} action={actions.refresh} onDone={() => void ctx.poll()}/>
                        <RollbackMirrorButton view={view} rpDates={extras.rpDates} memBytes={extras.config.limits.memBytes} action={actions.rollback} onDone={() => void ctx.poll()}/>
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
                <TabsContent className={FOCUS_RING_AA} value="overview"><MirrorProgress initial={initial} canManage={canManage} locked={locked} embedded lastFrom={extras.lastOp?.status === "failed" ? (extras.lastOp.from ?? null) : null} extra={overviewExtra} onCommitted={() => router.refresh()}/></TabsContent>
                <TabsContent className={FOCUS_RING_AA} value="configuration"><ConfigurationTab view={initial} extras={extras} now={now}/></TabsContent>
                <TabsContent className={FOCUS_RING_AA} value="history"><HistoryTab view={initial} rpDates={extras.rpDates}/></TabsContent>
                <TabsContent className={FOCUS_RING_AA} value="logs"><LogsTab entries={log}/></TabsContent>
            </Tabs>
        </div>
    );
}
/**
 * The outcome sentence of the last failed operation (stop / start / refresh / rollback), only while the mirror is still in the status that attempt ended in. A refresh that failed AFTER its revision
 * was built is explained by the failed-newer panel when the newest revision failed (no duplicate line). A `failed` mirror after a refresh / rollback is explained by the headline.
 */
function lastOpLine(view: MirrorView, op: MirrorDetailExtras["lastOp"], failedNewer: boolean): string | null {
    const status = view.mirror.status;
    if (!op || op.status !== status || !op.code) return null;
    const cur = view.revisions.find((r) => r.id === view.mirror.activeRevisionId)?.seq ?? 0;
    if (status === "ready") {
        if (op.from === "refreshing") return failedNewer ? null : MIRRORS.refresh.failedLine(reasonText(op.code), cur);
        if (op.from === "rolling_back") return MIRRORS.rollback.failedLine(reasonText(op.code), cur);
        return null;
    }
    if (status === "failed" && (op.from === "refreshing" || op.from === "rolling_back")) return null;
    return status === "stopped" ? MIRRORS.lifecycle.startFailedLine(reasonText(op.code)) : status === "failed" ? MIRRORS.lifecycle.lastStopFailed(reasonText(op.code)) : null;
}
const TAB_LABELS: readonly [MirrorTab, string][] = [["overview", D.tabs.overview], ["configuration", D.tabs.configuration], ["history", D.tabs.history], ["logs", D.tabs.logs]];
