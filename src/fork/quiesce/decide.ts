/** W17b run-time decision (D11): use the composite quiesce task or run crash-consistent and say why. Pure; precedence is pinned by a test. */
import type {OkPlan, QuiescePlan} from "./plan";
import {QUIESCE_CAPABILITY, type QuiesceSkipReason} from "./vocab";

export type QuiesceDecisionInput = {
    flagOn: boolean;
    mode: "on" | "locked" | "off";
    policy: {enabled: boolean; services: string[]; maxStopSeconds: number; enabledBy: string | null} | null;
    enablerHasRight: boolean;
    agentEnrolled: boolean;
    agentCapabilities: readonly string[];
    activeRestoreOnAgent: boolean;
    plan: QuiescePlan | null;
};
/** `reason: null` = the policy has quiesce off: no quiesce, no notice. */
export type QuiesceDecision = {use: false; reason: QuiesceSkipReason | null} | {use: true; plan: OkPlan};

export function decideQuiesce(i: QuiesceDecisionInput): QuiesceDecision {
    if (!i.policy?.enabled) return {use: false, reason: null};
    if (!i.flagOn) return {use: false, reason: "flag_off"};
    if (i.mode !== "on") return {use: false, reason: "locked"};
    if (!i.agentEnrolled) return {use: false, reason: "agent_unenrolled"};
    if (!i.agentCapabilities.includes(QUIESCE_CAPABILITY)) return {use: false, reason: "capability_missing"};
    if (!i.enablerHasRight || !i.policy.enabledBy) return {use: false, reason: "enabler_lost"};
    if (i.activeRestoreOnAgent) return {use: false, reason: "restore_busy"};
    if (!i.plan || !i.plan.ok) return {use: false, reason: "plan_blocked"};
    return {use: true, plan: i.plan};
}
