import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** Structural guarantees of the W12 code, checked on source text (runs in the unit tier, no DB). */
const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const RUNS = walk(path.join(ROOT, "src/fork/runs"));
const RP = walk(path.join(ROOT, "src/fork/recovery-point"));
const code = (f: string) => strip(readFileSync(f, "utf8"));
const rel = (f: string) => path.relative(ROOT, f);

describe("runs: structure", () => {
    it("finds the files", () => {
        expect(RUNS.map((f) => path.basename(f)).sort()).toEqual(["config.ts", "deps.ts", "engine.ts", "job.ts", "reauth.ts", "run-service.ts", "schedule-due.ts", "scheduler.ts", "service.ts", "start.ts", "steps.ts", "view.ts", "vocab.ts"]);
        expect(RP.map((f) => path.basename(f)).sort()).toEqual(["build.ts", "decide.ts", "finalize.ts", "hash.ts", "prune.ts", "retention.ts"]);
    });

    it("D43: NO code path of the run engine or the finaliser writes `verified` (only the W14 verify job may)", () => {
        for (const f of [...RUNS, ...RP.filter((x) => !/retention\.ts$|prune\.ts$/.test(x))]) {
            const c = code(f);
            expect(c, rel(f)).not.toMatch(/["'`]verified["'`]/);
            expect(c, rel(f)).not.toMatch(/verifiedAt\s*:\s*(?!null)/);
            expect(c, rel(f)).not.toMatch(/verified_at\s*=\s*(?!null)/);
        }
        // retention / prune only READ the status and set verifiedAt to null on a downgrade
        for (const f of RP.filter((x) => /retention\.ts$|prune\.ts$/.test(x))) expect(code(f), rel(f)).not.toMatch(/status\s*:\s*["']verified["']/);
    });

    it("ARCH-13: the step engine knows no mirror steps (R3 is optional and designs its own)", () => {
        for (const f of [...RUNS, ...RP]) expect(code(f), rel(f)).not.toMatch(/mirror/i);
    });

    it("D31 boundary: run/RP code reaches upstream ONLY through src/fork/upstream (no upstream table or feature import)", () => {
        const UPSTREAM_IMPORT = /from\s+["']@\/(db\/schema\/|features\/|lib\/(safe-actions|auth|acl|tasks|restic)|utils\/status-crypto|db["'/])/;
        for (const f of [...RUNS, ...RP]) expect(code(f), rel(f)).not.toMatch(UPSTREAM_IMPORT);
    });

    it("no process execution or docker access anywhere in runs/RP; network (fetch) only in the hash module", () => {
        for (const f of [...RUNS, ...RP]) {
            const c = code(f);
            expect(c, rel(f)).not.toMatch(/child_process|(?<![.\w])(exec|spawn|execFile)\(|docker\.sock/);
            if (!/hash\.ts$/.test(f)) expect(c, rel(f)).not.toMatch(/(?<![.\w])fetch\(|node:https?|XMLHttpRequest/);
        }
    });

    it("no console output (logs go through the redacting logger, codes only) and no direct env reads outside config", () => {
        for (const f of [...RUNS, ...RP]) {
            const c = code(f);
            expect(c, rel(f)).not.toMatch(/console\.(log|error|warn|info|debug)/);
            if (!/config\.ts$/.test(f)) expect(c, rel(f)).not.toMatch(/process\.env/);
        }
    });

    it("every mutating entry point audits, and checks a capability before touching a resource", () => {
        const svc = code(path.join(ROOT, "src/fork/runs/run-service.ts"));
        expect(svc).toMatch(/assertForkResource\([^)]*"backup\.run"/g);
        expect(svc.match(/assertForkResource\(/g)?.length).toBe(2);
        expect(svc).toMatch(/recordAudit/);
        expect(code(path.join(ROOT, "src/fork/runs/service.ts"))).toMatch(/fork\.stack_run\.cancel/);
        expect(code(path.join(ROOT, "src/fork/runs/start.ts"))).toMatch(/fork\.stack_run\.start/);
        expect(code(path.join(ROOT, "src/fork/recovery-point/prune.ts"))).toMatch(/fork\.recovery_point\.purge/);
    });

    it("the action module is a thin wrapper: no logic, no logging, input forwarded as unknown", () => {
        const a = code(path.join(ROOT, "src/fork/actions/stack-run.action.ts"));
        expect(a).toMatch(/inputSchema\(z\.unknown\(\)\)/g);
        expect(a).not.toMatch(/console|logger/);
    });

    it("the registered job is in the runtime plane (it must keep running while configuration is locked, ADR-010)", () => {
        const j = code(path.join(ROOT, "src/fork/runs/job.ts"));
        expect(j).toMatch(/plane:\s*"runtime"/);
        expect(j).not.toMatch(/plane:\s*"config"/);
    });
});
