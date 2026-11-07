import {z} from "zod";
import {SERVICE_NAME} from "@/fork/inventory/labels";
import {SelectionSchema} from "@/fork/materialize/types";
import {RetentionPolicySchema, DEFAULT_RETENTION} from "@/fork/recovery/retention-policy";
import {DEFAULT_SCHEDULE, ScheduleSchema} from "@/fork/schedule/schedule";

/**
 * Strict input of `activateStackPolicy` (W11). Nothing here is read from the browser without being re-validated server-side; the
 * selection/secrets/channels shapes are W10's. `secrets` (service name → DB password) goes straight into the upstream-encrypted source
 * config and is never persisted, audited or returned.
 */
const itemKey = z.string().min(3).max(1200).regex(/^(file|env|mount|volume|db|image|network|dep|dir|manual):/);

export const ActivateInputSchema = z.strictObject({
    stackId: z.uuid(),
    selection: SelectionSchema.default(SelectionSchema.parse({})),
    storageChannelIds: z.array(z.uuid()).max(20).default([]),
    secrets: z.record(z.string().regex(SERVICE_NAME), z.string().min(1).max(512)).default({}),
    /** The operator states the agent mounts the Docker socket (no agent-side probe exists in R1, ADR-001 §G). */
    confirmDockerAccess: z.boolean().default(false),
    schedule: ScheduleSchema.default(ScheduleSchema.parse(DEFAULT_SCHEDULE)),
    retention: RetentionPolicySchema.default(DEFAULT_RETENTION),
    /** UX-20: gaps the operator knowingly accepts, by completeness item key. */
    acceptedExclusions: z.array(itemKey).max(500).default([]),
});
export type ActivateInput = z.input<typeof ActivateInputSchema>;
export type ActivateParsed = z.output<typeof ActivateInputSchema>;
