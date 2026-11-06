import {describe, expect, it, vi} from "vitest";
import {registerForkRuntimeTask, startForkRuntime, tasksForMode} from "@/fork/runtime";

describe("fork runtime planes", () => {
    const setup = () => {
        const sched = vi.fn();
        const disc = vi.fn();
        registerForkRuntimeTask({name: "stack-schedules", plane: "runtime", start: sched});
        registerForkRuntimeTask({name: "discovery-sync", plane: "config", start: disc});
        return {sched, disc};
    };
    it("off starts nothing", async () => {
        const {sched, disc} = setup();
        expect((await startForkRuntime("off")).started).toEqual([]);
        expect(sched).not.toHaveBeenCalled();
        expect(disc).not.toHaveBeenCalled();
    });
    it("locked keeps the runtime plane (schedules) and drops the config plane", async () => {
        const {sched, disc} = setup();
        expect((await startForkRuntime("locked")).started).toEqual(["stack-schedules"]);
        expect(sched).toHaveBeenCalledOnce();
        expect(disc).not.toHaveBeenCalled();
    });
    it("on starts both planes", async () => {
        setup();
        expect(tasksForMode("on").map((t) => t.name)).toEqual(["stack-schedules", "discovery-sync"]);
    });
    it("a failing task is reported and does not stop the others", async () => {
        const ok = vi.fn();
        registerForkRuntimeTask({name: "bad", plane: "runtime", start: () => { throw new Error("boom"); }});
        registerForkRuntimeTask({name: "good", plane: "runtime", start: ok});
        const r = await startForkRuntime("on");
        expect(r.failed).toEqual([{name: "bad", error: "boom"}]);
        expect(r.started).toEqual(["good"]);
    });
    it("duplicate names are rejected", () => {
        registerForkRuntimeTask({name: "x", plane: "runtime", start: () => undefined});
        expect(() => registerForkRuntimeTask({name: "x", plane: "runtime", start: () => undefined})).toThrow(/already registered/);
    });
});
