import {DAY_MS} from "./vocab";

/** Plan D-7. PURE; `now` always comes from the caller (never `Date.now()` here). */
export function testRestoreFacet(i: {lastVerifiedAt: Date | null; now: Date; staleAfterDays: number}): {daysAgo: number | null; stale: boolean} {
    if (!i.lastVerifiedAt) return {daysAgo: null, stale: false};
    const age = i.now.getTime() - i.lastVerifiedAt.getTime();
    return {daysAgo: Math.max(0, Math.floor(age / DAY_MS)), stale: age > i.staleAfterDays * DAY_MS};
}

/** Plan D-8: the alert holds while the schedule is on and no successful test restore is recent (a never-tested stack gets one stale window of grace after enabling). */
export function testRestoreStaleHolds(i: {enabled: boolean; enabledAt: Date | null; lastVerifiedAt: Date | null; now: Date; staleAfterDays: number}): boolean {
    if (!i.enabled) return false;
    const limit = i.staleAfterDays * DAY_MS;
    if (i.lastVerifiedAt) return i.now.getTime() - i.lastVerifiedAt.getTime() > limit;
    return i.enabledAt !== null && i.now.getTime() - i.enabledAt.getTime() > limit;
}
