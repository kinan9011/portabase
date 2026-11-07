import {describe, expect, it} from "vitest";
import {advanceSteps, done, fail, failRemaining, initialSteps, wait, type StepOutcome, type StepRecord} from "@/fork/runs/engine";
import {RUN_STEPS} from "@/fork/runs/vocab";

const T0 = new Date("2026-11-07T10:00:00Z");
type N = "a" | "b" | "c";
const names: N[] = ["a", "b", "c"];
const clock = () => { let t = T0.getTime(); return {now: () => new Date((t += 1000)), tick: (ms: number) => { t += ms; }}; };
const store = () => { const saved: StepRecord<N>[][] = []; return {saved, persist: async (s: StepRecord<N>[]) => { saved.push(s.map((x) => ({...x}))); }}; };

describe("runs: durable step engine (ARCH-13, fake clock)", () => {
    it("runs steps in order and persists after every state change", async () => {
        const order: string[] = [];
        const h = {a: async () => { order.push("a"); return done(); }, b: async () => { order.push("b"); return done(); }, c: async () => { order.push("c"); return done(); }};
        const s = store(); const c = clock();
        const r = await advanceSteps(initialSteps(names), h, {}, {now: c.now, persist: s.persist});
        expect(r.state).toBe("done");
        expect(order).toEqual(["a", "b", "c"]);
        expect(s.saved.length).toBe(3); // once per finished step
        expect(r.steps.every((x) => x.status === "done" && x.finishedAt && x.startedAt)).toBe(true);
    });

    it("a wait step keeps the sequence open and later steps do not run; the next tick resumes at the same step", async () => {
        let polls = 0;
        const order: string[] = [];
        const h = {a: async () => { order.push("a"); return done(); }, b: async (): Promise<StepOutcome> => { polls++; return polls < 3 ? wait() : done(); }, c: async () => { order.push("c"); return done(); }};
        const s = store(); const c = clock();
        let steps = initialSteps(names);
        let r = await advanceSteps(steps, h, {}, {now: c.now, persist: s.persist});
        expect(r.state).toBe("running");
        expect(order).toEqual(["a"]);
        r = await advanceSteps(r.steps, h, {}, {now: c.now, persist: s.persist});
        expect(r.state).toBe("running");
        r = await advanceSteps(r.steps, h, {}, {now: c.now, persist: s.persist});
        expect(r.state).toBe("done");
        expect(order).toEqual(["a", "c"]); // `a` was NOT re-run: it was persisted done
        expect(r.steps[1].attempts).toBe(3);
        steps = r.steps;
    });

    it("crash resume: a fresh process continues from the persisted state (done steps never re-run)", async () => {
        const calls: string[] = [];
        const h = {a: async () => { calls.push("a"); return done(); }, b: async () => { calls.push("b"); return done(); }, c: async () => { calls.push("c"); return done(); }};
        const persisted: StepRecord<N>[] = initialSteps(names).map((x, i) => (i === 0 ? {...x, status: "done" as const} : x));
        const r = await advanceSteps(persisted, h, {}, {now: clock().now, persist: store().persist});
        expect(calls).toEqual(["b", "c"]);
        expect(r.state).toBe("done");
    });

    it("fail ends the sequence with the fixed code and stays failed on later ticks", async () => {
        const calls: string[] = [];
        const h = {a: async () => done(), b: async () => fail("agent_did_not_start"), c: async () => { calls.push("c"); return done(); }};
        const r = await advanceSteps(initialSteps(names), h, {}, {now: clock().now, persist: store().persist});
        expect(r).toMatchObject({state: "failed", failedStep: "b", code: "agent_did_not_start"});
        const again = await advanceSteps(r.steps, h, {}, {now: clock().now, persist: store().persist});
        expect(again.state).toBe("failed");
        expect(calls).toEqual([]);
    });

    it("a thrown error is retried, then fails with internal_error — the message is never stored", async () => {
        let n = 0;
        const h = {a: async (): Promise<StepOutcome> => { n++; throw new Error("password=hunter2 at https://user:secret@host"); }, b: async () => done(), c: async () => done()};
        const s = store();
        let steps = initialSteps(names);
        let r = await advanceSteps(steps, h, {}, {now: clock().now, persist: s.persist, maxErrors: 3});
        expect(r.state).toBe("running");
        r = await advanceSteps(r.steps, h, {}, {now: clock().now, persist: s.persist, maxErrors: 3});
        r = await advanceSteps(r.steps, h, {}, {now: clock().now, persist: s.persist, maxErrors: 3});
        expect(r).toMatchObject({state: "failed", failedStep: "a", code: "internal_error"});
        expect(n).toBe(3);
        expect(JSON.stringify(s.saved)).not.toMatch(/hunter2|secret/);
        steps = r.steps;
    });

    it("failRemaining fails only unfinished steps, code on the first", () => {
        const base = initialSteps(names).map((x, i) => (i === 0 ? {...x, status: "done" as const} : x));
        const out = failRemaining(base, "cancelled", T0);
        expect(out.map((x) => x.status)).toEqual(["done", "failed", "failed"]);
        expect(out[1].code).toBe("cancelled");
        expect(out[2].code).toBeUndefined();
    });

    it("the W12 run sequence is fixed and has no mirror steps", () => {
        expect([...RUN_STEPS]).toEqual(["reauthorize", "refresh_inventory", "validate", "trigger", "track", "finalize"]);
        expect(JSON.stringify(RUN_STEPS)).not.toMatch(/mirror/i);
    });
});
