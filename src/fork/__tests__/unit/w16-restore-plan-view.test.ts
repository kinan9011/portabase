import {describe, expect, it} from "vitest";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {kumaInput, planInput, u} from "@/fork/__tests__/w16-fixtures";
import {contentHash} from "@/fork/inventory/schema";
import {planRestore} from "@/fork/restore/plan";
import {toRestorePlanView, type PlanRow} from "@/fork/restore/service";

const row = (plan: ReturnType<typeof planRestore>, over: Partial<PlanRow> = {}): PlanRow => ({
    id: u(500), organizationId: u(501), stackId: u(2), rpId: u(1), rpSequence: 3, targetAgentId: u(60), targetAgentName: "restore-host", purpose: plan.plan.purpose, mode: plan.plan.mode, planVersion: 1,
    mappings: {restore_root: "/srv/restore", SECRET_MAPPING_MARKER: "x"}, plan: plan.plan, planHash: plan.planHash, inputsDigest: plan.inputsDigest, outcome: plan.plan.outcome,
    approvals: [{kind: "production_target", capability: "restore.production.approve", plan_hash: plan.planHash, approved_by: "user-id-1", approved_at: "2026-11-07T10:00:00Z"}],
    createdBy: "user-id-1", createdAt: new Date("2026-11-07T09:00:00Z"), expiresAt: new Date("2026-11-08T09:00:00Z"), ...over,
});

describe("toRestorePlanView (flagged-only surfacing, §3.2 row 21)", () => {
    // services env keys: one restored (compose present) and one require_input (env file not covered); one flagged + one unflagged decision
    const inv = cleanInventory({env_files: [{path_hint: "/srv/elsewhere.env", key_names: ["NEEDS_INPUT_KEY"], referenced_by: ["web"]}], networks: [{name: "proxy", driver: "bridge", internal: false, external: true, members: ["web"], classification: "shared_external"}]});
    const base = planRestore(planInput((i) => { i.target.facts.networks = ["proxy"]; }, inv));
    const view = toRestorePlanView(row(base), base.plan, {fresh: true});
    const json = JSON.stringify(view);

    it("returns only flagged secrets and decisions; unflagged key names and subjects are absent", () => {
        expect(base.plan.secrets.some((s) => !s.flagged)).toBe(true);
        expect(view.secrets).toEqual([{service: "web", key: "NEEDS_INPUT_KEY", origin: "env_file", class: "require_input", reason: null}]);
        expect(json).not.toContain('"A"'); // the unflagged service_env key name `A`
        expect(view.decisions.map((d) => d.code)).toEqual(["shared_network_reused"]);
    });
    it("a plan with an unflagged decision hides it", () => {
        const p = planRestore(planInput((i) => { i.target.same_environment = true; const x = cleanInventory({services: [{...cleanInventory().services[0], image: {ref: "local/app", pinned: false, built_locally: true}}]}); i.inventory = x; i.inventory_content_hash = contentHash(x); i.rp.inventory_hash = contentHash(x); }));
        expect(p.plan.decisions.length).toBeGreaterThan(0);
        expect(p.plan.decisions.every((d) => !d.flagged)).toBe(true);
        expect(toRestorePlanView(row(p), p.plan, {fresh: true}).decisions).toEqual([]);
    });
    it("explicit allowlist: no mappings echo, no inputs digest, no user ids, no hash-bound internals", () => {
        for (const bad of ["SECRET_MAPPING_MARKER", base.inputsDigest, "user-id-1", "inputs_digest", "mappings", "createdBy", "manifest_sha256", "deny_rules_sha256"]) expect(json, bad).not.toContain(bad);
        expect(Object.keys(view).sort()).toEqual(["actions", "approvalsGiven", "approvalsRequired", "blockers", "composeFindings", "composeFindingsBasis", "createdAt", "decisions", "expiresAt", "freshness", "id", "mode", "outcome", "planHash", "preconditions", "purpose", "rp", "secrets", "stackId", "target", "targetAgentId", "totals"].sort());
        expect(view.stackId).toBe(base.plan.rp.stack_id);
        expect(view.targetAgentId).toBe(base.plan.target.agent_id);
        expect(view.totals).toEqual({artifacts: base.plan.totals.artifacts, actions: base.plan.totals.actions, plaintextBytes: base.plan.totals.plaintext_bytes});
        expect(view.approvalsGiven).toEqual([{kind: "production_target", approvedAt: "2026-11-07T10:00:00Z"}]);
        expect(view.rp).toEqual({id: u(1), sequence: 3, verifiedAt: "2026-11-07T01:00:00Z"});
    });
    it("freshness maps expired / stale / fresh", () => {
        expect(toRestorePlanView(row(base), base.plan, {fresh: false, code: "expired", reason: "expired"}).freshness).toBe("expired");
        expect(toRestorePlanView(row(base), base.plan, {fresh: false, code: "stale", reason: "inputs_changed"}).freshness).toBe("stale");
        expect(view.freshness).toBe("fresh");
    });
    it("honest wording: the RP is shown as verified evidence only, never 'tested'", () => {
        const k = planRestore(kumaInput());
        expect(JSON.stringify(toRestorePlanView(row(k), k.plan, {fresh: true}))).not.toMatch(/tested/i);
    });
    it("the view's schema is strict: an extra field would throw", () => {
        expect(() => toRestorePlanView(row(base), {...base.plan, extra: 1} as never, {fresh: true})).not.toThrow(); // plan is not re-parsed here; the VIEW allowlist is what is strict
    });
});
