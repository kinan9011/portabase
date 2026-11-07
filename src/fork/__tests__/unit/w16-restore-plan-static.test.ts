import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

const ROOT = process.cwd();
const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === "__tests__") continue;
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
    return out;
};
const rel = (f: string) => path.relative(ROOT, f);
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const RESTORE = walk(path.join(ROOT, "src/fork/restore"));
const SCOPE = [...RESTORE, path.join(ROOT, "src/fork/actions/restore-plan.action.ts")];
const PURE = RESTORE.filter((f) => /restore[\\/](plan|schema|vocab)\.ts$/.test(f));

describe("W16 static guards (dry-run: no I/O, no secrets, pure core, honest states)", () => {
    it("the planner scope exists", () => { expect(RESTORE.map((f) => path.basename(f)).sort()).toEqual(["load.ts", "plan.ts", "schema.ts", "service.ts", "vocab.ts"]); });

    it("no network, process, restic, credential, key or task-enqueue import anywhere in the planner", () => {
        const banned = /\bfetch\(|node:http|node:https|node:net|node:child_process|child_process|pinned-request|restic|@\/fork\/upstream\/storage-read|@\/fork\/upstream\/credentials|@\/fork\/upstream\/master-key|@\/fork\/keys|@\/fork\/kek|decrypt|@\/fork\/agent-channel\/tasks|@\/lib\/logger|console\./;
        for (const f of SCOPE) expect(code(f), rel(f)).not.toMatch(banned);
    });

    it("plan.ts, schema.ts, vocab.ts are pure: no Date, Math.random, process.env, DB handle/schema/dto", () => {
        expect(PURE).toHaveLength(3);
        for (const f of PURE) {
            const c = code(f);
            expect(c, rel(f)).not.toMatch(/\bDate\b|Math\.random|process\.env|crypto\.randomUUID|randomUUID|@\/fork\/db\/(handle|schema|dto)|drizzle-orm\b.*from|@\/db\//);
        }
    });

    it("only src/fork/upstream/** touches upstream tables: the loader uses readAgent/agentAclAllows", () => {
        for (const f of SCOPE) expect(code(f), rel(f)).not.toMatch(/@\/db\/schema\/(08_agent|07_database|14_storage)/);
    });

    it("honest states: nothing in the planner says restore-tested / start-tested", () => {
        for (const f of SCOPE) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/restore[_-]?tested|restoreTested|start[_-]?tested/i);
    });

    it("the planner never writes recovery point status (D43: only the W14 verify job does)", () => {
        for (const f of SCOPE) { expect(code(f), rel(f)).not.toMatch(/status\s*:\s*["']verified["']/); expect(code(f), rel(f)).not.toMatch(/forkRecoveryPoint\)\s*\.set|update\(forkRecoveryPoint/); }
    });

    it("no API route was added for the planner (server actions only; CSRF = Next origin check)", () => {
        const routes = walk(path.join(ROOT, "app/api")).map(rel);
        expect(routes.filter((r) => /restore/i.test(r))).toEqual([]);
    });
});
