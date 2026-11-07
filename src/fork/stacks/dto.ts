import {z} from "zod";
import {PROTECTION_STATES, RUNTIME_STATES} from "@/fork/db/enums";
import {ConfigurationViewSchema, ProtectionViewSchema} from "@/fork/completeness/view";
import {StackInventoryV1} from "@/fork/inventory/schema";
import {PolicyViewSchema} from "@/fork/stack-policy/policy-schema";
import {RunViewSchema} from "@/fork/runs/view";
import {ActivityViewSchema} from "@/fork/stacks/activity-view";
import {BackupsViewSchema} from "@/fork/stacks/backups-view";

/**
 * Client-facing DTOs of the stacks UI (W08). Strict, JSON-serialisable, built FIELD BY FIELD from the stored inventory:
 * the raw `inventory` jsonb never crosses to the browser (wave security check). Deliberately NOT sent: environment variable
 * names (count only), container ids, provenance, the source block, label/config-file hints (W09 owns the Configuration tab),
 * and any key this file does not name. `parseInventoryStrict` already refused values at write time; the mapper is the second wall.
 */
const iso = z.string().nullable();
const Runtime = z.enum(RUNTIME_STATES);
const Protection = z.enum(PROTECTION_STATES);

export const StackListItemSchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    composeProject: z.string(),
    environmentName: z.string(),
    runtime: Runtime,
    protection: Protection,
    staleSince: iso,
    updatedAt: z.string(),
    inventory: z.strictObject({
        version: z.number().int().min(1),
        capturedAt: z.string(),
        counts: z.strictObject({
            services: z.number().int().min(0), volumes: z.number().int().min(0), binds: z.number().int().min(0),
            networks: z.number().int().min(0), databases: z.number().int().min(0), shared: z.number().int().min(0),
        }),
    }).nullable(),
});
export type StackListItem = z.infer<typeof StackListItemSchema>;

export const StackListSchema = z.strictObject({
    items: z.array(StackListItemSchema),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    summary: z.strictObject({total: z.number().int().min(0), unprotected: z.number().int().min(0), staleOrGone: z.number().int().min(0)}),
    environments: z.array(z.string()),
    /** Durable server state, polled via router.refresh() (UX-13): a sync holds the lease right now. */
    syncing: z.boolean(),
    circuitOpen: z.boolean(),
    setup: z.strictObject({connected: z.boolean(), enabledEnvironments: z.number().int().min(0)}),
});
export type StackList = z.infer<typeof StackListSchema>;

const Ownership = z.enum(["stack_owned", "external_shared", "unknown"]);
const ServiceState = z.enum(["running", "exited", "paused", "restarting", "created", "dead", "absent"]);

export const InventoryViewSchema = z.strictObject({
    version: z.number().int().min(1),
    capturedAt: z.string(),
    composeRead: z.enum(["none", "arcane_compose", "agent_files"]),
    services: z.array(z.strictObject({
        name: z.string(), state: ServiceState,
        image: z.strictObject({ref: z.string(), pinned: z.boolean(), builtLocally: z.boolean()}),
        ports: z.array(z.strictObject({published: z.number().int().optional(), target: z.number().int(), protocol: z.enum(["tcp", "udp"])})),
        networks: z.array(z.string()), mountCount: z.number().int().min(0), envCount: z.number().int().min(0),
        privileged: z.boolean(), networkMode: z.string().nullable(),
    })),
    volumes: z.array(z.strictObject({name: z.string(), driver: z.string(), usedBy: z.array(z.string()), ownership: Ownership, sizeBytes: z.number().int().nullable()})),
    anonymousVolumes: z.array(z.strictObject({destination: z.string(), consumers: z.array(z.string()), rw: z.boolean()})),
    binds: z.array(z.strictObject({destination: z.string(), hostPath: z.string().nullable(), rw: z.boolean(), consumers: z.array(z.string()), ownership: Ownership})),
    databases: z.array(z.strictObject({service: z.string(), engine: z.string(), basis: z.enum(["image", "port", "mount"])})),
    networks: z.array(z.strictObject({name: z.string(), driver: z.string(), internal: z.boolean(), external: z.boolean(), members: z.array(z.string()), classification: z.enum(["stack_owned", "shared_external", "manual"]).nullable()})),
    shared: z.array(z.strictObject({kind: z.enum(["network", "volume"]), name: z.string()})),
    warnings: z.array(z.strictObject({code: z.string(), severity: z.enum(["info", "warn", "blocker"])})),
});
export type InventoryView = z.infer<typeof InventoryViewSchema>;

