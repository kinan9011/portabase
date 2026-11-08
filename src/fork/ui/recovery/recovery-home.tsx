import Link from "next/link";
import {PageDescription, PageHeader, PageTitle} from "@/features/layout/components/page";
import type {RestoreRunSummary} from "@/fork/restore-run/view";
import type {RestoreChoice} from "@/fork/restore-wizard/view";
import {FACET_COPY, RP_STATUS_LABELS, RUNTIME_LABELS, type RuntimeStateKey} from "@/fork/ui/labels";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {ToneBadge} from "@/fork/ui/tone-badge";
import {fmtUtc, STACKS_HREF} from "@/fork/ui/stacks/format";
import {RECOVERY, STATE_CHIP, R_ROLE} from "@/fork/ui/recovery/labels";
import {elapsed, orderRuns, relative, toneOf} from "@/fork/ui/recovery/model";

export const LINK_PRIMARY = "bg-primary text-primary-foreground inline-flex h-9 items-center rounded-md px-4 text-sm font-medium";
export const LINK_PLAIN = "text-sm font-medium underline underline-offset-4";

/** Facet text from the SHARED labels (never re-declared: "Not tested" comes from `FACET_COPY`). */
export function FacetLines({c}: {c: Pick<RestoreChoice, "lastGood" | "testRestoreDaysAgo">}) {
    const lg = c.lastGood.hoursAgo === null ? FACET_COPY.lastGood.never : FACET_COPY.lastGood.ago(c.lastGood.hoursAgo);
    const tr = c.testRestoreDaysAgo === null ? FACET_COPY.testRestore.never : FACET_COPY.testRestore.ago(c.testRestoreDaysAgo);
    return (
        <>
            <span>{FACET_COPY.lastGood.label}: {lg}</span>
            <span>{FACET_COPY.testRestore.label} · {tr}</span>
        </>
    );
}

export const runtimeOf = (k: string) => RUNTIME_LABELS[(Object.hasOwn(RUNTIME_LABELS, k) ? k : "unknown") as RuntimeStateKey];

/** Screen R. Server-renderable: links and `aria-disabled` buttons only; the server already decided what this viewer may see. */
export function RecoveryHome({choices, runs, canPlan, locked, lockedText, now}: {choices: RestoreChoice[]; runs: RestoreRunSummary[] | null; canPlan: boolean; locked: boolean; lockedText: string | null; now: Date}) {
    const restorable = choices.filter((c) => c.verifiedCount > 0);
    const rest = choices.filter((c) => c.verifiedCount === 0);
    const startReason = !canPlan ? R_ROLE : locked ? RECOVERY.page.lockedBanner : null;
    const nameOf = new Map(choices.map((c) => [c.stackId, c.name]));
    return (
        <div className="space-y-8">
            <PageHeader><PageTitle>{RECOVERY.page.title}</PageTitle></PageHeader>
            <PageDescription>{RECOVERY.page.intro}</PageDescription>
            {lockedText && <p role="note" data-testid="locked-note" className="rounded-lg border p-3 text-sm">{lockedText}</p>}
            <div>
                {startReason === null
                    ? <Link href="/dashboard/recovery/new" data-testid="recovery-start" className={LINK_PRIMARY}>{RECOVERY.page.start}</Link>
                    : <ReasonButton data-testid="recovery-start" reason={startReason}>{RECOVERY.page.start}</ReasonButton>}
            </div>

            {runs !== null && (
                <section aria-labelledby="restores-h" data-testid="restores">
                    <h2 id="restores-h" className="mb-3 text-lg font-semibold">{RECOVERY.page.restores}</h2>
                    {runs.length === 0 ? <p className="text-muted-foreground text-sm">{RECOVERY.page.noRestores}</p> : (
                        <ul className="divide-y rounded-xl border">
                            {orderRuns(runs).map((r) => {
                                const started = new Date(r.createdAt);
                                return (
                                    <li key={r.id} data-testid="restore-row" className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
                                        <ToneBadge tone={toneOf(r.state)} busy={r.state === "running"}>{STATE_CHIP[r.state as keyof typeof STATE_CHIP] ?? r.state}</ToneBadge>
                                        <span className="font-medium break-words">{nameOf.get(r.stackId) ?? "Removed app"}</span>
                                        <span className="text-muted-foreground">on {r.targetAgentName}</span>
                                        <span className="text-muted-foreground">{RECOVERY.page.startedAt} {relative(started, now)} ({fmtUtc(r.createdAt, "—")})</span>
                                        {r.finishedAt && <span className="text-muted-foreground">{RECOVERY.page.duration} {elapsed(started, new Date(r.finishedAt))}</span>}
                                        <Link href={`/dashboard/recovery/runs/${r.id}`} className={`${LINK_PLAIN} ml-auto`}>{RECOVERY.page.open}<span className="sr-only"> restore of {nameOf.get(r.stackId) ?? "an app"}</span></Link>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            )}

            <section aria-labelledby="apps-h" data-testid="apps">
                <h2 id="apps-h" className="mb-3 text-lg font-semibold">{RECOVERY.page.apps}</h2>
                {choices.length === 0 ? (
                    <p className="text-muted-foreground text-sm">{RECOVERY.page.noStacks} <Link href={STACKS_HREF} className={LINK_PLAIN}>{RECOVERY.page.noStacksLink}</Link></p>
                ) : (
                    <>
                        {restorable.length === 0 && <p data-testid="nothing-verified" className="text-muted-foreground mb-3 text-sm">{RECOVERY.page.nothingVerified}</p>}
                        <ul className="divide-y rounded-xl border">
                            {[...restorable, ...rest].map((c) => {
                                const ok = c.verifiedCount > 0;
                                const reason = !ok ? (c.pendingCount > 0 ? RP_STATUS_LABELS.pending_verification.label : RECOVERY.page.noVerified) : startReason;
                                const rt = runtimeOf(c.runtime);
                                return (
                                    <li key={c.stackId} data-testid="app-row" className="flex flex-wrap items-start gap-x-6 gap-y-2 p-3 text-sm">
                                        <div className="min-w-0 flex-1 space-y-0.5">
                                            <p className="font-medium break-words">{c.name}</p>
                                            <p className="text-muted-foreground">{RECOVERY.page.ranOn(c.environmentName)} · {rt.label}</p>
                                            <p className="text-muted-foreground flex flex-col"><FacetLines c={c}/></p>
                                            {ok && <p className="text-muted-foreground">{RECOVERY.page.verifiedCount(c.verifiedCount)}</p>}
                                        </div>
                                        {reason === null
                                            ? <Link href={`/dashboard/recovery/new?stack=${c.stackId}`} className={LINK_PLAIN}>{RECOVERY.page.restoreApp}<span className="sr-only"> {c.name}</span></Link>
                                            : <ReasonButton variant="outline" size="sm" reason={reason} aria-label={`${RECOVERY.page.restoreApp} ${c.name}`}>{RECOVERY.page.restoreApp}</ReasonButton>}
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
            </section>
        </div>
    );
}
