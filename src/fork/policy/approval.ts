import {createHash} from "node:crypto";
import {z} from "zod";
import {canonicalJson} from "@/fork/canonical";
import type {PolicyVerdictV1} from "@/fork/policy/engine";
import {RULE_IDS, type RuleId} from "@/fork/policy/rules";

/**
 * Per-service policy approval token (W20a D-6/D-7, ADR-014 §17). DATA, not a credential: it carries no secret and no MAC. Integrity comes from the
 * D34 task signature (W18a embeds it in the signed `compose.up` payload; W17 re-checks it agent-side); on the dashboard `checkPolicyApproval`
 * re-checks it against a FRESH verdict right before enqueue. Bound to the SHA-256 of the exact rendered bytes, to the rule set, the restore
 * roots and the stack / recovery point / agent: any change ⇒ invalid (fail closed). Only `rules[]` ids are overridable (hard refusals are not
 * even representable in the schema). Signature / checksum failures are never policy inputs.
 */
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const PolicyApprovalV1 = z.strictObject({
    v: z.literal(1),
    compose_sha256: hex64,
    rules_sha256: hex64,
    roots: z.array(z.string().min(1).max(1024)).min(1).max(16),
    stack_id: z.uuid(),
    rp_id: z.uuid(),
    target_agent_id: z.uuid(),
    overrides: z.array(z.strictObject({service: z.string().regex(SERVICE), rules: z.array(z.enum(RULE_IDS)).min(1).max(RULE_IDS.length)})).min(1).max(500),
});
export type PolicyApprovalV1 = z.infer<typeof PolicyApprovalV1>;
export type PolicyContext = {stack_id: string; rp_id: string; target_agent_id: string};
export type Overridden = {service: string; rules: RuleId[]};

/** the phrase the operator types for ONE flagged service (outer whitespace trimmed, case-sensitive: same as the CLI's `[ "$ans" = "ALLOW $s" ]`). */
export const confirmationPhrase = (service: string) => `ALLOW ${service}`;

/** findings grouped by service: services sorted, rules in RULE_IDS order, de-duplicated. */
export function groupOverrides(verdict: PolicyVerdictV1): Overridden[] {
    const by = new Map<string, Set<RuleId>>();
    for (const f of verdict.findings) by.set(f.service, (by.get(f.service) ?? new Set()).add(f.rule));
    return [...by.keys()].sort().map((service) => ({service, rules: RULE_IDS.filter((r) => by.get(service)?.has(r))}));
}

export type BuildFailure = "hard_refusal" | "nothing_to_approve" | "missing_confirmation" | "confirmation_mismatch" | "service_not_flagged";
export function buildPolicyApproval(i: {verdict: PolicyVerdictV1; confirmations: Record<string, string>; context: PolicyContext}):
    | {ok: true; token: PolicyApprovalV1; approval_sha256: string}
    | {ok: false; code: BuildFailure} {
    const {verdict, confirmations, context} = i;
    if (verdict.hard.length > 0 || verdict.verdict === "deny") return {ok: false, code: "hard_refusal"};
    const overrides = groupOverrides(verdict);
    if (overrides.length === 0) return {ok: false, code: "nothing_to_approve"};
    const flagged = new Set(overrides.map((o) => o.service));
    if (Object.keys(confirmations).some((s) => !flagged.has(s))) return {ok: false, code: "service_not_flagged"};
    for (const {service} of overrides) {
        if (!Object.hasOwn(confirmations, service)) return {ok: false, code: "missing_confirmation"};
        if (String(confirmations[service]).trim() !== confirmationPhrase(service)) return {ok: false, code: "confirmation_mismatch"};
    }
    const token = PolicyApprovalV1.parse({v: 1, compose_sha256: verdict.compose_sha256, rules_sha256: verdict.rules_sha256, roots: [...verdict.roots].sort(), ...context, overrides});
    return {ok: true, token, approval_sha256: createHash("sha256").update(canonicalJson(token)).digest("hex")};
}

export type CheckFailure = "invalid" | "hard_refusal" | "compose_changed" | "rules_changed" | "roots_changed" | "context_mismatch" | "not_covered" | "over_broad";
export function checkPolicyApproval(i: {verdict: PolicyVerdictV1; token: unknown; context: PolicyContext}): {ok: true; overridden: Overridden[]} | {ok: false; code: CheckFailure} {
    const parsed = PolicyApprovalV1.safeParse(i.token);
    if (!parsed.success) return {ok: false, code: "invalid"};
    const t = parsed.data;
    const {verdict, context} = i;
    if (verdict.hard.length > 0 || verdict.verdict === "deny") return {ok: false, code: "hard_refusal"};
    if (t.compose_sha256 !== verdict.compose_sha256) return {ok: false, code: "compose_changed"};
    if (t.rules_sha256 !== verdict.rules_sha256) return {ok: false, code: "rules_changed"};
    if (JSON.stringify([...t.roots].sort()) !== JSON.stringify([...verdict.roots].sort())) return {ok: false, code: "roots_changed"};
    if (t.stack_id !== context.stack_id || t.rp_id !== context.rp_id || t.target_agent_id !== context.target_agent_id) return {ok: false, code: "context_mismatch"};
    const want = groupOverrides(verdict);
    const got = new Map<string, Set<RuleId>>();
    for (const o of t.overrides) {
        if (got.has(o.service) || new Set(o.rules).size !== o.rules.length) return {ok: false, code: "invalid"}; // duplicates are never produced by buildPolicyApproval
        got.set(o.service, new Set(o.rules));
    }
    for (const w of want) {
        const g = got.get(w.service);
        if (!g || w.rules.some((r) => !g.has(r))) return {ok: false, code: "not_covered"};
    }
    const wantBy = new Map(want.map((w) => [w.service, new Set(w.rules)]));
    for (const [service, rules] of got) {
        const w = wantBy.get(service);
        if (!w || [...rules].some((r) => !w.has(r))) return {ok: false, code: "over_broad"};
    }
    return {ok: true, overridden: want};
}
