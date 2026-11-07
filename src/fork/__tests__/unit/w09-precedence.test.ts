import {describe, expect, it} from "vitest";
import {cleanInventory, FULL_COVERAGE} from "@/fork/__tests__/w09-fixtures";
import {derivePrimaryState, deriveDeletable, deriveFacets, EMPTY_CONTEXT, PRIMARY_STATES, validateCompleteness, type FacetInputs, type PrimaryInputs, type PrimaryState} from "@/fork/completeness";

const base: PrimaryInputs = {hasActivePolicy: false, lastRunFailed: false, coverageGap: false, verifiedRpCount: 0, pendingRpCount: 0, hoursSinceLastVerified: null, staleAfterHours: null, kitVerified: null};
const st = (o: Partial<PrimaryInputs>) => derivePrimaryState({...base, ...o});

/** Minimal inputs that make EACH state the answer, and the extra inputs that make it (also) true. */
const WITNESS: Record<PrimaryState, Partial<PrimaryInputs>> = {
    failed: {hasActivePolicy: true, lastRunFailed: true},
    partial: {hasActivePolicy: true, coverageGap: true, kitVerified: true, verifiedRpCount: 1},
    stale: {hasActivePolicy: true, verifiedRpCount: 1, hoursSinceLastVerified: 100, staleAfterHours: 48, kitVerified: true},
    kit_not_verified: {hasActivePolicy: true, verifiedRpCount: 1, hoursSinceLastVerified: 1, staleAfterHours: 48, kitVerified: false},
    // mutually exclusive with Protected by definition (0 vs ≥ 1 verified RP), so the witness pins the count
    awaiting_first_backup: {hasActivePolicy: true, kitVerified: true, verifiedRpCount: 0, pendingRpCount: 2},
    protected: {hasActivePolicy: true, verifiedRpCount: 1, hoursSinceLastVerified: 1, staleAfterHours: 48, kitVerified: true},
    unprotected: {},
};

describe("§4.6 precedence: Failed > Partial > Stale > Kit not verified > Awaiting first backup > Protected > Unprotected", () => {
    it("order is exactly the plan's", () => {
        expect([...PRIMARY_STATES]).toEqual(["failed", "partial", "stale", "kit_not_verified", "awaiting_first_backup", "protected", "unprotected"]);
    });
    it.each(PRIMARY_STATES.map((s) => [s]))("%s is reachable on its own witness", (s) => {
        expect(st(WITNESS[s])).toBe(s);
    });
    // One test per ordered pair: when the witnesses of A and B are BOTH true, the higher-precedence state wins.
    const pairs = PRIMARY_STATES.flatMap((a, i) => PRIMARY_STATES.slice(i + 1).map((b) => [a, b] as const));
    it("21 pairs enumerated", () => expect(pairs).toHaveLength(21));
    it.each(pairs.map(([a, b]) => [a, b]))("%s beats %s", (a, b) => {
        const merged = {...WITNESS[b as PrimaryState], ...WITNESS[a as PrimaryState]};
        expect(st(merged)).toBe(a);
        // and the loser's own witness really would have produced the loser
        expect(st(WITNESS[b as PrimaryState])).toBe(b);
    });
});

describe("the three guarantees of the plan", () => {
    it("Kit not verified never hides Failed / Partial / Stale (§4.2) and replaces Protected / Awaiting", () => {
        const kitBad = {hasActivePolicy: true, kitVerified: false as const};
        expect(st({...kitBad, lastRunFailed: true})).toBe("failed");
        expect(st({...kitBad, coverageGap: true})).toBe("partial");
        expect(st({...kitBad, verifiedRpCount: 1, hoursSinceLastVerified: 99, staleAfterHours: 48})).toBe("stale");
        expect(st({...kitBad, verifiedRpCount: 1})).toBe("kit_not_verified"); // would be Protected
        expect(st({...kitBad})).toBe("kit_not_verified"); // would be Awaiting first backup
    });
    it("kit unknown (null) fails closed exactly like false; only `true` lets Protected through", () => {
        expect(st({hasActivePolicy: true, verifiedRpCount: 1, kitVerified: null})).toBe("kit_not_verified");
        expect(st({hasActivePolicy: true, verifiedRpCount: 1, kitVerified: true})).toBe("protected");
    });
    it("Kit not verified applies only to stacks with an active policy", () => {
        expect(st({hasActivePolicy: false, kitVerified: false})).toBe("unprotected");
        expect(st({hasActivePolicy: false, verifiedRpCount: 2, kitVerified: false})).toBe("unprotected");
    });
    it("D43: pending_verification alone is Awaiting first backup, never Protected; only verified RPs count", () => {
        expect(st({hasActivePolicy: true, kitVerified: true, pendingRpCount: 3, verifiedRpCount: 0})).toBe("awaiting_first_backup");
        expect(st({hasActivePolicy: true, kitVerified: true, pendingRpCount: 3, verifiedRpCount: 1})).toBe("protected");
    });
    it("a coverage gap (incl. a DB saved only by file copy, D29) can never be Protected", () => {
        expect(st({...WITNESS.protected, coverageGap: true})).toBe("partial");
    });
    it("a stack nothing is configured for stays Unprotected even with gaps (they show as blockers)", () => {
        expect(st({coverageGap: true})).toBe("unprotected");
    });
    it("no schedule known ⇒ never Stale; exactly at the threshold is not yet stale", () => {
        expect(st({...WITNESS.protected, staleAfterHours: null, hoursSinceLastVerified: 10_000})).toBe("protected");
        expect(st({...WITNESS.protected, hoursSinceLastVerified: 48, staleAfterHours: 48})).toBe("protected");
        expect(st({...WITNESS.protected, hoursSinceLastVerified: 48.01, staleAfterHours: 48})).toBe("stale");
    });
    it("a deactivated policy with old verified RPs: Stale if overdue, else Unprotected (never Protected)", () => {
        expect(st({verifiedRpCount: 1, hoursSinceLastVerified: 1, staleAfterHours: 48, kitVerified: true})).toBe("unprotected");
        expect(st({verifiedRpCount: 1, hoursSinceLastVerified: 99, staleAfterHours: 48})).toBe("stale");
    });
});

