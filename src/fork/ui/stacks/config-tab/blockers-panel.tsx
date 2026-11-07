import type {ConfigurationView, ProtectionView} from "@/fork/completeness/view";
import {BLOCKERS_PANEL as B, ITEM_KIND_LABELS, REASON_COPY} from "@/fork/ui/labels";
import {ItemStatusBadge} from "@/fork/ui/stacks/stack-status-badges";

const SHOWN = 5;

/** Overview panel (W09): replaces the W08 placeholder. States the consequence in plain words and lists the blockers with their reason, inline. */
export function BlockersPanel({p, c, onOpenConfiguration}: {p: ProtectionView; c: ConfigurationView; onOpenConfiguration: () => void}) {
    const blockers = c.items.filter((i) => i.gap && i.severity === "blocker");
    const shown = blockers.slice(0, SHOWN);
    return (
        <section aria-labelledby="ov-blockers" className="rounded-xl border p-4" data-testid="blockers-panel">
            <h2 id="ov-blockers" className="font-semibold">{B.heading}</h2>
            {!p.complete && <p className="mt-1 font-medium" data-testid="recovery-unavailable">{B.unavailable}</p>}
            <p className="text-muted-foreground mt-1 text-sm" data-testid="blockers">
                {blockers.length === 0 ? (p.complete ? B.none : B.noneNotComplete) : B.summary(blockers.length, p.counts.gaps)}
            </p>
            {shown.length > 0 && (
                <ul className="mt-3 flex flex-col gap-3" data-testid="blocker-list">
                    {shown.map((i) => (
                        <li key={i.key} className="flex flex-col gap-1" data-testid="blocker-item">
                            <span className="flex flex-wrap items-center gap-2 text-sm"><ItemStatusBadge status={i.status}/><span className="text-muted-foreground">{ITEM_KIND_LABELS[i.kind]}</span>{i.name && <span className="font-mono text-xs break-all">{i.name}</span>}</span>
                            <span className="text-muted-foreground text-xs">{REASON_COPY[i.reason]}</span>
                        </li>
                    ))}
                </ul>
            )}
            {blockers.length > SHOWN && <p className="text-muted-foreground mt-2 text-sm">{B.more(blockers.length - SHOWN)}</p>}
            <button type="button" onClick={onOpenConfiguration} className="mt-3 text-sm underline underline-offset-4">{B.viewAll}</button>
        </section>
    );
}
