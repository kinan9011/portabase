import {z} from "zod";
import {SERVICE_NAME} from "@/fork/inventory/labels";

/**
 * Materializer vocabulary (W10). Pure: no I/O, no upstream imports (only `src/fork/upstream/**` may touch upstream modules).
 *
 * SEC-24 (ADR-005 §6): `volume_name` must match this AND exist in the inventory. Path-like (`/`, `/etc`, `..`) and hash-named
 * (anonymous) volumes never pass; `container_name` is never produced (D29).
 */
export const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;
const ANONYMOUS_VOLUME_RE = /^[0-9a-f]{64}$/;
export const isAdoptableVolumeName = (n: string): boolean => VOLUME_NAME_RE.test(n) && n.length <= 255 && !ANONYMOUS_VOLUME_RE.test(n);

/** DB host = an operator-chosen network alias the AGENT resolves (ADR-001 §B). Never the loopback of the agent itself. */
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export function isAcceptableDbHost(h: string): boolean {
    if (!HOST_RE.test(h)) return false;
    const x = h.toLowerCase();
    return !(x === "localhost" || x.endsWith(".localhost") || /^127\./.test(x) || x === "0.0.0.0" || x === "::1" || /^169\.254\./.test(x));
}

export const DUMP_ENGINES = ["postgresql", "mysql", "mariadb", "mongodb", "redis", "valkey", "firebird", "mssql"] as const;
export type DumpEngine = (typeof DUMP_ENGINES)[number];
/** Fields upstream's per-engine config schema requires (database-config.schema.ts). `password` is carried separately and never persisted. */
export const DUMP_REQUIRED: Record<DumpEngine, {fields: readonly ("host" | "port" | "username" | "database")[]; secret: boolean}> = {
    postgresql: {fields: ["host", "port", "username", "database"], secret: true},
    mysql: {fields: ["host", "port", "username", "database"], secret: true},
    mariadb: {fields: ["host", "port", "username", "database"], secret: true},
    mssql: {fields: ["host", "port", "username", "database"], secret: true},
    mongodb: {fields: ["host", "database"], secret: false},
    redis: {fields: ["host", "port"], secret: false},
    valkey: {fields: ["host", "port"], secret: false},
    firebird: {fields: ["host", "port", "database"], secret: false},
};

const key = z.string().min(3).max(1200).regex(/^(file|env|mount|volume|db|image|network|dep|dir|manual):/);
const service = z.string().regex(SERVICE_NAME);
const absPath = z.string().min(2).max(1024);

/** Non-secret DB connection fields; persisted in `fork_stack_policy.selection`. The password is NOT part of it (D31). */
export const DbInputSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        kind: z.literal("dump"),
        host: z.string().max(253), port: z.number().int().min(1).max(65535).optional(),
        username: z.string().min(1).max(255).optional(), database: z.string().min(1).max(255).optional(),
    }),
    z.strictObject({kind: z.literal("sqlite"), path: absPath}),
]);
export type DbInput = z.infer<typeof DbInputSchema>;

export const ManualSourceSchema = z.strictObject({path: absPath, covers: z.array(key).min(1).max(20)});
export type ManualSource = z.infer<typeof ManualSourceSchema>;

export const SelectionSchema = z.strictObject({
    /** Explicit selection wins over an `exclude` label hint (D18). */
    includeKeys: z.array(key).max(2000).default([]),
    excludeKeys: z.array(key).max(2000).default([]),
    composeMethod: z.enum(["snapshot", "archive"]).default("snapshot"),
    bindMethod: z.enum(["archive", "snapshot"]).default("archive"),
    databases: z.record(service, DbInputSchema).default({}),
    manual: z.array(ManualSourceSchema).max(50).default([]),
    /** `stop` hints carried as DATA for W17b (R2); the materializer never sets `container_name` (D29). */
    stop: z.array(service).max(500).default([]),
});
export type Selection = z.infer<typeof SelectionSchema>;

export type PlannedSource = {
    /** Unique per stack; stable across re-plans. */
    resourceKey: string;
    role: "compose" | "env" | "bind" | "volume" | "db";
    origin: "discovered" | "manual";
    memberName: string;
    dbms: "files" | "docker-volume" | "sqlite" | DumpEngine;
    /** Upstream `backup_engine` (archive | restic). */
    engine: "archive" | "restic";
    /** Non-secret agent config (without `options.method`: the method lives in `engine`). */
    config: Record<string, unknown>;
    /** Completeness keys this member covers (W09 contract). */
    covers: readonly string[];
    coverage: "engine_dump" | "files" | "manual_files";
    /** Key the DB password (when `needsSecret`) is supplied under: the service name. */
    secretFor: string | null;
    needsSecret: boolean;
    requiresDocker: boolean;
    /** Identity of this member in the plan (role, covers, config, secret need). */
    hash: string;
    /** What the upstream row must look like (dbms, engine, NON-secret config): the drift job compares the live row against it. */
    configHash: string;
};

export const SKIP_REASONS = [
    "excluded_hint", "excluded_selection", "external_volume", "unsupported_driver", "anonymous_volume", "volume_name_invalid",
    "volume_not_in_inventory", "bind_path_denied", "compose_location_unknown", "db_not_selected", "db_input_invalid", "tmpfs",
    "manual_invalid", "manual_key_unknown",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export type Skipped = {key: string; reason: SkipReason};

export type Plan = {
    sources: PlannedSource[];
    /** Coverage the completeness validator is fed (engine-dump coverage of DB data mounts included). */
    coverage: Record<string, "engine_dump" | "files" | "manual_files">;
    skipped: Skipped[];
    stop: string[];
    planHash: string;
};
