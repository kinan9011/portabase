import {parseDocument, visit} from "yaml";
import {ENV_KEY, safePathHint, SERVICE_NAME} from "@/fork/inventory/labels";

/**
 * Compose YAML → NAMES AND PATHS ONLY (W07, SEC-17). Used only on the tier-2 (opt-in `projects:read`) path, where Arcane
 * returns the raw compose text. The text is untrusted and can embed secrets as literals, so:
 *  1. hard limits BEFORE and DURING parsing: bytes, bracket/indent depth, AST node count (aliases are not expanded by the
 *     count), alias count (`maxAliasCount`, which also bounds the expansion — billion-laughs), no custom tags (core schema:
 *     any unresolved tag is a warning ⇒ rejected), duplicate keys rejected, a single document only;
 *  2. extraction is an allow-list: service names, image ref, `build` present, environment KEY names, `env_file` paths,
 *     `profiles`, `depends_on` names, `external` volume/network names. No value of `environment`, `command`, `entrypoint`,
 *     `labels`, `healthcheck`, `secrets` or `configs` is read, so there is no code path that could return one.
 * A rejected file is not an error for the sync: the stack just keeps `compose_read = "none"` plus a warning.
 */
export const COMPOSE_YAML_LIMITS = {maxBytes: 256 * 1024, maxNodes: 20_000, maxDepth: 24, maxAliasCount: 10, maxIndent: 200} as const;

export type ComposeService = {name: string; image?: string; hasBuild: boolean; envNames: string[]; envFiles: string[]; profiles: string[]; dependsOn: string[]};
export type ParsedCompose = {services: ComposeService[]; externalNetworks: string[]; externalVolumes: string[]};
export type ComposeRejection = "too_large" | "too_deep" | "too_many_nodes" | "alias_limit" | "syntax" | "unsupported" | "duplicate_key" | "not_a_mapping";
export type ComposeResult = {ok: true; compose: ParsedCompose} | {ok: false; reason: ComposeRejection};

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function nestingTooDeep(text: string): boolean {
    let depth = 0;
    for (let i = 0, lineStart = true, indent = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\n") { lineStart = true; indent = 0; continue; }
        if (lineStart && ch === " ") { if (++indent > COMPOSE_YAML_LIMITS.maxIndent) return true; continue; }
        lineStart = false;
        if (ch === "[" || ch === "{") { if (++depth > COMPOSE_YAML_LIMITS.maxDepth) return true; }
        else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    }
    return false;
}

function jsDepth(v: unknown, d = 0): boolean {
    if (d > COMPOSE_YAML_LIMITS.maxDepth) return true;
    if (Array.isArray(v)) return v.some((x) => jsDepth(x, d + 1));
    if (isObj(v)) return Object.values(v).some((x) => jsDepth(x, d + 1));
    return false;
}

function parseOne(text: string): {ok: true; value: unknown} | {ok: false; reason: ComposeRejection} {
    if (Buffer.byteLength(text, "utf8") > COMPOSE_YAML_LIMITS.maxBytes) return {ok: false, reason: "too_large"};
    if (nestingTooDeep(text)) return {ok: false, reason: "too_deep"};
    try {
        const doc = parseDocument(text, {uniqueKeys: true, merge: true, version: "1.2", schema: "core", prettyErrors: false});
        if (doc.errors.length) return {ok: false, reason: doc.errors.some((e) => e.code === "DUPLICATE_KEY") ? "duplicate_key" : "syntax"};
        if (doc.warnings.length) return {ok: false, reason: "unsupported"}; // unresolved/custom tag
        let nodes = 0;
        visit(doc, () => (++nodes > COMPOSE_YAML_LIMITS.maxNodes ? visit.BREAK : undefined));
        if (nodes > COMPOSE_YAML_LIMITS.maxNodes) return {ok: false, reason: "too_many_nodes"};
        const value = doc.toJS({maxAliasCount: COMPOSE_YAML_LIMITS.maxAliasCount});
        if (jsDepth(value)) return {ok: false, reason: "too_deep"};
        return {ok: true, value};
    } catch (e) {
        if (e instanceof RangeError) return {ok: false, reason: "too_deep"};
        if (e instanceof ReferenceError || /alias/i.test(e instanceof Error ? e.message : "")) return {ok: false, reason: "alias_limit"};
        return {ok: false, reason: "syntax"};
    }
}

