import {z} from "zod";
import {parseYamlLimited} from "@/fork/inventory/compose-yaml";
import {SERVICE_NAME} from "@/fork/inventory/labels";
import {RESTORE_YAML_LIMITS} from "@/fork/policy/raw";
import {envKey, envVal} from "@/fork/restore-tasks/payload-schema";
import {OVERRIDE_LIMITS, type OverrideError} from "./vocab";

/**
 * W16b pure core (no DB, no env, no clock, no crypto): request schema + the merge of the stored override set into the payload the W17-ii task carries
 * (ADR-015 note "W16b R-k"). Per-key values of a SERVICE go into the override file at `services.<svc>.environment.<KEY>` (Compose: `environment` beats
 * `env_file`, and the same key is replaced), `$` doubled so Compose does not interpolate the value; keys of the service-less project `.env` go to the process
 * env of `docker compose config` (interpolation only). The result is serialised with `JSON.stringify` (JSON ⊂ YAML 1.2: no tags, deterministic).
 * Overrides are TAG-FREE: `!reset` / `!override` / any custom tag is refused (R-k, ADR-015 D-3 unchanged).
 */
export {OVERRIDE_LIMITS};
export type OverrideField = {service: string; key: string; value: string};
export type StoredOverridesV1 = {v: 1; env: OverrideField[]; yml: string | null};

const uuid = z.uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** control characters except TAB (a function, not a regex: biome forbids control characters in regex literals) */
const hasControl = (v: string) => [...v].some((c) => { const n = c.charCodeAt(0); return (n < 32 && n !== 9) || n === 127; });
export const envValStrict = envVal.refine((v) => !hasControl(v), "control");
const serviceField = z.string().max(128).refine((s) => s === "" || SERVICE_NAME.test(s), "service");

export const SetOverridesRequest = z.strictObject({
    planId: uuid, planHash: hex64,
    set: z.array(z.strictObject({service: serviceField, key: envKey, value: envValStrict})).max(OVERRIDE_LIMITS.maxFields).default([]),
    unset: z.array(z.strictObject({service: serviceField, key: envKey})).max(OVERRIDE_LIMITS.maxFields).default([]),
    /** undefined = keep, null = remove, string = replace */
    overrideYml: z.string().max(OVERRIDE_LIMITS.maxYmlBytes).nullable().optional(),
});
export type SetOverridesRequest = z.infer<typeof SetOverridesRequest>;
export const OverridesIdRequest = z.strictObject({planId: uuid, planHash: hex64});

export const StoredOverrides = z.strictObject({
    v: z.literal(1),
    env: z.array(z.strictObject({service: serviceField, key: envKey, value: envValStrict})).max(OVERRIDE_LIMITS.maxFields),
    yml: z.string().max(OVERRIDE_LIMITS.maxYmlBytes).nullable(),
});

type Violation = {kind: string; service: string | null};
export type OverridePayloadResult =
    | {ok: true; env: Record<string, string>; overrideYml: string | null}
    | {ok: false; code: OverrideError; violations?: Violation[]};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** own-property assignment that is safe for `__proto__` as a key */
const put = (o: Record<string, unknown>, k: string, v: unknown) => { Object.defineProperty(o, k, {value: v, enumerable: true, writable: true, configurable: true}); };
const fail = (code: OverrideError): OverridePayloadResult => ({ok: false, code});

/** Merge the stored set into the payload fields of the W17-ii compose tasks. Same code path at set time (validation) and at enqueue time (never trust a stored derived form). */
export function buildOverridePayload(s: StoredOverridesV1): OverridePayloadResult {
    if (!StoredOverrides.safeParse(s).success) return fail("override_field_invalid");
    const env: Record<string, string> = {};
    const svcFields = s.env.filter((f) => f.service !== "");
    for (const f of s.env) if (f.service === "") put(env, f.key, f.value);

    let tree: Record<string, unknown> = {};
    if (s.yml !== null) {
        const r = parseYamlLimited(s.yml, RESTORE_YAML_LIMITS);
        if (!r.ok) return fail(r.reason === "too_large" ? "override_too_large" : "override_yaml_invalid");
        if (r.value !== null && r.value !== undefined) {
            if (!isObj(r.value)) return fail("override_not_mapping");
            tree = r.value;
        }
    }
    if (svcFields.length > 0) {
        if (tree.services === undefined || tree.services === null) put(tree, "services", {});
        if (!isObj(tree.services)) return fail("override_not_mapping");
        const services = tree.services;
        for (const f of svcFields) {
            if (services[f.service] === undefined || services[f.service] === null) put(services, f.service, {});
            const svc = services[f.service];
            if (!isObj(svc)) return fail("override_not_mapping");
            let environment: Record<string, unknown> = {};
            const cur = svc.environment;
            if (Array.isArray(cur)) {
                // list form → map form ("A=b" → A:"b", "C" → C:null) so a field and the operator's entries merge in ONE map
                for (const e of cur) {
                    if (typeof e !== "string") return fail("override_yaml_invalid");
                    const i = e.indexOf("=");
                    put(environment, i < 0 ? e : e.slice(0, i), i < 0 ? null : e.slice(i + 1));
                }
            } else if (isObj(cur)) environment = cur;
            else if (cur !== undefined && cur !== null) return fail("override_not_mapping");
            if (Object.hasOwn(environment, f.key)) return fail("override_duplicate_key");
            put(environment, f.key, f.value.replaceAll("$", () => "$$"));
            put(svc, "environment", environment);
        }
    }
    const overrideYml = s.yml === null && svcFields.length === 0 ? null : JSON.stringify(tree);
    if (overrideYml !== null && Buffer.byteLength(overrideYml, "utf8") > OVERRIDE_LIMITS.maxYmlBytes) return fail("override_too_large");
    return {ok: true, env, overrideYml};
}
