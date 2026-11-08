import {z} from "zod";
import {SOURCE_DRIFT_REASONS, SOURCE_ORIGINS, SOURCE_PROBES, SOURCE_ROLES, SOURCE_STATUSES} from "@/fork/materialize/vocab";
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {deriveFacets, type FacetInputs} from "./facets";
import {derivePrimaryState, type PrimaryInputs} from "./precedence";
import {CONSISTENCY_FACETS, DELETABLE_VALUES, DIRECTIVE_CODES, ITEM_KINDS, ITEM_STATUSES, PRIMARY_STATES, REASON_CODES, SEVERITIES, type CompletenessReport} from "./types";

/**
 * Browser DTOs of the protection / configuration views (W09). STRICT and built field by field from the report: names, paths
 * (hints), statuses, reasons and hashes only. There is no field that could carry an environment value, file content, a command
 * line or a label map, and the stored inventory itself never crosses to the browser (W08 wall, extended).
 */
export const ItemViewSchema = z.strictObject({
    key: z.string().max(1100),
    kind: z.enum(ITEM_KINDS),
    name: z.string().max(1100),
    status: z.enum(ITEM_STATUSES),
    reason: z.enum(REASON_CODES),
    severity: z.enum(SEVERITIES),
    gap: z.boolean(),
    resolvable: z.boolean(),
    consumers: z.array(z.string().max(128)).max(500),
    placement: z.enum(["here", "outside"]).nullable(),
    consistency: z.enum(["engine_dump", "files_only"]).nullable(),
});
export type ItemView = z.infer<typeof ItemViewSchema>;

export const ProtectionViewSchema = z.strictObject({
    primary: z.enum(PRIMARY_STATES),
    complete: z.boolean(),
    counts: z.strictObject({total: z.number().int(), captured: z.number().int(), gaps: z.number().int(), blockers: z.number().int(), warnings: z.number().int(), external: z.number().int(), excluded: z.number().int(), accepted: z.number().int()}),
    recoveryPoints: z.strictObject({verified: z.number().int().min(0), pending: z.number().int().min(0)}),
    facets: z.strictObject({
        lastGoodBackup: z.strictObject({hoursAgo: z.number().min(0).nullable(), verifying: z.boolean()}),
        testRestore: z.strictObject({daysAgo: z.number().min(0).nullable(), stale: z.boolean()}),
        deletable: z.enum(DELETABLE_VALUES),
        hostCompromise: z.boolean(),
        consistency: z.array(z.strictObject({member: z.string().max(1100), level: z.enum(CONSISTENCY_FACETS)})).max(5000),
        pausedAfterReauthorization: z.boolean(),
        inventoryStale: z.boolean(),
        configLocked: z.boolean(),
    }),
});
export type ProtectionView = z.infer<typeof ProtectionViewSchema>;

/** W10: one materialized member source as the browser sees it: name, role, status, probe, reason. NEVER its config, path-bearing key or credential. */
export const SourceViewSchema = z.strictObject({
    name: z.string().max(255),
    role: z.enum(SOURCE_ROLES),
    origin: z.enum(SOURCE_ORIGINS),
    status: z.enum(SOURCE_STATUSES),
    probe: z.enum(SOURCE_PROBES).nullable(),
    reason: z.enum(SOURCE_DRIFT_REASONS).nullable(),
});
export type SourceView = z.infer<typeof SourceViewSchema>;

const ENV_NAMES_PER_SERVICE = 100;
export const ConfigurationViewSchema = z.strictObject({
    composeRead: z.enum(["none", "arcane_compose", "agent_files"]),
    items: z.array(ItemViewSchema).max(5000),
    directives: z.array(z.strictObject({code: z.enum(DIRECTIVE_CODES), service: z.string().max(128).nullable(), detail: z.string().max(1100).nullable()})).max(5000),
    networks: z.array(z.strictObject({name: z.string().max(128), ownership: z.enum(["stack_owned", "shared_external", "manual"]), subnets: z.array(z.string().max(64)).max(32)})).max(500),
    /** Environment variable NAMES per service. Values are never stored, so there is nothing to mask here, only to never add. */
    envNames: z.array(z.strictObject({service: z.string().max(128), names: z.array(z.string().max(256)).max(ENV_NAMES_PER_SERVICE), more: z.number().int().min(0)})).max(500),
    /** Content hash of the inventory version shown (sha256 hex). File hashes arrive with the materialiser (W10). */
    inventoryHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    /** W10: backup sources this stack manages ("Managed by this stack", D30). Empty until the stack configuration was applied. */
    sources: z.array(SourceViewSchema).max(500),
});
export type ConfigurationView = z.infer<typeof ConfigurationViewSchema>;

export const toItemView = (i: CompletenessReport["items"][number]): ItemView =>
    ItemViewSchema.parse({key: i.key, kind: i.kind, name: i.name, status: i.status, reason: i.reason, severity: i.severity, gap: i.gap, resolvable: i.resolvable, consumers: [...i.consumers], placement: i.placement, consistency: i.consistency});

export function toProtectionView(report: CompletenessReport, primary: PrimaryInputs, facets: FacetInputs): ProtectionView {
    return ProtectionViewSchema.parse({
        primary: derivePrimaryState(primary),
        complete: report.complete,
        counts: report.counts,
        recoveryPoints: {verified: primary.verifiedRpCount, pending: primary.pendingRpCount},
        facets: deriveFacets(facets, report),
    });
}

export function toConfigurationView(inv: StackInventoryV1, report: CompletenessReport, inventoryHash: string | null, sources: readonly SourceView[] = []): ConfigurationView {
    const showEnv = inv.stack.compose_read !== "none"; // names exist only when the compose definition was read
    return ConfigurationViewSchema.parse({
        composeRead: inv.stack.compose_read,
        items: report.items.map(toItemView),
        directives: report.directives,
        networks: report.networks.map((n) => ({name: n.name, ownership: n.ownership, subnets: [...n.subnets]})),
        envNames: showEnv
            ? inv.services.filter((s) => s.env_keys.length > 0).map((s) => ({service: s.name, names: s.env_keys.slice(0, ENV_NAMES_PER_SERVICE), more: Math.max(0, s.env_keys.length - ENV_NAMES_PER_SERVICE)}))
            : [],
        inventoryHash,
        sources: sources.map((x) => SourceViewSchema.parse(x)),
    });
}
