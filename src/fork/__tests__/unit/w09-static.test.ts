import {readFileSync, readdirSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** Structural guards of W09: the validator stays pure, the Configuration tab stays read-only, copy stays in labels.ts. */
const ROOT = path.resolve(__dirname, "../../..");
const walk = (d: string): string[] => readdirSync(d, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => /\.tsx?$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const completeness = walk(path.join(ROOT, "fork/completeness"));
const cfg = walk(path.join(ROOT, "fork/ui/stacks/config-tab"));

describe("W09 static guards", () => {
    it("finds the files", () => { expect(completeness.length).toBe(7); expect(cfg.length).toBe(4); });
    it("src/fork/completeness is pure: no db, no react, no fs/network, no clock, no randomness", () => {
        for (const f of completeness) {
            expect(code(f), f).not.toMatch(/from "(react|next|node:|drizzle-orm|@\/db|@\/fork\/db)|require\(|\bfetch\(|Date\.now|new Date\(\)|Math\.random|process\.env/);
        }
    });
    it("the browser-facing view mapper is the only completeness file that imports zod, and it declares no free-text value field", () => {
        const view = code(path.join(ROOT, "fork/completeness/view.ts"));
        expect(view).not.toMatch(/\b(value|values|content|contents|command|cmd|labels|env_values|secret)\s*:\s*z\./);
        for (const f of completeness.filter((x) => !x.endsWith("view.ts"))) expect(code(f), f).not.toMatch(/from "zod"/);
    });
    it("Configuration tab is read-only: no download, no fetch, no forms, no inputs, no server action, no storage", () => {
        for (const f of cfg) {
            expect(code(f), f).not.toMatch(/\bdownload\b|blob:|data:|<a\b|<form|<input|<textarea|"use server"|\bfetch\(|localStorage|sessionStorage|dangerouslySetInnerHTML|navigator\.clipboard|window\.open/);
        }
    });
    it("the Configuration tab never imports the inventory schema, the db or the loaders (it only gets the strict DTO)", () => {
        for (const f of cfg) expect(code(f), f).not.toMatch(/@\/fork\/inventory|@\/fork\/db|@\/fork\/stacks\/(queries|protection)|drizzle-orm/);
    });
    it("copy comes from labels.ts: no sentence-length string literal in config-tab components", () => {
        for (const f of cfg) {
            const src = code(f).replace(/(className|data-testid|aria-[a-z]+|id|key|scope|type|variant|size|tone)=("[^"]*"|\{[^}]*\})/g, "");
            const lits = [...src.matchAll(/\{\s*"([^"{}<>\n]{25,})"\s*\}|:\s*"([^"{}<>\n]{25,})"|\?\s*"([^"{}<>\n]{25,})"/g)].map((m) => m[1] ?? m[2] ?? m[3]);
            expect(lits, f).toEqual([]);
            const jsxText = [...src.matchAll(/>\s*([A-Za-z][^<>{}\n]{24,})\s*</g)].map((m) => m[1]);
            expect(jsxText, f).toEqual([]);
        }
    });
    it("no hover-only copy: no title= or tooltip primitives in the new components", () => {
        for (const f of [...cfg, path.join(ROOT, "fork/ui/stacks/stack-details.client.tsx")]) expect(code(f), f).not.toMatch(/<(?:div|span|a|button|section|li|p|abbr|td|th)\b[^>]*\btitle=|Tooltip|data-tooltip|onMouseEnter/);
    });
    it("the protection loader writes nothing (read-only M1)", () => {
        for (const f of [path.join(ROOT, "fork/stacks/protection.ts"), path.join(ROOT, "fork/stacks/queries.ts")]) expect(code(f), f).not.toMatch(/\b(insert|update|delete)\b\s+(into|from|\w+\s+set)|\.insert\(|\.update\(|\.delete\(|recordAudit/i);
    });
    it("page order is unchanged: authorise before loading the detail (the loader also gets the lock flag)", () => {
        const page = code(path.resolve(ROOT, "../app/(customer)/dashboard/(organization)/stacks/[stackId]/page.tsx"));
        expect(page.indexOf("assertForkResource(")).toBeLessThan(page.indexOf("loadStackDetail("));
        expect(page).toContain('configLocked: mode.mode === "locked"');
    });
});
