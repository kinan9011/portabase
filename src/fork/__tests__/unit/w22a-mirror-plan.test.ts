import {describe, expect, it} from "vitest";
import {art, planInput, u} from "@/fork/__tests__/w16-fixtures";
import {planRestore, PlannerRefusal} from "@/fork/restore/plan";
import type {PlanInputV1} from "@/fork/restore/schema";
import {BuildError, buildHeader} from "@/fork/restore-tasks/build";

const ROOT = "/srv/portabase-mirrors";
const PROJECT = "pbm-demo-r1";

/** Valid mirror baseline: a designated runner (no environment, runner.v1 + mirror.v1), purpose mirror / new_stack, project pbm-*, personal data declared false. */
function mirrorInput(mut?: (i: PlanInputV1) => void): PlanInputV1 {
    return planInput((i) => {
        i.purpose = "mirror";
        i.mode = "new_stack";
        i.mappings = {target_project: PROJECT, restore_root: ROOT, volumes: null, select: null, sqlite: null};
        i.stack.contains_personal_data = false;
        i.target.runner_eligible = true;
        i.target.environments = [];
        i.target.enrollment = {enabled: true, revoked: false, capabilities: ["channel.v1", "noop.v1", "channel-maint.v1", "runner.v1", "mirror.v1"]};
        mut?.(i);
    });
}
const refusal = (i: PlanInputV1) => { try { planRestore(i); } catch (e) { return e instanceof PlannerRefusal ? e.code : `other:${e}`; } return "none"; };

