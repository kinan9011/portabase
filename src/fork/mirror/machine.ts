/**
 * Mirror revision state machine (plan-W22a §3.2). PURE. Every DB write of `state` goes through `transition()` (a static test greps
 * `src/fork/mirror/**` for any other `state:` write). Terminal states are final, except `ready → rolled_back` (reserved for W24/W25).
 */
import type {StepRecord} from "@/fork/runs/engine";
import {ACTIVE_REVISION_STATES, type MirrorStep, type RevisionState, STEP_STATE, TERMINAL_REVISION_STATES} from "./vocab";

const LADDER: readonly RevisionState[] = ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting",
    "healthchecking", "ready"];

export class IllegalTransition extends Error {
    constructor(readonly from: RevisionState, readonly to: RevisionState) {
        super(`illegal mirror transition ${from} -> ${to}`);
    }
}

export const isActive = (s: RevisionState): boolean => (ACTIVE_REVISION_STATES as readonly string[]).includes(s);
export const isTerminal = (s: RevisionState): boolean => (TERMINAL_REVISION_STATES as readonly string[]).includes(s);

/**
 * State shown for a step list: the state of the first unfinished step. All steps done still shows the last step's state: `ready` is
 * NEVER derived here, only the `activate` handler sets it (inside the gate transaction, §3.5).
 */
export function stateOf(steps: readonly StepRecord<MirrorStep>[]): RevisionState {
    const cur = steps.find((s) => s.status !== "done") ?? steps[steps.length - 1];
    return cur ? STEP_STATE[cur.name] : "requested";
}

export function allowed(from: RevisionState, to: RevisionState): boolean {
    if (from === "ready") return to === "rolled_back";
    if (isTerminal(from)) return false;
    if (to === "blocked" || to === "failed" || to === "cancelled") return true; // any ACTIVE state
    const a = LADDER.indexOf(from);
    const b = LADDER.indexOf(to);
    if (a < 0 || b < 0) return false;
    if (b === a + 1) return true;
    // `restoring_db` may be skipped when that step is absent from the list
    return from === "transforming" && to === "starting";
}

/** The only way to compute a new `state` value. Same state is a no-op (several steps share one state). */
export function transition(from: RevisionState, to: RevisionState): RevisionState {
    if (from === to && isActive(from)) return to;
    if (!allowed(from, to)) throw new IllegalTransition(from, to);
    return to;
}
