import Link from "next/link";
import type {ActivityRun, ActivityView} from "@/fork/stacks/activity-view";
import {ACTIVITY, RP_STATUS_LABELS, RUNS} from "@/fork/ui/labels";
import {fmtUtc, stackHref} from "@/fork/ui/stacks/format";
import {runReasonText} from "@/fork/ui/stacks/run-reason";
import {StageAnnouncer} from "@/fork/ui/stacks/activity/stage-announcer.client";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {TONE_MAP, type Tone} from "@/fork/ui/tone";
import {ToneBadge} from "@/fork/ui/tone-badge";

const A = ACTIVITY;
const RUN_TONE: Record<ActivityRun["state"], Tone> = {starting: "active", running: "active", finalizing: "active", succeeded: "neutral", incomplete: "warning", failed: "danger", cancelled: "neutral", skipped: "neutral"};
const STEP_TONE: Record<ActivityRun["steps"][number]["status"], Tone> = {pending: "neutral", running: "active", done: "success", failed: "danger"};
const ITEM_TONE: Record<ActivityRun["items"][number]["state"], Tone> = {queued: "neutral", running: "active", succeeded: "success", failed: "danger", skipped: "neutral"};
const isActive = (r: ActivityRun) => r.state === "starting" || r.state === "running" || r.state === "finalizing";

function Run({run, stackId, limits, open}: {run: ActivityRun; stackId: string; limits: {waitMinutes: number; stallMinutes: number}; open: boolean}) {
    const reason = run.reason ? runReasonText(run.reason, limits) : run.skipReason ? RUNS.skip[run.skipReason] : null;
    return (
        <li data-testid="activity-run" data-state={run.state} data-run-id={run.id}>
            <details open={open} className="rounded-xl border p-3">
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <ToneBadge tone={RUN_TONE[run.state]}>{RUNS.states[run.state]}</ToneBadge>
                    <span>{fmtUtc(run.startedAt, "—")}</span>
                    <span className="text-muted-foreground">{RUNS.when[run.trigger]}</span>
                    {run.rp && <span className="text-muted-foreground">· {A.rp(run.rp.sequence)}: {RP_STATUS_LABELS[run.rp.status].label}</span>}
                </summary>
                <div className="mt-3 flex flex-col gap-3 text-sm">
                    {reason && <p data-testid="activity-reason" className={`rounded-lg border p-2 ${TONE_MAP[run.state === "failed" ? "danger" : "warning"].panel}`}>{reason}</p>}
                    {run.validatorBlocked && <p>{RUNS.blocked}</p>}
                    {run.inventoryRefresh && (run.inventoryRefresh === "failed" || run.inventoryRefresh === "skipped_locked") && <p>{RUNS.refresh[run.inventoryRefresh]}</p>}
                    <div>
                        <h3 className="font-medium">{A.stagesHeading}</h3>
                        <ol className="mt-1 flex flex-col gap-1" data-testid="activity-stages">
                            {run.steps.map((s) => (
                                <li key={s.name} className="flex flex-wrap items-center gap-2" data-step={s.name} data-status={s.status}>
                                    <ToneBadge tone={STEP_TONE[s.status]}>{A.stepStatus[s.status]}</ToneBadge>
                                    <span>{A.stage[s.name]}</span>
                                    <span className="text-muted-foreground text-xs">{s.finishedAt ? fmtUtc(s.finishedAt, "") : s.startedAt ? fmtUtc(s.startedAt, "") : ""}{s.attempts > 1 ? ` · ${A.attempts(s.attempts)}` : ""}</span>
                                    {s.code && <span className="text-xs">{runReasonText(s.code, limits)}</span>}
                                </li>
                            ))}
                            <li className="text-muted-foreground flex items-center gap-2" data-step="verify">{A.verifyStage}</li>
                        </ol>
                    </div>
                    <div>
                        <h3 className="font-medium">{A.itemsHeading}</h3>
                        {run.items.length === 0 ? <p className="text-muted-foreground">{A.noItems}</p> : (
                            <ul className="mt-1 flex flex-col gap-1" data-testid="activity-items">
                                {run.items.map((i) => (
                                    <li key={`${i.source}:${i.dbms}`} className="flex flex-wrap items-center gap-2" data-state={i.state}>
                                        <ToneBadge tone={ITEM_TONE[i.state]}>{A.itemState[i.state]}</ToneBadge>
                                        <span className="font-medium">{i.source}</span>
                                        <span className="text-muted-foreground text-xs">{A.dbms[i.dbms] ?? A.dbmsFallback} · {i.required ? A.required : A.optional}</span>
                                        {i.reason && <span className="text-xs">{runReasonText(i.reason, limits)}</span>}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        <span data-testid="activity-reference">{A.runLabel}: <code>{run.id}</code></span>
                        {run.finishedAt && <span>{A.finished}: {fmtUtc(run.finishedAt, "—")}</span>}
                        {run.rp && <Link href={`${stackHref(stackId, "backups")}&rp=${run.rp.sequence}`} className="font-medium underline underline-offset-4">{A.openBackups}</Link>}
                    </div>
                </div>
            </details>
        </li>
    );
}

/**
 * Activity tab (W13): the durable timeline of runs with their stages and member parts. Everything is read from persisted rows (a reload shows the same),
 * progress arrives by the page's polling (`RunPoller`) and stage changes are announced in the shared status region. Failures show the plain sentence for the
 * reason CODE — never an upstream error text.
 */
export function ActivityTab({stackId, view, limits}: {stackId: string; view: ActivityView | null; limits: {waitMinutes: number; stallMinutes: number}}) {
    if (!view) return <StateNotice testId="activity-error" tone="warning" title="Activity is not available" body="It could not be loaded for this stack."/>;
    const active = view.runs.find(isActive) ?? null;
    const latest = view.runs[0] ?? null;
    return (
        <section aria-labelledby="activity-heading" data-testid="activity-tab" className="flex flex-col gap-3">
            <StageAnnouncer stage={view.activeStage} runId={(active ?? latest)?.id ?? null} finalState={!active && latest ? latest.state : null}/>
            <h2 id="activity-heading" className="text-lg font-semibold">{A.heading}</h2>
            {view.runs.length === 0 ? <StateNotice testId="activity-none" title={A.none.title} body={A.none.body}/> : (
                <>
                    <p className="text-muted-foreground text-sm" data-testid="activity-count">{A.count(view.runs.length, view.total)}</p>
                    <ol className="flex flex-col gap-2">{view.runs.map((r, i) => <Run key={r.id} run={r} stackId={stackId} limits={limits} open={i === 0 || isActive(r)}/>)}</ol>
                </>
            )}
        </section>
    );
}
