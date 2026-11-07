"use client";

import Link from "next/link";
import * as React from "react";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs";
import type {ConfigurationView, ProtectionView} from "@/fork/completeness/view";
import type {InventoryView, StackDetail} from "@/fork/stacks/dto";
import {TABS, type StackTab} from "@/fork/ui/stacks/tabs";
import {CONFIG_TAB, SCHEDULE_TAB, ENVIRONMENT_COPY, RP_STATUS_LABELS, STACK_DETAILS, STACKS_EMPTY, WARNING_COPY, WARNING_FALLBACK, WARNING_SEVERITY_LABELS} from "@/fork/ui/labels";
import {BlockersPanel} from "@/fork/ui/stacks/config-tab/blockers-panel";
import {ConfigTab} from "@/fork/ui/stacks/config-tab/config-tab";
import {FacetsPanel, LastGoodBackupLine} from "@/fork/ui/stacks/config-tab/facets-panel";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {fmtPort, fmtUtc, STACKS_HREF} from "@/fork/ui/stacks/format";
import {ResourcesTabs} from "@/fork/ui/stacks/resources-tabs";
import {ScheduleTab} from "@/fork/ui/stacks/schedule-tab";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {PrimaryStateBadge, ProtectionBadge, RpStatusBadge, RuntimeBadge, StaleBadge} from "@/fork/ui/stacks/stack-status-badges";
import {SyncPoller} from "@/fork/ui/stacks/sync-poller";
import {TONE_MAP} from "@/fork/ui/tone";
import {ToneBadge} from "@/fork/ui/tone-badge";

const D = STACK_DETAILS;
function Actions({canConfigure, configLocked, stackId}: {canConfigure: boolean; configLocked: boolean; stackId: string}) {
    // Configure is a real link for an administrator while configuration is open (W11); every other action is visibly disabled with its reason (§8.2 rule 10).
    return (
        <div className="flex flex-wrap items-start gap-3" data-testid="actions">
            {canConfigure && !configLocked
                ? <Link href={`${STACKS_HREF}/${stackId}/configure`} data-testid="configure-link" className="border-input bg-background hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium">{D.actions.configure.label}</Link>
                : <ReasonButton type="button" variant="outline" reason={canConfigure ? D.actions.configure.admin : D.actions.configure.member}>{D.actions.configure.label}</ReasonButton>}
            <ReasonButton type="button" variant="outline" reason={D.actions.backupNow.reason}>{D.actions.backupNow.label}</ReasonButton>
            <ReasonButton type="button" variant="outline" reason={D.actions.restore.reason}>{D.actions.restore.label}</ReasonButton>
            <ReasonButton type="button" variant="outline" reason={D.actions.mirror.reason}>{D.actions.mirror.label}</ReasonButton>
        </div>
    );
}

function Summary({v}: {v: InventoryView}) {
    const running = v.services.filter((s) => s.state === "running").length;
    const items: [string, string][] = [
        ["Services", `${running} of ${v.services.length} running`],
        ["Named volumes", String(v.volumes.length)],
        ["Anonymous volumes", String(v.anonymousVolumes.length)],
        ["Bind mounts", String(v.binds.length)],
        ["Networks", String(v.networks.length)],
        ["Databases recognised", String(v.databases.length)],
    ];
    return (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="resource-summary">
            {items.map(([k, val]) => <div key={k} className="rounded-xl border px-4 py-3"><dt className="text-muted-foreground text-xs">{k}</dt><dd className="text-lg font-semibold">{val}</dd></div>)}
        </dl>
    );
}

/** One line per warning code (repeats are counted, not repeated). */
function groupWarnings(ws: InventoryView["warnings"]) {
    const m = new Map<string, {code: string; severity: InventoryView["warnings"][number]["severity"]; count: number}>();
    for (const w of ws) { const e = m.get(w.code); if (e) e.count++; else m.set(w.code, {...w, count: 1}); }
    return [...m.values()];
}

