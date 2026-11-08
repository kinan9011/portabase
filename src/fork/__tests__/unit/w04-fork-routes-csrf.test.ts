import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/**
 * SEC-16 structural guard: every `/api/fork/**` route handler that can change state (POST/PUT/PATCH/DELETE) must call
 * `forkCsrfGuard(` before doing anything else. A future wave that adds a mutating route without it fails here, not in review.
 */
const root = path.join(process.cwd(), "app/api/fork");
const routes = (dir: string): string[] =>
    readdirSync(dir, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? routes(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));

describe("SEC-16 every state-changing /api/fork route calls forkCsrfGuard first", () => {
    const all = routes(root);
    // W15: the agent channel routes are called by agents (no browser, no cookies): they authenticate with a bearer credential through `withAgent` — never a session —
    // so a cross-site request cannot carry any authority. They are pinned by their own test below instead of the CSRF guard.
    const files = all.filter((f) => !f.includes(`${path.sep}agent${path.sep}`));
    it("agent channel routes are cookie-less bearer routes: each authenticates through withAgent and never reads a session", () => {
        const agent = all.filter((f) => f.includes(`${path.sep}agent${path.sep}`));
        expect(agent.length).toBe(6); // W17b adds the quiesce progress route
        for (const f of agent) { const src = readFileSync(f, "utf8"); expect(src, f).toContain("withAgent("); expect(src, f).not.toMatch(/currentUser|getForkPrincipal|cookies\(/); }
    });
    it("there is at least the status route (the scan is not vacuous)", () => expect(files.length).toBeGreaterThan(0));
    it.each(files.map((f) => [path.relative(process.cwd(), f), readFileSync(f, "utf8")]))("%s", (_f, src) => {
        for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/g)) {
            const body = m[3].trimStart();
            expect(m[2], `${m[1]} must take the Request`).toMatch(/\w+\s*:\s*(Next)?Request|\breq\b|\brequest\b/);
            expect(body, `${m[1]} must start with the CSRF guard`).toMatch(/^const\s+\w+\s*=\s*forkCsrfGuard\(\s*\w+\s*\);\s*\n\s*if\s*\(\s*\w+\s*\)\s*return\s+\w+;/);
        }
    });
    it("the scanner itself detects an unguarded handler", () => {
        const bad = `export async function POST(req: Request) {\n  return NextResponse.json({});\n}`;
        const m = bad.match(/export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/)!;
        expect(m[3].trimStart()).not.toMatch(/^const\s+\w+\s*=\s*forkCsrfGuard/);
    });
});
