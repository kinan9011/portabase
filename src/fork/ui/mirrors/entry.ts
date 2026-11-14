import {STACK_DETAILS} from "@/fork/ui/labels";
import {MIRRORS} from "./labels";

export type MirrorEntry = {href: string} | {reason: string};
export type MirrorEntryFacts = {enabled: boolean; canManage: boolean; locked: boolean; verifiedCount: number; runnerCount: number; stackId: string};

/** Entry precedence of "Create test mirror" (plan-W22b DD-3): first failing precondition wins and is shown as the visible reason; opt-in / isolation / busy are fixed inside the wizard. */
export function mirrorEntry(f: MirrorEntryFacts): MirrorEntry {
    if (!f.enabled) return {reason: STACK_DETAILS.actions.mirror.reason};
    if (!f.canManage) return {reason: MIRRORS.entry.role};
    if (f.locked) return {reason: MIRRORS.entry.locked};
    if (f.verifiedCount === 0) return {reason: MIRRORS.entry.noVerified};
    if (f.runnerCount === 0) return {reason: MIRRORS.entry.noRunner};
    return {href: `/dashboard/mirrors/new?stack=${f.stackId}`};
}
