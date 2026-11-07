import {readFileSync, readdirSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** Structural guards for the W05 surface (source-level; the behaviour is covered by the other w05 tests). */
const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? (f === "__tests__" || f === "__fixtures__" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : [];
});
const W05 = ["src/fork/arcane", "src/fork/net", "src/fork/discovery", "src/fork/actions"].flatMap((d) => walk(path.join(ROOT, d)));
const src = (f: string) => readFileSync(f, "utf8");

describe("W05 read-only / no-leak structure", () => {
    it("finds the W05 files", () => {
        expect(W05.length).toBeGreaterThanOrEqual(12);
    });
    it("no write verb anywhere in the adapter or its transport (GET only, no fetch())", () => {
        for (const f of W05) {
            const t = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
            expect(t, f).not.toMatch(/method:\s*["'`](POST|PUT|PATCH|DELETE)/i);
            expect(t, f).not.toMatch(/\bfetch\s*\(/);
            // (connection-service legitimately deletes ITS OWN DB row with drizzle; the HTTP side is client/transport/discovery)
            if (!f.endsWith("connection-service.ts")) expect(t, f).not.toMatch(/\.(post|put|patch|delete)\(/);
        }
        expect(src(path.join(ROOT, "src/fork/net/pinned-request.ts"))).toContain('method: "GET"');
    });
    it("no logging in W05 code (console/pino/logger) — secrets can not be logged if nothing logs", () => {
        for (const f of W05) expect(src(f), f).not.toMatch(/\bconsole\.|\blogger\b|\bpino\b|process\.std(out|err)/);
    });
    it("only db/dto.ts reads or writes api_key_enc; no W05 file selects the column", () => {
        for (const f of W05) expect(src(f), f).not.toMatch(/apiKeyEnc|api_key_enc/);
    });
    it("every action goes through userAction and the service (no logic in the action file); it exports only actions", () => {
        const a = src(path.join(ROOT, "src/fork/actions/arcane-connection.action.ts"));
        expect(a.startsWith('"use server";')).toBe(true);
        expect(a.match(/export const \w+Action = userAction\.inputSchema\(/g)).toHaveLength(4);
        expect(a.match(/^export /gm)).toHaveLength(4);
        for (const fn of ["saveConnection", "testConnection", "rotateKey", "disconnect"]) expect(a).toContain(`${fn}(await deps()`);
    });
    it("every service use-case authorises with arcane.manage and gates on assertForkConfigAllowed before touching the network", () => {
        const s = src(path.join(ROOT, "src/fork/arcane/connection-service.ts"));
        expect(s).toContain('"arcane.manage"');
        expect(s).toContain("assertForkConfigAllowed");
        for (const useCase of ["save", "test", "rotate", "disconnect"]) expect(s).toContain(`authorize(d, "${useCase}"`);
        // verifyConnection (network) is never called before authorize in the same function
        for (const fn of ["saveConnection", "testConnection", "rotateKey"]) {
            const body = s.slice(s.indexOf(`export async function ${fn}`));
            expect(body.indexOf("authorize(")).toBeGreaterThan(-1);
            expect(body.indexOf("authorize(")).toBeLessThan(body.indexOf("verifyConnection("));
        }
    });
    it("the transport pins the vetted address (forced lookup, agent:false) and never follows redirects", () => {
        const t = src(path.join(ROOT, "src/fork/net/pinned-request.ts"));
        expect(t).toContain("lookup");
        expect(t).toContain("agent: false");
        expect(t).toContain('"redirect"');
        expect(t).not.toMatch(/maxRedirects|followRedirect|rejectUnauthorized:\s*false/);
    });
    it("no upstream file was touched by W05 (fork paths + docs only)", () => {
        // checked structurally elsewhere by check-patches; here: the W05 modules import upstream only through allowed seams
        for (const f of W05) {
            const imports = [...src(f).matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1]).filter((i) => !i.startsWith("@/fork/"));
            for (const i of imports) // W06 read model: the agents table + the upstream agent-status util (pinned in upstream-contract.test.ts)
            expect(["@/lib/safe-actions/actions", "@/db/schema/08_agent", "@/features/agents/utils/status/agent-status", "@/utils/get-server-url"], `${f} imports ${i}`).toContain(i);
        }
    });
});
