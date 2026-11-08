/**
 * W27a SEC-09: the fork attack surface, enumerated FROM THE CODE (node fs + regex, no app imports) so the unit tier needs no Next runtime and no DB.
 * The permission matrix (`matrix.ts`) must have exactly one row per item; the completeness test fails on a missing or stale row.
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative, sep} from "node:path";

export type SurfaceAction = {file: string; exportName: string};
export type SurfaceRoute = {file: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string};
export type SurfacePage = {file: string};

export const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const posix = (p: string) => p.split(sep).join("/");

function walk(dir: string, keep: (rel: string) => boolean, root: string, out: string[] = []): string[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return out; }
    for (const n of names) {
        if (n === "node_modules" || n === ".next" || n === "__tests__" || n.startsWith(".")) continue;
        const full = join(dir, n);
        if (statSync(full).isDirectory()) walk(full, keep, root, out);
        else if (keep(posix(relative(root, full)))) out.push(posix(relative(root, full)));
    }
    return out.sort();
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const startsUseServer = (src: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(src);

export function listForkActions(root = REPO_ROOT): SurfaceAction[] {
    const out: SurfaceAction[] = [];
    for (const file of walk(join(root, "src/fork/actions"), (r) => r.endsWith(".action.ts"), root)) {
        const src = read(root, file);
        if (!startsUseServer(src)) throw new Error(`${file}: a fork action file must start with "use server"`);
        for (const m of src.matchAll(/export const (\w+Action)\s*=\s*userAction\b/g)) out.push({file, exportName: m[1]!});
    }
    return out;
}

/** Every `export` in an action file that is NOT built from `userAction` (a "use server" export that skips the session gate). */
export function listUnguardedExports(root = REPO_ROOT): string[] {
    const bad: string[] = [];
    for (const file of walk(join(root, "src/fork/actions"), (r) => r.endsWith(".action.ts"), root)) {
        const src = read(root, file);
        for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class|default)\b\s*(\w*)(\s*=\s*userAction\b)?/gm)) if (!m[2]) bad.push(`${file}#${m[1] || "default"}`);
    }
    return bad;
}

export function listForkRoutes(root = REPO_ROOT): SurfaceRoute[] {
    const out: SurfaceRoute[] = [];
    for (const file of walk(join(root, "app/api/fork"), (r) => r.endsWith("/route.ts"), root)) {
        const path = "/" + file.replace(/^app\//, "").replace(/\/route\.ts$/, "");
        for (const m of read(root, file).matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)) out.push({file, method: m[1] as SurfaceRoute["method"], path});
    }
    return out;
}

export function listForkPages(root = REPO_ROOT): SurfacePage[] {
    return walk(join(root, "app"), (r) => r.endsWith("/page.tsx"), root)
        .filter((file) => /from "@\/fork\//.test(read(root, file)))
        .map((file) => ({file}));
}

/** "use server" modules that import fork code but live outside `src/fork/actions/` (they would escape the matrix). */
export function listStrayServerFiles(root = REPO_ROOT): string[] {
    const files = [...walk(join(root, "src"), (r) => /\.(ts|tsx)$/.test(r), root), ...walk(join(root, "app"), (r) => /\.(ts|tsx)$/.test(r), root)];
    return files.filter((f) => !f.startsWith("src/fork/actions/") && !f.startsWith("src/fork/__tests__/")).filter((f) => {
        const src = read(root, f);
        return startsUseServer(src) && /from "@\/fork(\/|")/.test(src);
    });
}

/** Pure comparison used by the completeness test (and its mutant): returns human-readable problems, [] when surface ≡ table. */
export function diffKeys(kind: string, surfaceKeys: readonly string[], tableKeys: readonly string[]): string[] {
    const s = new Set(surfaceKeys), t = new Set(tableKeys);
    return [
        ...surfaceKeys.filter((k) => !t.has(k)).map((k) => `${kind} ${k} has NO matrix row (add one to src/fork/__tests__/security/matrix.ts)`),
        ...tableKeys.filter((k) => !s.has(k)).map((k) => `${kind} row ${k} is STALE (no such ${kind} in the code)`),
    ];
}

export const actionKey = (a: SurfaceAction) => `${a.file.replace(/^src\/fork\/actions\//, "")}#${a.exportName}`;
export const routeKey = (r: SurfaceRoute) => `${r.method} ${r.path}`;
