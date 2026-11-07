import {createHash} from "node:crypto";
import {z} from "zod";
import {canonicalJson} from "@/fork/canonical";
import raw from "@/fork/policy/compose-deny.json";

/**
 * Compose deny list, rule file v2 (W20a, D27): loaded and schema-validated ONCE at import. A rule file that fails its schema throws
 * here, so every consumer of the engine fails closed. Normative semantics: vault ADR-015; oracle: compose-policy-vectors.json.
 */
export const RULE_IDS = ["privileged", "network_mode_host", "pid_host", "ipc_host", "devices", "cap_add", "docker_sock", "bind_outside_root", "shared_namespace", "unknown_directive"] as const;
export const HARD_IDS = ["read_outside_root", "path_ambiguous", "yaml_invalid", "limits", "raw_incomplete", "service_name", "top_level_unknown", "shape_invalid"] as const;
export type RuleId = (typeof RULE_IDS)[number];
export type HardId = (typeof HARD_IDS)[number];

const unique = (ids: {id: string}[]) => new Set(ids.map((r) => r.id)).size === ids.length;

export const RulesV2 = z.strictObject({
    version: z.literal(2),
    description: z.string(),
    rules: z.array(z.strictObject({id: z.enum(RULE_IDS), directive: z.string().min(3), plain: z.string().min(20)})).length(RULE_IDS.length).refine(unique, "duplicate rule id"),
    hard_refusals: z.array(z.strictObject({id: z.enum(HARD_IDS), plain: z.string().min(20)})).length(HARD_IDS.length).refine(unique, "duplicate hard id"),
    cap_add_allowlist: z.array(z.string().regex(/^[A-Z_]+$/)),
    docker_socket_paths: z.array(z.string().startsWith("/")).min(1),
    docker_socket_basename: z.literal("docker.sock"),
    top_level_keys: z.array(z.string()),
    service_keys_known: z.array(z.string()),
    namespace_values_ok: z.array(z.string()),
    network_drivers_ok: z.array(z.string()),
    security_opt_ok: z.array(z.string()),
    raw_read_scope: z.strictObject({
        description: z.string(),
        keys: z.array(z.string()),
        max_depth: z.number().int().min(1).max(16),
        max_files: z.number().int().min(1).max(256),
        max_bytes: z.number().int().min(1024).max(1_048_576),
    }),
});

export const RULES = RulesV2.parse(raw);
/** Same formula as `DENY_RULES_SHA256` in restore/load.ts (W16): a plan's informational findings are tied to this exact rule set. */
export const RULES_SHA256 = createHash("sha256").update(canonicalJson(raw)).digest("hex");

const PLAIN = new Map<string, string>([...RULES.rules, ...RULES.hard_refusals].map((r) => [r.id, r.plain]));
export const plainOf = (id: RuleId | HardId): string => PLAIN.get(id) ?? "";

// ---- path predicates (normative, D-2): the SAME definitions are implemented in jq (portabase-recover) and, later, Rust (W17); the corpus is the oracle.
function hasControlOrDollar(p: string): boolean {
    for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        if (c <= 0x1f || c === 0x7f || c === 0x24) return true;
    }
    return false;
}
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/;
/** canonical absolute path: starts with `/`, ≤ 1024 chars, no control char or `$`, no `//`, no `.`/`..` segment, no trailing `/` (except `/`). */
export function isCanonPath(p: unknown): p is string {
    if (typeof p !== "string" || !p.startsWith("/") || p.length > 2048) return false;
    if (Array.from(p).length > 1024) return false;
    if (hasControlOrDollar(p) || DOT_SEGMENT.test(p) || p.includes("//")) return false;
    return !(p.length > 1 && p.endsWith("/"));
}
/** `p` is one of the roots or below one (roots and `p` already canonical). */
export const isUnderRoots = (p: string, roots: readonly string[]): boolean => roots.some((r) => p === r || p.startsWith(`${r}/`));
/** `p` is the docker socket, `/`, or a prefix directory of a socket path (`/var/run`, `/run`, `/var`), or ends in `/docker.sock`. */
export const isSocketPath = (p: string): boolean =>
    p.endsWith(`/${RULES.docker_socket_basename}`) || p === "/" || RULES.docker_socket_paths.some((s) => s === p || s.startsWith(`${p}/`));
