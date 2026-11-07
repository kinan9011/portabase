import {z} from "zod";
import {CRON_FIELDS, CRON_MAX_LENGTH, expandField, isValidCron} from "./cron-expr";

/**
 * Stack schedule (W11, D14: dashboard-held; EU-16: presets + timezone, raw cron only under Advanced). Pure, dependency-free
 * (`Intl` only). W11 stores and previews it; the W12 scheduler executes it. `toCron` is the single source of the effective cron.
 */
export const SCHEDULE_PRESETS = ["hourly", "every_6h", "every_12h", "daily", "weekly", "monthly", "cron"] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

export function isValidTimezone(tz: string): boolean {
    if (tz.length === 0 || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat("en-US", {timeZone: tz});
        return true;
    } catch {
        return false;
    }
}

export const ScheduleSchema = z.strictObject({
    preset: z.enum(SCHEDULE_PRESETS),
    timezone: z.string().refine(isValidTimezone, "invalid_timezone"),
    minute: z.number().int().min(0).max(59).default(0),
    hour: z.number().int().min(0).max(23).default(2),
    weekday: z.number().int().min(0).max(6).default(0),
    /** 1–28 so "monthly" never skips a short month. */
    monthday: z.number().int().min(1).max(28).default(1),
    cron: z.string().max(CRON_MAX_LENGTH).optional(),
}).superRefine((s, ctx) => {
    if (s.preset === "cron" && !(s.cron !== undefined && isValidCron(s.cron))) ctx.addIssue({code: "custom", path: ["cron"], message: "invalid_cron"});
    if (s.preset !== "cron" && s.cron !== undefined) ctx.addIssue({code: "custom", path: ["cron"], message: "cron_only_in_advanced"});
});
export type Schedule = z.infer<typeof ScheduleSchema>;
export const DEFAULT_SCHEDULE: Schedule = {preset: "daily", timezone: "UTC", minute: 0, hour: 2, weekday: 0, monthday: 1};

/** The effective 5-field cron (what the W12 scheduler reads). */
export function toCron(s: Schedule): string {
    switch (s.preset) {
        case "hourly": return `${s.minute} * * * *`;
        case "every_6h": return `${s.minute} */6 * * *`;
        case "every_12h": return `${s.minute} */12 * * *`;
        case "daily": return `${s.minute} ${s.hour} * * *`;
        case "weekly": return `${s.minute} ${s.hour} * * ${s.weekday}`;
        case "monthly": return `${s.minute} ${s.hour} ${s.monthday} * *`;
        case "cron": return (s.cron ?? "").trim().replace(/\s+/g, " ");
    }
}

// ---- timezone math ---------------------------------------------------------------------------------------------------------
const dtf = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string) => {
    let f = dtf.get(tz);
    if (!f) { f = new Intl.DateTimeFormat("en-US", {timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"}); dtf.set(tz, f); }
    return f;
};
type Parts = {y: number; mo: number; d: number; h: number; mi: number};
function parts(ms: number, tz: string): Parts {
    const o: Record<string, number> = {};
    for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
    return {y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute};
}
const offsetMs = (ms: number, tz: string) => { const p = parts(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000; };
const same = (a: Parts, b: Parts) => a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi;

/** Local wall time → instant. A time skipped by DST runs just after the gap; a repeated time runs once (first occurrence). */
export function zonedToUtc(w: Parts, tz: string): number {
    const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    const t1 = guess - offsetMs(guess, tz);
    const t2 = guess - offsetMs(t1, tz);
    const ok = [t1, t2].filter((t) => same(parts(t, tz), w));
    return ok.length ? Math.min(...ok) : Math.max(t1, t2);
}

/** Next `n` run instants strictly after `from`, in the schedule's timezone (bounded: ≤ 400 local days scanned). Standard cron day semantics: dom and dow both restricted ⇒ either matches. */
export function nextRuns(s: Schedule, from: Date, n = 3): Date[] {
    const f = toCron(s).split(" ");
    const [mins, hours, doms, months, dows] = CRON_FIELDS.map((t, i) => expandField(t, f[i]));
    const domStar = f[2] === "*";
    const dowStar = f[4] === "*";
    const start = parts(from.getTime(), s.timezone);
    const out: Date[] = [];
    for (let i = 0; i < 400 && out.length < n; i++) {
        const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
        const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate(), dow = day.getUTCDay();
        if (!months.includes(mo)) continue;
        const domOk = doms.includes(d), dowOk = dows.includes(dow === 7 ? 0 : dow);
        if (!(domStar && dowStar ? true : domStar ? dowOk : dowStar ? domOk : domOk || dowOk)) continue;
        for (const h of hours) for (const mi of mins) {
            const t = zonedToUtc({y, mo, d, h, mi}, s.timezone);
            if (t > from.getTime() && !out.some((o) => o.getTime() === t)) out.push(new Date(t));
        }
        out.sort((a, b) => a.getTime() - b.getTime());
    }
    return out.slice(0, n);
}

/** Longest gap between the next runs, in hours (the dead-man threshold is 1.5 × this, §4.7). null when the schedule never fires. */
export function intervalHours(s: Schedule, from: Date = new Date()): number | null {
    const runs = nextRuns(s, from, 5);
    if (runs.length < 2) return null;
    let max = 0;
    for (let i = 1; i < runs.length; i++) max = Math.max(max, runs[i].getTime() - runs[i - 1].getTime());
    return max / 3_600_000;
}
