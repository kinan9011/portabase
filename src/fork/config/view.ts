import {z} from "zod";
import type {OverrideRefusal} from "./vocab";

/** W16b read model (pure, client-safe): names and states only — no value, no value hash, no YAML text, no ciphertext (DD7). Strict allow-list like `RestorePlanView`. */
export const RestoreOverridesView = z.strictObject({
    applicable: z.boolean(),
    reason: z.enum(["purpose", "outcome", "no_compose_up", "no_restore_root"]).nullable(),
    frozen: z.boolean(),
    revision: z.number().int().min(0),
    fields: z.array(z.strictObject({service: z.string(), key: z.string(), origin: z.enum(["service_env", "env_file"]), class: z.enum(["restore", "require_input"]), isSet: z.boolean()})),
    yml: z.strictObject({present: z.boolean(), bytes: z.number().int().min(0)}),
    missingRequired: z.number().int().min(0),
});
export type RestoreOverridesView = z.infer<typeof RestoreOverridesView>;

export type OverrideFailure = {ok: false; code: OverrideRefusal; violations?: {kind: string; service: string | null}[]; retryAfterSeconds?: number};
