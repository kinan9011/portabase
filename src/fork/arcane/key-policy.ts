import {ENV_MINIMUM, GLOBAL_MINIMUM, TIER2_PERMISSION} from "@/fork/arcane/endpoints";
import type {ArcaneErrorClass} from "@/fork/arcane/errors";
import type {ApiKeyRowT} from "@/fork/arcane/schemas";

/**
 * Permission self-test of the stored Arcane key (ADR-002 A7, ADR-005 B2-E, W05).
 * Input: the rows of `GET /auth/me/api-keys` (the OWNER's keys) and the plaintext key. The key's own row is the one whose
 * non-secret `keyPrefix` is a prefix of the key. Rule: the grant set must equal the list-only minimum — global
 * `environments:list`, plus, for every environment the key covers, the five env-scoped `*:list` permissions — optionally
 * plus `projects:read` (tier 2, only when the connection opted in). Anything else is refused with the exact names; we
 * never probe secret-returning endpoints to find out (a successful probe would itself be the leak).
 */
export type KeyEvaluation =
    | {ok: false; errorClass: Extract<ArcaneErrorClass, "key_unverifiable" | "key_too_broad">; extra: string[]; keyId: string | null}
    | {ok: true; keyId: string; environmentIds: string[]; /** per env: missing minimum permissions */ missing: Record<string, string[]>; missingGlobal: string[]; partial: boolean};

const GLOBAL_OK = new Set<string>(GLOBAL_MINIMUM);
const ENV_OK = new Set<string>(ENV_MINIMUM);

export function findOwnKey(rows: readonly ApiKeyRowT[], apiKey: string): ApiKeyRowT | null {
    // longest prefix wins (two keys of one owner can share a short prefix); empty prefixes never match.
    const hits = rows.filter((r) => r.keyPrefix.length >= 4 && apiKey.startsWith(r.keyPrefix)).sort((a, b) => b.keyPrefix.length - a.keyPrefix.length);
    return hits.length === 1 || (hits.length > 1 && hits[0].keyPrefix.length > hits[1].keyPrefix.length) ? hits[0] : null;
}

export function evaluateKeyPermissions(rows: readonly ApiKeyRowT[], apiKey: string, o: {allowProjectsRead: boolean}): KeyEvaluation {
    const own = findOwnKey(rows, apiKey);
    if (!own) return {ok: false, errorClass: "key_unverifiable", extra: [], keyId: null};
    const extra = new Set<string>();
    const envPerms = new Map<string, Set<string>>();
    const global = new Set<string>();
    for (const g of own.permissions) {
        const name = g.permission;
        if (g.environmentId === null) {
            if (GLOBAL_OK.has(name)) global.add(name);
            else extra.add(ENV_OK.has(name) || name === TIER2_PERMISSION ? `${name} (global grant — must be scoped to an environment)` : name);
        } else if (ENV_OK.has(name) || (name === TIER2_PERMISSION && o.allowProjectsRead)) {
            const s = envPerms.get(g.environmentId) ?? new Set<string>();
            s.add(name);
            envPerms.set(g.environmentId, s);
        } else {
            extra.add(name === TIER2_PERMISSION ? `${name} (tier 2 is not enabled for this connection)` : name);
        }
    }
    if (extra.size) return {ok: false, errorClass: "key_too_broad", extra: [...extra].sort(), keyId: own.id};
    const missing: Record<string, string[]> = {};
    for (const [env, set] of envPerms) {
        const m = ENV_MINIMUM.filter((p) => !set.has(p));
        if (m.length) missing[env] = m;
    }
    const missingGlobal = GLOBAL_MINIMUM.filter((p) => !global.has(p));
    return {ok: true, keyId: own.id, environmentIds: [...envPerms.keys()].sort(), missing, missingGlobal, partial: missingGlobal.length > 0 || Object.keys(missing).length > 0 || envPerms.size === 0};
}

/** Plain-language list for the UI/errors: the exact permission names the form must show (UX copy never says "read-only"). */
export const REQUIRED_PERMISSIONS_TEXT = `environments:list (global) and, for each environment to protect: ${ENV_MINIMUM.join(", ")}`;
