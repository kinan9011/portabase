import {describe, expect, it} from "vitest";
import {planRestore} from "@/fork/restore/plan";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {checkDb, checkProbe, checkServices, checkStage, checkVerify, deriveSteps, expectedServices, neededBytes, needsCompose, needsDb, parseServices} from "@/fork/restore-run/derive";
import {REASON_RE, restoreConfirmPhrase} from "@/fork/restore-run/vocab";
import {kumaInput, planInput} from "@/fork/__tests__/w16-fixtures";

const RULES = "e".repeat(64);
const planOf = (mut?: Parameters<typeof planInput>[0]): RestorePlanV1 => planRestore(planInput(mut)).plan;
const probe = (over: Record<string, unknown> = {}) => ({roots: [{path: "/srv/restore", shared: true, free_bytes: 10 ** 12}], workspace_state: "absent", arch: "x86_64", compose_version: "5.4.0", rules_sha256: RULES, ...over});

describe("W18a deriveSteps (pure, from the plan)", () => {
    it("new_stack with a PostgreSQL dump: the full chain, verify_manifest FIRST", () => {
        const p = planOf();
        expect(p.outcome).toBe("ready");
        expect(deriveSteps(p)).toEqual(["verify_manifest", "probe", "stage", "apply", "render", "restore_db", "compose_up", "check_services"]);
        expect(needsCompose(p) && needsDb(p)).toBe(true);
    });
    it("new_stack without a PostgreSQL dump: no restore_db", () => {
        const p = planOf((i) => { i.artifacts = i.artifacts.filter((a) => a.engine !== "postgresql"); });
        expect(deriveSteps(p)).toEqual(["verify_manifest", "probe", "stage", "apply", "render", "compose_up", "check_services"]);
        expect(needsDb(p)).toBe(false);
    });
    it("selective (data only): no compose bracket at all", () => {
        const p = planOf((i) => { i.mode = "selective"; i.mappings.select = ["dir:/srv/app", "volume:app_data"]; });
        expect(deriveSteps(p)).toEqual(["verify_manifest", "probe", "stage", "apply"]);
        expect(needsCompose(p)).toBe(false);
    });
    it("the pilot shape (volume + sqlite) in a new stack still derives a chain that ends in check_services; steps are unique and ordered", () => {
        const p = planRestore(kumaInput()).plan;
        const steps = deriveSteps(p);
        expect(new Set(steps).size).toBe(steps.length);
        expect(steps.slice(0, 4)).toEqual(["verify_manifest", "probe", "stage", "apply"]);
        if (needsCompose(p)) expect(steps.at(-1)).toBe("check_services");
    });
    it("neededBytes sums DISTINCT artifacts and ignores unknown sizes", () => {
        const p = planOf();
        const ids = new Set(p.actions.filter((a) => a.op !== "skip" && a.artifact_ids[0]).map((a) => a.artifact_ids[0]));
        expect(neededBytes(p)).toBe(ids.size * 1000);
        expect(neededBytes({...p, actions: p.actions.map((a) => ({...a, expect: {...a.expect, plaintext_size: null}}))})).toBe(0);
    });
});

describe("W18a probe check (defence in depth; the agent is authoritative)", () => {
    const p = planOf();
    const need = neededBytes(p);
    it("accepts a usable host; boundary: free_bytes == needed is ok, needed − 1 is not; null free_bytes (unknown) is ok", () => {
        expect(checkProbe(probe(), p, RULES)).toEqual({ok: true});
        expect(checkProbe(probe({roots: [{path: "/srv/restore", shared: true, free_bytes: need}]}), p, RULES)).toEqual({ok: true});
        expect(checkProbe(probe({roots: [{path: "/srv/restore", shared: true, free_bytes: need - 1}]}), p, RULES)).toEqual({ok: false, code: "insufficient_disk"});
        expect(checkProbe(probe({roots: [{path: "/srv/restore", shared: true, free_bytes: null}]}), p, RULES)).toEqual({ok: true});
    });
    it("every refusal has its own code", () => {
        const code = (x: unknown) => (checkProbe(x, p, RULES) as {code: string}).code;
        expect(code(probe({roots: [{path: "/elsewhere", shared: true, free_bytes: 1e12}]}))).toBe("root_missing");
        expect(code(probe({roots: []}))).toBe("root_missing");
        expect(code(probe({roots: [{path: "/srv/rest", shared: true, free_bytes: 1e12}]}))).toBe("root_missing"); // prefix of a path segment is not a root
        expect(code(probe({roots: [{path: "/srv/restore", shared: false, free_bytes: 1e12}]}))).toBe("root_not_shared");
        expect(code(probe({workspace_state: "foreign"}))).toBe("workspace_not_owned");
        expect(code(probe({compose_version: null}))).toBe("compose_unavailable");
        expect(code(probe({rules_sha256: "f".repeat(64)}))).toBe("rules_mismatch");
        expect(code(probe({rules_sha256: null}))).toBe("rules_mismatch");
        for (const bad of [null, "x", {roots: "no"}, {}, probe({workspace_state: "weird"})]) expect(code(bad)).toBe("probe_invalid");
    });
    it("a root that is a parent of the restore root counts (and a trailing slash does not matter)", () => {
        expect(checkProbe(probe({roots: [{path: "/srv/", shared: true, free_bytes: 1e12}]}), p, RULES)).toEqual({ok: true});
    });
    it("a data-only plan does not need compose or the rule set", () => {
        const d = planOf((i) => { i.mode = "selective"; i.mappings.select = ["dir:/srv/app", "volume:app_data"]; });
        expect(checkProbe(probe({compose_version: null, rules_sha256: null}), d, RULES)).toEqual({ok: true});
    });
});

