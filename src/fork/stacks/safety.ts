import {z} from "zod";
import type {ProtectionView} from "@/fork/completeness/view";

/**
 * "Am I safe?" strip mapping (REVISED-PLAN §4.6, W13) — PURE and total.
 *   Safe             = primary Protected AND no warning facet
 *   Needs attention  = primary Failed | Partial | Stale | Kit not verified, OR (Protected with) a warning facet:
 *                      facet 3 "deletable from source host" yes / not checked (and facet 4 "not protected against host compromise" — the same signal),
 *                      facet 6 paused, facet 7 inventory stale, configuration locked, an agent whose poll is failing.
 *                      Facet 5 (consistency) and facet 1 / 2 are informational: they never move a stack.
 *   Not protected    = primary Unprotected | Awaiting first backup
 * `pending_verification` never counts as Protected (D43) because the primary state is derived from VERIFIED recovery points only; nothing here can
 * promote a stack. Each reason carries a fix target (EU-15): the UI turns (reason, stack id) into a link with `fixHref`.
 */
export const STRIP_BUCKETS = ["safe", "needs_attention", "not_protected"] as const;
export type StripBucket = (typeof STRIP_BUCKETS)[number];

export const STRIP_REASONS = [
    "failed", "partial", "stale", "kit_not_verified", "host_compromise", "paused", "inventory_stale", "config_locked", "agent_poll_failing",
    "unprotected", "awaiting_first_backup", "no_inventory",
] as const;
export type StripReason = (typeof STRIP_REASONS)[number];

export type Classified = {bucket: StripBucket; reasons: StripReason[]};

export function warningReasons(p: ProtectionView, pollFailing: boolean): StripReason[] {
    const r: StripReason[] = [];
    if (p.facets.hostCompromise) r.push("host_compromise");
    if (p.facets.pausedAfterReauthorization) r.push("paused");
    if (p.facets.inventoryStale) r.push("inventory_stale");
    if (p.facets.configLocked) r.push("config_locked");
    if (pollFailing) r.push("agent_poll_failing");
    return r;
}

export function classifyStack(p: ProtectionView | null, pollFailing = false): Classified {
    if (p === null) return {bucket: "not_protected", reasons: ["no_inventory"]};
    switch (p.primary) {
        case "unprotected":
        case "awaiting_first_backup":
            return {bucket: "not_protected", reasons: [p.primary]};
        case "failed":
        case "partial":
        case "stale":
        case "kit_not_verified":
            return {bucket: "needs_attention", reasons: [p.primary, ...warningReasons(p, pollFailing)]};
        case "protected": {
            const w = warningReasons(p, pollFailing);
            return w.length === 0 ? {bucket: "safe", reasons: []} : {bucket: "needs_attention", reasons: w};
        }
    }
}

const STACKS = "/dashboard/stacks";
/** Where the operator fixes each reason (EU-15). Paths only; the stack id is a validated uuid supplied by the server-built DTO. */
export function fixHref(reason: StripReason, stackId: string): string {
    switch (reason) {
        case "failed": case "stale": return `${STACKS}/${stackId}?tab=activity`;
        case "partial": return `${STACKS}/${stackId}?tab=configuration`;
        case "kit_not_verified": return `${STACKS}/${stackId}?tab=backups`;
        case "host_compromise": return `${STACKS}/${stackId}?tab=schedule`;
        case "paused": case "unprotected": case "awaiting_first_backup": return `${STACKS}/${stackId}/configure`;
        case "inventory_stale": return "/dashboard/integrations";
        case "agent_poll_failing": return "/dashboard/agents";
        case "config_locked": case "no_inventory": return `${STACKS}/${stackId}`;
    }
}

export const StripItemSchema = z.strictObject({
    stackId: z.uuid(),
    name: z.string().max(255),
    bucket: z.enum(STRIP_BUCKETS),
    reasons: z.array(z.enum(STRIP_REASONS)).max(12),
});
export type StripItem = z.infer<typeof StripItemSchema>;

/** "Agent poll failing: <source>" (CH-22c): ONE entry per agent with the stacks it affects — never one per stack. */
export const AgentIssueSchema = z.strictObject({
    agentName: z.string().max(255),
    stacks: z.array(z.strictObject({id: z.uuid(), name: z.string().max(255)})).max(200),
});
export type AgentIssue = z.infer<typeof AgentIssueSchema>;

export const SafetyStripSchema = z.strictObject({
    counts: z.strictObject({safe: z.number().int().min(0), needsAttention: z.number().int().min(0), notProtected: z.number().int().min(0)}),
    items: z.array(StripItemSchema).max(200),
    agentIssues: z.array(AgentIssueSchema).max(100),
    /** More stacks exist than the strip evaluates (ceiling, honest). */
    capped: z.boolean(),
    total: z.number().int().min(0),
});
export type SafetyStrip = z.infer<typeof SafetyStripSchema>;

/** Groups per-stack poll-failing rows into one entry per agent (stable order). */
export function groupAgentIssues(rows: readonly {agentId: string; agentName: string; stackId: string; stackName: string}[]): AgentIssue[] {
    const m = new Map<string, {agentName: string; stacks: Map<string, string>}>();
    for (const r of rows) {
        const e = m.get(r.agentId) ?? {agentName: r.agentName, stacks: new Map<string, string>()};
        e.stacks.set(r.stackId, r.stackName);
        m.set(r.agentId, e);
    }
    return [...m.values()].sort((a, b) => a.agentName.localeCompare(b.agentName)).map((e) => ({agentName: e.agentName, stacks: [...e.stacks].map(([id, name]) => ({id, name})).sort((a, b) => a.name.localeCompare(b.name))}));
}
