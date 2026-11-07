import type {ProtectionView} from "@/fork/completeness/view";
import {FACET_COPY as F} from "@/fork/ui/labels";
import {ToneBadge} from "@/fork/ui/tone-badge";

/** One row = label, value, inline description (§8.2: never hover-only). Facet 1 is the first line of the page's protection block. */
function Row({label, value, description, tone, testId}: {label: string; value: React.ReactNode; description: string; tone?: "warning" | "neutral"; testId: string}) {
    return (
        <li className="flex flex-col gap-0.5" data-testid={testId}>
            <span className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">{label}:</span>{tone ? <ToneBadge tone={tone}>{value}</ToneBadge> : <span className="font-medium">{value}</span>}</span>
            <span className="text-muted-foreground max-w-prose text-xs">{description}</span>
        </li>
    );
}

/** First line of the protection block: facet 1 only, above any badge (§4.6). */
export function LastGoodBackupLine({p}: {p: ProtectionView}) {
    const f = p.facets.lastGoodBackup;
    return (
        <p className="text-sm" data-testid="facet-last-good">
            <span className="text-muted-foreground">{F.lastGood.label}: </span>
            <span className="font-semibold">{f.hoursAgo === null ? F.lastGood.never : F.lastGood.ago(f.hoursAgo)}</span>
            {f.verifying && <span className="text-muted-foreground block text-xs" data-testid="facet-verifying">{F.lastGood.verifying}</span>}
        </p>
    );
}

export function FacetsPanel({p}: {p: ProtectionView}) {
    const f = p.facets;
    return (
        <section aria-labelledby="facets-h" className="flex flex-col gap-3" data-testid="facets">
            <h2 id="facets-h" className="text-lg font-semibold">{F.heading}</h2>
            <ul className="flex flex-col gap-3">
                <Row testId="facet-test-restore" label={F.testRestore.label} value={f.testRestore.daysAgo === null ? F.testRestore.never : F.testRestore.ago(f.testRestore.daysAgo)} description={F.testRestore.description}/>
                <Row testId="facet-deletable" label={F.deletable.label} value={F.deletable.values[f.deletable]} description={F.deletable.description[f.deletable]} tone={f.deletable === "no" ? undefined : "warning"}/>
                {f.hostCompromise && <Row testId="facet-host-compromise" label={F.hostCompromise.label} value={F.needsAttention} description={F.hostCompromise.description} tone="warning"/>}
                <li className="flex flex-col gap-1" data-testid="facet-consistency">
                    <span className="text-muted-foreground text-sm">{F.consistency.label}:</span>
                    {f.consistency.length === 0 ? <span className="text-muted-foreground text-xs">{F.consistency.none}</span> : (
                        <ul className="flex flex-col gap-0.5 text-sm">{f.consistency.map((c) => <li key={`${c.member}:${c.level}`}><span className="font-mono text-xs">{c.member}</span>: {F.consistency.values[c.level]}</li>)}</ul>
                    )}
                </li>
                {f.pausedAfterReauthorization && <Row testId="facet-paused" label={F.paused.label} value={F.yes} description={F.paused.description} tone="warning"/>}
                {f.inventoryStale && <Row testId="facet-inventory-stale" label={F.inventoryStale.label} value={F.yes} description={F.inventoryStale.description} tone="warning"/>}
                {f.configLocked && <Row testId="facet-config-locked" label={F.configLocked.label} value={F.yes} description={F.configLocked.description} tone="warning"/>}
            </ul>
        </section>
    );
}
