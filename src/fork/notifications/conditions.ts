import type {PrimaryState} from "@/fork/completeness/types";
import type {AlertKind} from "./vocab";

/**
 * Alert conditions the fork evaluates itself (W13, §4.7). Pure part:
 *  - `stack.partial`: the primary state is Partial ("drift to Partial": coverage no longer complete for a stack with backup intent);
 *  - `stack.no_good_backup` (dead-man): hours since the newest VERIFIED RP (D43: pending_verification does not count), or since activation when
 *    none exists, exceed N = max(`FORK_DEADMAN_MIN_HOURS`, 1.5 × schedule interval). Until W14 can verify, this fires N h after activation: literal §4.7.
 */
export type ConditionInputs = {primary: PrimaryState; hoursSinceVerified: number | null; hoursSinceActivation: number; staleAfterHours: number | null; minHours: number};
export type Condition = {kind: AlertKind; holds: boolean; hours: number | null};

export function evaluateConditions(i: ConditionInputs): Condition[] {
    const limit = Math.max(i.minHours, Math.ceil(i.staleAfterHours ?? 0));
    const reference = i.hoursSinceVerified ?? i.hoursSinceActivation;
    return [
        {kind: "stack.partial", holds: i.primary === "partial", hours: null},
        {kind: "stack.no_good_backup", holds: reference > limit, hours: Math.floor(reference)},
    ];
}

/** One notification per episode: fires when the condition starts holding, re-arms (silently) when it stops. */
export function nextEpisode(prev: {active: boolean; epoch: number} | undefined, holds: boolean): {active: boolean; epoch: number; fire: boolean} {
    const active = prev?.active ?? false;
    const epoch = prev?.epoch ?? 0;
    if (holds && !active) return {active: true, epoch: epoch + 1, fire: true};
    if (!holds && active) return {active: false, epoch, fire: false};
    return {active, epoch, fire: false};
}
