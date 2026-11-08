import {describe, expect, it} from "vitest";
import {validatePayload} from "@/fork/agent-channel/tasks";
import {planRestore} from "@/fork/restore/plan";
import type {PlanInputV1} from "@/fork/restore/schema";
import {BuildError, buildVerifyPayload, engineCheckCount, engineChecks, type BuildInput} from "@/fork/restore-tasks/build";
import {art, kumaInput, planInput, u} from "@/fork/__tests__/w16-fixtures";

const RID = u(900), PLAN = u(901);
const testEnv = [{id: u(70), name: "scratch", host_role: "test" as const, allowed_path_roots: [], facts_fresh: true}];
const toTest = (i: PlanInputV1) => { i.purpose = "test_restore"; i.target.environments = testEnv; };
const planOf = (input: PlanInputV1) => planRestore(input).plan;
const bi = (plan: ReturnType<typeof planOf>): BuildInput => {
    const indexOf = new Map<string, number>();
    plan.actions.filter((a) => a.op !== "skip" && a.artifact_ids[0]).forEach((a, ix) => { indexOf.set(a.artifact_ids[0], ix); });
    return {restoreId: RID, planId: PLAN, planHash: "a".repeat(64), plan, approvals: [], indexOf};
};
const kumaTest = () => planOf(kumaInput(toTest)); // compose dir + volume + sqlite
const pgTest = () => planOf(planInput(toTest)); // compose dir + volume + pg dump
const mysqlTest = () => planOf(planInput((i) => { toTest(i); i.artifacts[2] = art(13, "db:db", "db", "mysql"); }));

describe("W-TR engineChecks (plan D-4)", () => {
    it("sqlite file ⇒ sqlite check", () => {
        const p = kumaTest();
        const r = engineChecks(bi(p));
        expect(r.checks).toHaveLength(1);
        expect(r.checks[0].engine).toBe("sqlite");
        expect(r.notSupported).toBe(0);
    });
    it("PostgreSQL dump ⇒ postgresql check", () => {
        expect(engineChecks(bi(pgTest())).checks.map((c) => c.engine)).toEqual(["postgresql"]);
    });
    it("a MySQL dump is counted, not checked", () => {
        const p = mysqlTest();
        expect(engineChecks(bi(p))).toEqual({checks: [], notSupported: 1});
        expect(engineCheckCount(p)).toEqual({checkable: 0, notSupported: 1});
    });
    it("engineCheckCount equals engineChecks without an index map", () => {
        for (const p of [kumaTest(), pgTest(), mysqlTest()]) expect(engineCheckCount(p).checkable).toBe(engineChecks(bi(p)).checks.length);
    });
    it("files-only plan ⇒ nothing to check", () => {
        const p = planOf(planInput((i) => { toTest(i); i.artifacts = i.artifacts.slice(0, 2); }));
        expect(engineCheckCount(p)).toEqual({checkable: 0, notSupported: 0});
    });
    it("dedupes by index and orders by index", () => {
        const p = pgTest();
        const i = bi(p);
        const dumpId = p.actions.find((a) => a.kind === "restore_db_dump")!.artifact_ids[0];
        const sqlite = {...kumaTest()};
        expect(engineChecks(i).checks).toEqual([{index: i.indexOf.get(dumpId)!, engine: "postgresql"}]);
        expect(sqlite.actions.length).toBeGreaterThan(0);
        const dup: BuildInput = {...i, plan: {...p, actions: [...p.actions, ...p.actions.filter((a) => a.kind === "restore_db_dump")]}};
        expect(engineChecks(dup).checks).toHaveLength(1);
    });
    it("an unmapped artifact is manifest_mismatch", () => {
        const p = pgTest();
        expect(() => engineChecks({...bi(p), indexOf: new Map()})).toThrow(BuildError);
    });
});

describe("W-TR buildVerifyPayload", () => {
    it("builds a strict, schema-valid payload for a test plan", () => {
        const p = kumaTest();
        const out = buildVerifyPayload(bi(p), "b".repeat(64));
        expect(out).toMatchObject({purpose: "test_restore", mode: "new_stack", manifest_sha256: "b".repeat(64)});
        expect(out.checks).toHaveLength(1);
        expect(validatePayload("restore_verify", out as never)).toBeNull();
        expect(validatePayload("restore_verify", {...out, extra: 1} as never)).not.toBeNull();
        expect(validatePayload("restore_verify", {...out, checks: [{index: 0, engine: "mysql"}]} as never)).not.toBeNull();
        expect(validatePayload("restore_verify", {...out, checks: []} as never)).not.toBeNull();
    });
    it("refuses purpose restore and plans with no checkable artifact", () => {
        const normal = planOf(planInput());
        expect(() => buildVerifyPayload(bi(normal), "b".repeat(64))).toThrowError(expect.objectContaining({code: "mode_unsupported"}));
        expect(() => buildVerifyPayload(bi(mysqlTest()), "b".repeat(64))).toThrowError(expect.objectContaining({code: "mode_unsupported"}));
    });
});
