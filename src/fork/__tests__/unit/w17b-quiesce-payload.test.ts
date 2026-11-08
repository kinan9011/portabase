import {describe, expect, it} from "vitest";
import {buildQuiescePayload, buildQuiesceStartPayload, QuiescePayloadSchema, QuiesceResultSchema, QuiesceStartPayloadSchema} from "@/fork/quiesce/payload";

const U = "11111111-1111-4111-8111-111111111111";
const good = () => ({v: 1, run_id: U, stack_id: U, project: "forklab-quiesce", targets: [{service: "web", container_id: "0123456789ab"}, {service: "db", container_id: "fedcba987654"}], max_stop_seconds: 600, stop_timeout_cap_seconds: 120, start_timeout_seconds: 180, dry_run: false});

describe("W17b payload schemas", () => {
    it("accepts the planner's payload and refuses every free-form addition", () => {
        expect(QuiescePayloadSchema.safeParse(good()).success).toBe(true);
        for (const k of ["command", "image", "path", "container_name", "env", "volumes"]) expect(QuiescePayloadSchema.safeParse({...good(), [k]: "x"}).success, k).toBe(false);
        expect(QuiescePayloadSchema.safeParse({...good(), targets: [{service: "web", container_id: "0123456789ab", name: "x"}]}).success).toBe(false);
    });
    it("grammar and bounds", () => {
        const bad = (o: object) => QuiescePayloadSchema.safeParse({...good(), ...o}).success;
        expect(bad({targets: []})).toBe(false);
        expect(bad({targets: Array.from({length: 33}, (_, i) => ({service: `s${i}`, container_id: "0123456789ab"}))})).toBe(false);
        expect(bad({targets: [{service: "a", container_id: "0123456789ab"}, {service: "a", container_id: "fedcba987654"}]})).toBe(false);
        expect(bad({targets: [{service: "a", container_id: "0123456789ab"}, {service: "b", container_id: "0123456789ab"}]})).toBe(false);
        expect(bad({targets: [{service: "a b", container_id: "0123456789ab"}]})).toBe(false);
        expect(bad({targets: [{service: "a", container_id: "0123456789AB"}]})).toBe(false);
        expect(bad({targets: [{service: "a", container_id: "01234567"}]})).toBe(false);
        expect(bad({project: "Bad Project"})).toBe(false);
        for (const [k, v] of [["max_stop_seconds", 59], ["max_stop_seconds", 3601], ["stop_timeout_cap_seconds", 9], ["stop_timeout_cap_seconds", 301], ["start_timeout_seconds", 29], ["start_timeout_seconds", 601], ["v", 2]] as const) expect(bad({[k]: v}), `${k}=${v}`).toBe(false);
        expect(JSON.stringify(good()).length).toBeLessThan(2048);
    });
    it("builders validate; the start payload carries ONLY the task id and the project", () => {
        expect(() => buildQuiescePayload({runId: U, stackId: U, project: "p", targets: [], maxStopSeconds: 600, stopTimeoutCapSeconds: 120, startTimeoutSeconds: 180, dryRun: false})).toThrow();
        const s = buildQuiesceStartPayload({quiesceTaskId: U, project: "p"});
        expect(Object.keys(s).sort()).toEqual(["project", "quiesce_task_id", "v"]);
        expect(QuiesceStartPayloadSchema.safeParse({...s, ids: ["x"]}).success).toBe(false);
    });
    it("result schema: tolerant of the agent's summary, strict about keys", () => {
        const r = {project: "p", released_by: "dashboard", window_intact: true, downtime_ms: 61234, all_verified: true, stopped_count: 2, verified_count: 2,
            containers: [{service: "web", id12: "0123456789ab", was_running: true, stopped: true, started: true, outcome: "verified"}]};
        expect(QuiesceResultSchema.safeParse(r).success).toBe(true);
        expect(QuiesceResultSchema.safeParse({...r, reason: "restart_unverified"}).success).toBe(true);
        expect(QuiesceResultSchema.safeParse({...r, surprise: 1}).success).toBe(false);
        expect(QuiesceResultSchema.safeParse({truncated: true}).success).toBe(false); // handled by the reconcile fallback
    });
});
