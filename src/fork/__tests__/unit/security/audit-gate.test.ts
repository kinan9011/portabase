import {describe, expect, it} from "vitest";
import {ACCEPTED, evaluate, FORK_DIRECT} from "../../../../../scripts/fork/audit-gate.mjs";

const adv = (over: Record<string, unknown>) => ({github_advisory_id: "GHSA-test", module_name: "x", severity: "moderate", vulnerable_versions: "<1", patched_versions: ">=1", findings: [{paths: [".>x"]}], ...over});
const rep = (...a: Record<string, unknown>[]) => ({advisories: Object.fromEntries(a.map((x, i) => [String(i), adv(x)]))});

describe("W27a audit gate (OD-W27-9): fails only for high/critical advisories on fork-added dependencies", () => {
    it("shape pinned against a real `pnpm audit --json` record (advisories → {severity, module_name, findings[].paths, github_advisory_id})", () => {
        const real = {findings: [{version: "3.2.4", paths: [".>@better-auth/passkey>better-auth>vitest"], dev: false, optional: false, bundled: false}], id: 1, title: "t", module_name: "vitest", vulnerable_versions: "<3.2.6", patched_versions: ">=3.2.6", severity: "critical", github_advisory_id: "GHSA-5xrq-8626-4rwp", url: "u"};
        expect(evaluate({advisories: {"1": real}}).gated).toEqual(["critical vitest GHSA-5xrq-8626-4rwp (<3.2.6 -> >=3.2.6)"]);
    });
    it("a high/critical advisory on a fork direct dependency (by module OR by path hop) is gated", () => {
        for (const m of FORK_DIRECT) expect(evaluate(rep({module_name: m, severity: "high"})).gated.length, m).toBe(1);
        expect(evaluate(rep({module_name: "tinypool", severity: "critical", findings: [{paths: [".>better-auth>vitest>tinypool"]}]})).gated.length).toBe(1);
    });
    it("upstream-only high/critical and fork-owned moderate/low stay informational", () => {
        const r = evaluate(rep({module_name: "decode-uri-component", severity: "high", findings: [{paths: [".>minio>query-string>decode-uri-component"]}]}, {module_name: "vitest", severity: "moderate"}, {module_name: "yaml", severity: "low"}));
        expect(r).toEqual({gated: [], accepted: [], informational: 3});
    });
    it("an ACCEPTED id (written reason) is reported as accepted, not gated; a different id on the same module is still gated", () => {
        const id = Object.keys(ACCEPTED)[0];
        expect(evaluate(rep({module_name: "tinypool", severity: "critical", github_advisory_id: id, findings: [{paths: [".>better-auth>vitest>tinypool"]}]})).accepted.length).toBe(1);
        expect(evaluate(rep({module_name: "tinypool", severity: "critical", github_advisory_id: "GHSA-new", findings: [{paths: [".>better-auth>vitest>tinypool"]}]})).gated.length).toBe(1);
        for (const reason of Object.values(ACCEPTED)) expect((reason as string).length).toBeGreaterThan(30);
    });
    it("empty / malformed reports do not crash", () => { expect(evaluate({})).toEqual({gated: [], accepted: [], informational: 0}); expect(evaluate(null)).toEqual({gated: [], accepted: [], informational: 0}); });
});