describe("W18a stage / db / services checks", () => {
    const p = planOf();
    it("stage must report the plan's manifest sequence", () => {
        expect(checkStage({manifest_sequence: p.rp.sequence}, p)).toEqual({ok: true});
        for (const bad of [{manifest_sequence: p.rp.sequence - 1}, {}, null, "3", {manifest_sequence: String(p.rp.sequence)}]) expect(checkStage(bad, p)).toEqual({ok: false, code: "stage_mismatch"});
    });
    it("restore_db: every database restored or reused, else db_restore_failed; an empty or malformed report is not success", () => {
        expect(checkDb({dbs: [{status: "restored"}, {status: "reused"}]})).toEqual({ok: true});
        expect(checkDb({dbs: [{status: "restored"}, {status: "failed"}]})).toEqual({ok: false, code: "db_restore_failed"});
        for (const bad of [null, {}, {dbs: "x"}, {dbs: [{}]}]) expect(checkDb(bad)).toEqual({ok: false, code: "db_restore_failed"});
    });
    it("parseServices validates names and states and caps the list", () => {
        expect(parseServices({services: [{service: "web", state: "running"}]})).toEqual([{service: "web", state: "running"}]);
        for (const bad of [null, {services: [{service: "we b", state: "running"}]}, {services: [{service: "web", state: "weird"}]}, {services: [{service: "web", state: "running", extra: 1}]}, {services: Array.from({length: 501}, () => ({service: "w", state: "running"}))}]) expect(parseServices(bad)).toBeNull();
    });
    const view = JSON.stringify({services: {web: {image: "x"}, db: {image: "y"}}});
    it("check_services: all running ⇒ ok; one exited, one missing, an empty or unreadable view ⇒ service_not_running (never success)", () => {
        const s = (web: string, db?: string) => [{service: "web", state: web as "running"}, ...(db ? [{service: "db", state: db as "running"}] : [])];
        expect(checkServices(view, s("running", "running"))).toEqual({ok: true});
        expect(checkServices(view, [...s("running", "running"), {service: "extra", state: "exited"}])).toEqual({ok: true}); // only rendered services are judged
        expect(checkServices(view, s("running", "exited"))).toEqual({ok: false, code: "service_not_running"});
        expect(checkServices(view, s("running"))).toEqual({ok: false, code: "service_not_running"});
        expect(checkServices(JSON.stringify({services: {}}), [])).toEqual({ok: false, code: "service_not_running"});
        expect(checkServices("not json", s("running", "running"))).toEqual({ok: false, code: "service_not_running"});
        expect(expectedServices(view)).toEqual(["web", "db"]);
        expect(expectedServices(JSON.stringify({services: []}))).toBeNull();
    });
});

describe("W18a vocabulary", () => {
    it("reason grammar and the typed phrase", () => {
        for (const ok of ["stale", "agent_offline", "a".repeat(64)]) expect(REASON_RE.test(ok)).toBe(true);
        for (const bad of ["", "Stale", "a-b", "a1", "a".repeat(65), "has space"]) expect(REASON_RE.test(bad)).toBe(false);
        expect(restoreConfirmPhrase("shop")).toBe("RESTORE shop");
    });
});

describe("W-TR integrity step + checkVerify", () => {
    const testEnv = [{id: "00000000-0000-4000-8000-000000000070", name: "scratch", host_role: "test" as const, allowed_path_roots: [], facts_fresh: true}];
    const testPlan = (mut?: Parameters<typeof planInput>[0]) => planOf((i) => { i.purpose = "test_restore"; i.target.environments = testEnv; mut?.(i); });
    it("test restore with a PostgreSQL dump ⇒ …apply, integrity (and never a compose step)", () => {
        expect(deriveSteps(testPlan())).toEqual(["verify_manifest", "probe", "stage", "apply", "integrity"]);
    });
    it("test restore with sqlite ⇒ integrity; files only ⇒ none; purpose restore never gets it", () => {
        const sqlite = planRestore(kumaInput((i) => { i.purpose = "test_restore"; i.target.environments = testEnv; })).plan;
        expect(deriveSteps(sqlite).at(-1)).toBe("integrity");
        expect(deriveSteps(testPlan((i) => { i.artifacts = i.artifacts.slice(0, 2); }))).toEqual(["verify_manifest", "probe", "stage", "apply"]);
        expect(deriveSteps(planOf())).not.toContain("integrity");
    });
    it("checkVerify: exactly the expected number of ok checks", () => {
        const ok = {checks: [{index: 1, engine: "postgresql", status: "ok"}]};
        expect(checkVerify(ok, 1)).toEqual({ok: true});
        expect(checkVerify(ok, 2)).toEqual({ok: false, code: "integrity_failed"});
        expect(checkVerify({checks: []}, 1)).toEqual({ok: false, code: "integrity_failed"});
        expect(checkVerify({checks: [{index: 1, engine: "postgresql", status: "failed"}]}, 1)).toEqual({ok: false, code: "integrity_failed"});
        expect(checkVerify({checks: [{index: 1, engine: "mysql", status: "ok"}]}, 1)).toEqual({ok: false, code: "integrity_failed"});
        expect(checkVerify(null, 1)).toEqual({ok: false, code: "integrity_failed"});
        expect(checkVerify("x", 0)).toEqual({ok: false, code: "integrity_failed"});
    });
});
