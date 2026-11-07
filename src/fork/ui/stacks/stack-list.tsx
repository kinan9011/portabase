import Link from "next/link";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import type {StackList, StackListItem} from "@/fork/stacks/dto";
import {isFiltered, toQueryString, type StackListParams} from "@/fork/stacks/params";
import {ENVIRONMENT_COPY, STACKS_EMPTY, STACKS_PAGE, STALE_BANNER} from "@/fork/ui/labels";
import {fmtUtc, STACKS_HREF, stackHref} from "@/fork/ui/stacks/format";
import {FilteredEmpty, StacksEmpty} from "@/fork/ui/stacks/stack-empty-states";
import {ScrollRegion} from "@/fork/ui/stacks/scroll-region";
import {StackFilters} from "@/fork/ui/stacks/stack-filters";
import {ProtectionBadge, RuntimeBadge, StaleBadge} from "@/fork/ui/stacks/stack-status-badges";
import {SyncPoller} from "@/fork/ui/stacks/sync-poller";
import {TONE_MAP} from "@/fork/ui/tone";
import {ToneIcon} from "@/fork/ui/tone-badge";

const U = STACKS_PAGE.resourceUnits;

function Resources({item}: {item: StackListItem}) {
    const c = item.inventory?.counts;
    if (!c) return <span className="text-muted-foreground text-xs">{STACKS_EMPTY.noInventory.title}</span>;
    const chips: [number, string][] = [[c.services, U.services], [c.volumes, U.volumes], [c.binds, U.binds], [c.networks, U.networks], [c.databases, U.databases]];
    return (
        <ul className="flex max-w-60 flex-wrap gap-1" aria-label="Resources">
            {chips.filter(([n]) => n > 0).map(([n, label]) => <li key={label} className="bg-muted rounded-md px-1.5 py-0.5 text-xs"><b className="font-semibold">{n}</b> {label}</li>)}
            {c.shared > 0 && <li className="rounded-md border px-1.5 py-0.5 text-xs font-medium">{STACKS_PAGE.sharedFlag(c.shared)}</li>}
        </ul>
    );
}

function Pager({list, params}: {list: StackList; params: StackListParams}) {
    const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
    const from = list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1;
    const to = Math.min(list.total, list.page * list.pageSize);
    const link = "rounded-md border px-3 py-1.5 text-sm font-medium";
    return (
        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm" data-testid="results-count">{list.total === 0 ? STACKS_PAGE.resultsNone : STACKS_PAGE.results(from, to, list.total)}</p>
            {pages > 1 && (
                <div className="flex gap-2">
                    {list.page > 1 ? <Link rel="prev" className={link} href={`${STACKS_HREF}${toQueryString({...params, page: list.page - 1})}`}>{STACKS_PAGE.previous}</Link> : <span aria-disabled="true" className={`${link} opacity-50`}>{STACKS_PAGE.previous}</span>}
                    {list.page < pages ? <Link rel="next" className={link} href={`${STACKS_HREF}${toQueryString({...params, page: list.page + 1})}`}>{STACKS_PAGE.next}</Link> : <span aria-disabled="true" className={`${link} opacity-50`}>{STACKS_PAGE.next}</span>}
                </div>
            )}
        </nav>
    );
}

export function StackListView({list, params, isAdmin}: {list: StackList; params: StackListParams; isAdmin: boolean}) {
    const filtered = isFiltered(params);
    const noData = list.summary.total === 0;
    const emptyKind = !list.setup.connected ? "noConnection" : list.setup.enabledEnvironments === 0 ? "noEnabledEnvironment" : "noStacks";
    const staleTone = TONE_MAP.warning;
    return (
        <div className="flex flex-col gap-5">
            <SyncPoller active={list.syncing}/>
            {(list.summary.staleOrGone > 0 || list.circuitOpen) && (
                <section data-testid="stale-banner" aria-labelledby="stale-title" className={`flex items-start gap-3 rounded-lg border p-4 ${staleTone.panel}`}>
                    <ToneIcon tone="warning" className="mt-0.5 size-4"/>
                    <div className="flex-1 text-sm">
                        <h2 id="stale-title" className={`font-semibold ${staleTone.title}`}>{STALE_BANNER.title}</h2>
                        <p className={staleTone.body}>{list.summary.staleOrGone > 0 ? STALE_BANNER.body(list.summary.staleOrGone) : ""} {list.circuitOpen ? STALE_BANNER.circuit : ""}</p>
                    </div>
                    {isAdmin && <Link href="/dashboard/integrations" className={`text-sm font-semibold underline underline-offset-4 ${staleTone.title}`}>{STALE_BANNER.link}</Link>}
                </section>
            )}

            {noData ? <StacksEmpty kind={emptyKind} isAdmin={isAdmin}/> : (
                <>
                    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="summary">
                        {[[STACKS_PAGE.foundTile, list.summary.total], [STACKS_PAGE.unprotectedTile, list.summary.unprotected], [STACKS_PAGE.staleTile, list.summary.staleOrGone]].map(([label, n]) => (
                            <div key={label as string} className="rounded-xl border px-4 py-3"><dt className="text-muted-foreground text-xs">{label}</dt><dd className="text-2xl font-bold">{n}</dd></div>
                        ))}
                    </dl>
                    <StackFilters params={params} environments={list.environments}/>
                    {list.items.length === 0 ? <FilteredEmpty clearHref={STACKS_HREF}/> : (
                        <ScrollRegion label="Stacks table, scrolls sideways on narrow screens">
                            <Table>
                                <caption className="sr-only">{STACKS_PAGE.tableCaption}</caption>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead scope="col">{STACKS_PAGE.columns.stack}</TableHead><TableHead scope="col">{STACKS_PAGE.columns.environment}</TableHead><TableHead scope="col">{STACKS_PAGE.columns.runtime}</TableHead>
                                        <TableHead scope="col">{STACKS_PAGE.columns.resources}</TableHead><TableHead scope="col">{STACKS_PAGE.columns.protection}</TableHead><TableHead scope="col">{STACKS_PAGE.columns.latestRp}</TableHead>
                                        <TableHead scope="col">{STACKS_PAGE.columns.seen}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {list.items.map((s) => (
                                        <TableRow key={s.id} data-testid="stack-row">
                                            <TableCell>
                                                <Link href={stackHref(s.id)} className="font-semibold underline-offset-4 hover:underline">{s.name}<span className="sr-only"> ({STACKS_PAGE.open})</span></Link>
                                                {s.name !== s.composeProject && <div className="text-muted-foreground font-mono text-xs">{s.composeProject}</div>}
                                            </TableCell>
                                            <TableCell>{s.environmentName}</TableCell>
                                            <TableCell><div className="flex flex-col items-start gap-1"><RuntimeBadge state={s.runtime}/>{s.staleSince && s.runtime !== "absent" && <StaleBadge/>}</div></TableCell>
                                            <TableCell><Resources item={s}/></TableCell>
                                            <TableCell><ProtectionBadge state={s.protection}/></TableCell>
                                            <TableCell className="text-muted-foreground">{STACKS_PAGE.noRecoveryPoint}</TableCell>
                                            <TableCell className="whitespace-nowrap text-xs">{s.inventory ? fmtUtc(s.inventory.capturedAt, ENVIRONMENT_COPY.notSynced) : ENVIRONMENT_COPY.notSynced}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </ScrollRegion>
                    )}
                    <Pager list={list} params={params}/>
                    <p className="text-muted-foreground text-xs">{STACKS_PAGE.sourceNote}</p>
                </>
            )}
        </div>
    );
}
