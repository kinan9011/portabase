"use client";

import * as React from "react";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {CONFIGURE} from "@/fork/ui/labels";
import {isValidCron} from "@/fork/schedule/cron-expr";
import {nextRuns, SCHEDULE_PRESETS, toCron, type Schedule, type SchedulePreset} from "@/fork/schedule/schedule";

/**
 * Schedule form (W11, EU-16): presets + timezone; a raw cron expression only inside the native "Advanced" disclosure. CONTROLLED COPY (D31) of
 * the upstream `BackupScheduleSelector` idea (presets + custom cron) rebuilt on native controls and the fork's pure schedule model; the contract
 * test pins the upstream source it derives from. Next-three-runs preview is computed in the browser from the same pure `nextRuns` the server uses.
 */
const S = CONFIGURE.schedule;
const pad = (n: number) => String(n).padStart(2, "0");
const hasHour = (p: SchedulePreset) => p === "daily" || p === "weekly" || p === "monthly";

export function timezones(): string[] {
    try {
        const list = (Intl as unknown as {supportedValuesOf?: (k: string) => string[]}).supportedValuesOf?.("timeZone");
        return list && list.length > 0 ? ["UTC", ...list.filter((z) => z !== "UTC")] : ["UTC"];
    } catch { return ["UTC"]; }
}

function fmtRun(d: Date, tz: string): string {
    try { return new Intl.DateTimeFormat("en-GB", {timeZone: tz, dateStyle: "medium", timeStyle: "short"}).format(d); } catch { return d.toISOString(); }
}

export function SchedulePicker({value, onChange, onCronValidity}: {value: Schedule; onChange: (s: Schedule) => void; onCronValidity?: (valid: boolean) => void}) {
    const id = React.useId();
    const zones = React.useMemo(timezones, []);
    const [cron, setCron] = React.useState(value.preset === "cron" ? value.cron ?? "" : "");
    const cronValid = cron.trim() === "" || isValidCron(cron);
    React.useEffect(() => { onCronValidity?.(value.preset !== "cron" || cronValid); }, [cronValid, value.preset, onCronValidity]);
    const set = (p: Partial<Schedule>) => onChange({...value, ...p});
    const setPreset = (preset: SchedulePreset) => { if (preset !== "cron") { set({preset, cron: undefined}); } else set({preset, cron: cron.trim() || undefined}); };
    const runs = React.useMemo(() => { try { return value.preset === "cron" && !(value.cron && isValidCron(value.cron)) ? [] : nextRuns(value, new Date(), 3); } catch { return []; } }, [value]);
    const advancedOpen = value.preset === "cron";

    return (
        <div className="flex flex-col gap-4" data-testid="schedule-picker">
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-preset`}>{S.preset}</Label>
                    <select id={`${id}-preset`} className="border-input bg-background h-9 rounded-md border px-3 text-sm" value={value.preset === "cron" ? "daily" : value.preset} disabled={value.preset === "cron"} onChange={(e) => setPreset(e.target.value as SchedulePreset)}>
                        {SCHEDULE_PRESETS.filter((p) => p !== "cron").map((p) => <option key={p} value={p}>{S.presets[p]}</option>)}
                    </select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-tz`}>{S.timezone}</Label>
                    <select id={`${id}-tz`} className="border-input bg-background h-9 rounded-md border px-3 text-sm" value={value.timezone} onChange={(e) => set({timezone: e.target.value})}>
                        {(zones.includes(value.timezone) ? zones : [value.timezone, ...zones]).map((z) => <option key={z} value={z}>{z}</option>)}
                    </select>
                </div>
                {value.preset !== "cron" && (
                    <>
                        {hasHour(value.preset) ? (
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor={`${id}-time`}>{S.time}</Label>
                                <Input id={`${id}-time`} type="time" value={`${pad(value.hour)}:${pad(value.minute)}`} onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); if (Number.isInteger(h) && Number.isInteger(m)) set({hour: h, minute: m}); }}/>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor={`${id}-minute`}>{S.minute}</Label>
                                <Input id={`${id}-minute`} type="number" min={0} max={59} value={value.minute} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 59) set({minute: n}); }}/>
                            </div>
                        )}
                        {value.preset === "weekly" && (
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor={`${id}-weekday`}>{S.weekday}</Label>
                                <select id={`${id}-weekday`} className="border-input bg-background h-9 rounded-md border px-3 text-sm" value={value.weekday} onChange={(e) => set({weekday: Number(e.target.value)})}>
                                    {S.weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}
                                </select>
                            </div>
                        )}
                        {value.preset === "monthly" && (
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor={`${id}-monthday`}>{S.monthday}</Label>
                                <Input id={`${id}-monthday`} type="number" min={1} max={28} value={value.monthday} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 28) set({monthday: n}); }}/>
                            </div>
                        )}
                    </>
                )}
            </div>

            <details open={advancedOpen} className="rounded-lg border p-3" data-testid="schedule-advanced">
                <summary className="cursor-pointer text-sm font-medium">{S.advanced}</summary>
                <div className="mt-3 flex flex-col gap-2">
                    <p id={`${id}-cron-hint`} className="text-muted-foreground text-xs">{S.advancedHint}</p>
                    <Label htmlFor={`${id}-cron`}>{S.cron}</Label>
                    <Input id={`${id}-cron`} className="font-mono" value={cron} placeholder="0 2 * * *" aria-invalid={!cronValid} aria-describedby={`${id}-cron-hint${cronValid ? "" : ` ${id}-cron-err`}`}
                        onChange={(e) => { const v = e.target.value; setCron(v); if (v.trim() === "") set({preset: "daily", cron: undefined}); else set({preset: "cron", cron: v.trim()}); }}/>
                    {!cronValid && <p id={`${id}-cron-err`} role="alert" className="text-destructive text-sm">{S.cronInvalid}</p>}
                    {value.preset === "cron" && <button type="button" className="w-fit text-sm underline underline-offset-4" onClick={() => { setCron(""); set({preset: "daily", cron: undefined}); }}>{S.cronClear}</button>}
                </div>
            </details>

            <div data-testid="next-runs">
                <h4 className="text-sm font-medium">{S.next}</h4>
                {runs.length === 0 ? <p className="text-muted-foreground text-sm">—</p> : (
                    <ul className="text-sm">
                        {runs.map((r) => <li key={r.toISOString()}>{fmtRun(r, value.timezone)} <span className="text-muted-foreground">({r.toISOString().slice(0, 16).replace("T", " ")} {S.nextUtc})</span></li>)}
                    </ul>
                )}
                <p className="text-muted-foreground mt-1 font-mono text-xs">{value.preset === "cron" && !(value.cron && isValidCron(value.cron)) ? "" : toCron(value)}</p>
            </div>
        </div>
    );
}
