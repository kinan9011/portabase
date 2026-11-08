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
const CONFIG = walk(path.join(ROOT, "src/fork/config"));
const UI = walk(path.join(ROOT, "src/fork/ui/stacks/config"));
const ACTION = path.join(ROOT, "src/fork/actions/stack-config.action.ts");
const SCOPE = [...CONFIG, ...UI, ACTION];
const PURE = CONFIG.filter((f) => /config[\\/](override|vocab|view)\.ts$/.test(f));

describe("W16b static guards (no network, no Arcane, pure core, one decryptor, no secrets in the UI)", () => {
    it("the scope exists", () => {
        expect(CONFIG.map((f) => path.basename(f)).sort()).toEqual(["override.ts", "purge-task.ts", "resolve.ts", "service.ts", "view.ts", "vocab.ts"]);
        expect(UI.map((f) => path.basename(f)).sort()).toEqual(["labels.ts", "restore-overrides-panel.client.tsx"]);
    });

    it("no network, process, Arcane, pinned-request, key-provider or task-enqueue import anywhere in the scope", () => {
        const bannedModule = /node:https?|node:net|child_process|pinned-request|@\/fork\/arcane|upstream\/(storage-read|credentials|master-key)|@\/fork\/keys|agent-channel\/tasks|restore-tasks\/enqueue|^undici$|^axios$/;
        const bannedCall = /\bfetch\(|\bexec(Sync|File)?\(|\bspawn(Sync)?\(|console\./;
        for (const f of SCOPE) {
            const c = code(f);
            for (const m of c.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)) expect(m[1], `${rel(f)} imports ${m[1]}`).not.toMatch(bannedModule);
            expect(c, rel(f)).not.toMatch(bannedCall);
        }
    });

    it("override.ts, vocab.ts and view.ts are pure: no Date, Math.random, process.env, crypto, DB, KEK", () => {
        expect(PURE).toHaveLength(3);
        for (const f of PURE) expect(code(f), rel(f)).not.toMatch(/\bDate\b|Math\.random|process\.env|node:crypto|randomUUID|@\/fork\/db\/|@\/fork\/kek|drizzle-orm|@\/db\//);
    });

    it("only config/service.ts (plus the table definition and the KEK rotation registry) names the encrypted column; only service.ts decrypts", () => {
        const all = walk(path.join(ROOT, "src/fork"));
        const touching = all.filter((f) => /valuesEnc|values_enc/.test(code(f))).map(rel).sort();
        expect(touching).toEqual(["src/fork/config/service.ts", "src/fork/db/schema/restore-override.ts", "src/fork/kek-rotation.ts"]); // resolve.ts goes through `decryptStored`
        for (const f of all.filter((x) => /fork[\\/]config[\\/]/.test(x) && !/config[\\/]service\.ts$/.test(x))) expect(code(f), rel(f)).not.toMatch(/decryptForkSecret/);
    });

    it("the UI never imports the decrypting modules or the KEK", () => {
        for (const f of UI) expect(code(f), rel(f)).not.toMatch(/@\/fork\/config\/(resolve|service)|@\/fork\/kek/);
    });

    it("the enqueue hook reads overrides only through the resolve helper", () => {
        const c = code(path.join(ROOT, "src/fork/restore-tasks/enqueue.ts"));
        expect(c).toMatch(/resolveOverridesForEnqueue/);
        expect(c).not.toMatch(/valuesEnc|values_enc|decryptForkSecret|decryptStored/);
    });

    it("honest states: the labels never claim a restore or an override was tested/verified", () => {
        for (const f of UI) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/\b(tested|verified)\b|restore[_-]?tested/i);
    });

    it("no API route was added for overrides (server actions only; CSRF = Next origin check)", () => {
        let routes: string[] = [];
        try { routes = walk(path.join(ROOT, "app/api/fork")).map(rel); } catch { /* no fork routes dir */ }
        expect(routes.filter((r) => /override|restore-config|stack-config/i.test(r))).toEqual([]);
    });

    it("no value, hash of a value or YAML hash reaches an audit call", () => {
        const c = code(path.join(ROOT, "src/fork/config/service.ts"));
        expect(c).not.toMatch(/createHash|sha256|canonicalJson/);
    });
});
