import type {RetentionPolicy} from "@/fork/recovery/retention-policy";

/**
 * D33 fork-owned retention over RecoveryPoints: PURE selection (no I/O). GFS buckets are computed in the stack schedule's timezone
 * from `finalizedAt`; only `verified` RPs fill GFS slots (hourly/last is `keep_last`). Invariants (ADR-004 §3, tested):
 *  (a) the newest verified RP is never pruned; (b) never fewer than `keep_last` verified RPs remain; (c) `pending_verification`,
 *  `incomplete`, `failed` RPs are pruned by age only and never count towards GFS slots; (d) the last verified RP of any storage
 *  channel is kept (DR safety); (e) buckets use the schedule timezone; (f, W12) while the stack has NO verified RP the newest RP of
 *  any status is kept — W14 has not promoted anything yet, so never delete the only backup; (g) an RP in use (active run / restore in
 *  flight) is never selected; (h) a purged RP (tombstone) is ignored; an RP already `expiring` is selected again (retry).
 */
export type RpFacts = {
    id: string;
    status: "incomplete" | "pending_verification" | "verified" | "failed";
    sequence: number;
    finalizedAt: Date | null;
    createdAt: Date;
    purgedAt: Date | null;
    /** channel ids of this RP's present artifacts */
    channelIds: readonly string[];
    /** active run on the stack or a restore reading one of its backups */
    inUse: boolean;
    /** `expires_at` is set: a previous prune attempt started and did not finish (retention_partial) ⇒ retried regardless of age (h). */
    expiring?: boolean;
};

export type RetentionSelection = {prune: string[]; keep: Map<string, string>};
export const DEFAULT_MAX_AGE_DAYS = 30;

type Parts = {y: number; mo: number; d: number; h: number};
const dtfs = new Map<string, Intl.DateTimeFormat>();
function parts(date: Date, tz: string): Parts & {isoYear: number; isoWeek: number} {
    let f = dtfs.get(tz);
    if (!f) { f = new Intl.DateTimeFormat("en-US", {timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric"}); dtfs.set(tz, f); }
    const o: Record<string, number> = {};
    for (const p of f.formatToParts(date)) if (p.type !== "literal") o[p.type] = Number(p.value);
    const local = new Date(Date.UTC(o.year, o.month - 1, o.day));
    // ISO week (Monday start), computed on the local calendar date
    const dow = (local.getUTCDay() + 6) % 7;
    const thursday = new Date(local.getTime() + (3 - dow) * 86_400_000);
    const isoYear = thursday.getUTCFullYear();
    const jan1 = new Date(Date.UTC(isoYear, 0, 1));
    const isoWeek = 1 + Math.floor((thursday.getTime() - jan1.getTime()) / (7 * 86_400_000));
    return {y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, isoYear, isoWeek};
}
const dayKey = (p: Parts) => `${p.y}-${p.mo}-${p.d}`;
const weekKey = (p: {isoYear: number; isoWeek: number}) => `${p.isoYear}-W${p.isoWeek}`;
const monthKey = (p: Parts) => `${p.y}-${p.mo}`;

export function selectRetention(rps: readonly RpFacts[], policy: RetentionPolicy, o: {now: Date; timezone: string; maxAgeDays?: number}): RetentionSelection {
    const keep = new Map<string, string>();
    const live = rps.filter((r) => r.purgedAt === null);
    const when = (r: RpFacts) => r.finalizedAt ?? r.createdAt;
    const newestFirst = [...live].sort((a, b) => b.sequence - a.sequence);
    const verified = newestFirst.filter((r) => r.status === "verified");

    // (a) + (b)
    verified.slice(0, policy.keep_last).forEach((r) => keep.set(r.id, "keep_last"));
    // GFS over verified RPs: the NEWEST RP of each day / ISO week / month / year bucket, newest buckets first
    const take = (key: (p: ReturnType<typeof parts>) => string, n: number, why: string) => {
        if (n <= 0) return;
        const seen = new Set<string>();
        for (const r of verified) {
            const k = key(parts(when(r), o.timezone));
            if (seen.has(k)) continue;
            if (seen.size >= n) break;
            seen.add(k);
            if (!keep.has(r.id)) keep.set(r.id, why);
        }
    };
    take(dayKey, policy.daily, "daily");
    take(weekKey, policy.weekly, "weekly");
    take(monthKey, policy.monthly, "monthly");
    take((p) => String(p.y), policy.yearly, "yearly");

    // (d) the last verified RP of every channel
    const seenCh = new Set<string>();
    for (const r of verified) for (const c of r.channelIds) if (!seenCh.has(c)) { seenCh.add(c); if (!keep.has(r.id)) keep.set(r.id, "last_for_channel"); }

    // (f) no verified RP at all: keep the newest RP of any status
    if (verified.length === 0 && newestFirst[0]) keep.set(newestFirst[0].id, "only_backup");

    // (g) in use
    for (const r of live) if (r.inUse && !keep.has(r.id)) keep.set(r.id, "in_use");

    // (c) non-verified: by age only
    const maxAgeMs = (o.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86_400_000;
    const prune: string[] = [];
    for (const r of newestFirst) {
        if (keep.has(r.id)) continue;
        if (r.expiring) { prune.push(r.id); continue; }
        if (r.status !== "verified") {
            if (o.now.getTime() - when(r).getTime() < maxAgeMs) { keep.set(r.id, "young"); continue; }
        }
        prune.push(r.id);
    }
    return {prune, keep};
}
