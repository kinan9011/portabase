import {z} from "zod";
import {SyncSummarySchema} from "@/fork/discovery/sync-summary";
import {HOST_ROLES, SYNC_STATUSES} from "@/fork/db/enums";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";

/**
 * Explicit column allowlist for `fork_arcane_environment` (same discipline as `db/dto.ts` for the connection): nothing but
 * what the Integrations page shows. The table holds no secret and (ADR-012 B2-I2) no foreign Arcane `apiUrl`, but the
 * allowlist keeps it that way when a column is added later (`allowed_path_roots` is deliberately not exposed in W06).
 */
export const ENVIRONMENT_PUBLIC_COLUMNS = {
    id: forkArcaneEnvironment.id,
    connectionId: forkArcaneEnvironment.connectionId,
    externalId: forkArcaneEnvironment.externalId,
    name: forkArcaneEnvironment.name,
    enabled: forkArcaneEnvironment.enabled,
    hostRole: forkArcaneEnvironment.hostRole,
    agentId: forkArcaneEnvironment.agentId,
    agentName: forkArcaneEnvironment.agentName,
    lastSyncAt: forkArcaneEnvironment.lastSyncAt,
    lastSyncStatus: forkArcaneEnvironment.lastSyncStatus,
    lastSyncErrorClass: forkArcaneEnvironment.lastSyncErrorClass,
    lastSyncSummary: forkArcaneEnvironment.lastSyncSummary,
} as const;

export const EnvironmentDtoSchema = z.strictObject({
    id: z.uuid(),
    connectionId: z.uuid(),
    externalId: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    hostRole: z.enum(HOST_ROLES),
    agentId: z.uuid().nullable(),
    agentName: z.string().nullable(),
    lastSyncAt: z.date().nullable(),
    lastSyncStatus: z.enum(SYNC_STATUSES).nullable(),
    lastSyncErrorClass: z.string().nullable(),
    lastSyncSummary: SyncSummarySchema.nullable(),
});
export type EnvironmentDto = z.infer<typeof EnvironmentDtoSchema>;

export function toEnvironmentDto(row: Record<string, unknown>): EnvironmentDto {
    const picked: Record<string, unknown> = {};
    for (const k of Object.keys(ENVIRONMENT_PUBLIC_COLUMNS)) picked[k] = row[k];
    return EnvironmentDtoSchema.parse(picked);
}
