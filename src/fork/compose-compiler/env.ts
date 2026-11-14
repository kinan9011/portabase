import {createHmac} from "node:crypto";
import type {EnvAction, MirrorSpecV1} from "@/fork/compose-compiler/compile";
import {blankPolicyView} from "@/fork/restore-tasks/view";

/**
 * Runner-side reference (W20 D-5, D-6): the env value functions and `applyMirrorSpec`. NORMATIVE for the later Rust port; the vectors in
 * compose-mirror-vectors.json are the oracle. This runs ONLY where the full, secret-bearing render exists (the runner), never on the dashboard.
 * PURE: the seed is injected (32 random bytes per mirror revision, generated and kept on the runner, never uploaded). No clock, no randomness, no I/O.
 */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DOMAIN = "portabase-mirror-env-v1";
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** H(x) = first 32 lowercase hex chars of HMAC-SHA256(seed, "portabase-mirror-env-v1" || 0x00 || UTF-8(x)). */
export function mirrorHash(seed: Uint8Array, x: string): string {
    return createHmac("sha256", seed).update(Buffer.concat([Buffer.from(DOMAIN, "utf8"), Buffer.from([0]), Buffer.from(x, "utf8")])).digest("hex").slice(0, 32);
}

const pctDecode = (s: string): string => {
    try {
        return decodeURIComponent(s);
    } catch {
        return s; // invalid encoding: use the raw text
    }
};

/** procedural URL split (for Rust parity): scheme `://`, authority up to the first `/ ? #`, userinfo up to the LAST `@`, password after the FIRST `:`. */
function splitUrl(v: string): {scheme: string; authority: string; rest: string} | null {
    const m = URL_RE.exec(v);
    if (m === null) return null;
    const afterScheme = v.slice(m[0].length);
    const end = afterScheme.search(/[/?#]/);
    return {scheme: m[0], authority: end < 0 ? afterScheme : afterScheme.slice(0, end), rest: end < 0 ? "" : afterScheme.slice(end)};
}

/** the URL with its userinfo password replaced by H(pctDecode(pass)); null when there is no (non-empty) password. */
function rotateUrlPassword(v: string, seed: Uint8Array): string | null {
    const u = splitUrl(v);
    if (u === null) return null;
    const at = u.authority.lastIndexOf("@");
    if (at < 0) return null;
    const userinfo = u.authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    if (colon < 0 || colon === userinfo.length - 1) return null;
    return `${u.scheme}${userinfo.slice(0, colon)}:${mirrorHash(seed, pctDecode(userinfo.slice(colon + 1)))}@${u.authority.slice(at + 1)}${u.rest}`;
}

/** undefined = drop the key. `null` (pass-through) stays null for every action except drop. */
export function mirrorEnvValue(action: EnvAction, v: string | null, seed: Uint8Array): string | null | undefined {
    if (action === "drop") return undefined;
    if (v === null) return null;
    switch (action) {
        case "keep_exact":
            return v;
        case "keep":
            return rotateUrlPassword(v, seed) ?? v;
        case "rotate":
            return v === "" ? "" : (rotateUrlPassword(v, seed) ?? mirrorHash(seed, v));
        case "disable": {
            if (v === "") return "";
            const u = splitUrl(v);
            return u === null ? "disabled.invalid" : `${u.scheme}disabled.invalid${u.rest}`;
        }
    }
}

// ---- apply ---------------------------------------------------------------------------------------------------------------------------------

export type ApplyError = "service_missing" | "env_missing" | "label_missing" | "structure_mismatch" | "seed_invalid";
const STRUCT_KEYS = ["command", "entrypoint", "healthcheck", "secrets", "configs", "annotations"] as const;

/** same rule as `blankScalars` in restore-tasks/view.ts (not exported there; that file must stay identical with the agent's view.rs) */
function blankScalars(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(blankScalars);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blankScalars(x)]));
    return v === null || v === undefined ? v : "";
}
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    if (isObj(a)) {
        if (!isObj(b)) return false;
        const ka = Object.keys(a);
        return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
    }
    return false;
}
const toEnvString = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "string" ? v : String(v));

/**
 * D-6. `full` = the runner's own pass-2 render (secret-bearing). Merges the skeleton `spec.view` with it:
 * env values by action, kept label values, and the blanked structures copied as-is after a structure check; then proves
 * `blankPolicyView(result)` deep-equals `spec.view`. Structure (ports, networks, volumes, …) always comes from the spec, never from `full`.
 * The caller must verify `sha256(own view bytes) == spec.source_view_sha256` BEFORE calling this (source_changed), and validate the result with
 * `docker compose config` AFTER (this function runs no process).
 */
export function applyMirrorSpec(full: unknown, spec: MirrorSpecV1, seed: Uint8Array): {ok: true; doc: Record<string, unknown>} | {ok: false; code: ApplyError} {
    if (!(seed instanceof Uint8Array) || seed.length !== 32) return {ok: false, code: "seed_invalid"};
    const fail = (code: ApplyError) => ({ok: false, code}) as const;
    if (!isObj(full) || !isObj(full.services) || !isObj(spec.view) || !isObj(spec.view.services)) return fail("structure_mismatch");
    const out = structuredClone(spec.view) as Record<string, unknown>;
    const outSvcs = out.services as Record<string, Record<string, unknown>>;
    for (const name of Object.keys(outSvcs)) if (!isObj(full.services[name])) return fail("service_missing");
    for (const [name, o] of Object.entries(outSvcs)) {
        const f = full.services[name] as Record<string, unknown>;
        if (isObj(o.labels)) {
            const fl = isObj(f.labels) ? f.labels : {};
            for (const k of Object.keys(o.labels)) {
                if (!Object.hasOwn(fl, k)) return fail("label_missing");
                o.labels[k] = fl[k];
            }
        }
        if (isObj(o.environment)) {
            const fe = isObj(f.environment) ? f.environment : {};
            const acts = spec.env[name] ?? {};
            for (const k of Object.keys(o.environment)) {
                if (!Object.hasOwn(fe, k)) return fail("env_missing");
                const a = acts[k];
                if (a === undefined) return fail("structure_mismatch");
                const val = mirrorEnvValue(a, toEnvString(fe[k]), seed);
                if (val === undefined) delete o.environment[k];
                else o.environment[k] = val;
            }
        }
        for (const k of STRUCT_KEYS) {
            if (!(k in o)) continue;
            if (!deepEqual(blankScalars(f[k]), o[k])) return fail("structure_mismatch");
            o[k] = structuredClone(f[k]);
        }
    }
    for (const top of ["secrets", "configs"] as const) {
        const defs = out[top];
        if (!isObj(defs)) continue;
        const fdefs = isObj(full[top]) ? (full[top] as Record<string, unknown>) : {};
        for (const [k, d] of Object.entries(defs)) {
            const fd = fdefs[k];
            if (!isObj(d) || !isObj(fd)) return fail("structure_mismatch");
            for (const key of ["content", "environment"]) {
                if (!(key in d)) continue;
                if (!deepEqual(blankScalars(fd[key]), d[key])) return fail("structure_mismatch");
                d[key] = structuredClone(fd[key]);
            }
        }
    }
    if (!deepEqual(blankPolicyView(out), spec.view)) return fail("structure_mismatch");
    return {ok: true, doc: out};
}
