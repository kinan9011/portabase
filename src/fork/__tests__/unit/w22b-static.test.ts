import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {MIRRORS} from "@/fork/ui/mirrors/labels";

const ROOT = path.resolve(__dirname, "../../../..");
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const APP = path.join(ROOT, "app/(customer)/dashboard/(organization)/mirrors");
const UI = path.join(ROOT, "src/fork/ui/mirrors");
const SCOPE = [...walk(UI), ...walk(APP), path.join(ROOT, "src/fork/mirror/wizard-view.ts")].filter((f) => /\.(ts|tsx)$/.test(f));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const src = (f: string) => strip(readFileSync(f, "utf8"));
const rel = (f: string) => path.relative(ROOT, f);
const CLIENT = SCOPE.filter((f) => /\.client\.tsx$/.test(f) || f.endsWith("wizard/model.ts"));

describe("W22b static guards", () => {
    it("scope is not empty (the guard would pass vacuously otherwise)", () => {
        expect(SCOPE.length).toBeGreaterThan(8);
        expect(SCOPE.some((f) => f.endsWith("mirrors/new/page.tsx"))).toBe(true);
        expect(SCOPE.some((f) => f.endsWith("mirrors/[mirrorId]/page.tsx"))).toBe(true);
        expect(SCOPE.some((f) => f.endsWith("progress.client.tsx"))).toBe(true);
        expect(CLIENT.length).toBeGreaterThanOrEqual(5);
    });
    it("no React Query, no secret input, no storage, no SSE, no raw <select> or custom listbox (Radix Select / RadioGroup only)", () => {
        for (const f of SCOPE) {
            const c = src(f);
            expect(c, rel(f)).not.toMatch(/useQuery|@tanstack\/react-query/);
            expect(c, rel(f)).not.toMatch(/type=["']password["']|type=\{["']password["']\}/);
            expect(c, rel(f)).not.toMatch(/localStorage|sessionStorage|indexedDB/);
            expect(c, rel(f)).not.toMatch(/EventSource|text\/event-stream/);
            expect(c, rel(f)).not.toMatch(/<select[\s>]|role=["']listbox["']|<datalist/);
        }
    });
    it("client files take no server value import: only vocab constants, ui and the action modules (types may come from anywhere)", () => {
        const BAD = /^import\s+(?!type\b)[^;]*from\s+["']@\/fork\/(mirror\/(service|tick|steps|wizard-view|enqueue|build|derive|policy|machine)|db|compose-compiler|runner|restore\/|acl|audit|keys|env)\b/m;
        for (const f of CLIENT) expect(src(f), rel(f)).not.toMatch(BAD);
    });
    it("hrefs are built from the query keys stack|point|runner|step only (no env key, name or value in a URL)", () => {
        for (const f of SCOPE.filter((x) => !x.endsWith("wizard-view.ts"))) {
            const c = src(f);
            for (const m of c.matchAll(/\/dashboard\/mirrors\/new\?([^`"']*)/g)) for (const k of m[1]!.matchAll(/(?:^|&)([a-z]+)=/g)) expect(["stack", "point", "runner", "step"], `${rel(f)}: ${m[0]}`).toContain(k[1]);
        }
        expect(src(path.join(UI, "wizard/common.client.tsx"))).toMatch(/\["step", "stack", "point", "runner"\]/);
    });
    it("the release-gated stub text is gone from the product; labels.ts carries the new stub reason exactly twice", () => {
        const hits = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "app"))].filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__") && readFileSync(f, "utf8").includes("not part of this release"));
        expect(hits.map(rel)).toEqual([]);
        const labels = readFileSync(path.join(ROOT, "src/fork/ui/labels.ts"), "utf8");
        expect(labels.split("Test mirrors are not enabled on this installation.").length - 1).toBe(2);
    });
    it("the Ready copy never claims verified or restore-tested; the wizard has no hover-only text (title / tooltip)", () => {
        expect(MIRRORS.progress.ready("r")).not.toMatch(/verified|restore-tested/i);
        for (const f of SCOPE) expect(src(f), rel(f)).not.toMatch(/<(?:div|span|button|a|p|li|svg|Button|Link|Input)\b[^>]*\stitle=|Tooltip/);
    });
});
