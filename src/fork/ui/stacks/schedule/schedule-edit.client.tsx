"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {updateStackScheduleAction} from "@/fork/actions/stack-schedule.action";
import {RetentionPolicySchema, type RetentionPolicy} from "@/fork/recovery/retention-policy";
import {retentionFieldErrors} from "@/fork/ui/a11y/retention-errors";
import {ScheduleSchema, type Schedule} from "@/fork/schedule/schedule";
import type {EditScheduleResult} from "@/fork/stack-policy/update-schedule";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {CONFIGURE, GENERIC_FAILURE, SCHEDULE_EDIT} from "@/fork/ui/labels";
import {SchedulePicker} from "@/fork/ui/schedule-picker";
import {normalise} from "@/fork/ui/stacks/wizard/outcome";
import {useAnnounce} from "@/fork/ui/status-announcer";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";

const E = SCHEDULE_EDIT;
const T = CONFIGURE.schedule;
const RETENTION_KEYS = ["keep_last", "daily", "weekly", "monthly", "yearly"] as const;

/**
 * Schedule + retention editor (W13, D31 controlled copy of the W11 form pieces). Nothing is persisted until Save; the server re-validates everything and
 * answers with its own verdict, which is what the page shows (no optimistic "saved"). Real only for a system administrator while configuration is open;
 * otherwise the button is `aria-disabled` and the reason is visible text (§8.2 rule 10).
 */
export function ScheduleEditor({stackId, schedule, retention, reason}: {stackId: string; schedule: Schedule; retention: RetentionPolicy; reason: string | null}) {
    const router = useRouter();
    const announce = useAnnounce();
    const [open, setOpen] = React.useState(false);
    const [sched, setSched] = React.useState<Schedule>(schedule);
    const [ret, setRet] = React.useState<RetentionPolicy>(retention);
    const [cronOk, setCronOk] = React.useState(true);
    const [pending, setPending] = React.useState(false);
    const [msg, setMsg] = React.useState<{ok: boolean; text: string} | null>(null);
    const retOk = RetentionPolicySchema.safeParse(ret).success;
    const retErrs = retentionFieldErrors(ret, (k) => T.retention[k]);
    const schedOk = ScheduleSchema.safeParse(sched).success && cronOk;
    const setRetention = (k: (typeof RETENTION_KEYS)[number], raw: string) => { const n = Number(raw); if (Number.isInteger(n)) setRet({...ret, [k]: n}); };

    const save = async () => {
        if (pending || !retOk || !schedOk) return;
        setPending(true);
        try {
            const r = normalise<EditScheduleResult>(await updateStackScheduleAction({stackId, schedule: sched, retention: ret}) as never);
            const text = r.kind === "ok" ? (r.outcome.ok ? (r.outcome.noop ? E.unchanged : r.outcome.paused ? E.savedPaused : E.saved) : GENERIC_FAILURE)
                : r.kind === "refused" ? (E.outcome[r.code] ?? GENERIC_FAILURE) : GENERIC_FAILURE;
            setMsg({ok: r.kind === "ok", text});
            announce(text);
            if (r.kind === "ok") { setOpen(false); router.refresh(); }
        } catch {
            setMsg({ok: false, text: GENERIC_FAILURE});
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="flex flex-col gap-3" data-testid="schedule-editor">
            {!open && (
                <div className="flex flex-wrap items-start gap-3">
                    <ReasonButton type="button" variant="outline" reason={reason} onClick={() => { setSched(schedule); setRet(retention); setMsg(null); setOpen(true); }} data-testid="schedule-edit-open">{E.open}</ReasonButton>
                    {msg && <span data-testid="schedule-edit-outcome" className={`max-w-prose text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</span>}
                </div>
            )}
            {open && (
                <form className="flex flex-col gap-4 rounded-xl border p-4" aria-labelledby="schedule-edit-heading" data-testid="schedule-edit-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
                    <h3 id="schedule-edit-heading" className="font-semibold">{E.heading}</h3>
                    <SchedulePicker value={sched} onChange={setSched} onCronValidity={setCronOk}/>
                    <fieldset className="flex flex-col gap-3 rounded-lg border p-3" data-testid="retention-edit">
                        <legend className="px-1 font-medium">{T.retention.heading}</legend>
                        <p className="text-muted-foreground text-xs">{T.retention.intro}</p>
                        <div className="grid gap-3 sm:grid-cols-3">
                            {RETENTION_KEYS.map((k) => (
                                <div key={k} className="flex flex-col gap-1.5">
                                    <Label htmlFor={`edit-ret-${k}`}>{T.retention[k]}</Label>
                                    <Input id={`edit-ret-${k}`} type="number" min={k === "keep_last" ? 1 : 0} value={ret[k]} onChange={(e) => setRetention(k, e.target.value)} aria-invalid={retErrs[k] ? true : undefined} aria-describedby={retErrs[k] ? `edit-ret-${k}-unit edit-ret-${k}-err` : `edit-ret-${k}-unit`}/>
                                    <span id={`edit-ret-${k}-unit`} className="text-muted-foreground text-xs">{T.retention.unit[k]}</span>
                                    {retErrs[k] && <span id={`edit-ret-${k}-err`} className="text-destructive text-xs">{retErrs[k]}</span>}
                                </div>
                            ))}
                        </div>
                        <p className="text-muted-foreground text-xs">{E.retentionNote}</p>
                        {!retOk && <p role="alert" className="text-destructive text-sm">{E.outcome.invalid_input}</p>}
                    </fieldset>
                    {msg && !msg.ok && <p role="alert" data-testid="schedule-edit-error" className="text-destructive text-sm">{msg.text}</p>}
                    <div className="flex flex-wrap gap-3">
                        <Button className={PRIMARY_AA} type="submit" aria-busy={pending || undefined} aria-disabled={!retOk || !schedOk || undefined} data-testid="schedule-edit-save">{pending ? E.saving : E.save}</Button>
                        <Button type="button" variant="outline" onClick={() => setOpen(false)} data-testid="schedule-edit-cancel">{E.cancel}</Button>
                    </div>
                </form>
            )}
        </div>
    );
}
