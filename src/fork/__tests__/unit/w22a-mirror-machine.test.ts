import {describe, expect, it} from "vitest";
import {initialSteps, type StepRecord} from "@/fork/runs/engine";
import {allowed, IllegalTransition, isActive, isTerminal, stateOf, transition} from "@/fork/mirror/machine";
import {
    ACTIVE_REVISION_STATES, MIRROR_STEPS, type MirrorStep, REVISION_STATES, type RevisionState, STEP_STATE, TERMINAL_REVISION_STATES,
} from "@/fork/mirror/vocab";

const LADDER: RevisionState[] = ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting", "healthchecking", "ready"];

describe("W22a mirror state machine", () => {
    it("active + terminal partition the state list", () => {
        const all = new Set([...ACTIVE_REVISION_STATES, ...TERMINAL_REVISION_STATES]);
        expect([...all].sort()).toEqual([...REVISION_STATES].sort());
        for (const s of ACTIVE_REVISION_STATES) expect(TERMINAL_REVISION_STATES).not.toContain(s);
    });

    it("full transition table: every pair", () => {
        for (const from of REVISION_STATES) {
            for (const to of REVISION_STATES) {
                const a = LADDER.indexOf(from);
                const b = LADDER.indexOf(to);
                let expected: boolean;
                if (from === "ready") expected = to === "rolled_back";
                else if (TERMINAL_REVISION_STATES.includes(from as never)) expected = false;
                else if (to === "blocked" || to === "failed" || to === "cancelled") expected = true;
                else expected = b === a + 1 || (from === "transforming" && to === "starting");
                expect(allowed(from, to), `${from} -> ${to}`).toBe(expected);
            }
        }
    });

    it("terminal states are immutable except ready -> rolled_back", () => {
        for (const t of ["blocked", "failed", "cancelled", "rolled_back"] as const) {
            for (const to of REVISION_STATES) expect(() => transition(t, to)).toThrow(IllegalTransition);
        }
        expect(transition("ready", "rolled_back")).toBe("rolled_back");
        expect(() => transition("ready", "failed")).toThrow(IllegalTransition);
    });

    it("failed/blocked/cancelled never reach ready; rolled_back only from ready", () => {
        for (const from of REVISION_STATES) {
            if (from !== "ready") expect(allowed(from, "rolled_back")).toBe(false);
            if (from !== "healthchecking") expect(allowed(from, "ready")).toBe(false);
        }
    });

    it("same active state is a no-op, same terminal state is illegal", () => {
        expect(transition("staging", "staging")).toBe("staging");
        expect(() => transition("failed", "failed")).toThrow(IllegalTransition);
    });

    it("stateOf: first unfinished step; ready is never derived", () => {
        const steps = initialSteps(MIRROR_STEPS) as StepRecord<MirrorStep>[];
        expect(stateOf(steps)).toBe("validating");
        let prev: RevisionState = "validating";
        MIRROR_STEPS.forEach((name, i) => {
            for (let j = 0; j <= i; j++) steps[j].status = "done";
            const s = stateOf(steps);
            if (i < MIRROR_STEPS.length - 1) {
                expect(s).toBe(STEP_STATE[MIRROR_STEPS[i + 1]]);
                expect(allowed(prev, s) || prev === s, `${prev} -> ${s}`).toBe(true);
                prev = s;
            } else {
                expect(s).toBe("healthchecking");
            }
            expect(s).not.toBe("ready");
            void name;
        });
        expect(stateOf([])).toBe("requested");
    });

    it("isActive / isTerminal agree with the lists", () => {
        for (const s of REVISION_STATES) expect(isActive(s)).toBe(!isTerminal(s));
    });
});
