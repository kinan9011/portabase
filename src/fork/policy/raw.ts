import path from "node:path";
import {COMPOSE_YAML_LIMITS, parseYamlLimited} from "@/fork/inventory/compose-yaml";
import {RULES, isCanonPath, isUnderRoots} from "@/fork/policy/rules";

/**
 * PRE-RENDER check of the RAW compose / override YAML (W20a D-3). Pure: callers supply the texts (the dashboard never reads the filesystem
 * or runs compose, D46). Every file the compose files can pull in (`env_file`, `include`, `extends.file`, `label_file`, `secrets.*.file`,
 * `configs.*.file`) must stay inside the restore root; included / extended files inside the root are scanned recursively. `$` and a leading
 * `~` cannot be proven inside the root ⇒ outside (fail closed). Same semantics as `kit-tool compose-scan` (parity-tested on the shared corpus).
 * Output carries kinds, service names and target PATHS only, never a value of `environment`, `labels`, `command`, ….
 */
export const RESTORE_YAML_LIMITS = {...COMPOSE_YAML_LIMITS, maxAliasCount: 100} as const; // D-10: W07 limits except yaml's default alias count

export type RawKind = "include" | "include_env_file" | "include_project_directory" | "env_file" | "extends" | "label_file" | "secret_file" | "config_file" | "missing";
export type RawViolation = {kind: RawKind; service: string | null; target: string};
export type RawResult = {refused: boolean; violations: RawViolation[]; reason: "yaml_invalid" | "limits" | null};
export type RawInput = {root: string; entry: string[]; files: {path: string; text: string}[]};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const TARGET_MAX = 256;
const show = (t: unknown): string => (typeof t === "string" ? t : JSON.stringify(t) ?? "?").slice(0, TARGET_MAX);

/** a target (relative to the declaring file's directory) that does not provably stay inside `root`. */
function outside(root: string, base: string, t: unknown): boolean {
    if (typeof t !== "string" || t === "" || t.includes("\0") || t.includes("$") || t.startsWith("~")) return true;
    const full = path.posix.resolve(base, t);
    return !(full === root || full.startsWith(`${root}/`));
}

/** env_file-style list: string | list of (string | {path: string|string[]}) */
function fileTargets(v: unknown): unknown[] {
    const out: unknown[] = [];
    for (const it of asList(v)) {
        if (isObj(it)) out.push(...asList(it.path));
        else out.push(it);
    }
    return out;
}

const REASON = {too_large: "limits", too_deep: "limits", too_many_nodes: "limits", alias_limit: "limits", syntax: "yaml_invalid", unsupported: "yaml_invalid", duplicate_key: "yaml_invalid", not_a_mapping: "yaml_invalid"} as const;

export function checkRawCompose(input: RawInput): RawResult {
    const {root, entry, files} = input;
    if (!isCanonPath(root) || root === "/" || entry.length === 0 || !entry.every((e) => isCanonPath(e) && isUnderRoots(e, [root]))) throw new TypeError("checkRawCompose: root and entry must be canonical absolute paths, entry inside root");
    const texts = new Map(files.map((f) => [f.path, f.text]));
    const seen = new Set<string>();
    const found = new Map<string, RawViolation>();
    const add = (kind: RawKind, service: string | null, target: unknown) => {
        const v = {kind, service, target: show(target)};
        found.set(`${kind}\0${service ?? ""}\0${v.target}`, v);
    };
    const done = (reason: RawResult["reason"]): RawResult => {
        const violations = [...found.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.service ?? "") < (b.service ?? "") ? -1 : (a.service ?? "") > (b.service ?? "") ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
        return {refused: reason !== null || violations.length > 0, violations, reason};
    };
    const queue: {file: string; depth: number}[] = entry.map((file) => ({file, depth: 0}));
    const limits = {...RESTORE_YAML_LIMITS, maxBytes: Math.min(RESTORE_YAML_LIMITS.maxBytes, RULES.raw_read_scope.max_bytes)};

    /** include / extends target: refused when outside, queued when inside (depth- and count-bounded). Returns false when a limit is hit. */
    const follow = (base: string, depth: number, t: unknown, kind: RawKind, service: string | null): boolean => {
        if (outside(root, base, t)) { add(kind, service, t); return true; }
        if (depth + 1 > RULES.raw_read_scope.max_depth) return false;
        queue.push({file: path.posix.resolve(base, t as string), depth: depth + 1});
        return true;
    };

    for (let q = 0; q < queue.length; q++) {
        const {file, depth} = queue[q] as {file: string; depth: number};
        if (seen.has(file)) continue;
        if (seen.size >= RULES.raw_read_scope.max_files) return done("limits");
        seen.add(file);
        const text = texts.get(file);
        if (text === undefined) { add("missing", null, file); continue; }
        const parsed = parseYamlLimited(text, limits);
        if (!parsed.ok) return done(REASON[parsed.reason]);
        if (!isObj(parsed.value)) return done("yaml_invalid");
        const doc = parsed.value;
        const base = path.posix.dirname(file);

        for (const it of asList(doc.include)) {
            if (isObj(it)) {
                for (const t of asList(it.path)) if (!follow(base, depth, t, "include", null)) return done("limits");
                for (const t of asList(it.env_file)) if (outside(root, base, t)) add("include_env_file", null, t);
                if (it.project_directory !== undefined && it.project_directory !== null) add("include_project_directory", null, it.project_directory); // not modelled: fail closed
            } else if (!follow(base, depth, it, "include", null)) return done("limits");
        }
        for (const [section, kind] of [["secrets", "secret_file"], ["configs", "config_file"]] as const) {
            const defs = doc[section];
            if (!isObj(defs)) continue;
            for (const [name, spec] of Object.entries(defs)) if (isObj(spec) && "file" in spec && outside(root, base, spec.file)) add(kind, name, spec.file);
        }
        if (isObj(doc.services)) {
            for (const [svc, spec] of Object.entries(doc.services)) {
                if (!isObj(spec)) continue;
                for (const t of fileTargets(spec.env_file)) if (outside(root, base, t)) add("env_file", svc, t);
                for (const t of asList(spec.label_file)) if (outside(root, base, t)) add("label_file", svc, t);
                const ext = spec.extends;
                if (isObj(ext) && ext.file !== undefined && ext.file !== null && !follow(base, depth, ext.file, "extends", svc)) return done("limits");
                // same-file extends (service only, no file): nothing outside is read
            }
        }
    }
    return done(null);
}