export const StackDetailSchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    composeProject: z.string(),
    environmentName: z.string(),
    runtime: Runtime,
    protection: Protection,
    staleSince: iso,
    lastSyncAt: iso,
    syncing: z.boolean(),
    /** W11: the ACTIVATED backup policy (Schedule tab), null when none. */
    policy: PolicyViewSchema.nullable().default(null),
    /** W12: runs (latest / active / paused), null for a stack that never had a policy. */
    runs: RunViewSchema.nullable().default(null),
    /** W13: recovery-point table (+ the selected one's artifacts) and the durable run timeline. Polled with the page (router.refresh), never pushed. */
    backups: BackupsViewSchema.nullable().default(null),
    activity: ActivityViewSchema.nullable().default(null),
    /** `ok` = readable inventory, `unreadable` = stored but not understood by this release, `none` = no version recorded. */
    inventory: z.discriminatedUnion("state", [
        z.strictObject({state: z.literal("ok"), view: InventoryViewSchema, protection: ProtectionViewSchema, configuration: ConfigurationViewSchema}),
        z.strictObject({state: z.literal("unreadable")}),
        z.strictObject({state: z.literal("none")}),
    ]),
});
export type StackDetail = z.infer<typeof StackDetailSchema>;

/** Strips `user:password@` from an image reference (a registry credential must never reach the browser even if Arcane echoed one). */
export function safeImageRef(ref: string): string {
    return ref.replace(/^[^\s/@]*@(?=[^\s@]*\/)/, "");
}

/** Maps a STORED inventory to the view. Returns `null` when the stored value does not parse as `StackInventoryV1` (never throws, never echoes). */
export function toInventoryView(stored: unknown, meta: {version: number; capturedAt: Date}): InventoryView | null {
    const parsed = StackInventoryV1.safeParse(stored);
    return parsed.success ? inventoryViewFrom(parsed.data, meta) : null;
}

/** Same mapping from an inventory that is already parsed (the loader parses once and also feeds the completeness validator). */
export function inventoryViewFrom(inv: StackInventoryV1, meta: {version: number; capturedAt: Date}): InventoryView {
    const mountsOf = (kind: string) => inv.mounts.filter((m) => m.kind === kind);

    const databases = inv.services.flatMap((s) => (s.database_hint ? [{service: s.name, engine: s.database_hint.engine, basis: s.database_hint.basis}] : []));
    const shared = [
        ...inv.networks.filter((n) => n.classification === "shared_external" || n.external).map((n) => ({kind: "network" as const, name: n.name})),
        ...inv.volumes.filter((v) => v.ownership === "external_shared").map((v) => ({kind: "volume" as const, name: v.name})),
    ];
    return InventoryViewSchema.parse({
        version: meta.version,
        capturedAt: meta.capturedAt.toISOString(),
        composeRead: inv.stack.compose_read,
        services: inv.services.map((s) => ({
            name: s.name, state: s.state,
            image: {ref: safeImageRef(s.image.ref), pinned: s.image.pinned, builtLocally: s.image.built_locally},
            ports: s.ports.map((p) => ({...(p.published !== undefined ? {published: p.published} : {}), target: p.target, protocol: p.protocol})),
            networks: s.networks, mountCount: s.mounts.length, envCount: s.env_keys.length,
            privileged: s.privileged === true, networkMode: s.network_mode ?? null,
        })),
        volumes: inv.volumes.map((v) => ({name: v.name, driver: v.driver, usedBy: v.in_use_by, ownership: v.ownership, sizeBytes: v.size_bytes ?? null})),
        anonymousVolumes: mountsOf("anonymous_volume").map((m) => ({destination: m.destination, consumers: m.consumers, rw: m.rw})),
        binds: mountsOf("bind").map((m) => ({destination: m.destination, hostPath: m.host_path_hint ?? null, rw: m.rw, consumers: m.consumers, ownership: m.ownership})),
        databases,
        networks: inv.networks.map((n) => ({name: n.name, driver: n.driver, internal: n.internal, external: n.external, members: n.members, classification: n.classification ?? null})),
        shared,
        warnings: inv.warnings.map((w) => ({code: w.code, severity: w.severity})),
    });
}
