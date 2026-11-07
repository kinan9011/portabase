import type {RunView} from "@/fork/runs/view";
import {RP_STATUS_LABELS, RUNS} from "@/fork/ui/labels";
import {CancelRunButton} from "@/fork/ui/stacks/run-controls.client";
import {fmtUtc} from "@/fork/ui/stacks/format";
import {RpStatusBadge} from "@/fork/ui/stacks/stack-status-badges";
import {TONE_MAP} from "@/fork/ui/tone";

/** Latest run + paused notice for the Schedule tab. Codes → plain sentences (`RUNS`); the recovery-point label is "Backed up · verifying" until W14 verifies (D43). */
export function RunPanel({runs, canRun}: {runs: RunView | null; canRun: boolean}) {
    if (!runs) return null;
    const l = runs.latest;
    const reasonText = l?.reason ? (RUNS.reasons[l.reason] as (n: number) => string)(l.reason === "agent_made_no_progress" ? runs.limits.stallMinutes : runs.limits.waitMinutes) : null;
    return (
        <section aria-labelledby="run-heading" data-testid="run-panel" className="flex flex-col gap-3">
            {runs.paused && (
                <div role="note" data-testid="paused-notice" className={`rounded-lg border p-3 text-sm ${TONE_MAP.warning.panel}`}>
                    <p className="font-medium">{RUNS.paused.title}</p>
                    <p>{RUNS.paused.reasons[runs.paused.reason]}</p>
                    <p>{RUNS.paused.fix}</p>
                </div>
            )}
            <h2 id="run-heading" className="text-lg font-semibold">{RUNS.heading}</h2>
            {!l ? <p className="text-muted-foreground text-sm" data-testid="run-none">{RUNS.none}</p> : (
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]" data-testid="run-latest" data-state={l.state}>
                    <dt className="text-muted-foreground">State</dt><dd data-testid="run-state">{RUNS.states[l.state]}</dd>
                    <dt className="text-muted-foreground">Started</dt><dd>{fmtUtc(l.startedAt, "—")} · {RUNS.when[l.trigger]}</dd>
                    {l.finishedAt && <><dt className="text-muted-foreground">Finished</dt><dd>{fmtUtc(l.finishedAt, "—")}</dd></>}
                    {l.skipReason && <><dt className="text-muted-foreground">Why</dt><dd>{RUNS.skip[l.skipReason]}</dd></>}
                    {reasonText && <><dt className="text-muted-foreground">Why</dt><dd data-testid="run-reason">{reasonText}</dd></>}
                    {l.validatorBlocked && <><dt className="text-muted-foreground">Coverage</dt><dd>{RUNS.blocked}</dd></>}
                    {l.inventoryRefresh && (l.inventoryRefresh === "failed" || l.inventoryRefresh === "skipped_locked") && <><dt className="text-muted-foreground">Inventory</dt><dd>{RUNS.refresh[l.inventoryRefresh]}</dd></>}
                    {l.rp && <><dt className="text-muted-foreground">{RUNS.rp.label}</dt><dd className="flex flex-wrap items-center gap-2"><RpStatusBadge status={l.rp.status}/><span className="text-muted-foreground">#{l.rp.sequence} · {RP_STATUS_LABELS[l.rp.status].description}</span></dd></>}
                </dl>
            )}
            {runs.active && canRun && <div><CancelRunButton runId={runs.active.id}/></div>}
        </section>
    );
}
