import type {RunReason} from "@/fork/runs/vocab";
import {RUNS} from "@/fork/ui/labels";

/** Run/item reason CODE → plain sentence (the timeout minutes come from the server-side limits). The only place a code becomes text; unknown codes cannot occur (closed enum). */
export function runReasonText(reason: RunReason, limits: {waitMinutes: number; stallMinutes: number}): string {
    return (RUNS.reasons[reason] as (n: number) => string)(reason === "agent_made_no_progress" ? limits.stallMinutes : limits.waitMinutes);
}
