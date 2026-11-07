import {describe, expect, it} from "vitest";
import {evaluateConditions, nextEpisode} from "@/fork/notifications/conditions";
import {backoffMs, BACKOFF_MINUTES} from "@/fork/notifications/vocab";

const base = {primary: "awaiting_first_backup" as const, hoursSinceVerified: null, hoursSinceActivation: 1, staleAfterHours: 36, minHours: 12};
const get = (o: Partial<typeof base>, kind: string) => evaluateConditions({...base, ...o}).find((c) => c.kind === kind)!;

describe("alert conditions (§4.7, D43)", () => {
    it("drift to Partial: only the primary state Partial", () => {
        expect(get({primary: "partial"}, "stack.partial").holds).toBe(true);
        for (const p of ["failed", "stale", "kit_not_verified", "awaiting_first_backup", "protected", "unprotected"] as const) expect(get({primary: p}, "stack.partial").holds).toBe(false);
    });
    it("dead-man counts VERIFIED backups only: a verified RP resets it, with none the activation time is the reference", () => {
        expect(get({hoursSinceVerified: 2, hoursSinceActivation: 500}, "stack.no_good_backup").holds).toBe(false);
        expect(get({hoursSinceVerified: null, hoursSinceActivation: 20}, "stack.no_good_backup").holds).toBe(false);
        expect(get({hoursSinceVerified: null, hoursSinceActivation: 37}, "stack.no_good_backup").holds).toBe(true);
        expect(get({hoursSinceVerified: 40, hoursSinceActivation: 500}, "stack.no_good_backup")).toMatchObject({holds: true, hours: 40});
    });
    it("threshold = max(floor, 1.5 × interval) — an hourly schedule is floored, a weekly one is its own", () => {
        expect(get({staleAfterHours: 1.5, hoursSinceActivation: 11}, "stack.no_good_backup").holds).toBe(false);
        expect(get({staleAfterHours: 1.5, hoursSinceActivation: 13}, "stack.no_good_backup").holds).toBe(true);
        expect(get({staleAfterHours: 252, hoursSinceActivation: 200}, "stack.no_good_backup").holds).toBe(false);
        expect(get({staleAfterHours: null, hoursSinceActivation: 13}, "stack.no_good_backup").holds).toBe(true);
    });
});

describe("alert episodes: one notification per episode, silent re-arm", () => {
    it("fires on start, not while it keeps holding, re-arms on clear, fires again with a new epoch", () => {
        let s = nextEpisode(undefined, false);
        expect(s).toEqual({active: false, epoch: 0, fire: false});
        s = nextEpisode(s, true); expect(s).toEqual({active: true, epoch: 1, fire: true});
        s = nextEpisode(s, true); expect(s).toEqual({active: true, epoch: 1, fire: false});
        s = nextEpisode(s, false); expect(s).toEqual({active: false, epoch: 1, fire: false});
        s = nextEpisode(s, true); expect(s).toEqual({active: true, epoch: 2, fire: true});
    });
});

describe("retry backoff", () => {
    it("grows and is capped by the schedule", () => {
        expect(backoffMs(1)).toBe(60_000);
        expect(backoffMs(2)).toBe(5 * 60_000);
        expect(backoffMs(99)).toBe(BACKOFF_MINUTES.at(-1)! * 60_000);
        expect(backoffMs(0)).toBe(60_000);
    });
});
