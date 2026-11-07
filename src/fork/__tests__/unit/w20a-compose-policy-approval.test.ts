import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {type PolicyContext, buildPolicyApproval, checkPolicyApproval, confirmationPhrase, groupOverrides} from "@/fork/policy/approval";
import {evaluateRenderedCompose} from "@/fork/policy/engine";
import type {RawResult} from "@/fork/policy/raw";
import {RULES_SHA256} from "@/fork/policy/rules";

const CLEAN: RawResult = {refused: false, violations: [], reason: null};
const CTX: PolicyContext = {stack_id: "11111111-1111-4111-8111-111111111111", rp_id: "22222222-2222-4222-8222-222222222222", target_agent_id: "33333333-3333-4333-8333-333333333333"};
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const svc = (extra: Record<string, unknown> = {}) => ({image: "nginx:1", networks: {default: null}, ...extra});
const compose = (services: Record<string, unknown>) => JSON.stringify({name: "r", services, networks: {default: {name: "r_default"}}});
const verdictOf = (text: string, roots = ["/restore"]) => evaluateRenderedCompose({rendered: text, roots, raw: CLEAN, drift: null});
const TWO = compose({web: svc({privileged: true, cap_add: ["SYS_ADMIN"]}), db: svc({network_mode: "host"}), ok: svc()});
const phrases = (v: ReturnType<typeof verdictOf>) => Object.fromEntries(v.services_needing_override.map((s) => [s, confirmationPhrase(s)]));
const built = (text = TWO) => {
    const v = verdictOf(text);
    const r = buildPolicyApproval({verdict: v, confirmations: phrases(v), context: CTX});
    if (!r.ok) throw new Error(r.code);
    return {v, token: r.token, sha: r.approval_sha256};
};

describe("typed ALLOW <service> phrases", () => {
    it("phrase is `ALLOW <svc>`; outer whitespace trimmed; case, extra words and other services refused", () => {
        const v = verdictOf(TWO);
        const ok = (confirmations: Record<string, string>) => buildPolicyApproval({verdict: v, confirmations, context: CTX});
        expect(confirmationPhrase("web")).toBe("ALLOW web");
        expect(ok({web: "ALLOW web", db: "  ALLOW db\n"}).ok).toBe(true);
        expect(ok({web: "allow web", db: "ALLOW db"})).toEqual({ok: false, code: "confirmation_mismatch"});
        expect(ok({web: "ALLOW web please", db: "ALLOW db"})).toEqual({ok: false, code: "confirmation_mismatch"});
        expect(ok({web: "ALLOW db", db: "ALLOW db"})).toEqual({ok: false, code: "confirmation_mismatch"});
        expect(ok({web: "ALLOW  web", db: "ALLOW db"})).toEqual({ok: false, code: "confirmation_mismatch"});
        expect(ok({web: "ALLOW web"})).toEqual({ok: false, code: "missing_confirmation"});
        expect(ok({})).toEqual({ok: false, code: "missing_confirmation"});
        expect(ok({web: "ALLOW web", db: "ALLOW db", ok: "ALLOW ok"})).toEqual({ok: false, code: "service_not_flagged"});
        expect(ok({web: "ALLOW web", db: "ALLOW db", ghost: "ALLOW ghost"})).toEqual({ok: false, code: "service_not_flagged"});
        expect(ok({__proto__x: "x", web: "ALLOW web", db: "ALLOW db"}).ok).toBe(false);
    });
    it("a verdict with a hard refusal or without findings never yields a token", () => {
        const hard = verdictOf(compose({a: svc({privileged: true, volumes: [{type: "bind", source: "/restore/../x", target: "/x"}]})}));
        expect(buildPolicyApproval({verdict: hard, confirmations: {a: "ALLOW a"}, context: CTX})).toEqual({ok: false, code: "hard_refusal"});
        const clean = verdictOf(compose({a: svc()}));
        expect(buildPolicyApproval({verdict: clean, confirmations: {}, context: CTX})).toEqual({ok: false, code: "nothing_to_approve"});
        expect(clean.verdict).toBe("allow"); // consumers check `verdict === "allow"`; no token is needed
    });
});