describe("W22a planner purpose mirror (plan v2)", () => {
    it("runner target ⇒ ready plan: host_role runner, no approvals, <root>/<project> layout, renamed volumes, no network/port/secret/finding sections", () => {
        const {plan} = planRestore(mirrorInput());
        expect(plan.plan_version).toBe(2);
        expect(plan.outcome).toBe("ready");
        expect(plan.blockers).toEqual([]);
        expect(plan.purpose).toBe("mirror");
        expect(plan.target).toMatchObject({host_role: "runner", host_role_source: "default", project: PROJECT, restore_root: ROOT});
        expect(plan.approvals_required).toEqual([]);
        expect(plan.secrets).toEqual([]);
        expect(plan.compose_findings).toEqual([]);
        expect(plan.actions.some((a) => a.kind === "create_network")).toBe(false);
        expect(plan.decisions.some((d) => d.code.startsWith("shared_network") || d.code === "port_in_use")).toBe(false);
        const compose = plan.actions.find((a) => a.kind === "restore_compose_dir");
        expect(compose?.destination.path).toBe(`${ROOT}/${PROJECT}/compose`);
        const vol = plan.actions.find((a) => a.kind === "restore_volume");
        expect(vol?.destination.name).toBe(`${PROJECT}_data`);
        expect(plan.actions.every((a) => a.risk === "safe")).toBe(true);
        expect(plan.actions.some((a) => a.kind === "compose_up")).toBe(true);
    });

    it("refusals: non-runner, runner mapped to an environment, selective mode", () => {
        expect(refusal(mirrorInput((i) => { i.target.runner_eligible = false; }))).toBe("mirror_target_not_runner");
        expect(refusal(mirrorInput((i) => { i.target.environments = [{id: u(70), name: "env", host_role: "test", allowed_path_roots: [], facts_fresh: true}]; }))).toBe("mirror_target_not_runner");
        expect(refusal(mirrorInput((i) => { i.mode = "selective"; }))).toBe("mirror_mode_invalid");
        expect(refusal(mirrorInput((i) => { i.mode = "existing_stack"; }))).toBe("mirror_mode_invalid");
    });

    it("personal data: true and NULL need the mirror opt-in; false does not; the opt-in unlocks", () => {
        expect(refusal(mirrorInput((i) => { i.stack.contains_personal_data = true; }))).toBe("personal_data_no_mirror_opt_in");
        expect(refusal(mirrorInput((i) => { i.stack.contains_personal_data = null; }))).toBe("personal_data_no_mirror_opt_in");
        expect(refusal(mirrorInput((i) => { i.stack.contains_personal_data = null; i.stack.mirror_opt_in = true; }))).toBe("none");
        expect(refusal(mirrorInput((i) => { i.stack.contains_personal_data = false; }))).toBe("none");
        // the test-restore opt-in is NOT a mirror opt-in
        expect(refusal(mirrorInput((i) => { i.stack.contains_personal_data = true; i.stack.test_restore_opt_in = true; }))).toBe("personal_data_no_mirror_opt_in");
    });

    it("RP refusals stay first (not verified / purged)", () => {
        expect(refusal(mirrorInput((i) => { i.rp.rp_status = "incomplete"; }))).toBe("rp_not_verified");
        expect(refusal(mirrorInput((i) => { i.rp.purged = true; }))).toBe("rp_purged");
    });

    it("missing mirror.v1 or runner.v1 ⇒ blocker target_capability_missing", () => {
        const noMirror = planRestore(mirrorInput((i) => { i.target.enrollment = {enabled: true, revoked: false, capabilities: ["channel.v1", "runner.v1"]}; })).plan;
        expect(noMirror.outcome).toBe("blocked");
        expect(noMirror.blockers).toContain("target_capability_missing");
        const noRunner = planRestore(mirrorInput((i) => { i.target.enrollment = {enabled: true, revoked: false, capabilities: ["channel.v1", "mirror.v1"]}; })).plan;
        expect(noRunner.blockers).toContain("target_capability_missing");
    });

    it("a project that is not pbm-… blocks the plan", () => {
        for (const p of ["demo", "pbm-", "pbm_x", "pbm--x", null]) {
            const {plan} = planRestore(mirrorInput((i) => { i.mappings.target_project = p; }));
            expect(plan.outcome, String(p)).toBe("blocked");
            expect(plan.blockers).toContain("project_name_conflict");
        }
    });

    it("mirrors have no approval path: an unmapped artifact or unresolved sqlite blocks instead of needing approval", () => {
        const {plan} = planRestore(mirrorInput((i) => { i.artifacts.push(art(20, null, "db", "mongodb")); }));
        expect(plan.outcome).toBe("blocked");
        expect(plan.blockers).toContain("artifact_unmapped");
        expect(plan.approvals_required).toEqual([]);
        expect(plan.actions.some((a) => a.risk === "needs_approval")).toBe(false);
        const sq = planRestore(mirrorInput((i) => { i.artifacts.push(art(21, "db:kuma", "db", "sqlite")); })).plan;
        expect(sq.blockers).toContain("sqlite_placement_unresolved");
        expect(sq.approvals_required).toEqual([]);
    });

    it("a bad root blocks (restore_root_required / rejected)", () => {
        expect(planRestore(mirrorInput((i) => { i.mappings.restore_root = null; })).plan.blockers).toContain("restore_root_required");
        expect(planRestore(mirrorInput((i) => { i.mappings.restore_root = "/etc"; })).plan.blockers).toContain("restore_root_rejected");
    });

    it("deterministic: same input ⇒ same hash; mirror vs restore input differ", () => {
        const a = planRestore(mirrorInput());
        expect(planRestore(mirrorInput()).planHash).toBe(a.planHash);
        expect(planRestore(planInput()).planHash).not.toBe(a.planHash);
    });

    it("existing purposes keep their behaviour except the plan version", () => {
        const r = planRestore(planInput());
        expect(r.plan.plan_version).toBe(2);
        expect(r.plan.target.host_role).toBe("production");
        expect(r.plan.approvals_required.map((a) => a.kind)).toContain("production_target");
    });

    it("buildHeader refuses a mirror plan (restore builders can never build a mirror task)", () => {
        const {plan, planHash} = planRestore(mirrorInput());
        const mk = () => buildHeader({restoreId: u(90), planId: u(91), planHash, plan, approvals: [], indexOf: new Map()});
        expect(mk).toThrow(BuildError);
        expect(() => mk()).toThrow("mode_unsupported");
    });
});
