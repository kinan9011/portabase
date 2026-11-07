import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** Structural guards for the W07 surface (the behaviour is covered by the other w07 tests). */
const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? (f === "__tests__" || f === "__fixtures__" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : [];
});
const W07 = [...walk(path.join(ROOT, "src/fork/discovery")), ...walk(path.join(ROOT, "src/fork/inventory"))];
const src = (f: string) => readFileSync(path.resolve(ROOT, f), "utf8");
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("W07 discovery: read-only, no-leak, no-exec structure", () => {
    it("finds the W07 files", () => {
        expect(W07.map((f) => path.basename(f)).sort()).toEqual(expect.arrayContaining(["compose-yaml.ts", "labels.ts", "normalize.ts", "provider.ts", "schema.ts", "sync-state.ts", "sync-summary.ts", "sync.ts"]));
    });
    it("no logging, no console, no stdout in discovery/inventory (a secret can not be logged if nothing logs)", () => {
        for (const f of W07) expect(code(f), f).not.toMatch(/\bconsole\.|\blogger\b|\bpino\b|process\.std(out|err)/);
    });
    it("nothing can execute: no child_process / exec / spawn / docker / fetch in discovery or inventory — a `stop` label is data (D29, R1 never stops containers)", () => {
        for (const f of W07) {
            const t = code(f);
            expect(t, f).not.toMatch(/child_process|(?<![.\w])exec(File|Sync)?\s*\(|(?<![.\w])spawn(Sync)?\s*\(|docker\.sock|\bfetch\s*\(/);
            expect(t, f).not.toMatch(/\.(post|put|patch)\(/);
        }
    });
    it("inventory + normaliser never read env values, commands, entrypoints or raw label maps (allow-list only)", () => {
        const n = code("src/fork/inventory/normalize.ts");
        expect(n).not.toMatch(/\.(command|entrypoint|environment|config)\b/);
        expect(n).not.toMatch(/Object\.(entries|values)\(\s*\w*\.?labels/); // labels are only looked up by fixed key
        expect(n).not.toMatch(/\.\.\.\s*(c|rep|container|input)\b(?!\w)/); // no spread of an input object into the output
    });
    it("Sync now: the action is a thin userAction wrapper; the use-case authorises (arcane.manage, resource-scoped), gates (D21) and rate-limits BEFORE any sync", () => {
        const a = src("src/fork/actions/sync.action.ts");
        expect(a.startsWith('"use server";')).toBe(true);
        expect(a.match(/export const \w+Action = userAction\.inputSchema\(/g)).toHaveLength(1);
        expect(a.match(/^export /gm)).toHaveLength(1);
        expect(a).toContain("syncNow(await deps()");
        const s = code("src/fork/discovery/sync.ts");
        const body = s.slice(s.indexOf("export async function syncNow"));
        const idx = (needle: string) => body.indexOf(needle);
        expect(idx('"arcane.manage"')).toBeGreaterThan(-1);
        expect(idx('"arcane.manage"')).toBeLessThan(idx("assertForkConfigAllowed"));
        expect(idx("assertForkConfigAllowed")).toBeLessThan(idx("checkRate"));
        expect(idx("checkRate")).toBeLessThan(idx("syncConnection("));
    });
    it("only db/dto.ts reads or writes api_key_enc; sync reads the key through readConnectionApiKey", () => {
        for (const f of W07) expect(src(path.relative(ROOT, f)), f).not.toMatch(/apiKeyEnc|api_key_enc/);
        expect(code("src/fork/discovery/sync.ts")).toContain("readConnectionApiKey");
    });
    it("the sync takes the DB lease first and always releases it in finally (overlap = skip, ARCH-10)", () => {
        const s = code("src/fork/discovery/sync.ts");
        const body = s.slice(s.indexOf("export async function syncConnection"), s.indexOf("async function listEnabled"));
        expect(body.indexOf("acquireLease(")).toBeLessThan(body.indexOf("runLocked("));
        expect(body).toMatch(/finally\s*{\s*await releaseLease\(/);
    });
    it("the cron lives on the config plane, is mode-gated per tick and touches no upstream file (P03 withdrawn)", () => {
        const c = code("src/fork/cron.ts");
        expect(c).toContain('plane: "config"');
        expect(c.indexOf("await d.mode()")).toBeLessThan(c.indexOf("listDueConnections(db"));
        expect(readFileSync(path.join(ROOT, "scripts/fork/patch-registry.txt"), "utf8")).not.toMatch(/^P03\|/m);
        expect(readFileSync(path.join(ROOT, "src/utils/init/cron.ts"), "utf8")).not.toMatch(/fork/i);
    });
    it("W07 modules import upstream only through allowed seams (shared with W05/W06 pins)", () => {
        for (const f of W07) {
            const imports = [...src(path.relative(ROOT, f)).matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1]).filter((i) => !i.startsWith("@/fork/"));
            expect(imports, f).toEqual([]);
        }
    });
});
