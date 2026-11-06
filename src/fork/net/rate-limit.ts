/**
 * Tiny in-process sliding-window limiter for fork actions that reach an external system (W05: test/save/rotate).
 * ponytail: per-process only — fine for the single-instance, single-operator deployment (D21). If the dashboard is ever
 * run with several replicas, back this with a DB row (fork_locks/schedule state) instead.
 */
const buckets = new Map<string, number[]>();

export type RateVerdict = {ok: true} | {ok: false; retryAfterSeconds: number};

export function checkRate(key: string, limit: number, windowMs: number, now = Date.now()): RateVerdict {
    const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
        buckets.set(key, hits);
        return {ok: false, retryAfterSeconds: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000))};
    }
    hits.push(now);
    buckets.set(key, hits);
    return {ok: true};
}

/** Test helper. */
export const resetRateLimits = () => buckets.clear();
