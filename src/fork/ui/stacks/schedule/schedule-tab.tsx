import * as React from "react";
import Link from "next/link";
import type {PolicyView} from "@/fork/stack-policy/policy-schema";
import {SCHEDULE_PRESETS, type SchedulePreset} from "@/fork/schedule/schedule";
import {CONFIGURE, SCHEDULE_EDIT, SCHEDULE_TAB} from "@/fork/ui/labels";
import {fmtUtc} from "@/fork/ui/stacks/format";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import type {RunView} from "@/fork/runs/view";
import {RunPanel} from "@/fork/ui/stacks/schedule/run-panel";
import {ScheduleEditor} from "@/fork/ui/stacks/schedule/schedule-edit.client";

const T = SCHEDULE_TAB;
const when = (iso: string, tz: string) => { try { return new Intl.DateTimeFormat("en-GB", {timeZone: tz, dateStyle: "medium", timeStyle: "short"}).format(new Date(iso)); } catch { return iso; } };
const presetLabel = (p: SchedulePreset) => CONFIGURE.schedule.presets[SCHEDULE_PRESETS.includes(p) ? p : "cron"];

/** The ACTIVATED policy, its editor (system admin only, locked with a visible reason, W13) and the latest run (W12). Names, settings, states and plain reasons only. */
export function ScheduleTab({policy, stackId, canConfigure, configureHref, runs = null, canRun = false, isAdmin = canConfigure, configLocked = false}: {policy: PolicyView | null; stackId: string; canConfigure: boolean; configureHref: string; runs?: RunView | null; canRun?: boolean; isAdmin?: boolean; configLocked?: boolean}) {
    if (!policy) {
        return (
            <section aria-labelledby="schedule-none" data-testid="schedule-tab" data-state="none" className="flex flex-col gap-3">
                <StateNotice testId="schedule-none-notice" title={T.none.title} body={T.none.body}/>
                {canConfigure && <Link href={configureHref} className="bg-primary text-primary-foreground inline-flex h-9 w-fit items-center rounded-md px-4 text-sm font-medium">{T.configure}</Link>}
            </section>
        );
    }
    const rows: [string, React.ReactNode][] = [
        [T.rows.activated, when(policy.activatedAt, "UTC") + " UTC"],
        [T.rows.schedule, `${presetLabel(policy.schedule.preset)} (${policy.cron})`],
        [T.rows.timezone, policy.schedule.timezone],
        [T.rows.next, <ul key="n">{policy.nextRuns.map((r) => <li key={r}>{when(r, policy.schedule.timezone)} <span className="text-muted-foreground">({fmtUtc(r, "")})</span></li>)}</ul>],
        [T.rows.retention, T.retention(policy.retention)],
        [T.rows.channels, <ul key="c">{policy.channels.map((c) => <li key={c.name}>{c.name} ({c.provider}){c.local ? ` — ${T.local}` : ""}</li>)}</ul>],
        [T.rows.sources, String(policy.sourceCount)],
        [T.rows.consistency, T.consistency[policy.consistency]],
    ];
    return (
        <section aria-labelledby="schedule-heading" data-testid="schedule-tab" data-state="active" className="flex flex-col gap-3">
            <h2 id="schedule-heading" className="text-lg font-semibold">{T.heading}</h2>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
                {rows.map(([k, v]) => <React.Fragment key={k}><dt className="text-muted-foreground text-sm">{k}</dt><dd className="text-sm">{v}</dd></React.Fragment>)}
            </dl>
            <ScheduleEditor stackId={stackId} schedule={policy.schedule} retention={policy.retention} reason={!isAdmin ? SCHEDULE_EDIT.reasons.member : configLocked ? SCHEDULE_EDIT.reasons.locked : null}/>
            <RunPanel runs={runs} canRun={canRun}/>
            <p className="text-muted-foreground text-sm">{T.note}</p>
            {canConfigure && <Link href={configureHref} className="w-fit text-sm font-medium underline underline-offset-4" data-stack={stackId}>{T.configure}</Link>}
        </section>
    );
}