describe("token bound to compose hash, rules, roots, context", () => {
    it("a built token checks ok against the same bytes and covers exactly the findings, grouped by service", () => {
        const {v, token, sha} = built();
        expect(token.overrides).toEqual([{service: "db", rules: ["network_mode_host"]}, {service: "web", rules: ["privileged", "cap_add"]}]);
        expect(token.compose_sha256).toBe(createHash("sha256").update(TWO).digest("hex"));
        expect(token.rules_sha256).toBe(RULES_SHA256);
        expect(sha).toMatch(/^[0-9a-f]{64}$/);
        expect(checkPolicyApproval({verdict: v, token, context: CTX})).toEqual({ok: true, overridden: groupOverrides(v)});
        expect(JSON.parse(JSON.stringify(token))).toEqual(token); // plain data
    });
    it("token invalid when the compose hash changes (one byte)", () => {
        const {token} = built();
        const changed = verdictOf(`${TWO} `);
        expect(changed.verdict).toBe("needs-explicit-override");
        expect(checkPolicyApproval({verdict: changed, token, context: CTX})).toEqual({ok: false, code: "compose_changed"});
        const flipped = TWO.replace("nginx:1", "nginx:2");
        expect(checkPolicyApproval({verdict: verdictOf(flipped), token, context: CTX})).toEqual({ok: false, code: "compose_changed"});
    });
    it("rules, roots, stack, recovery point and agent changes invalidate it", () => {
        const {v, token} = built();
        const check = (t: unknown, ctx = CTX, verdict = v) => checkPolicyApproval({verdict, token: t, context: ctx});
        expect(check({...token, rules_sha256: "0".repeat(64)})).toEqual({ok: false, code: "rules_changed"});
        expect(check({...token, roots: ["/elsewhere"]})).toEqual({ok: false, code: "roots_changed"});
        expect(check({...token, roots: [...token.roots, "/more"]})).toEqual({ok: false, code: "roots_changed"});
        expect(check(token, {...CTX, target_agent_id: OTHER_AGENT})).toEqual({ok: false, code: "context_mismatch"});
        expect(check(token, {...CTX, rp_id: OTHER_AGENT})).toEqual({ok: false, code: "context_mismatch"});
        expect(check(token, {...CTX, stack_id: OTHER_AGENT})).toEqual({ok: false, code: "context_mismatch"});
        expect(check({...token, target_agent_id: OTHER_AGENT})).toEqual({ok: false, code: "context_mismatch"});
        expect(check(token, CTX, verdictOf(TWO, ["/restore", "/more"]))).toEqual({ok: false, code: "roots_changed"});
    });
    it("coverage is exact: a missing service/rule is not_covered, an extra one is over_broad", () => {
        const {v, token} = built();
        const check = (overrides: unknown) => checkPolicyApproval({verdict: v, token: {...token, overrides}, context: CTX});
        expect(check([{service: "db", rules: ["network_mode_host"]}])).toEqual({ok: false, code: "not_covered"});
        expect(check([{service: "db", rules: ["network_mode_host"]}, {service: "web", rules: ["privileged"]}])).toEqual({ok: false, code: "not_covered"});
        expect(check([...token.overrides, {service: "ok", rules: ["privileged"]}])).toEqual({ok: false, code: "over_broad"});
        expect(check([{service: "db", rules: ["network_mode_host", "pid_host"]}, {service: "web", rules: ["privileged", "cap_add"]}])).toEqual({ok: false, code: "over_broad"});
        expect(check([...token.overrides, ...token.overrides])).toEqual({ok: false, code: "invalid"});
        expect(check([{service: "db", rules: ["network_mode_host", "network_mode_host"]}, {service: "web", rules: ["privileged", "cap_add"]}])).toEqual({ok: false, code: "invalid"});
    });
    it("forged or malformed tokens are invalid: hard ids in rules, unknown keys, bad hex, not an object", () => {
        const {v, token} = built();
        const check = (t: unknown) => checkPolicyApproval({verdict: v, token: t, context: CTX});
        expect(check({...token, overrides: [{service: "web", rules: ["read_outside_root"]}]})).toEqual({ok: false, code: "invalid"});
        expect(check({...token, overrides: [{service: "web", rules: ["signature_invalid"]}]})).toEqual({ok: false, code: "invalid"});
        expect(check({...token, extra: 1})).toEqual({ok: false, code: "invalid"});
        expect(check({...token, compose_sha256: "XYZ"})).toEqual({ok: false, code: "invalid"});
        expect(check({...token, stack_id: "nope"})).toEqual({ok: false, code: "invalid"});
        expect(check({...token, overrides: []})).toEqual({ok: false, code: "invalid"});
        expect(check({...token, overrides: [{service: "bad name", rules: ["privileged"]}]})).toEqual({ok: false, code: "invalid"});
        for (const t of [null, undefined, 5, "x", []]) expect(check(t)).toEqual({ok: false, code: "invalid"});
    });
    it("a token over a verdict with a hard refusal is refused", () => {
        const {token} = built();
        const hard = verdictOf(compose({web: svc({privileged: true}), x: svc({volumes: [{type: "bind", source: "rel", target: "/x"}]})}));
        expect(checkPolicyApproval({verdict: hard, token, context: CTX})).toEqual({ok: false, code: "hard_refusal"});
    });
});

