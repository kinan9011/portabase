import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import * as labels from "@/fork/ui/recovery/labels";

const ROOT = path.resolve(__dirname, "../../../..");
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const RECOVERY_APP = path.join(ROOT, "app/(customer)/dashboard/(organization)/recovery");
const SCOPE = [...walk(path.join(ROOT, "src/fork/ui/recovery")), ...walk(path.join(ROOT, "src/fork/restore-wizard")), ...walk(RECOVERY_APP)].filter((f) => /\.(ts|tsx)$/.test(f));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const src = (f: string) => strip(readFileSync(f, "utf8"));
const rel = (f: string) => path.relative(ROOT, f);

const FORBIDDEN = /\bmode\b|new_stack|existing_stack|\bselective\b|orchestrat|\blease\b|payload|\brender|compose_up|plan hash|restore_id|restore-tested|start-tested|\bhealthy\b|\btested\b/i;

/** Every string a user can read from the labels module (functions are called with sample arguments; code lists are skipped: they are not display text). */
function texts(x: unknown, out: string[] = [], depth = 0): string[] {
    if (depth > 8) return out;
    if (typeof x === "string") out.push(x);
    else if (typeof x === "function") { try { texts((x as (...a: unknown[]) => unknown)("clean-host", "notes", "svc", "8080"), out, depth + 1); } catch { /* needs another argument shape */ } try { texts((x as (...a: unknown[]) => unknown)(["a", "b"], 2, 3), out, depth + 1); } catch { /* ignore */ } }
    else if (Array.isArray(x)) x.forEach((y) => texts(y, out, depth + 1));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) if (k !== "codes") texts(y, out, depth + 1);
    return out;
}

describe("W18b static guards", () => {
    it("scope is not empty (the guard would pass vacuously otherwise)", () => {
        expect(SCOPE.length).toBeGreaterThan(10);
        expect(SCOPE.some((f) => f.endsWith("restore-wizard/view.ts"))).toBe(true);
        expect(SCOPE.some((f) => f.endsWith("recovery/runs/[runId]/page.tsx"))).toBe(true);
    });
    it("1. copy honesty: no internal vocabulary or 'tested/healthy' claim in any label, and none in the JSX text / string literals of the scope", () => {
        const all = texts({...labels, VOCABULARIES: undefined, FAILURE_GROUPS: labels.FAILURE_GROUPS.map((g) => ({text: g.text}))});
        expect(all.length).toBeGreaterThan(300);
        for (const t of all) expect(t, t).not.toMatch(FORBIDDEN);
        const bad: string[] = [];
        for (const f of SCOPE.filter((x) => x.endsWith(".tsx"))) {
            const code = src(f);
            for (const m of code.matchAll(/"([^"\n]{3,})"|>([^<>{}\n]{3,})</g)) {
                const lit = (m[1] ?? m[2] ?? "").trim();
                if (lit.includes(" ") && FORBIDDEN.test(lit)) bad.push(`${rel(f)}: ${lit}`);
            }
        }
        expect(bad).toEqual([]);
    });
    it("2. model.ts is pure: no clock, env, DB, fetch, React or client marker", () => {
        const code = src(path.join(ROOT, "src/fork/ui/recovery/model.ts"));
        for (const bad of [/Date\.now/, /new Date\(\)/, /process\.env/, /@\/fork\/db/, /drizzle/, /fetch\(/, /"use client"/, /from "react"/]) expect(code, String(bad)).not.toMatch(bad);
        expect(readFileSync(path.join(ROOT, "src/fork/ui/recovery/labels.ts"), "utf8")).not.toMatch(/"use client"/);
    });
    it("3. client files never import plan / run / wizard read services, the DB, keys, or the plan-view action (plan views stay server-side)", () => {
        for (const f of SCOPE.filter((x) => x.endsWith(".client.tsx"))) {
            const code = src(f);
            for (const bad of [/@\/fork\/restore\/service/, /@\/fork\/restore-run\/view["']/, /@\/fork\/restore-wizard\/view/, /@\/fork\/db\//, /@\/fork\/keys/, /getRestorePlanViewAction/]) {
                // type-only imports are erased and allowed
                const lines = code.split("\n").filter((l) => bad.test(l) && !/^\s*import type /.test(l));
                expect(lines, `${rel(f)} ${bad}`).toEqual([]);
            }
        }
        for (const f of SCOPE.filter((x) => x.includes("src/fork/ui/recovery"))) expect(src(f), rel(f)).not.toMatch(/@\/fork\/keys/);
    });
    it("4. polling only: no console, browser storage, React Query hooks, EventSource or WebSocket in the scope", () => {
        for (const f of SCOPE) {
            const code = src(f);
            for (const bad of [/\bconsole\./, /localStorage|sessionStorage/, /\buseQuery\b/, /EventSource|WebSocket/]) expect(code, `${rel(f)} ${bad}`).not.toMatch(bad);
        }
    });
    it("5. Radix primitives only: no <Dialog (confirms are AlertDialog via DangerousActionConfirm), no direct @radix-ui import", () => {
        for (const f of SCOPE) { const code = src(f); expect(code, rel(f)).not.toMatch(/<Dialog\b/); expect(code, rel(f)).not.toMatch(/@radix-ui\//); }
    });
    it("6. every page exports force-dynamic and checks the fork mode before it reads the principal", () => {
        const pages = SCOPE.filter((f) => /\/page\.tsx$/.test(f));
        expect(pages.length).toBe(4);
        for (const f of pages) {
            const code = src(f);
            expect(code, rel(f)).toMatch(/export const dynamic = "force-dynamic"/);
            expect(code.indexOf("currentForkMode()"), rel(f)).toBeGreaterThan(-1);
            expect(code.indexOf("currentForkMode()"), rel(f)).toBeLessThan(code.indexOf("getForkPrincipal()"));
        }
    });
    it("7. no API route for restore or recovery under app/api/fork", () => {
        expect(walk(path.join(ROOT, "app/api/fork")).filter((f) => /restore|recovery/i.test(path.relative(path.join(ROOT, "app/api/fork"), f)))).toEqual([]);
    });
    it("8. the wizard read model never names an enrolment credential column", () => {
        expect(src(path.join(ROOT, "src/fork/restore-wizard/view.ts"))).not.toMatch(/credentialHash|prevCredentialHash|pendingCredentialHash|taskKeyEnc|pinnedKids|pinFingerprint|enrollId/);
    });
    it("9. secret-bearing inputs carry the §8.2 attributes (typed confirm + ALLOW) and nothing in scope puts a value in a URL", () => {
        const run = src(path.join(ROOT, "src/fork/ui/recovery/run-view.client.tsx"));
        for (const a of [/spellCheck=\{false\}/, /autoComplete="off"/, /data-gramm="false"/, /data-1p-ignore/]) expect(run).toMatch(a);
        for (const f of SCOPE) expect(src(f), rel(f)).not.toMatch(/router\.(push|replace)\([^)]*(confirm|typed|secret|value)=/i);
    });
});
