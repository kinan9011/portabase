"use client";

import * as React from "react";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs";
import type {InventoryView} from "@/fork/stacks/dto";
import {STACK_DETAILS} from "@/fork/ui/labels";
import {fmtBytes, fmtPort} from "@/fork/ui/stacks/format";
import {ScrollRegion} from "@/fork/ui/stacks/scroll-region";
import {ServiceStateBadge} from "@/fork/ui/stacks/stack-status-badges";
import {ToneBadge} from "@/fork/ui/tone-badge";

const R = STACK_DETAILS.resources;
const C = R.columns;
type Key = keyof typeof R.sections;

const Scroll = ScrollRegion;
const Empty = ({text}: {text: string}) => <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">{text}</p>;
const Chips = ({items}: {items: string[]}) => (items.length ? <ul className="flex flex-wrap gap-1">{items.map((i) => <li key={i} className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{i}</li>)}</ul> : <span className="text-muted-foreground">—</span>);
const Shared = () => <ToneBadge tone="warning">{R.sharedMarker}</ToneBadge>;

function Services({v}: {v: InventoryView}) {
    if (!v.services.length) return <Empty text={R.empty.services}/>;
    return (
        <Scroll label={R.sections.services}>
            <Table>
                <caption className="sr-only">{R.sections.services}</caption>
                <TableHeader><TableRow>{[C.service, C.image, C.state, C.ports, C.networks, C.mounts].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                <TableBody>
                    {v.services.map((s) => (
                        <TableRow key={s.name} data-testid="service-row">
                            <TableCell><div className="font-semibold">{s.name}</div>{s.privileged && <div className="text-xs">{R.privileged}</div>}{s.envCount > 0 && <div className="text-muted-foreground text-xs">{R.envNote(s.envCount)}</div>}</TableCell>
                            <TableCell><div className="font-mono text-xs break-all">{s.image.ref}</div><div className="text-muted-foreground text-xs">{s.image.pinned ? R.imagePinned : R.imageUnpinned}{s.image.builtLocally ? ` · ${R.builtLocally}` : ""}</div></TableCell>
                            <TableCell><ServiceStateBadge state={s.state}/></TableCell>
                            <TableCell>{s.ports.length ? <ul>{s.ports.map((p) => <li key={fmtPort(p)} className="font-mono text-xs">{fmtPort(p)}</li>)}</ul> : <span className="text-muted-foreground">—</span>}</TableCell>
                            <TableCell><Chips items={s.networks}/></TableCell>
                            <TableCell>{s.mountCount}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </Scroll>
    );
}

function Volumes({v}: {v: InventoryView}) {
    if (!v.volumes.length && !v.anonymousVolumes.length) return <Empty text={R.empty.volumes}/>;
    return (
        <div className="flex flex-col gap-4">
            {v.volumes.length > 0 && (
                <Scroll label={R.sections.volumes}>
                    <Table>
                        <caption className="sr-only">{R.sections.volumes}</caption>
                        <TableHeader><TableRow>{[C.volume, C.driver, C.usedBy, C.ownership].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                        <TableBody>
                            {v.volumes.map((x) => (
                                <TableRow key={x.name} data-testid="volume-row">
                                    <TableCell><div className="font-mono text-xs break-all font-semibold">{x.name}</div>{fmtBytes(x.sizeBytes) && <div className="text-muted-foreground text-xs">{fmtBytes(x.sizeBytes)}</div>}</TableCell>
                                    <TableCell>{x.driver}</TableCell>
                                    <TableCell><Chips items={x.usedBy}/></TableCell>
                                    <TableCell><span className="inline-flex items-center gap-2">{R.ownership[x.ownership]}{x.ownership === "external_shared" && <Shared/>}</span></TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </Scroll>
            )}
            {v.anonymousVolumes.length > 0 && (
                <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium">{R.anonymousWarning}</p>
                    <Scroll label="Anonymous volumes">
                        <Table>
                            <caption className="sr-only">Anonymous volumes</caption>
                            <TableHeader><TableRow>{[C.destination, C.consumers, C.access].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                            <TableBody>
                                {v.anonymousVolumes.map((a) => <TableRow key={a.destination} data-testid="anonymous-row"><TableCell className="font-mono text-xs">{a.destination}</TableCell><TableCell><Chips items={a.consumers}/></TableCell><TableCell>{R.rw[String(a.rw) as "true" | "false"]}</TableCell></TableRow>)}
                            </TableBody>
                        </Table>
                    </Scroll>
                </div>
            )}
        </div>
    );
}

function Binds({v}: {v: InventoryView}) {
    if (!v.binds.length) return <Empty text={R.empty.binds}/>;
    return (
        <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">{R.bindNote}</p>
            <Scroll label={R.sections.binds}>
                <Table>
                    <caption className="sr-only">{R.sections.binds}</caption>
                    <TableHeader><TableRow>{[C.hostPath, C.destination, C.access, C.consumers].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                    <TableBody>
                        {v.binds.map((b) => (
                            <TableRow key={`${b.destination}|${b.hostPath}`} data-testid="bind-row">
                                <TableCell className="font-mono text-xs break-all">{b.hostPath ?? "—"}</TableCell>
                                <TableCell className="font-mono text-xs break-all">{b.destination}</TableCell>
                                <TableCell>{R.rw[String(b.rw) as "true" | "false"]}</TableCell>
                                <TableCell><Chips items={b.consumers}/></TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Scroll>
        </div>
    );
}

function Databases({v}: {v: InventoryView}) {
    if (!v.databases.length) return <Empty text={R.empty.databases}/>;
    return (
        <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">{R.dbNote}</p>
            <Scroll label={R.sections.databases}>
                <Table>
                    <caption className="sr-only">{R.sections.databases}</caption>
                    <TableHeader><TableRow>{[C.service, C.engine, C.basis].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                    <TableBody>{v.databases.map((d) => <TableRow key={d.service} data-testid="database-row"><TableCell className="font-semibold">{d.service}</TableCell><TableCell>{d.engine}</TableCell><TableCell>{R.dbBasis[d.basis]}</TableCell></TableRow>)}</TableBody>
                </Table>
            </Scroll>
        </div>
    );
}

function Networks({v}: {v: InventoryView}) {
    if (!v.networks.length) return <Empty text={R.empty.networks}/>;
    return (
        <Scroll label={R.sections.networks}>
            <Table>
                <caption className="sr-only">{R.sections.networks}</caption>
                <TableHeader><TableRow>{[C.network, C.kind, C.members, C.flags].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                <TableBody>
                    {v.networks.map((n) => {
                        const shared = n.classification === "shared_external" || n.external;
                        return (
                            <TableRow key={n.name} data-testid="network-row" data-shared={shared || undefined}>
                                <TableCell className="font-mono text-xs break-all font-semibold">{n.name}</TableCell>
                                <TableCell>{n.classification ? R.classification[n.classification] : "—"} · {n.driver}</TableCell>
                                <TableCell><Chips items={n.members}/></TableCell>
                                <TableCell><span className="flex flex-wrap gap-1">{shared && <Shared/>}{n.external && <ToneBadge tone="neutral">{R.externalMarker}</ToneBadge>}{n.internal && <ToneBadge tone="neutral">{R.internalNetwork}</ToneBadge>}</span></TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </Scroll>
    );
}

const PANELS: Record<Key, (p: {v: InventoryView}) => React.ReactNode> = {services: Services, volumes: Volumes, binds: Binds, databases: Databases, networks: Networks};
const COUNT: Record<Key, (v: InventoryView) => number> = {
    services: (v) => v.services.length, volumes: (v) => v.volumes.length + v.anonymousVolumes.length, binds: (v) => v.binds.length, databases: (v) => v.databases.length, networks: (v) => v.networks.length,
};

/** Resources of one stack: five Radix sub-tabs (services / named volumes / bind mounts / databases / networks), shared and external resources marked, agent-side-access note always visible. */
export function ResourcesTabs({view}: {view: InventoryView}) {
    return (
        <section aria-labelledby="resources-heading" className="flex flex-col gap-3">
            <h2 id="resources-heading" className="text-lg font-semibold">{R.heading}</h2>
            <p className="text-muted-foreground text-sm" data-testid="agent-note">{R.agentNote}</p>
            <Tabs defaultValue="services">
                <div className="max-w-full overflow-x-auto"><TabsList aria-label={R.tabsLabel}>
                    {(Object.keys(R.sections) as Key[]).map((k) => <TabsTrigger key={k} value={k}>{R.sections[k]} <span className="ml-1 tabular-nums">({COUNT[k](view)})</span></TabsTrigger>)}
                </TabsList></div>
                {(Object.keys(R.sections) as Key[]).map((k) => { const P = PANELS[k]; return <TabsContent key={k} value={k}><P v={view}/></TabsContent>; })}
            </Tabs>
        </section>
    );
}
