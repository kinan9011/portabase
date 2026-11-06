import {describe, expect, it, vi} from "vitest";
import {
    assertForkConfigAllowed, currentForkMode, ForkLockedError, getLaneStatus, registerActivePolicyProbe,
    registerSelfCheck, resolveForkMode, setLaneStatus,
} from "@/fork/mode";

const ON = {FORK_STACKS_ENABLED: "true"};

describe("resolveForkMode (ADR-010 table)", () => {
    const cases: [string, Parameters<typeof resolveForkMode>[0], string, string?][] = [
        ["flags off, no policy", {flagsOn: false, activePolicyCount: 0, selfCheckOk: true, laneOk: true}, "off"],
        ["flags on, healthy, no policy", {flagsOn: true, activePolicyCount: 0, selfCheckOk: true, laneOk: true}, "on"],
        ["flags on, healthy, policies", {flagsOn: true, activePolicyCount: 3, selfCheckOk: true, laneOk: true}, "on"],
        ["flags OFF with active policy → locked (never silently unscheduled)", {flagsOn: false, activePolicyCount: 1, selfCheckOk: true, laneOk: true}, "locked", "flags-off"],
        ["self-check fails with active policy → locked", {flagsOn: true, activePolicyCount: 2, selfCheckOk: false, laneOk: true}, "locked", "self-check-failed"],
        ["lane fails with active policy → locked", {flagsOn: true, activePolicyCount: 2, selfCheckOk: true, laneOk: false}, "locked", "lane-failed"],
        ["self-check fails, no policy → off", {flagsOn: true, activePolicyCount: 0, selfCheckOk: false, laneOk: true}, "off"],
        ["lane fails, no policy → off", {flagsOn: true, activePolicyCount: 0, selfCheckOk: true, laneOk: false}, "off"],
    ];
    for (const [name, input, mode, reason] of cases) {
        it(name, () => {
            const r = resolveForkMode(input);
            expect(r.mode).toBe(mode);
            expect(r.lockReason).toBe(reason);
        });
    }
});

describe("currentForkMode", () => {
    it("is off and DB-free with defaults", async () => {
        expect((await currentForkMode()).mode).toBe("off");
    });
    it("flag on → on", async () => {
        expect((await currentForkMode({env: ON})).mode).toBe("on");
    });
    it("flags off + probe reports an active policy → locked/flags-off", async () => {
        registerActivePolicyProbe(async () => 2);
        expect(await currentForkMode({env: {}})).toMatchObject({mode: "locked", lockReason: "flags-off"});
    });
    it("probe throwing is treated as 'may be active' → locked, never off", async () => {
        registerActivePolicyProbe(async () => { throw new Error("db down"); });
        expect((await currentForkMode({env: {}})).mode).toBe("locked");
    });
    it("self-check failure with active policy → locked with the failed check as detail", async () => {
        registerActivePolicyProbe(async () => 1);
        registerSelfCheck(async () => ({ok: false, failed: "AUTH_SIGNUP_ENABLED=true"}));
        expect(await currentForkMode({env: ON})).toMatchObject({mode: "locked", lockReason: "self-check-failed", detail: "AUTH_SIGNUP_ENABLED=true"});
    });
    it("a failed lane with an active policy locks; an applied lane does not", async () => {
        registerActivePolicyProbe(async () => 1);
        setLaneStatus({state: "skipped-upstream-incomplete", detail: "1/94 not applied"});
        expect(await currentForkMode({env: ON})).toMatchObject({mode: "locked", lockReason: "lane-failed"});
        setLaneStatus({state: "applied"});
        expect((await currentForkMode({env: ON})).mode).toBe("on");
        expect(getLaneStatus().state).toBe("applied");
    });
    it("caches for 60 s, then re-evaluates", async () => {
        const probe = vi.fn(async () => 0);
        registerActivePolicyProbe(probe);
        await currentForkMode({now: 1_000, env: {}});
        await currentForkMode({now: 30_000, env: {}});
        expect(probe).toHaveBeenCalledTimes(1);
        await currentForkMode({now: 61_001, env: {}});
        expect(probe).toHaveBeenCalledTimes(2);
    });
});

describe("assertForkConfigAllowed", () => {
    it("throws ForkLockedError unless mode is on", async () => {
        await expect(assertForkConfigAllowed({env: {}})).rejects.toBeInstanceOf(ForkLockedError);
        registerActivePolicyProbe(async () => 1);
        await expect(assertForkConfigAllowed({env: {}})).rejects.toThrow(/locked: flags-off/);
    });
    it("passes when on", async () => {
        await expect(assertForkConfigAllowed({env: ON})).resolves.toBeUndefined();
    });
});
