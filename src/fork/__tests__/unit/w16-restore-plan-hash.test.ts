import {describe, expect, it} from "vitest";
import {H, kumaInput, planInput, u} from "@/fork/__tests__/w16-fixtures";
import {canonicalJson} from "@/fork/canonical";
import {hashPlan, planRestore} from "@/fork/restore/plan";
import type {PlanInputV1} from "@/fork/restore/schema";

const hashes = (i: PlanInputV1) => { const r = planRestore(i); return {digest: r.inputsDigest, hash: r.planHash}; };
const kuma = (mut?: (i: PlanInputV1) => void) => kumaInput((i) => { i.mappings.sqlite = {"uptime-kuma": {volume: "uptime-kuma_data", relative_path: "kuma.db"}}; mut?.(i); });

/** Deterministic shuffle of every array of the input (config_files_hint is ordered: compose override order). */
function shuffle<T>(v: T, seed = 7): T {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const walk = (x: unknown, key = ""): unknown => {
        if (Array.isArray(x)) {
            const a = x.map((e) => walk(e));
            if (key !== "config_files_hint") for (let n = a.length - 1; n > 0; n--) { const j = Math.floor(rnd() * (n + 1)); [a[n], a[j]] = [a[j], a[n]]; }
            return a;
        }
        if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).reverse().map(([k, val]) => [k, walk(val, k)]));
        return x;
    };
    return walk(v) as T;
}

