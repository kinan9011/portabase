import {REFUSALS} from "@/fork/restore/vocab";

/**
 * W16b vocabulary (pure). Refusal codes of the override services = the W16 plan refusals + the override-specific ones. Codes are the only thing a refusal
 * ever carries (never an input echo): the UI maps each code to a fixed sentence (`ui/stacks/config/labels.ts`).
 */
export const OVERRIDE_ERRORS = ["unknown_key", "override_field_invalid", "override_yaml_invalid", "override_not_mapping", "override_duplicate_key", "override_too_large", "override_raw_refused"] as const;
export type OverrideError = (typeof OVERRIDE_ERRORS)[number];

export const OVERRIDE_STATE_REFUSALS = ["overrides_frozen", "overrides_not_applicable", "overrides_unreadable"] as const;

export const OVERRIDE_REFUSALS = [...REFUSALS, ...OVERRIDE_ERRORS, ...OVERRIDE_STATE_REFUSALS] as const;
export type OverrideRefusal = (typeof OVERRIDE_REFUSALS)[number];

export const OVERRIDE_PURGE_REASONS = ["cleanup", "expired", "terminal"] as const;
export type OverridePurgeReason = (typeof OVERRIDE_PURGE_REASONS)[number];

/** Limits shared by the schema, the merge and the DB CHECKs. */
export const OVERRIDE_LIMITS = {maxFields: 200, maxValue: 4096, maxYmlBytes: 64 * 1024} as const;