/** W17 vectors: the agent re-checks the same token rules in Rust. Generated here, committed, re-verified on every run. */
type Case = {name: string; compose_text: string; roots: string[]; context: PolicyContext; token: unknown; expect: string; approval_sha256?: string};
function buildCases(): Case[] {
    const base = built();
    const t = base.token;
    const mk = (name: string, text: string, token: unknown, expectCode: string, extra: Partial<Case> = {}): Case => ({name, compose_text: text, roots: ["/restore"], context: CTX, token, expect: expectCode, ...extra});
    const hardText = compose({web: svc({privileged: true}), x: svc({volumes: [{type: "bind", source: "/restore/../x", target: "/x"}]})});
    return [
        mk("ok", TWO, t, "ok", {approval_sha256: base.sha}),
        mk("compose_changed_one_byte", `${TWO} `, t, "compose_changed"),
        mk("rules_changed", TWO, {...t, rules_sha256: "0".repeat(64)}, "rules_changed"),
        mk("roots_changed", TWO, {...t, roots: ["/other"]}, "roots_changed"),
        mk("context_mismatch_other_agent", TWO, {...t, target_agent_id: OTHER_AGENT}, "context_mismatch"),
        mk("not_covered_one_service_missing", TWO, {...t, overrides: [(t as {overrides: unknown[]}).overrides[0]]}, "not_covered"),
        mk("over_broad_extra_service", TWO, {...t, overrides: [...(t as {overrides: unknown[]}).overrides, {service: "ok", rules: ["privileged"]}]}, "over_broad"),
        mk("over_broad_extra_rule", TWO, {...t, overrides: [{service: "db", rules: ["network_mode_host", "pid_host"]}, {service: "web", rules: ["privileged", "cap_add"]}]}, "over_broad"),
        mk("hard_refusal_base_has_hard", hardText, t, "hard_refusal"),
        mk("invalid_hard_id_in_rules", TWO, {...t, overrides: [{service: "web", rules: ["read_outside_root"]}]}, "invalid"),
        mk("invalid_unknown_key", TWO, {...t, extra: true}, "invalid"),
        mk("invalid_bad_hex", TWO, {...t, compose_sha256: "ZZ"}, "invalid"),
    ];
}
const VECTORS = path.join(process.cwd(), "src/fork/__tests__/fixtures/compose-policy-approval-vectors.json");
const serialise = (cases: Case[]) => `${JSON.stringify({version: 1, rules_sha256: RULES_SHA256, note: "Approval-token vectors for W17 (agent re-check). Generated by w20a-compose-policy-approval.test.ts (W20A_VECTORS_OUT=<path>); re-verified on every run. No timestamps.", cases}, null, 1)}\n`;

describe("approval vectors for the agent (W17)", () => {
    it("generator mode: W20A_VECTORS_OUT=<path> writes the vector file", () => {
        const out = process.env.W20A_VECTORS_OUT;
        if (!out) return;
        writeFileSync(out, serialise(buildCases()));
    });
    it("the committed vector file equals what the reference generates (no drift) and every case re-checks to its expectation", () => {
        const committed = readFileSync(VECTORS, "utf8");
        expect(committed).toBe(serialise(buildCases()));
        const file = JSON.parse(committed) as {cases: Case[]};
        for (const c of file.cases) {
            const v = verdictOf(c.compose_text, c.roots);
            const r = checkPolicyApproval({verdict: v, token: c.token, context: c.context});
            expect(r.ok ? "ok" : r.code, c.name).toBe(c.expect);
            if (c.expect === "ok") expect(createHash("sha256").update(c.compose_text).digest("hex"), c.name).toBe((c.token as {compose_sha256: string}).compose_sha256);
        }
        expect(file.cases.map((c) => c.expect)).toEqual(expect.arrayContaining(["ok", "compose_changed", "rules_changed", "roots_changed", "context_mismatch", "not_covered", "over_broad", "hard_refusal", "invalid"]));
    });
});
