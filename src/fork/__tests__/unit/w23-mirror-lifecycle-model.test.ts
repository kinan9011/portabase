import {describe, expect, it} from "vitest";
import {nextMirrorStatus, type LifecycleEvent} from "@/fork/mirror/lifecycle";
import {MIRROR_STATUSES, type MirrorStatus} from "@/fork/mirror/vocab";
import {mirrorActions} from "@/fork/ui/mirrors/model";

const LEGAL: [MirrorStatus, LifecycleEvent, MirrorStatus][] = [
    ["ready", "stop_requested", "stopping"], ["failed", "stop_requested", "stopping"], ["stopping", "stop_done", "stopped"], ["stopping", "stop_failed", "failed"],
    ["stopped", "start_requested", "starting"], ["starting", "start_done", "ready"], ["starting", "start_aborted", "stopped"], ["starting", "start_failed", "failed"],
];
const EVENTS: LifecycleEvent[] = ["stop_requested", "stop_done", "stop_failed", "start_requested", "start_done", "start_aborted", "start_failed"];

describe("nextMirrorStatus (W23 Part B)", () => {
    it("every legal pair moves, every other pair throws", () => {
        for (const [from, ev, to] of LEGAL) expect(nextMirrorStatus(from, ev), `${from} ${ev}`).toBe(to);
        let illegal = 0;
        for (const from of MIRROR_STATUSES) for (const ev of EVENTS) {
            if (LEGAL.some((l) => l[0] === from && l[1] === ev)) continue;
            illegal += 1;
            expect(() => nextMirrorStatus(from, ev), `${from} ${ev}`).toThrow(/illegal mirror status move/);
        }
        expect(illegal).toBe(MIRROR_STATUSES.length * EVENTS.length - LEGAL.length);
    });
    it("a mirror can never be started from ready, nor stopped while creating / starting / deleting", () => {
        expect(() => nextMirrorStatus("ready", "start_requested")).toThrow();
        for (const s of ["creating", "starting", "deleting", "deleted", "cancelled"] as const) expect(() => nextMirrorStatus(s, "stop_requested")).toThrow();
    });
});

describe("mirrorActions with Stop / Start", () => {
    const can = (o: Partial<{manage: boolean; locked: boolean; flagOn: boolean}> = {}) => ({manage: true, locked: false, flagOn: true, stopStart: true, ...o});
    const facts = (status: string, hasActiveRevision = true) => ({status, hasActiveRevision, activeCreation: false, wipeFailed: false});
    it("ready: Stop + Delete, no Start", () => {
        const a = mirrorActions(facts("ready"), can());
        expect(a.stop).toEqual({enabled: true}); expect(a.delete).toEqual({enabled: true}); expect(a.start).toEqual({hidden: true});
    });
    it("stopped: Start (blocked with a visible reason while locked or with the flag off) + Delete, no Stop", () => {
        expect(mirrorActions(facts("stopped"), can()).start).toEqual({enabled: true});
        expect(mirrorActions(facts("stopped"), can({locked: true})).start).toMatchObject({reason: expect.stringContaining("locked")});
        expect(mirrorActions(facts("stopped"), can({flagOn: false})).start).toHaveProperty("reason");
        expect(mirrorActions(facts("stopped"), can()).stop).toEqual({hidden: true});
        expect(mirrorActions(facts("stopped"), can({locked: true})).delete).toEqual({enabled: true}); // OD-W23-2
    });
    it("failed with an active revision: retry Stop + Delete; without one: Delete only", () => {
        expect(mirrorActions(facts("failed"), can()).stop).toEqual({enabled: true});
        expect(mirrorActions(facts("failed", false), can()).stop).toEqual({hidden: true});
    });
    it("in-flight statuses block Stop / Start / Delete with a reason; members get nothing", () => {
        for (const s of ["stopping", "starting"]) { const a = mirrorActions(facts(s), can()); expect(a.stop).toHaveProperty("reason"); expect(a.start).toHaveProperty("reason"); expect(a.delete).toHaveProperty("reason"); }
        const m = mirrorActions(facts("ready"), can({manage: false}));
        expect(Object.values(m).every((x) => "hidden" in x)).toBe(true);
    });
});
