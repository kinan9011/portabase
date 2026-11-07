/**
 * Cron-expression validation for the stack schedule (W11). CONTROLLED COPY of upstream `src/utils/cron.ts#isValidCronPart` (D31):
 * `__tests__/unit/w11-upstream-contract.test.ts` pins the upstream file hash and asserts this copy agrees with the upstream function
 * on a corpus, so an upstream change fails the W-SYNC gate instead of silently diverging. Pure: no I/O.
 */
const BOUNDS: Record<string, [number, number]> = {
    minute: [0, 59],
    hour: [0, 23],
    "day-of-month": [1, 31],
    month: [1, 12],
    "day-of-week": [0, 6],
};
export const CRON_FIELDS = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;
export const CRON_MAX_LENGTH = 100;

const inRange = (v: string, min: number, max: number) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max;
const rangeOrNumber = (v: string, min: number, max: number): boolean => {
    const r = v.match(/^(\d+)-(\d+)$/);
    if (r) return inRange(r[1], min, max) && inRange(r[2], min, max) && Number(r[1]) <= Number(r[2]);
    return inRange(v, min, max);
};

export function isValidCronPart(type: string, value: string): boolean {
    const bounds = BOUNDS[type];
    if (!bounds) return false;
    const [min, max] = bounds;
    return value.split(",").every((raw) => {
        const part = raw.trim();
        if (part === "") return false;
        const step = part.match(/^(.+)\/(\d+)$/);
        if (step) {
            const n = Number(step[2]);
            if (!/^\d+$/.test(step[2]) || n < 1 || n > max) return false;
            return step[1] === "*" || rangeOrNumber(step[1], min, max);
        }
        return part === "*" || rangeOrNumber(part, min, max);
    });
}

/** 5 whitespace-separated fields, each valid. Bounded length (abuse guard). */
export function isValidCron(expr: string): boolean {
    if (expr.length > CRON_MAX_LENGTH) return false;
    const parts = expr.trim().split(/\s+/);
    return parts.length === 5 && parts.every((p, i) => isValidCronPart(CRON_FIELDS[i], p));
}

/** Expands one VALID field into the sorted set of values it matches. */
export function expandField(type: (typeof CRON_FIELDS)[number], value: string): number[] {
    const [min, max] = BOUNDS[type];
    const out = new Set<number>();
    for (const raw of value.split(",")) {
        const part = raw.trim();
        const step = part.match(/^(.+)\/(\d+)$/);
        const base = step ? step[1] : part;
        const inc = step ? Number(step[2]) : 1;
        let lo = min;
        let hi = max;
        if (base !== "*") {
            const r = base.match(/^(\d+)-(\d+)$/);
            lo = r ? Number(r[1]) : Number(base);
            hi = r ? Number(r[2]) : step ? max : Number(base); // `5/10` = from 5 to max
        }
        for (let v = lo; v <= hi; v += inc) out.add(v);
    }
    return [...out].sort((a, b) => a - b);
}
