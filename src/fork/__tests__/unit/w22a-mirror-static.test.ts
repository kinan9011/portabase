import {existsSync, readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** W22a purity + guard rules for `src/fork/mirror/**` (plan-W22a A1/A5/A7). */
const DIR = path.join(process.cwd(), "src/fork/mirror");
const read = (f: string) => readFileSync(path.join(DIR, f), "utf8");
const PURE = ["vocab.ts", "machine.ts", "payload-schema.ts", "build.ts", "derive.ts"].filter((f) => existsSync(path.join(DIR, f)));
const FORBIDDEN = [/process\.env/, /\bDate\.now\b/, /new Date\(\)/, /Math\.random/, /\bconsole\./, /child_process/, /\bfetch\s*\(/, /node:fs/, /from "fs"/, /@\/fork\/db/, /\bspawn/, /node:net/, /node:http/, /setTimeout/];
const importsOf = (src: string) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g)].map((m) => m[1] as string);

describe("W22a mirror module purity", () => {
    it("the pure modules exist", () => {
        for (const f of ["vocab.ts", "machine.ts"]) expect(PURE).toContain(f);
    });
    it.each(PURE)("%s: no I/O, clock, randomness, process, DB", (f) => {
        const src = read(f);
        for (const bad of FORBIDDEN) expect(src, `${f} must not match ${bad}`).not.toMatch(bad);
        expect(src).not.toMatch(/\bimport\s*\(/);
        for (const i of importsOf(src)) expect(i, `${f} imports ${i}`).not.toMatch(/^(node:|@\/fork\/db|@\/db)/);
    });
});

describe("W22a mirror module guards", () => {
    const all = (d: string): string[] => readdirSync(d, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? all(path.join(d, e.name)) : /\.ts$/.test(e.name) ? [path.join(d, e.name)] : []));
    it("every DB write of `state` goes through transition() (`state: next`)", () => {
        for (const p of all(DIR)) {
            const src = readFileSync(p, "utf8");
            for (const m of src.matchAll(/\.set\(\{([^}]*)\}\)/gs)) {
                const body = m[1] as string;
                const hit = body.match(/(?:^|[\s,{])state:\s*([^,\n}]+)/);
                if (hit) expect((hit[1] as string).trim(), `${path.basename(p)}: ${body.slice(0, 80)}`).toBe("next");
            }
        }
    });
    it("only enqueue.ts under src/fork/mirror inserts signed tasks", () => {
        for (const p of all(DIR)) {
            const src = readFileSync(p, "utf8");
            if (/\binsertSignedTask\s*\(/.test(src)) expect(path.basename(p)).toBe("enqueue.ts");
        }
    });
});
