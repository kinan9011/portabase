import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import type {ItemView} from "@/fork/completeness/view";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {CONFIG_TAB as T, ITEM_KIND_LABELS, REASON_COPY} from "@/fork/ui/labels";
import {ScrollRegion} from "@/fork/ui/stacks/scroll-region";
import {ItemStatusBadge} from "@/fork/ui/stacks/stack-status-badges";

const accounted = (i: ItemView) => !i.gap;

/** Every required resource with status and the reason as inline text (never a tooltip). Actions are visibly disabled with their reason: nothing here changes anything. */
export function CoverageChecklist({items}: {items: ItemView[]}) {
    const L = T.checklist;
    if (items.length === 0) return <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">{L.none}</p>;
    return (
        <div className="flex flex-col gap-2">
            <p className="text-sm font-medium" data-testid="checklist-summary">{L.summary(items.filter(accounted).length, items.length)}</p>
            <ScrollRegion label={L.caption}>
                <Table>
                    <caption className="sr-only">{L.caption}</caption>
                    <TableHeader><TableRow>{[L.columns.resource, L.columns.kind, L.columns.status, L.columns.why].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow></TableHeader>
                    <TableBody>
                        {items.map((i) => (
                            <TableRow key={i.key} data-testid="checklist-row" data-status={i.status}>
                                <TableCell className="max-w-[24rem] whitespace-normal">
                                    <div className="font-mono text-xs break-all font-semibold">{i.name || ITEM_KIND_LABELS[i.kind]}</div>
                                    {i.consumers.length > 0 && <div className="text-muted-foreground text-xs">{i.consumers.join(", ")}</div>}
                                </TableCell>
                                <TableCell>{ITEM_KIND_LABELS[i.kind]}</TableCell>
                                <TableCell><ItemStatusBadge status={i.status}/></TableCell>
                                <TableCell className="min-w-[16rem] max-w-md whitespace-normal">
                                    <p className="text-sm">{REASON_COPY[i.reason]}</p>
                                    {i.gap && i.resolvable && <div className="mt-2"><ReasonButton type="button" variant="outline" size="sm" reason={T.resolve.addSourceReason}>{T.resolve.addSource}</ReasonButton></div>}
                                    {i.gap && !i.resolvable && i.status !== "unsupported" && <div className="mt-2"><ReasonButton type="button" variant="outline" size="sm" reason={T.resolve.acceptReason}>{T.resolve.accept}</ReasonButton></div>}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </ScrollRegion>
        </div>
    );
}