describe("plan hash (D-W16-2)", () => {
    it("is deterministic", () => {
        expect(hashes(kuma())).toEqual(hashes(kuma()));
        expect(planRestore(kuma()).planHash).toMatch(/^[0-9a-f]{64}$/);
    });
    it("is permutation-invariant: shuffling every input array (and key order) changes neither digest nor hash", () => {
        const base = hashes(kuma((i) => { i.target.facts.volumes = ["z", "a", "m"]; i.target.facts.projects = ["p2", "p1"]; i.target.facts.published_ports = [{port: 9, protocol: "tcp"}, {port: 1, protocol: "udp"}]; i.target.environments[0].allowed_path_roots = ["/srv", "/data"]; }));
        for (const seed of [1, 2, 3, 4, 5]) {
            const i = shuffle(kuma((x) => { x.target.facts.volumes = ["z", "a", "m"]; x.target.facts.projects = ["p2", "p1"]; x.target.facts.published_ports = [{port: 9, protocol: "tcp"}, {port: 1, protocol: "udp"}]; x.target.environments[0].allowed_path_roots = ["/srv", "/data"]; }), seed);
            expect(hashes(i), `seed ${seed}`).toEqual(base);
        }
    });
    it("the plan hash is exactly sha256(canonicalJson(plan)) and survives a JSON (jsonb) round trip", () => {
        const {plan, planHash} = planRestore(kuma());
        expect(hashPlan(JSON.parse(JSON.stringify(plan)))).toBe(planHash);
        expect(hashPlan(JSON.parse(canonicalJson(plan)))).toBe(planHash);
        expect(plan.inputs_digest).toBe(planRestore(kuma()).inputsDigest);
    });
    it("a changed action field changes the plan hash", () => {
        const {plan, planHash} = planRestore(kuma());
        for (const edit of [(p: typeof plan) => { p.actions[0].op = "skip"; }, (p: typeof plan) => { p.actions[1].destination.name = "other"; }, (p: typeof plan) => { p.outcome = "blocked"; }, (p: typeof plan) => { p.approvals_required = []; }, (p: typeof plan) => { p.actions[0].artifact_ids = []; }]) {
            const c = JSON.parse(JSON.stringify(plan)) as typeof plan;
            edit(c);
            expect(hashPlan(c)).not.toBe(planHash);
        }
    });

    const MUTATIONS: [string, (i: PlanInputV1) => void][] = [
        ["rp.sequence", (i) => { i.rp.sequence += 1; }],
        ["rp.id", (i) => { i.rp.id = u(999); }],
        ["rp.manifest_sha256", (i) => { i.rp.manifest_sha256 = H("b"); }],
        ["rp.manifest_sig_kid", (i) => { i.rp.manifest_sig_kid = "ba9876543210"; }],
        ["rp.verified_at", (i) => { i.rp.verified_at = "2026-11-07T02:00:00Z"; }],
        ["rp.inventory_hash", (i) => { i.rp.inventory_hash = H("c"); }],
        ["rp.consistency_level", (i) => { i.rp.consistency_level = "engine_dump"; }],
        ["artifact.plaintext_sha256", (i) => { i.artifacts[0].plaintext_sha256 = H("9"); }],
        ["artifact.plaintext_size", (i) => { i.artifacts[1].plaintext_size = 1; }],
        ["artifact.presence (optional artifact)", (i) => { i.artifacts[1].required = false; i.artifacts[1].presence = "unknown"; }],
        ["artifact.channel_id", (i) => { i.artifacts[0].channel_id = u(950); }],
        ["inventory volume name", (i) => { i.inventory!.volumes[0].name = "renamed"; }],
        ["inventory inventory_content_hash", (i) => { i.inventory_content_hash = H("8"); }],
        ["stack.contains_personal_data", (i) => { i.stack.contains_personal_data = true; }],
        ["stack.test_restore_opt_in", (i) => { i.stack.test_restore_opt_in = true; }],
        ["target.environment host_role", (i) => { i.target.environments[0].host_role = "test"; }],
        ["target.environment facts_fresh", (i) => { i.target.environments[0].facts_fresh = false; }],
        ["target.capability", (i) => { i.target.enrollment!.capabilities.push("extra.v1"); }],
        ["target.allowed_path_roots", (i) => { i.target.environments[0].allowed_path_roots = ["/srv"]; }],
        ["target.facts.volumes", (i) => { i.target.facts.volumes = ["unrelated"]; }],
        ["target.facts.published_ports", (i) => { i.target.facts.published_ports = [{port: 22, protocol: "tcp"}]; }],
        ["target.facts.inventory_hashes", (i) => { i.target.facts.inventory_hashes = [H("7")]; }],
        ["target.facts.arch", (i) => { i.target.facts.arch = "amd64"; }],
        ["target.facts.free_disk_bytes", (i) => { i.target.facts.free_disk_bytes = 10 ** 12; }],
        ["target.same_environment", (i) => { i.target.same_environment = true; }],
        ["target.agent_name", (i) => { i.target.agent_name = "other-host"; }],
        ["mappings.restore_root", (i) => { i.mappings.restore_root = "/mnt/elsewhere"; }],
        ["mappings.target_project", (i) => { i.mappings.target_project = "kuma2"; }],
        ["mappings.volumes", (i) => { i.mappings.volumes = {"uptime-kuma_data": "renamed_data"}; }],
        ["mappings.sqlite", (i) => { i.mappings.sqlite = {"uptime-kuma": {volume: "uptime-kuma_data", relative_path: "db/kuma.db"}}; }],
        ["mappings.select (ignored by new_stack, still digested)", (i) => { i.mappings.select = ["volume:uptime-kuma_data"]; }],
        ["mode", (i) => { i.mode = "selective"; i.mappings.select = ["volume:uptime-kuma_data"]; }],
        ["selection.sqlite path", (i) => { i.selection.sqlite = {"uptime-kuma": "/other/kuma.db"}; }],
        ["planner.deny_rules_sha256", (i) => { i.planner.deny_rules_sha256 = H("1"); }],
    ];
    it.each(MUTATIONS)("mutation %s ⇒ different inputsDigest AND different planHash", (_n, mut) => {
        const base = hashes(kuma());
        const m = hashes(kuma(mut));
        expect(m.digest).not.toBe(base.digest);
        expect(m.hash).not.toBe(base.hash);
    });
    it("purpose is part of the hash (test_restore vs restore on a test host)", () => {
        const onTest = (purpose: "restore" | "test_restore") => kuma((i) => { i.purpose = purpose; i.target.environments[0].host_role = "test"; });
        expect(hashes(onTest("restore")).hash).not.toBe(hashes(onTest("test_restore")).hash);
    });
    it("an input change that derives IDENTICAL actions still changes the hash (digest folded in)", () => {
        const a = planRestore(kuma());
        const b = planRestore(kuma((i) => { i.target.facts.volumes = ["unrelated"]; }));
        expect(JSON.stringify(b.plan.actions)).toBe(JSON.stringify(a.plan.actions));
        expect(b.planHash).not.toBe(a.planHash);
    });
    it("plan_version bump discipline: the plan carries version 2 and the ruleset", () => {
        const {plan} = planRestore(planInput());
        expect(plan.plan_version).toBe(2);
        expect(plan.ruleset).toBe("w16.2");
    });
});