const names = (v: unknown, re: RegExp, max: number): string[] => {
    const raw = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : isObj(v) ? Object.keys(v) : [];
    return [...new Set(raw.filter((x) => re.test(x)))].sort().slice(0, max);
};

function envNames(v: unknown): string[] {
    // map form: KEYS; list form: "KEY=value" / "KEY" — only the part before `=` is ever looked at
    const raw = isObj(v) ? Object.keys(v) : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.split("=", 1)[0] ?? "") : [];
    return [...new Set(raw.filter((k) => ENV_KEY.test(k)))].sort().slice(0, 500);
}

function envFiles(v: unknown): string[] {
    const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
    const out = list.map((x) => (typeof x === "string" ? x : isObj(x) && typeof x.path === "string" ? x.path : null)).map(safePathHint).filter((x): x is string => !!x);
    return [...new Set(out)].sort().slice(0, 64);
}

function extract(root: unknown, into: Map<string, ComposeService>, extNets: Set<string>, extVols: Set<string>) {
    if (!isObj(root)) return false;
    const services = isObj(root.services) ? root.services : {};
    for (const [name, def] of Object.entries(services)) {
        if (!SERVICE_NAME.test(name) || !isObj(def) || into.size >= 500 && !into.has(name)) continue;
        const cur = into.get(name) ?? {name, hasBuild: false, envNames: [], envFiles: [], profiles: [], dependsOn: []};
        if (typeof def.image === "string" && def.image.length <= 512) cur.image = def.image;
        if (def.build !== undefined && def.build !== null && def.build !== false) cur.hasBuild = true;
        cur.envNames = [...new Set([...cur.envNames, ...envNames(def.environment)])].sort();
        cur.envFiles = [...new Set([...cur.envFiles, ...envFiles(def.env_file)])].sort();
        cur.profiles = [...new Set([...cur.profiles, ...names(def.profiles, PROFILE, 32)])].sort();
        cur.dependsOn = [...new Set([...cur.dependsOn, ...names(def.depends_on, SERVICE_NAME, 100)])].sort();
        into.set(name, cur);
    }
    for (const [section, set] of [["networks", extNets], ["volumes", extVols]] as const) {
        const defs = root[section];
        if (!isObj(defs)) continue;
        for (const [key, def] of Object.entries(defs)) {
            if (!isObj(def) || !(def.external === true || isObj(def.external))) continue;
            const real = typeof def.name === "string" ? def.name : key; // external resources keep their own name (no project prefix)
            if (real.length <= 256) set.add(real);
        }
    }
    return true;
}

/** `composeText` + optional override file (Arcane returns both); services are unioned by name. */
export function parseComposeYaml(composeText: string, overrideText?: string | null): ComposeResult {
    const into = new Map<string, ComposeService>();
    const extNets = new Set<string>();
    const extVols = new Set<string>();
    for (const [i, text] of [composeText, overrideText].entries()) {
        if (text === null || text === undefined || (i === 1 && text.trim() === "")) continue;
        const r = parseOne(text);
        if (!r.ok) return r;
        if (!extract(r.value, into, extNets, extVols)) return {ok: false, reason: "not_a_mapping"};
    }
    return {ok: true, compose: {services: [...into.values()].sort((a, b) => a.name.localeCompare(b.name)), externalNetworks: [...extNets].sort(), externalVolumes: [...extVols].sort()}};
}