function Overview({v, p, c, onOpenConfiguration}: {v: InventoryView; p: ProtectionView; c: ConfigurationView; onOpenConfiguration: () => void}) {
    const o = D.overview;
    const ports = v.services.flatMap((s) => s.ports.map((p) => ({s: s.name, p})));
    return (
        <div className="flex flex-col gap-6">
            <section aria-labelledby="ov-resources" className="flex flex-col gap-3"><h2 id="ov-resources" className="text-lg font-semibold">{o.resources}</h2><Summary v={v}/></section>

            <div className="grid gap-4 md:grid-cols-2">
                <section aria-labelledby="ov-rp" className="rounded-xl border p-4" data-testid="recovery-section">
                    <h2 id="ov-rp" className="font-semibold">{o.recovery}</h2>
                    {p.recoveryPoints.verified + p.recoveryPoints.pending === 0 ? <><p className="mt-1 text-lg">{o.noRecovery}</p><p className="text-muted-foreground text-sm">{o.noRecoveryNote}</p></> : (
                        <div className="mt-2 flex flex-col gap-2 text-sm">
                            <p>{o.verifiedCount(p.recoveryPoints.verified)}</p>
                            {p.recoveryPoints.pending > 0 && <p className="flex flex-wrap items-center gap-2"><RpStatusBadge status="pending_verification"/><span className="text-muted-foreground text-xs">{RP_STATUS_LABELS.pending_verification.description}</span></p>}
                        </div>
                    )}
                </section>
                <BlockersPanel p={p} c={c} onOpenConfiguration={onOpenConfiguration}/>
            </div>

            <FacetsPanel p={p}/>

            <section aria-labelledby="ov-shared" className="flex flex-col gap-2" data-testid="shared-section">
                <h2 id="ov-shared" className="text-lg font-semibold">{o.sharedHeading}</h2>
                {v.shared.length === 0 ? <p className="text-muted-foreground text-sm">{o.sharedNone}</p> : (
                    <>
                        <ul className="flex flex-wrap gap-2">{v.shared.map((s) => <li key={`${s.kind}:${s.name}`} data-testid="shared-item"><ToneBadge tone="warning"><span className="font-mono">{s.name}</span><span className="font-normal">({s.kind})</span></ToneBadge></li>)}</ul>
                        <p className="text-muted-foreground text-sm">{o.sharedNote}</p>
                    </>
                )}
            </section>

            <section aria-labelledby="ov-facts" className="flex flex-col gap-2">
                <h2 id="ov-facts" className="text-lg font-semibold">{o.facts}</h2>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                    <dt className="text-muted-foreground">{o.inventoryVersion}</dt><dd>{v.version}</dd>
                    <dt className="text-muted-foreground">{D.inventoryCaptured}</dt><dd>{fmtUtc(v.capturedAt, D.notSynced)}</dd>
                    <dt className="text-muted-foreground">{o.composeReadLabel}</dt><dd>{o.composeRead[v.composeRead]}</dd>
                    <dt className="text-muted-foreground">{o.ports}</dt><dd>{ports.length ? <ul>{ports.map(({s, p}) => <li key={`${s}${fmtPort(p)}`} className="font-mono text-xs">{s}: {fmtPort(p)}</li>)}</ul> : "—"}</dd>
                </dl>
            </section>

            <section aria-labelledby="ov-warnings" className="flex flex-col gap-2">
                <h2 id="ov-warnings" className="text-lg font-semibold">{o.warnings}</h2>
                {v.warnings.length === 0 ? <p className="text-muted-foreground text-sm">{o.noWarnings}</p> : (
                    <ul className="flex flex-col gap-1.5" data-testid="warnings">
                        {groupWarnings(v.warnings).map((w) => (
                            <li key={w.code} className="flex flex-wrap items-center gap-2 text-sm">
                                <ToneBadge tone={w.severity === "blocker" ? "danger" : w.severity === "warn" ? "warning" : "neutral"}>{WARNING_SEVERITY_LABELS[w.severity]}</ToneBadge>
                                <span>{WARNING_COPY[w.code] ?? WARNING_FALLBACK}{w.count > 1 ? ` (${w.count}×)` : ""}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

export function StackDetailsClient({detail, initialTab, canConfigure, configLocked = false}: {detail: StackDetail; initialTab: StackTab; canConfigure: boolean; configLocked?: boolean}) {
    const [tab, setTab] = React.useState<StackTab>(initialTab);
    const gone = detail.runtime === "absent";
    const stale = detail.staleSince !== null && !gone;
    const onTab = (t: string) => {
        const next = (TABS as readonly string[]).includes(t) ? (t as StackTab) : "overview";
        setTab(next);
        try { window.history.replaceState(null, "", next === "overview" ? window.location.pathname : `${window.location.pathname}?tab=${next}`); } catch { /* URL sync is a convenience */ }
    };
    const view = detail.inventory.state === "ok" ? detail.inventory.view : null;
    const protection = detail.inventory.state === "ok" ? detail.inventory.protection : null;
    const configuration = detail.inventory.state === "ok" ? detail.inventory.configuration : null;
    const warn = TONE_MAP.warning;
    return (
        <div className="flex flex-col gap-5">
            <SyncPoller active={detail.syncing}/>
            <nav aria-label="Breadcrumb"><Link href={STACKS_HREF} className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline">← {D.back}</Link></nav>

            <header className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h1 className="text-3xl font-bold break-words">{detail.name}</h1>
                        <dl className="text-muted-foreground mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                            <div className="flex gap-1.5"><dt>{D.environment}:</dt><dd className="text-foreground">{detail.environmentName}</dd></div>
                            <div className="flex gap-1.5"><dt>{D.composeProject}:</dt><dd className="text-foreground font-mono">{detail.composeProject}</dd></div>
                            <div className="flex gap-1.5"><dt>{D.lastSync}:</dt><dd className="text-foreground">{fmtUtc(detail.lastSyncAt, ENVIRONMENT_COPY.notSynced)}</dd></div>
                        </dl>
                    </div>
                    <Actions canConfigure={canConfigure} configLocked={configLocked} stackId={detail.id}/>
                </div>
                {protection && <LastGoodBackupLine p={protection}/>}
                <div className="flex flex-wrap items-start gap-4"><RuntimeBadge state={detail.runtime} describe/>{protection ? <PrimaryStateBadge state={protection.primary} describe/> : <ProtectionBadge state={detail.protection} describe/>}{stale && <StaleBadge/>}</div>
            </header>

            {gone && <StateNotice testId="gone-banner" tone="warning" title={D.goneBanner.title} body={D.goneBanner.body}/>}
            {stale && (
                <section data-testid="stale-banner" className={`rounded-xl border p-4 ${warn.panel}`}><h2 className={`font-semibold ${warn.title}`}>{D.staleBanner.title}</h2><p className={`text-sm ${warn.body}`}>{D.staleBanner.body(fmtUtc(view?.capturedAt ?? detail.staleSince, D.notSynced))}</p></section>
            )}
            {detail.inventory.state === "unreadable" && <StateNotice testId="unreadable" tone="warning" title={STACKS_EMPTY.notReadable.title} body={STACKS_EMPTY.notReadable.body}/>}
            {detail.inventory.state === "none" && <StateNotice testId="no-inventory" title={STACKS_EMPTY.noInventory.title} body={STACKS_EMPTY.noInventory.body}/>}

            {view && (
                <Tabs value={tab} onValueChange={onTab}>
                    <TabsList aria-label={D.tabsLabel}>
                        <TabsTrigger value="overview">{D.tabs.overview}</TabsTrigger>
                        <TabsTrigger value="resources">{D.tabs.resources}</TabsTrigger>
                        <TabsTrigger value="configuration">{CONFIG_TAB.tab}</TabsTrigger>
                        <TabsTrigger value="schedule">{SCHEDULE_TAB.tab}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="overview">{protection && configuration && <Overview v={view} p={protection} c={configuration} onOpenConfiguration={() => onTab("configuration")}/>}</TabsContent>
                    <TabsContent value="resources"><ResourcesTabs view={view}/></TabsContent>
                    <TabsContent value="configuration">{configuration && <ConfigTab c={configuration}/>}</TabsContent>
                    <TabsContent value="schedule"><ScheduleTab policy={detail.policy} stackId={detail.id} canConfigure={canConfigure && !configLocked} configureHref={`${STACKS_HREF}/${detail.id}/configure`}/></TabsContent>
                </Tabs>
            )}
        </div>
    );
}
