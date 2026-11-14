import {execFileSync} from "node:child_process";
import {readFileSync, readdirSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {anyForkFlagOn} from "@/fork/env";
import {PUBLIC_TASK_TYPES} from "@/fork/agent-channel/vocab";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
/** code without comments and string-free enough for greps */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const walk = (d: string): string[] => readdirSync(path.join(ROOT, d)).flatMap((n) => { const p = `${d}/${n}`; return statSync(path.join(ROOT, p)).isDirectory() ? walk(p) : [p]; });
const quiesceFiles = walk("src/fork/quiesce");

describe("W17b static guards", () => {
    it("only quiesce/enqueue.ts signs a quiesce-type task; the generic enqueue refuses the types", () => {
        const hits = execFileSync("grep", ["-rln", "insertSignedTask", "src/fork", "app", "--include=*.ts", "--include=*.tsx"], {cwd: ROOT, encoding: "utf8"}).split("\n").filter(Boolean).filter((f) => !f.includes("__tests__"));
        expect(hits.sort()).toEqual(["src/fork/agent-channel/maint.ts", "src/fork/agent-channel/tasks.ts", "src/fork/quiesce/enqueue.ts", "src/fork/restore-tasks/enqueue.ts", "src/fork/runner/service.ts"].sort());
        expect([...PUBLIC_TASK_TYPES]).toEqual(["noop"]);
        expect(code("src/fork/agent-channel/tasks.ts")).toMatch(/type: z\.enum\(PUBLIC_TASK_TYPES\)/);
    });
    it("pure modules (plan, decide, payload, alert, vocab) import no db / drizzle / react / node / process / fetch", () => {
        for (const f of ["plan", "decide", "payload", "alert", "vocab"]) {
            const c = code(`src/fork/quiesce/${f}.ts`);
            expect(c, f).not.toMatch(/@\/fork\/db|drizzle|from "react"|from "node:|process\.|fetch\(|Date\.now|new Date\(\)/);
        }
    });
    it("no quiesce module writes a `verified` status, mentions `container_name`, or builds a free-form command", () => {
        for (const f of quiesceFiles) {
            const c = code(f);
            expect(c, f).not.toMatch(/status:\s*["']verified["']|set\(\{[^}]*["']verified["']/);
            expect(c, f).not.toMatch(/container_name|containerName|execSync|spawn\(|child_process/);
        }
    });
    it("notification payload keys written by quiesce code are the allowlist (state, reason, since, stackId, link)", () => {
        const allowed = new Set(["state", "reason", "since", "stackId", "link"]);
        const src = [code("src/fork/quiesce/reconcile.ts"), code("src/fork/quiesce/steps.ts"), code("src/fork/runs/start.ts"), code("src/fork/notifications/evaluate.ts")].join("\n");
        for (const m of src.matchAll(/payload:\s*\{([^}]*)\}/g)) {
            for (const k of m[1].matchAll(/(?:^|,)\s*(?:\.\.\.\([^)]*\)\s*,?|\.\.\.\w+[^,]*,?)?\s*(\w+)\s*(?::|,|$)/g)) if (k[1]) expect(allowed.has(k[1]) || ["hours"].includes(k[1]), `payload key ${k[1]}`).toBe(true);
        }
    });
    it("UI copy comes from labels.ts (no sentence literals in the quiesce components), the route is a runtime route, flags-off parity holds", () => {
        for (const f of ["quiesce-panel.client.tsx", "quiesce-status-row.tsx"]) {
            const c = code(`src/fork/ui/stacks/quiesce/${f}`);
            expect(c, f).not.toMatch(/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</);
        }
        expect(read("src/fork/routes.ts")).toMatch(/render\|quiesce/);
        expect(anyForkFlagOn({FORK_QUIESCE_ENABLED: "true"})).toBe(false); // the quiesce switch is config-plane, NOT a fork feature flag
        expect(code("src/fork/env.ts")).toMatch(/FORK_QUIESCE_ENABLED: flag/);
        expect(code("src/fork/env.ts").match(/return e\.FORK_STACKS_ENABLED[^;]*;/)?.[0]).not.toMatch(/QUIESCE/);
    });
    it("the agent route is bearer-only: withAgent, no cookies, no session", () => {
        const c = code("app/api/fork/agent/[agentId]/tasks/[taskId]/quiesce/route.ts");
        expect(c).toMatch(/withAgent\(/);
        expect(c).not.toMatch(/cookies|session|forkCsrfGuard/);
    });
});
