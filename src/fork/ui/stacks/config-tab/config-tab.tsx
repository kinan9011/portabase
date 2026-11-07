import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import type {ConfigurationView} from "@/fork/completeness/view";
import {CONFIG_TAB as T, DIRECTIVE_COPY} from "@/fork/ui/labels";
import {CoverageChecklist} from "@/fork/ui/stacks/config-tab/coverage-checklist";
import {SourcesTable} from "@/fork/ui/stacks/config-tab/sources-table";
import {ScrollRegion} from "@/fork/ui/stacks/scroll-region";
import {ItemStatusBadge} from "@/fork/ui/stacks/stack-status-badges";

/**
 * Configuration tab (W09). READ-ONLY: names, paths (hints), statuses, reasons and hashes. No file content, no variable value,
 * no download control and no mutation exists on this tab; the two resolve actions are disabled with a visible reason.
 */
export function ConfigTab({c}: {c: ConfigurationView}) {
    const files = c.items.filter((i) => i.kind === "compose_file" || i.kind === "env_file");
    return (
        <div className="flex flex-col gap-8" data-testid="config-tab">
            <p className="text-muted-foreground max-w-prose text-sm">{T.intro}</p>

            <section aria-labelledby="cfg-files" className="flex flex-col gap-2" data-testid="config-files">
                <h2 id="cfg-files" className="text-lg font-semibold">{T.files.heading}</h2>
                <p className="text-muted-foreground max-w-prose text-xs">{T.files.placementNote}</p>
                {files.length === 0 ? <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">{T.files.none}</p> : (
                    <ScrollRegion label={T.files.caption}>
                        <Table>
                            <caption className="sr-only">{T.files.caption}</caption>
                            <TableHeader><TableRow>{[T.files.columns.file, T.files.columns.placement, T.files.columns.status, T.files.columns.hash].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                            <TableBody>
                                {files.map((f) => (
                                    <TableRow key={f.key} data-testid="file-row">
                                        <TableCell className="max-w-[28rem] whitespace-normal"><div className="font-mono text-xs break-all font-semibold">{f.name || "—"}</div>{f.consumers.length > 0 && <div className="text-muted-foreground text-xs">{f.consumers.join(", ")}</div>}</TableCell>
                                        <TableCell>{f.placement ? T.files.placement[f.placement] : "—"}</TableCell>
                                        <TableCell><ItemStatusBadge status={f.status}/></TableCell>
                                        <TableCell className="text-muted-foreground text-xs whitespace-normal">{T.files.hashNone}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </ScrollRegion>
                )}
            </section>

            <section aria-labelledby="cfg-env" className="flex flex-col gap-2" data-testid="config-env">
                <h2 id="cfg-env" className="text-lg font-semibold">{T.env.heading}</h2>
                <p className="text-muted-foreground max-w-prose text-xs">{T.env.note}</p>
                {c.composeRead === "none" ? <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">{T.env.undetermined}</p>
                    : c.envNames.length === 0 ? <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">{T.env.none}</p> : (
                        <ScrollRegion label={T.env.caption}>
                            <Table>
                                <caption className="sr-only">{T.env.caption}</caption>
                                <TableHeader><TableRow>{[T.env.columns.service, T.env.columns.names, T.env.columns.value].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                                <TableBody>
                                    {c.envNames.map((e) => (
                                        <TableRow key={e.service} data-testid="env-row">
                                            <TableCell className="font-semibold">{e.service}</TableCell>
                                            <TableCell><ul className="flex flex-wrap gap-1">{e.names.map((n) => <li key={n} className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{n}</li>)}</ul>{e.more > 0 && <p className="text-muted-foreground mt-1 text-xs">{T.env.more(e.more)}</p>}</TableCell>
                                            <TableCell className="text-muted-foreground text-xs" data-testid="env-masked">{T.env.masked}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </ScrollRegion>
                    )}
            </section>

            <section aria-labelledby="cfg-cov" className="flex flex-col gap-2" data-testid="config-coverage">
                <h2 id="cfg-cov" className="text-lg font-semibold">{T.checklist.heading}</h2>
                <p className="text-muted-foreground max-w-prose text-xs">{T.resolve.help}</p>
                <CoverageChecklist items={c.items}/>
            </section>

            <SourcesTable sources={c.sources}/>

            <section aria-labelledby="cfg-dir" className="flex flex-col gap-2" data-testid="config-directives">
                <h2 id="cfg-dir" className="text-lg font-semibold">{T.directives.heading}</h2>
                <p className="text-muted-foreground max-w-prose text-xs">{T.directives.note}</p>
                {c.directives.length === 0 ? <p className="text-muted-foreground text-sm">{T.directives.none}</p> : (
                    <ul className="flex flex-col gap-2">{c.directives.map((d) => <li key={`${d.code}:${d.service}:${d.detail}`} className="text-sm"><span className="font-semibold">{d.service ?? "—"}</span>{d.detail && <span className="text-muted-foreground font-mono text-xs"> {d.detail}</span>}: {DIRECTIVE_COPY[d.code]}</li>)}</ul>
                )}
            </section>

            <section aria-labelledby="cfg-net" className="flex flex-col gap-2" data-testid="config-networks">
                <h2 id="cfg-net" className="text-lg font-semibold">{T.networks.heading}</h2>
                <ScrollRegion label={T.networks.caption}>
                    <Table>
                        <caption className="sr-only">{T.networks.caption}</caption>
                        <TableHeader><TableRow>{[T.networks.columns.network, T.networks.columns.ownership, T.networks.columns.subnets].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                        <TableBody>
                            {c.networks.map((n) => <TableRow key={n.name}><TableCell className="font-mono text-xs">{n.name}</TableCell><TableCell>{T.networks.ownership[n.ownership]}</TableCell><TableCell className="font-mono text-xs">{n.subnets.length ? n.subnets.join(", ") : T.networks.noSubnets}</TableCell></TableRow>)}
                        </TableBody>
                    </Table>
                </ScrollRegion>
            </section>

            <section aria-labelledby="cfg-hash" className="flex flex-col gap-1">
                <h2 id="cfg-hash" className="text-lg font-semibold">{T.hash.heading}</h2>
                <p className="text-sm"><span className="text-muted-foreground">{T.hash.label}: </span><span className="font-mono text-xs break-all" data-testid="inventory-hash">{c.inventoryHash ?? "—"}</span></p>
                <p className="text-muted-foreground max-w-prose text-xs">{T.hash.note}</p>
            </section>

            <p className="text-muted-foreground text-xs" data-testid="read-only-note">{T.readOnly}</p>
        </div>
    );
}
