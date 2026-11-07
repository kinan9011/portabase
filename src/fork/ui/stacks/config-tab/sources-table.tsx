import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import type {SourceView} from "@/fork/completeness/view";
import {SOURCES_COPY as S} from "@/fork/ui/labels";
import {ScrollRegion} from "@/fork/ui/stacks/scroll-region";
import {ToneBadge} from "@/fork/ui/tone-badge";

/**
 * "Managed by this stack" (D30). READ-ONLY: member name, what it covers, status (with the reason inline, never hover-only) and the last agent
 * check. No configuration, path or credential is part of the view; creating/removing sources is a server action with its own ACL (W11 UI).
 */
export function SourcesTable({sources}: {sources: readonly SourceView[]}) {
    return (
        <section aria-labelledby="cfg-src" className="flex flex-col gap-2" data-testid="config-sources">
            <h2 id="cfg-src" className="text-lg font-semibold">{S.heading}</h2>
            <p className="text-muted-foreground max-w-prose text-xs">{S.note}</p>
            {sources.length === 0 ? <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">{S.none}</p> : (
                <ScrollRegion label={S.caption}>
                    <Table>
                        <caption className="sr-only">{S.caption}</caption>
                        <TableHeader><TableRow>{Object.values(S.columns).map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                        <TableBody>
                            {sources.map((x, i) => {
                                const st = S.status[x.status];
                                const id = `src-why-${i}`;
                                return (
                                    <TableRow key={`${x.name}-${i}`} data-testid="source-row">
                                        <TableCell className="max-w-[24rem] whitespace-normal font-mono text-xs font-semibold break-all">{x.name}</TableCell>
                                        <TableCell>{S.role[x.role]}{S.origin[x.origin]}</TableCell>
                                        <TableCell className="whitespace-normal">
                                            <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
                                            <p id={id} className="text-muted-foreground mt-1 max-w-xs text-xs">{x.reason ? S.reason[x.reason] : st.description}</p>
                                        </TableCell>
                                        <TableCell className="text-xs">{S.probe[x.probe ?? "none"]}</TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </ScrollRegion>
            )}
        </section>
    );
}
