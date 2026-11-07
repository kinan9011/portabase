import type {CompletenessReport, ConsistencyFacet, Deletable} from "./types";

/**
 * The seven independent facets (§4.6) + the configuration-locked facet (§4.1). They never change the primary state,
 * except through the inputs that `derivePrimaryState` reads. Inputs that no wave feeds yet are `null` and rendered
 * "not checked / not available yet" — never an invented value.
 */
export type FacetInputs = {
    hasActivePolicy: boolean;
    /** Newest `verified` RP age (D43); `verifying` = a newer `pending_verification` RP exists. */
    hoursSinceLastVerified: number | null;
    verifying: boolean;
    /** Data verified by a test restore, days ago (R2, D36). Null = never / not fed. */
    daysSinceTestRestore: number | null;
    /** Per storage channel: can the source host delete the copy? Empty = no channel / not checked. */
    channelDeletable: readonly Deletable[];
    /** Policy paused because the activating user lost rights (F7). */
    pausedAfterReauthorization: boolean;
    /** `fork_stack.stale_since` set: Arcane was unreachable, the last inventory is used (UX-09). */
    inventoryStale: boolean;
    /** Self-check mode `locked` (§4.1). */
    configLocked: boolean;
};

export type Facets = {
    lastGoodBackup: {hoursAgo: number | null; verifying: boolean};
    testRestore: {daysAgo: number | null};
    /** Worst of the channels, failing closed: yes > not_checked > no is the order of concern. */
    deletable: Deletable;
    /** A facet and a "Needs attention" item — NEVER a reason for Partial (§4.5). */
    hostCompromise: boolean;
    consistency: {member: string; level: ConsistencyFacet}[];
    pausedAfterReauthorization: boolean;
    inventoryStale: boolean;
    configLocked: boolean;
};

export function deriveDeletable(channels: readonly Deletable[]): Deletable {
    if (channels.length === 0) return "not_checked";
    if (channels.includes("yes")) return "yes";
    if (channels.includes("not_checked")) return "not_checked";
    return "no";
}

export function deriveFacets(i: FacetInputs, report: CompletenessReport): Facets {
    const deletable = deriveDeletable(i.channelDeletable);
    const consistency = report.items.flatMap((it): {member: string; level: ConsistencyFacet}[] => {
        if (it.status !== "captured") return [];
        if (it.kind === "database") return [{member: it.name, level: it.consistency === "engine_dump" ? "database_saved_safely" : "files_copied_running"}];
        if (it.kind === "volume" || it.kind === "bind" || it.kind === "anonymous_volume") return [{member: it.name, level: "files_copied_running"}];
        return [];
    });
    return {
        lastGoodBackup: {hoursAgo: i.hoursSinceLastVerified, verifying: i.verifying},
        testRestore: {daysAgo: i.daysSinceTestRestore},
        deletable,
        hostCompromise: i.hasActivePolicy && deletable !== "no",
        consistency,
        pausedAfterReauthorization: i.pausedAfterReauthorization,
        inventoryStale: i.inventoryStale,
        configLocked: i.configLocked,
    };
}
