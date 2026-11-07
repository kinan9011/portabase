import {z} from "zod";

/**
 * Result of the last sync of ONE environment (`fork_arcane_environment.last_sync_summary`, W07). Counts and fixed codes only:
 * no name, path, label or message from Arcane can be stored here, so it is safe to show and to audit.
 */
export const SYNC_ERROR_CODES = ["unreachable", "invalid_key", "permission", "incompatible", "rate_limited", "bad_response", "tls", "blocked_url", "not_found", "deadline", "invalid_project", "inventory_limit", "inventory_invalid", "key_too_broad", "key_unverifiable", "partial", "internal"] as const;
const n = z.number().int().min(0);
export const SyncSummarySchema = z.strictObject({
    trigger: z.enum(["manual", "cron"]),
    started_at: z.iso.datetime(),
    duration_ms: n,
    stacks_found: n,
    stacks_new: n,
    stacks_changed: n,
    stacks_unchanged: n,
    stacks_absent: n,
    stacks_rejected: n,
    services: n,
    mounts: n,
    unmanaged_containers: n,
    warnings: n,
    errors: z.array(z.strictObject({code: z.enum(SYNC_ERROR_CODES), count: n})).max(20),
    partial: z.boolean(),
});
export type SyncSummary = z.infer<typeof SyncSummarySchema>;
