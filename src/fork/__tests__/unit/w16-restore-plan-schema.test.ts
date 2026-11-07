import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {kumaInput, planInput} from "@/fork/__tests__/w16-fixtures";
import {canonicalJson} from "@/fork/canonical";
import {planRestore} from "@/fork/restore/plan";
import {ApproveRequest, CreatePlanRequest, MappingsV1, PlanInputV1, PrivacyRequest, RestorePlanV1} from "@/fork/restore/schema";
import {APPROVAL_KINDS, DENY_RULE_IDS, PLAN_OUTCOMES, RESTORE_MODES, RESTORE_PURPOSES} from "@/fork/restore/vocab";

/** Adds an unknown key to every object of a value and asserts the schema rejects each one. */
function everyObjectIsStrict(schema: {safeParse: (v: unknown) => {success: boolean}}, value: unknown) {
    const paths: (string | number)[][] = [];
    const find = (x: unknown, p: (string | number)[]) => {
        if (Array.isArray(x)) { for (const [k, e] of x.entries()) find(e, [...p, k]); }
        else if (x && typeof x === "object") { paths.push(p); for (const [k, v] of Object.entries(x)) find(v, [...p, k]); }
    };
    find(value, []);
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) {
        const c = structuredClone(value) as Record<string, unknown>;
        let t: any = c; for (const k of p) t = t[k];
        if (p.join(".").startsWith("inventory.provenance") || /mappings\.(volumes|sqlite)$/.test(p.join(".")) || /image_platforms$/.test(p.join(".")) || /selection\.sqlite$/.test(p.join("."))) continue; // records: keys are data
        t.__unknown = 1;
        expect(schema.safeParse(c).success, `extra key accepted at ${p.join(".") || "<root>"}`).toBe(false);
    }
}

describe("restore plan schemas", () => {
    it("every object of the plan and of the input is strict", () => {
        everyObjectIsStrict(RestorePlanV1, planRestore(kumaInput()).plan);
        everyObjectIsStrict(PlanInputV1, kumaInput());
    });
    it("request schemas are strict", () => {
        expect(CreatePlanRequest.safeParse({rpId: planInput().rp.id, targetAgentId: planInput().target.agent_id, purpose: "restore", mode: "new_stack", mappings: planInput().mappings, extra: 1}).success).toBe(false);
        expect(ApproveRequest.safeParse({planId: planInput().rp.id, planHash: "x", kind: "production_target"}).success).toBe(false);
        expect(PrivacyRequest.safeParse({stackId: planInput().rp.id, containsPersonalData: null, testRestoreOptIn: true, x: 1}).success).toBe(false);
    });
    it("nullable, never optional: a parsed plan has no undefined anywhere and round-trips canonically", () => {
        const {plan} = planRestore(kumaInput());
        const walk = (x: unknown) => { if (x === undefined) throw new Error("undefined in plan"); if (x && typeof x === "object") Object.values(x).forEach(walk); };
        walk(plan);
        const back = RestorePlanV1.parse(JSON.parse(canonicalJson(plan)));
        expect(canonicalJson(back)).toBe(canonicalJson(plan));
        // an absent optional field is a parse error, not a default
        const dropped = JSON.parse(JSON.stringify(plan)); delete dropped.actions[0].expect;
        expect(RestorePlanV1.safeParse(dropped).success).toBe(false);
    });
    it("vocabulary lists equal the SQL CHECK lists of migration 0011", () => {
        const sql = readFileSync(path.join(process.cwd(), "src/fork/db/migrations/0011_restore_plan.sql"), "utf8");
        const list = (col: string) => [...(sql.match(new RegExp(`"${col}" IN \\(([^)]*)\\)`))?.[1].matchAll(/'([^']+)'/g) ?? [])].map((m) => m[1]);
        expect(list("purpose")).toEqual([...RESTORE_PURPOSES]);
        expect(list("mode")).toEqual([...RESTORE_MODES]);
        expect(list("outcome")).toEqual([...PLAN_OUTCOMES]);
        expect(APPROVAL_KINDS).toEqual(["production_target", "destructive_replace"]);
    });
    it("DENY_RULE_IDS equal the rule ids of policy/compose-deny.json", () => {
        const j = JSON.parse(readFileSync(path.join(process.cwd(), "src/fork/policy/compose-deny.json"), "utf8")) as {rules: {id: string}[]};
        expect(j.rules.map((r) => r.id)).toEqual([...DENY_RULE_IDS]);
    });
    it("MappingsV1 bounds: ≤500 volume mappings, ≤2000 select keys, project name grammar", () => {
        const base = {target_project: null, restore_root: null, volumes: null, select: null, sqlite: null};
        expect(MappingsV1.safeParse({...base, volumes: Object.fromEntries(Array.from({length: 500}, (_, k) => [`v${k}`, "x"]))}).success).toBe(true);
        expect(MappingsV1.safeParse({...base, volumes: Object.fromEntries(Array.from({length: 501}, (_, k) => [`v${k}`, "x"]))}).success).toBe(false);
        expect(MappingsV1.safeParse({...base, select: Array.from({length: 2001}, () => "k")}).success).toBe(false);
        expect(MappingsV1.safeParse({...base, target_project: "Bad Name"}).success).toBe(false);
        expect(MappingsV1.safeParse({...base, restore_root: "x".repeat(1025)}).success).toBe(false);
    });
});
