/**
 * `MirrorPolicyV1` (plan-W22a §3.4): what the operator decided for a mirror, stored on `fork_mirror.policy`. KEYS and actions only: no env value ever
 * appears here (the operator's `keep_exact` choices are confirmed by typed phrases, which are not stored either). Pure module.
 */
import {z} from "zod";
import {ENV_KEY_RE} from "@/fork/compose-compiler/rules";
import {SERVICE_NAME} from "@/fork/inventory/labels";
import {HTTP_PATH_RE} from "./payload-schema";
import {LIMIT_CAPS, LIMIT_DEFAULTS, LIMIT_FLOORS} from "./vocab";

const svc = z.string().regex(SERVICE_NAME);
const envKey = z.string().regex(ENV_KEY_RE);
export const KEPT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;
const Limits = z.strictObject({
    mem_bytes: z.number().int().min(LIMIT_FLOORS.mem_bytes).max(LIMIT_CAPS.mem_bytes),
    pids: z.number().int().min(LIMIT_FLOORS.pids).max(LIMIT_CAPS.pids),
    nano_cpus: z.number().int().min(LIMIT_FLOORS.nano_cpus).max(LIMIT_CAPS.nano_cpus),
});
const EnvMap = z.record(svc, z.record(envKey, z.enum(["keep", "keep_exact", "rotate", "disable", "drop"])))
    .refine((m) => Object.values(m).reduce((n, r) => n + Object.keys(r).length, 0) <= 500, "too many env keys");

/** What the user sends (limits optional, `kept_confirmed` derived from the typed confirmations). */
export const MirrorPolicyInput = z.strictObject({
    v: z.literal(1),
    access: z.strictObject({service: svc, target: z.number().int().min(1).max(65535)}),
    http_path: z.string().regex(HTTP_PATH_RE).nullable(),
    env: EnvMap,
    limits: Limits.optional(),
});
export type MirrorPolicyInput = z.infer<typeof MirrorPolicyInput>;

/** What is stored (limits resolved, confirmed keys recorded). */
export const MirrorPolicyV1 = z.strictObject({
    v: z.literal(1),
    access: z.strictObject({service: svc, target: z.number().int().min(1).max(65535)}),
    http_path: z.string().regex(HTTP_PATH_RE).nullable(),
    env: EnvMap,
    kept_confirmed: z.array(z.string().regex(KEPT_RE)).max(100),
    limits: Limits,
});
export type MirrorPolicyV1 = z.infer<typeof MirrorPolicyV1>;

export const resolvePolicy = (input: MirrorPolicyInput, keptConfirmed: readonly string[]): MirrorPolicyV1 => ({
    v: 1, access: input.access, http_path: input.http_path, env: input.env, kept_confirmed: [...keptConfirmed].sort(), limits: input.limits ?? {...LIMIT_DEFAULTS},
});
