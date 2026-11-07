import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

const ROOT = process.cwd();
const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === ".next" || e === "__tests__") continue;
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
    return out;
};
const rel = (f: string) => path.relative(ROOT, f);
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const FORK = walk(path.join(ROOT, "src/fork"));

describe("W14 static guards (key custody, D43, no kit through API/MCP)", () => {
    it("D43: ONLY the verify service writes RecoveryPoint status `verified` (or verified_at)", () => {
        // only files that touch the RecoveryPoint table are in scope (the kit has its own `verified` status, which is a different thing)
        for (const f of FORK.filter((x) => !/verify[\\/]service\.ts$/.test(x))) {
            const c = code(f);
            if (!/forkRecoveryPoint\b|fork_recovery_point\b/.test(c)) continue;
            expect(c, rel(f)).not.toMatch(/status\s*:\s*["']verified["']/);
            expect(c, rel(f)).not.toMatch(/set\s+status\s*=\s*'verified'/i);
            expect(c, rel(f)).not.toMatch(/\.set\(\{[^}]*verifiedAt\s*:\s*(?!\s*null)/);
        }
        expect(code(path.join(ROOT, "src/fork/verify/service.ts"))).toMatch(/status:\s*"verified"/);
    });

    it("key files are read in exactly three places: keys.ts (signing key), kek.ts (keyring), upstream/master-key.ts (master via upstream)", () => {
        const allowed = /src[\\/]fork[\\/](keys\.ts|kek\.ts|upstream[\\/]master-key\.ts)$/;
        for (const f of FORK.filter((x) => !allowed.test(x))) {
            const c = code(f);
            expect(c, rel(f)).not.toMatch(/master_key\.bin|server_private\.pem/);
            expect(c, rel(f)).not.toMatch(/getMasterServerKeyContent/);
        }
    });

    it("the kit is not reachable through the API-key / MCP / public API surface", () => {
        const surfaces = [path.join(ROOT, "src/lib/mcp"), path.join(ROOT, "src/features"), path.join(ROOT, "app/api")];
        for (const dir of surfaces) {
            let files: string[] = [];
            try { files = walk(dir); } catch { continue; }
            for (const f of files) {
                if (rel(f).replace(/\\/g, "/").startsWith("app/api/fork/kit/")) continue;
                expect(code(f), rel(f)).not.toMatch(/@\/fork\/kit\/|@\/fork\/kek-rotation|@\/fork\/keys/);
            }
        }
        const route = code(path.join(ROOT, "app/api/fork/kit/[kind]/route.ts"));
        expect(route).toMatch(/x-api-key/); expect(route).toMatch(/authorization/); expect(route).toMatch(/no-store/); expect(route).toMatch(/forkCsrfGuard/);
        expect(route).not.toMatch(/logger|console\./);
    });

    it("kit modules never log (no logger/console in anything that touches key material); the watch job logs fixed fields only", () => {
        for (const f of FORK.filter((x) => /src[\\/]fork[\\/]kit[\\/]/.test(x) && !/watch\.ts$/.test(x))) expect(code(f), rel(f)).not.toMatch(/@\/lib\/logger|console\./);
        const w = code(path.join(ROOT, "src/fork/kit/watch.ts"));
        for (const m of w.matchAll(/log\.(?:info|error|warn)\(([^)]*)\)/g)) expect(m[1]).not.toMatch(/master|kek|key|passphrase|password|code|fingerprint/i);
        for (const f of ["manifest/store.ts", "manifest/restic-runner.ts", "verify/archive.ts", "verify/artifact.ts", "verify/service.ts", "keys.ts"]) expect(code(path.join(ROOT, "src/fork", f)), f).not.toMatch(/console\./);
    });

    it("client components import kit code as TYPES only (no key-handling code in the browser bundle)", () => {
        for (const f of FORK.filter((x) => /\.client\.tsx$/.test(x) && /ui[\\/]kit[\\/]/.test(x))) {
            for (const m of readFileSync(f, "utf8").matchAll(/^import\s+(type\s+)?[^;]*from\s+"(@\/fork\/(?:kit|kek|keys|manifest|verify)[^"]*)"/gm)) expect(m[1], `${rel(f)} imports ${m[2]}`).toBeTruthy();
        }
    });

    it("the manifest schema is strict and carries no secret-shaped field names", () => {
        const s = code(path.join(ROOT, "src/fork/manifest/schema.ts"));
        expect(s).toMatch(/strictObject/);
        expect(s).not.toMatch(/password|secret|token|credential|private|apikey|access_?key/i);
    });

    it("paper kit: no external resources, no JSON, escapes values; digital kit stores no passphrase", () => {
        const p = code(path.join(ROOT, "src/fork/kit/paper.ts"));
        expect(p).toMatch(/esc\(/); expect(p).not.toMatch(/<script[^>]*src=|<link /);
        const svc = code(path.join(ROOT, "src/fork/kit/service.ts"));
        expect(svc).not.toMatch(/insert\(forkKit\)\.values\([^)]*passphrase/);
    });
});
