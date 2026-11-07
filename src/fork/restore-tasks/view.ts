/**
 * Policy view of a rendered compose document (W17-ii E4, ADR-015 D-2). PURE: no I/O. The agent blanks secret-bearing values BEFORE it uploads the render;
 * the dashboard re-checks (`isPolicyView`) as defence in depth and refuses a render that still carries a value in a blanked field.
 * Rule (must stay identical to the agent's `fork::policy::view`): replace every non-null scalar (string, number, bool) under
 *   services.*.{environment, labels, annotations, command, entrypoint, healthcheck, build, secrets, configs}, every key starting `x-` at any level,
 *   top-level secrets.*.{content, environment} and configs.*.{content, environment}
 * by "" — keys, nulls, arrays and structure stay.
 */
const SERVICE_BLANKED = ["environment", "labels", "annotations", "command", "entrypoint", "healthcheck", "build", "secrets", "configs"] as const;
const TOP_BLANKED = ["content", "environment"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function blankScalars(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(blankScalars);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blankScalars(x)]));
    return v === null || v === undefined ? v : "";
}

/** `x-*` keys at any depth: the whole subtree is blanked. Applied first, structure-preserving. */
function blankExtensions(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(blankExtensions);
    if (!isObj(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.startsWith("x-") ? blankScalars(x) : blankExtensions(x)]));
}

export function blankPolicyView(doc: unknown): unknown {
    const d = blankExtensions(doc);
    if (!isObj(d)) return d;
    const out: Record<string, unknown> = {...d};
    if (isObj(out.services)) {
        out.services = Object.fromEntries(Object.entries(out.services).map(([name, svc]) => {
            if (!isObj(svc)) return [name, svc];
            const s: Record<string, unknown> = {...svc};
            for (const k of SERVICE_BLANKED) if (k in s) s[k] = blankScalars(s[k]);
            return [name, s];
        }));
    }
    for (const top of ["secrets", "configs"] as const) {
        const t = out[top];
        if (!isObj(t)) continue;
        out[top] = Object.fromEntries(Object.entries(t).map(([name, def]) => {
            if (!isObj(def)) return [name, def];
            const o: Record<string, unknown> = {...def};
            for (const k of TOP_BLANKED) if (k in o) o[k] = blankScalars(o[k]);
            return [name, o];
        }));
    }
    return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    if (isObj(a)) {
        if (!isObj(b)) return false;
        const ka = Object.keys(a), kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
    }
    return false;
}

/** True when blanking the parsed document again changes nothing, i.e. no secret-bearing field carries a value. */
export const isPolicyView = (doc: unknown): boolean => deepEqual(blankPolicyView(doc), doc);
