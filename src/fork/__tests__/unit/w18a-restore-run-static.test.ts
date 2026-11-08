import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "src/fork/restore-run");
const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === "__tests__") continue;
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
    return out;
};
const rel = (f: string) => path.relative(ROOT, f);
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const FILES = walk(DIR);
const SCOPE = [...FILES, path.join(ROOT, "src/fork/actions/restore-run.action.ts")];
const only = (n: string) => FILES.find((f) => path.basename(f) === n)!;

/** the keys of every `details: { … }` object literal of every `recordAudit(` call in `src` (depth-1 identifiers only) */
function auditKeys(src: string): string[] {
    const keys: string[] = [];
    for (const m of src.matchAll(/recordAudit\(/g)) {
        const call = src.slice(m.index!, m.index! + 4000);
        const at = call.search(/details:\s*\{/);
        if (at < 0) continue;
        let i = call.indexOf("{", at);
        let depth = 0;
        let token = "";
        for (; i < call.length; i++) {
            const ch = call[i];
            if (ch === "{" || ch === "[" || ch === "(") { depth++; token = ""; continue; }
            if (ch === "}" || ch === "]" || ch === ")") {
                if (depth === 1 && ch === "}" && /^[A-Za-z_]\w*$/.test(token.trim())) keys.push(token.trim());
                depth--; token = "";
                if (depth === 0) break;
                continue;
            }
            if (depth === 1 && (ch === ":" || ch === ",")) { if (/^[A-Za-z_]\w*$/.test(token.trim())) keys.push(token.trim()); token = ch === ":" ? "\u0000" : ""; continue; }
            if (token === "\u0000") { if (ch === ",") token = ""; continue; } // skip the value until the next depth-1 comma
            token += ch;
        }
    }
    return keys;
}

describe("W18a static guards (orchestrator: one task builder, pure vocabulary, honest wording)", () => {
    it("the module scope is exactly the planned files (no execute.ts: the W16 planner directory stays pinned)", () => {
        expect(FILES.map((f) => path.basename(f)).sort()).toEqual(["deps.ts", "derive.ts", "job.ts", "manifest.ts", "service.ts", "steps.ts", "tick.ts", "view.ts", "vocab.ts"]);
    });
    it("vocab.ts and derive.ts are pure: no Date / env / DB / crypto / network / agent-channel", () => {
        for (const n of ["vocab.ts", "derive.ts"]) {
            const c = code(only(n));
            expect(c, n).not.toMatch(/new Date\(|Date\.now|process\.env|forkEnv|node:|@\/fork\/db|drizzle-orm|\bfetch\(|@\/fork\/agent-channel|@\/fork\/(keys|kek)\b|@\/lib\/logger|Math\.random/);
            for (const m of c.matchAll(/(?:from\s+)["']([^"']+)["']/g)) expect(["zod", "./vocab", "@/fork/restore/schema"], `${n} imports ${m[1]}`).toContain(m[1]);
        }
    });
    it("only enqueueRestoreTask builds tasks: no insertSignedTask / enqueueTask, no agent version", () => {
        for (const f of SCOPE) {
            const c = code(f);
            expect(c, rel(f)).not.toMatch(/\binsertSignedTask\b|\benqueueTask\b|\bagentVersion\b|agent_version/);
        }
    });
    it("the step engine is the W12 one (ARCH-13), imported, not re-implemented", () => {
        expect(code(only("tick.ts"))).toMatch(/import\s*\{[^}]*\badvanceSteps\b[^}]*\}\s*from\s*"@\/fork\/runs\/engine"/);
        expect(code(only("steps.ts"))).toMatch(/from\s*"@\/fork\/runs\/engine"/);
        expect(FILES.map(rel).filter((f) => /engine/.test(f))).toEqual([]);
    });
    it("no console.*, and logger only in the job with fixed messages (never a result / manifest / task variable)", () => {
        for (const f of SCOPE) {
            const c = code(f);
            expect(c, rel(f)).not.toMatch(/\bconsole\./);
            if (path.basename(f) !== "job.ts") expect(c, rel(f)).not.toMatch(/\blogger\b|\blog\.(info|warn|error|debug)\(/);
        }
        for (const m of code(only("job.ts")).matchAll(/log\.(?:info|warn|error)\(([^;]*)\);/g)) expect(m[1], m[0]).not.toMatch(/result|manifest|payload|task|approval|override/i);
    });
    it("no 'tested' / 'start-tested' wording and no recovery-point status write (D36, D43): a restore never claims more than it observed", () => {
        for (const f of SCOPE) {
            const c = code(f);
            expect(c, rel(f)).not.toMatch(/restore[_-]?tested|start[_-]?tested|\btested\b/i);
            expect(c, rel(f)).not.toMatch(/update\(\s*forkRecoveryPoint\b|status:\s*"verified"/);
        }
    });
    it("audit details carry ids, hashes, codes and counts: no key that could hold a url, payload, manifest, path, env or value", () => {
        const banned = /url|payload|manifest\b|dest|workspace|path|env|value/i;
        let seen = 0;
        for (const f of SCOPE) {
            for (const k of auditKeys(code(f))) { seen += 1; expect(k, `${rel(f)} audit key ${k}`).not.toMatch(banned); }
        }
        expect(seen).toBeGreaterThan(15); // the extractor really read the calls
    });
    it("upstream tables are reached only through src/fork/upstream (no @/db/schema import in the module)", () => {
        for (const f of SCOPE) expect(code(f), rel(f)).not.toMatch(/@\/db\/schema\//);
    });
    it("no API route for restore runs (server actions only: Next's origin check is the CSRF guard); the action file is the thin wrapper", () => {
        const api = path.join(ROOT, "app/api/fork");
        const routes = walk(api).map(rel).filter((f) => /restore/i.test(f));
        expect(routes).toEqual([]);
        const a = code(path.join(ROOT, "src/fork/actions/restore-run.action.ts"));
        expect(a).toMatch(/^"use server";/);
        expect((a.match(/export const \w+Action = userAction\.inputSchema\(z\.unknown\(\)\)/g) ?? []).length).toBe(6);
    });
    it("the job is a runtime-plane task registered once and guarded by the process key", () => {
        const j = code(only("job.ts"));
        expect(j).toMatch(/name:\s*"fork-restore-runs"/);
        expect(j).toMatch(/plane:\s*"runtime"/);
        expect(j).toMatch(/Symbol\.for\("portabase\.fork\.restore-runs\.v1"\)/);
        expect(j).toMatch(/FORK_RESTORE_TICK_SECONDS/);
    });
});
