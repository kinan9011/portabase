import {describe, expect, it} from "vitest";
import {evaluateProbe, RunnerNotIsolatedError, type EvalInput} from "@/fork/runner/evaluate";
import {targetsSha, type ProbeTarget} from "@/fork/runner/targets";

/** Every timestamp derives from a real `new Date()` plus an offset (never a fixed past instant vs the real clock). */
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3600e3;
const PROBE_ID = "99999999-9999-4999-8999-999999999999";
const TARGETS: ProbeTarget[] = [
    {id: "t01", kind: "tcp", host: "10.20.30.25", port: 25, class: "smtp", label: "Prod SMTP"},
    {id: "t02", kind: "tcp", host: "10.20.30.54", port: 5432, class: "database", label: "Prod DB"},
    {id: "t03", kind: "dns_name", host: "example.com", class: "dns", label: "DNS canary"},
];
const CFG = "c".repeat(64);
const result = (over: Record<string, unknown> = {}) => ({v: 1, probe_id: PROBE_ID, targets_sha256: targetsSha(TARGETS), self_dns: "ok", results: TARGETS.map((t) => ({id: t.id, outcome: "blocked"})), wiped: {containers: 1, networks: 1}, ...over});
const input = (o: Partial<EvalInput> & {result?: unknown; status?: string; finishedAt?: Date | null} = {}): EvalInput => {
    const {result: r, status, finishedAt, ...rest} = o;
    return {
        eligibility: {ok: true},
        last: {taskId: "task-1", probeId: PROBE_ID, targets: TARGETS, configSha256: CFG},
        task: {id: "task-1", status: status ?? "succeeded", result: r === undefined ? result() : r, finishedAt: finishedAt === undefined ? ago(60_000) : finishedAt},
        expectedConfigSha: CFG, now: NOW, maxAgeMs: 24 * H, ...rest,
    };
};

describe("evaluateProbe (fail closed)", () => {
    it("isolated only when every condition holds", () => {
        expect(evaluateProbe(input())).toEqual({state: "isolated", probedAt: expect.any(Date), targetCount: 3});
    });
    it("not eligible ⇒ unknown(not_a_runner | not_attested), whatever the result says", () => {
        expect(evaluateProbe(input({eligibility: {ok: false, reason: "not_a_runner"}}))).toEqual({state: "unknown", reason: "not_a_runner"});
        expect(evaluateProbe(input({eligibility: {ok: false, reason: "not_attested"}}))).toEqual({state: "unknown", reason: "not_attested"});
    });
    it("never probed / wrong task row", () => {
        expect(evaluateProbe(input({last: null}))).toEqual({state: "unknown", reason: "never_probed"});
        expect(evaluateProbe(input({task: null}))).toEqual({state: "unknown", reason: "never_probed"});
        expect(evaluateProbe(input({last: {taskId: "other", probeId: PROBE_ID, targets: TARGETS, configSha256: CFG}}))).toEqual({state: "unknown", reason: "never_probed"});
    });
    it("pending / failed", () => {
        for (const s of ["queued", "leased", "running"]) expect(evaluateProbe(input({status: s}))).toEqual({state: "unknown", reason: "probe_pending"});
        for (const s of ["failed", "rejected", "expired", "cancelled"]) expect(evaluateProbe(input({status: s}))).toEqual({state: "unknown", reason: "probe_failed"});
    });
    it("targets_changed when the stored config sha differs from the current one", () => {
        expect(evaluateProbe(input({expectedConfigSha: "d".repeat(64)}))).toEqual({state: "unknown", reason: "targets_changed"});
    });
    it("result_invalid: not strict, wrong echo, id set mismatch (missing, extra, duplicate)", () => {
        const bad = (r: unknown) => expect(evaluateProbe(input({result: r}))).toEqual({state: "unknown", reason: "result_invalid"});
        bad(null); bad("x"); bad(result({extra: 1})); bad(result({v: 2}));
        bad(result({probe_id: "11111111-1111-4111-8111-111111111111"})); // probe id echo
        bad(result({targets_sha256: "e".repeat(64)})); // sha echo
        bad(result({results: TARGETS.slice(1).map((t) => ({id: t.id, outcome: "blocked"}))})); // missing t01
        bad(result({results: [...TARGETS.map((t) => ({id: t.id, outcome: "blocked"})), {id: "t99", outcome: "blocked"}]})); // extra id
        bad(result({results: [{id: "t01", outcome: "blocked"}, {id: "t01", outcome: "blocked"}, {id: "t02", outcome: "blocked"}]})); // duplicate masks t03
        bad(result({results: TARGETS.map((t) => ({id: t.id, outcome: "maybe"}))}));
        bad(result({results: [...TARGETS.map((t) => ({id: t.id, outcome: "blocked"}))].map((x) => ({...x, host: "10.0.0.1"}))})); // unknown key in a row
    });
    it("one reachable ⇒ not_isolated with class + label only (no hosts), even when other things are inconclusive", () => {
        const r = result({self_dns: "fail", results: [{id: "t01", outcome: "reachable"}, {id: "t02", outcome: "error"}, {id: "t03", outcome: "blocked"}]});
        const v = evaluateProbe(input({result: r}));
        expect(v).toEqual({state: "not_isolated", probedAt: expect.any(Date), reachable: [{id: "t01", class: "smtp", label: "Prod SMTP"}]});
        expect(JSON.stringify(v)).not.toContain("10.20.30.25");
    });
    it("an `error` outcome or a failing self DNS is inconclusive, never isolated", () => {
        expect(evaluateProbe(input({result: result({results: [{id: "t01", outcome: "blocked"}, {id: "t02", outcome: "error"}, {id: "t03", outcome: "blocked"}]})}))).toEqual({state: "unknown", reason: "inconclusive"});
        expect(evaluateProbe(input({result: result({self_dns: "fail"})}))).toEqual({state: "unknown", reason: "inconclusive"});
    });
    it("stale beyond maxAge (and without a finish time), fresh just inside it", () => {
        expect(evaluateProbe(input({finishedAt: ago(24 * H + 1000)}))).toEqual({state: "unknown", reason: "stale"});
        expect(evaluateProbe(input({finishedAt: null}))).toEqual({state: "unknown", reason: "stale"});
        expect(evaluateProbe(input({finishedAt: ago(24 * H - 60_000)})).state).toBe("isolated");
        expect(evaluateProbe(input({finishedAt: ago(2 * H), maxAgeMs: H})).state).toBe("unknown");
    });
    it("RunnerNotIsolatedError carries the verdict", () => {
        const e = new RunnerNotIsolatedError({state: "unknown", reason: "stale"});
        expect(e.message).toContain("stale");
        expect(e.isolation).toEqual({state: "unknown", reason: "stale"});
    });
});
