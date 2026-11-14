import {readFileSync, readdirSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {RULES_SHA256} from "@/fork/policy/rules";

/** Purity guard (W20 D-9): the mirror compiler is a pure library. No I/O, clock, randomness, process, network or DB. */
const DIR = path.join(process.cwd(), "src/fork/compose-compiler");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const ALLOWED = [/^node:crypto$/, /^zod$/, /^@\/fork\/policy\/(engine|raw|rules)$/, /^@\/fork\/restore-tasks\/view$/, /^@\/fork\/inventory\/labels$/, /^@\/fork\/canonical$/, /^@\/fork\/compose-compiler\/(rules|ir|compile|env|diff)$/];
/** recorded at W20 Step 0 (origin/main 2e50fd51): an accidental edit of compose-deny.json or the rule loader stales every stored plan and the agent corpus */
const RULES_SHA256_AT_W20 = "8bc218ae0bcdec9d390f0126fa70f2ec57061b7ac0f28c45f33cfc4926b9ca0a";

describe("mirror compiler is pure (W20 D-9)", () => {
    it("has the five modules and the vectors file", () => {
        expect(files.sort()).toEqual(["compile.ts", "diff.ts", "env.ts", "ir.ts", "rules.ts"]);
    });
    it.each(files)("%s: import allow-list and no forbidden API", (f) => {
        const src = readFileSync(path.join(DIR, f), "utf8");
        const imports = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g)].map((m) => m[1] as string);
        for (const i of imports) expect(ALLOWED.some((re) => re.test(i)), `${f} imports ${i}`).toBe(true);
        expect(src).not.toMatch(/\bimport\s*\(/); // no dynamic import
        expect(src).not.toMatch(/\brequire\s*\(/);
        for (const bad of [/process\.env/, /\bDate\b/, /Math\.random/, /\bconsole\./, /\bchild_process\b/, /\bfetch\s*\(/, /node:fs/, /from "fs"/, /@\/fork\/db/, /\bspawn/, /\bexec(Sync)?\s*\(/, /node:net/, /node:http/, /setTimeout/]) {
            expect(src, `${f} must not match ${bad}`).not.toMatch(bad);
        }
    });
    it("the shared rule file is unchanged (RULES_SHA256 recorded at Step 0)", () => {
        expect(RULES_SHA256).toBe(RULES_SHA256_AT_W20);
    });
    it("only the two known modules may import child_process under src/fork (W20 adds none)", () => {
        const hits: string[] = [];
        const walk = (d: string) => {
            for (const e of readdirSync(d, {withFileTypes: true})) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); }
                else if (/\.tsx?$/.test(e.name) && /child_process/.test(readFileSync(p, "utf8"))) hits.push(path.relative(process.cwd(), p));
            }
        };
        walk(path.join(process.cwd(), "src/fork"));
        expect(hits.some((h) => h.includes("compose-compiler"))).toBe(false);
    });
});
