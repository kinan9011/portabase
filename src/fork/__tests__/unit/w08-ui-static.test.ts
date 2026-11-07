import {readFileSync, readdirSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** Structural guards for the W08 stacks UI + read model. */
const ROOT = path.resolve(__dirname, "../../..");
const APP = path.resolve(ROOT, "../app/(customer)/dashboard/(organization)/stacks");
const walk = (d: string): string[] => readdirSync(d, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => /\.tsx?$/.test(f));
const ui = walk(path.join(ROOT, "fork/ui/stacks"));
const server = walk(path.join(ROOT, "fork/stacks"));
const pages = walk(APP);
const read = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"); // comments may mention forbidden words

describe("W08 static guards", () => {
    it("finds the files", () => { expect(ui.length).toBeGreaterThanOrEqual(8); expect(server.length).toBe(4); expect(pages.length).toBe(2); });

    it("no SSE / WebSocket / upstream event bus, no network from the UI: progress is polled through router.refresh() only (UX-13, CH-32)", () => {
        for (const f of [...ui, ...server, ...pages]) expect(code(f), f).not.toMatch(/EventSource|text\/event-stream|WebSocket|@\/lib\/event|\bfetch\(|XMLHttpRequest|sendBeacon/);
        const poller = read(path.join(ROOT, "fork/ui/stacks/sync-poller.tsx"));
        expect(poller).toMatch(/setInterval\(\(\) => router\.refresh\(\), POLL_MS\)/);
        expect(poller).toContain("clearInterval");
    });
    it("no raw HTML injection, browser storage, cookies or console output", () => {
        for (const f of [...ui, ...server, ...pages]) expect(code(f), f).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|indexedDB|document\.cookie|console\.|\.innerHTML/);
    });
    it("the browser side never sees the database or the raw inventory: ui/stacks imports no db, no schema, no queries, no inventory schema", () => {
        for (const f of ui) expect(code(f), f).not.toMatch(/@\/db\b|@\/fork\/db|@\/fork\/stacks\/queries|@\/fork\/inventory|drizzle-orm|jsonb|\.inventory\b.*as/);
    });
    it("the stacks pages never select the inventory column themselves (only the DTO loaders touch it)", () => {
        for (const f of pages) expect(code(f), f).not.toMatch(/fork_stack_inventory|forkStackInventory|\.inventory\b/);
    });
    it("hard-coded colours only in the one tone map", () => {
        for (const f of [...ui, ...pages]) expect(code(f), f).not.toMatch(/#[0-9a-fA-F]{6}\b|\brgb\(|\bhsl\(|\boklch\(/);
    });
    it("state words that imply a guarantee never appear in component code (they come from labels.ts, which has none for this release)", () => {
        for (const f of ui) expect(code(f), f).not.toMatch(/["'`>][^"'`<]*\b(Protected|Backed up|Verified|Restore-tested|Healthy|All good)\b/);
    });
    it("a server page never calls a function exported from a \"use client\" module (Next refuses it at render time; jsdom would not notice)", () => {
        const clientModules = ui.filter((f) => read(f).trimStart().startsWith('"use client"'));
        expect(clientModules.length).toBeGreaterThanOrEqual(3);
        for (const f of clientModules) {
            const nonComponent = [...read(f).matchAll(/export (?:const|function|async function) ([a-z][A-Za-z0-9_]*)/g)].map((m) => m[1]); // lower-case exports are helpers, components are Capitalised
            expect(nonComponent, `${path.basename(f)} exports helpers from a client module`).toEqual([]);
        }
    });
    it("pages gate first: mode → principal → authorisation, in that order, before any loader", () => {
        const list = code(path.join(APP, "page.tsx"));
        const order = ["currentForkMode()", "getForkPrincipal()", "soleOrganization(", 'forkCan(actor, "stacks.view")', "loadStackList("].map((s) => list.indexOf(s));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        const det = code(path.join(APP, "[stackId]/page.tsx"));
        const o2 = ["currentForkMode()", "getForkPrincipal()", "assertForkResource(", "loadStackDetail("].map((s) => det.indexOf(s));
        expect(o2.every((i) => i >= 0)).toBe(true);
        expect([...o2].sort((a, b) => a - b)).toEqual(o2);
        for (const f of pages) expect(read(f)).toContain('export const dynamic = "force-dynamic"');
    });
    it("SQL: every statement is org-scoped and the only raw SQL is the two literal JSON helpers (no request value is ever concatenated)", () => {
        const q = read(path.join(ROOT, "fork/stacks/queries.ts"));
        const raws = [...q.matchAll(/sql\.raw\((.{0,34})/g)].map((m) => m[1]);
        expect(raws.length).toBeGreaterThanOrEqual(4);
        for (const r of raws) expect(r, r).toMatch(/^(arr\("li\.inventory->'[a-z]+'"\)\)|`case when jsonb_typeof\(\$\{expr\}\) =)/);
        expect(q).not.toMatch(/sql\.raw\([^)]*(params|organizationId|stackId|\.q\b)/);
        expect((q.match(/organization_id = \$\{organizationId\}/g) ?? []).length).toBeGreaterThanOrEqual(5);
        expect(q).toContain("s.id = ${stackId} and s.organization_id = ${organizationId}");
    });
    it("the list filters are a GET form on purpose (shareable, works before hydration) and carry no secret input", () => {
        const f = code(path.join(ROOT, "fork/ui/stacks/stack-filters.tsx"));
        expect(f).toContain('method="get"');
        expect(f).not.toMatch(/type="password"|apiKey|secret/i);
    });
});