describe("exhaustive grid: the function is total and `protected` is impossible unless every condition holds", () => {
    const bools = [false, true];
    const counts = [0, 1];
    const ages: [number | null, number | null][] = [[null, null], [1, 48], [100, 48], [100, null], [null, 48]];
    const kits: (boolean | null)[] = [null, false, true];
    let n = 0;
    it("all combinations", () => {
        for (const hasActivePolicy of bools) for (const lastRunFailed of bools) for (const coverageGap of bools)
            for (const verifiedRpCount of counts) for (const pendingRpCount of counts) for (const [hoursSinceLastVerified, staleAfterHours] of ages) for (const kitVerified of kits) {
                const i: PrimaryInputs = {hasActivePolicy, lastRunFailed, coverageGap, verifiedRpCount, pendingRpCount, hoursSinceLastVerified, staleAfterHours, kitVerified};
                const s = derivePrimaryState(i);
                n++;
                expect(PRIMARY_STATES).toContain(s);
                if (s === "protected") {
                    expect(i.hasActivePolicy && i.verifiedRpCount > 0 && !i.coverageGap && !i.lastRunFailed && i.kitVerified === true).toBe(true);
                    const stale = i.hoursSinceLastVerified !== null && i.staleAfterHours !== null && i.hoursSinceLastVerified > i.staleAfterHours;
                    expect(stale).toBe(false);
                }
                if (i.lastRunFailed) expect(s).toBe("failed");
                if (s === "awaiting_first_backup") expect(i.verifiedRpCount).toBe(0);
                if (s === "kit_not_verified") expect(i.hasActivePolicy && i.kitVerified !== true).toBe(true);
                if (i.verifiedRpCount === 0) expect(s).not.toBe("protected"); // pending never yields Protected
            }
        expect(n).toBe(2 * 2 * 2 * 2 * 2 * 5 * 3);
    });
});

describe("facets (§4.6 1–7 + locked)", () => {
    const fi: FacetInputs = {hasActivePolicy: true, hoursSinceLastVerified: 5, verifying: false, daysSinceTestRestore: null, channelDeletable: [], pausedAfterReauthorization: false, inventoryStale: false, configLocked: false};
    const report = validateCompleteness(cleanInventory(), {...EMPTY_CONTEXT, ...FULL_COVERAGE});

    it("3: not checked fails closed; worst-of channels", () => {
        expect(deriveDeletable([])).toBe("not_checked");
        expect(deriveDeletable(["no", "not_checked"])).toBe("not_checked");
        expect(deriveDeletable(["no", "yes"])).toBe("yes");
        expect(deriveDeletable(["no", "no"])).toBe("no");
    });
    it("4: host compromise is a facet for yes / not_checked on an active policy; never feeds Partial", () => {
        expect(deriveFacets(fi, report).hostCompromise).toBe(true);
        expect(deriveFacets({...fi, channelDeletable: ["no"]}, report).hostCompromise).toBe(false);
        expect(deriveFacets({...fi, hasActivePolicy: false}, report).hostCompromise).toBe(false);
        // the primary-state function has no input for it at all, so it cannot yield Partial; assert the shape stays that way
        expect(Object.keys(base)).not.toContain("hostCompromise");
        expect(st({...WITNESS.protected})).toBe("protected");
    });
    it("1/2/6/7/locked are passed through, not invented", () => {
        const f = deriveFacets({...fi, verifying: true, daysSinceTestRestore: 3, pausedAfterReauthorization: true, inventoryStale: true, configLocked: true}, report);
        expect(f).toMatchObject({lastGoodBackup: {hoursAgo: 5, verifying: true}, testRestore: {daysAgo: 3}, pausedAfterReauthorization: true, inventoryStale: true, configLocked: true});
        expect(deriveFacets({...fi, hoursSinceLastVerified: null}, report).lastGoodBackup.hoursAgo).toBeNull();
    });
    it("5: consistency per member — engine dump = saved safely, file copy = copied while running; app paused is never produced in R1", () => {
        const inv = cleanInventory({services: [{name: "db", state: "running", image: {ref: "postgres:17", pinned: false, built_locally: false}, ports: [], networks: [], mounts: ["m:0000000000000001"], env_keys: [], database_hint: {engine: "postgresql", basis: "image"}}], mounts: [{id: "m:0000000000000001", kind: "named_volume", volume_name: "app_data", destination: "/d", rw: true, consumers: ["db"], ownership: "stack_owned"}], env_files: []});
        const r = validateCompleteness(inv, {...EMPTY_CONTEXT, coverage: {...FULL_COVERAGE.coverage, "db:db": "engine_dump"}, probes: FULL_COVERAGE.probes});
        const levels = deriveFacets(fi, r).consistency;
        expect(levels).toContainEqual({member: "db", level: "database_saved_safely"});
        expect(levels).toContainEqual({member: "app_data", level: "files_copied_running"});
        expect(levels.some((l) => l.level === "app_paused")).toBe(false);
    });
});
