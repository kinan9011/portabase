import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {DbInputSchema, SelectionSchema} from "@/fork/materialize/types";

/** Structural guards of W10: the copy-and-own boundary, no secret persistence, no container_name, mutation pipeline order. */
const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? (f === "__tests__" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : [];
});
const src = (f: string) => readFileSync(path.resolve(ROOT, f), "utf8");
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const MATERIALIZE = walk(path.join(ROOT, "src/fork/materialize"));
const UPSTREAM = walk(path.join(ROOT, "src/fork/upstream"));
const rel = (f: string) => path.relative(ROOT, f);

describe("W10 structure", () => {
    it("finds the files", () => {
        expect(MATERIALIZE.map((f) => path.basename(f)).sort()).toEqual(["apply.ts", "context.ts", "drift.ts", "job.ts", "plan.ts", "remove.ts", "types.ts", "vocab.ts"]);
        expect(UPSTREAM.map((f) => path.basename(f)).sort()).toEqual(["agents.ts", "backups.ts", "channels.ts", "credentials.ts", "index.ts", "master-key.ts", "projects.ts", "sources.ts", "storage-read.ts", "users.ts"]);
    });

    it("D31 boundary: ONLY src/fork/upstream imports upstream tables/features; the materializer reaches upstream through the adapter", () => {
        const UPSTREAM_IMPORT = /from\s+["']@\/(db\/schema\/(06_project|07_database|08_agent|01_setting|10_alert-policy|12_storage-channel|13_storage-policy)|features\/|lib\/(safe-actions|auth|acl)|utils\/status-crypto|db["'/])/;
        for (const f of MATERIALIZE) expect(code(rel(f)), rel(f)).not.toMatch(UPSTREAM_IMPORT);
        expect(UPSTREAM.some((f) => UPSTREAM_IMPORT.test(code(rel(f))))).toBe(true); // the adapter is where they live
    });

    it("never calls session-bound userActions or reads a session (the adapter and the services are session-free); only the action wrapper uses userAction", () => {
        for (const f of [...MATERIALIZE, ...UPSTREAM]) expect(code(rel(f)), rel(f)).not.toMatch(/safe-actions|userAction|currentUser|getActiveMember|getOrganization\b|next\/headers|\bcookies\(/);
        const a = src("src/fork/actions/materialize.action.ts");
        expect(a.startsWith('"use server";')).toBe(true);
        expect(a.match(/export const \w+Action = userAction\.inputSchema\(/g)).toHaveLength(2);
        expect(a.match(/^export /gm)).toHaveLength(2);
    });

    it("`container_name` is never produced (D29): it only appears in comments, tests and the SEC-24 re-check that REJECTS it", () => {
        for (const f of [...MATERIALIZE, ...UPSTREAM]) {
            const t = code(rel(f));
            const hits = [...t.matchAll(/container_name/g)].length;
            if (path.basename(f) === "drift.ts") expect(hits).toBe(1); // `"container_name" in cfg` ⇒ unsafe_volume
            else expect(hits, rel(f)).toBe(0);
        }
    });

    it("no secret can be persisted by the fork: the stored selection has no password-like key; secrets only flow into the upstream-encrypted config", () => {
        const keys = (s: unknown): string[] => {
            const shape = (s as {def: {shape?: Record<string, unknown>; options?: unknown[]; innerType?: unknown}}).def;
            if (shape.options) return shape.options.flatMap(keys);
            return Object.entries(shape.shape ?? {}).flatMap(([k, v]) => [k, ...keys((v as {def: {innerType?: unknown; element?: unknown}}).def.innerType ?? (v as {def: {element?: unknown}}).def.element ?? v)]);
        };
        const all = [...keys(DbInputSchema), ...Object.keys(SelectionSchema.shape)];
        expect(all.join(",")).not.toMatch(/pass|secret|token|credential/i);
        const apply = code("src/fork/materialize/apply.ts");
        // the secrets input is used for exactly one thing: building the `secretsFor` map handed to the upstream adapter
        expect([...apply.matchAll(/input\.secrets/g)].length).toBeLessThanOrEqual(5);
        expect(apply).not.toMatch(/selection:\s*\{[^}]*secrets|secrets:\s*input\.secrets[^)]*audit/);
        // logging exists only in the job wrapper (counts and error class names, never data); services return and audit instead
        for (const f of MATERIALIZE.filter((x) => !x.endsWith("job.ts"))) expect(code(rel(f)), rel(f)).not.toMatch(/\bconsole\.|\blogger\b/);
    });

    it("no process execution, network or docker access anywhere in the materializer or the adapter (the agent is unchanged in R1)", () => {
        for (const f of [...MATERIALIZE, ...UPSTREAM]) expect(code(rel(f)), rel(f)).not.toMatch(/child_process|(?<![.\w])(exec|spawn)(File|Sync)?\s*\(|docker\.sock|\bfetch\s*\(|node:net|node:http/);
    });

    it("every mutation runs the same pipeline in the same order: resource-scoped capability → D21 gate → rate limit → work", () => {
        const a = code("src/fork/materialize/apply.ts");
        const body = a.slice(a.indexOf("export async function authorizeMutation"), a.indexOf("export async function materializeStack"));
        const idx = (n: string) => body.indexOf(n);
        expect(idx('"stacks.backup.manage"')).toBeGreaterThan(-1);
        expect(idx('"stacks.backup.manage"')).toBeLessThan(idx("assertForkConfigAllowed"));
        expect(idx("assertForkConfigAllowed")).toBeLessThan(idx("checkRate"));
        const m = a.slice(a.indexOf("export async function materializeStack"));
        expect(m.indexOf("authorizeMutation(")).toBeLessThan(m.indexOf("agentAclAllows("));
        expect(m.indexOf("agentAclAllows(")).toBeLessThan(m.indexOf("withForkLock("));
        const r = code("src/fork/materialize/remove.ts");
        expect(r.indexOf("authorizeMutation(")).toBeLessThan(r.indexOf("withForkLock("));
        expect(r).toContain("z.literal(true)"); // confirm is mandatory
        expect(r).toMatch(/has_backups/);
    });

    it("fork_stack_source is written only by apply, remove and the drift job; the browser view never carries config, keys or database ids", () => {
        for (const f of walk(path.join(ROOT, "src/fork"))) {
            if (/materialize\/(apply|remove|drift)\.ts$/.test(f)) continue;
            expect(code(rel(f)), rel(f)).not.toMatch(/\.(insert|update|delete)\(\s*forkStackSource\b/);
        }
        const view = code("src/fork/completeness/view.ts");
        const block = view.slice(view.indexOf("export const SourceViewSchema"), view.indexOf("const ENV_NAMES_PER_SERVICE"));
        expect(block).not.toMatch(/config|databaseId|database_id|resourceKey|key:|hash|password/i);
    });

    it("the drift job is registered on the RUNTIME plane (keeps running when configuration is locked) and from fork init, not from an upstream file", () => {
        const j = code("src/fork/materialize/job.ts");
        expect(j).toMatch(/plane:\s*"runtime"/);
        expect(code("src/fork/init.ts")).toContain("registerMaterializeDriftJob()");
        expect(readFileSync(path.join(ROOT, "scripts/fork/patch-registry.txt"), "utf8")).not.toMatch(/materializ|W10/i);
        expect(src("src/utils/init/cron.ts")).not.toMatch(/fork|materializ/i);
    });

    it("audit codes are namespaced fork.materialize.*", () => {
        const codes = new Set<string>();
        for (const f of MATERIALIZE) for (const m of code(rel(f)).matchAll(/["'](fork\.materialize\.[a-z_.]+)["']/g)) codes.add(m[1]);
        expect([...codes].sort()).toEqual([
            "fork.materialize.apply", "fork.materialize.canary.confirmed", "fork.materialize.canary.rolled_back", "fork.materialize.drift.channels", "fork.materialize.drift.cleared",
            "fork.materialize.drift.inventory", "fork.materialize.drift.orphaned", "fork.materialize.drift.reverted", "fork.materialize.drift.seen", "fork.materialize.drift.source",
            "fork.materialize.promoted", "fork.materialize.remove",
        ]);
    });
});
