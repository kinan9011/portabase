import type {PrimaryState} from "./types";

/**
 * Primary protection state (REVISED-PLAN §4.6, D43). First match wins, in this order:
 *   Failed > Partial > Stale > Kit not verified > Awaiting first backup > Protected > Unprotected.
 * Pure and total: every input combination maps to exactly one state (an exhaustive-grid test enforces it).
 */
export type PrimaryInputs = {
    /** An activated, non-deactivated backup policy exists (`fork_stack_policy`). */
    hasActivePolicy: boolean;
    /** The most recent run / recovery point failed. */
    lastRunFailed: boolean;
    /** The completeness report has a gap (incl. a DB saved only by file copy, D29). */
    coverageGap: boolean;
    /** Recovery points with status `verified` — the ONLY ones that count (D43). */
    verifiedRpCount: number;
    /** `pending_verification` recovery points: shown as "Backed up · verifying", never counted. */
    pendingRpCount: number;
    /** Age of the newest verified RP; null when none. */
    hoursSinceLastVerified: number | null;
    /** Beyond this the newest verified RP is Stale (2 × schedule interval); null = no schedule known, so never stale. */
    staleAfterHours: number | null;
    /** Recovery kit generated AND verified (§4.2). Anything but `true` is "not verified" (fail closed). */
    kitVerified: boolean | null;
};

export function derivePrimaryState(i: PrimaryInputs): PrimaryState {
    const hasBackupIntent = i.hasActivePolicy || i.verifiedRpCount > 0 || i.pendingRpCount > 0;
    if (i.lastRunFailed) return "failed";
    // "Partial" is a coverage gap of something that is (or was) being backed up. A stack nothing is configured for stays
    // Unprotected; its gaps are shown as blockers on Overview and Configuration instead.
    if (i.coverageGap && hasBackupIntent) return "partial";
    const stale = i.verifiedRpCount > 0 && i.hoursSinceLastVerified !== null && i.staleAfterHours !== null && i.hoursSinceLastVerified > i.staleAfterHours;
    if (stale) return "stale";
    if (i.hasActivePolicy && i.kitVerified !== true) return "kit_not_verified";
    if (i.hasActivePolicy && i.verifiedRpCount === 0) return "awaiting_first_backup";
    if (i.hasActivePolicy && i.verifiedRpCount > 0 && !i.coverageGap) return "protected";
    return "unprotected";
}
