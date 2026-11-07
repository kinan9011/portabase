import {z} from "zod";

/**
 * D33 fork-owned retention policy v1 (ADR-004 §3): GFS over RecoveryPoints with status `verified`; `keep_last` covers hourly/last.
 * W11 validates and stores it in `fork_stack_policy.policy`; W12 executes it (invariants in ADR-004 §3: newest verified RP and
 * `keep_last` verified RPs are never pruned). Bounds are an abuse guard, not a recommendation.
 */
export const RetentionPolicySchema = z.strictObject({
    keep_last: z.number().int().min(1).max(100),
    daily: z.number().int().min(0).max(366),
    weekly: z.number().int().min(0).max(104),
    monthly: z.number().int().min(0).max(120),
    yearly: z.number().int().min(0).max(50),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;
/** Defaults proposed in ADR-004 §3 ("target, tune with actuals"). */
export const DEFAULT_RETENTION: RetentionPolicy = {keep_last: 3, daily: 7, weekly: 4, monthly: 6, yearly: 0};
