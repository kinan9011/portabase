import {createHash} from "node:crypto";
import {z} from "zod";
import {canonicalJson} from "@/fork/canonical";

export {canonicalJson};

/**
 * Stack inventory schema v1 (ADR-004 §4, `schema_version: 1`).
 *
 * - Every object is `strictObject`: unknown keys are REJECTED on write (`parseInventoryStrict`) and
 *   DROPPED on Arcane ingest (`sanitizeIngest`). There is deliberately no field that could hold an env
 *   VALUE, a command line, a label map or file contents (ADR-004 "Never stored").
 * - Limits reject, never truncate. Canonical JSON is capped at 1 MiB.
 * - Readers refuse an unknown major (`schema_version` literal 1).
 */
export const INVENTORY_SCHEMA_VERSION = 1 as const;
export const INVENTORY_MAX_BYTES = 1024 * 1024;

const iso = z.iso.datetime({offset: false}); // ISO-8601 UTC ("Z")
const sha256Ref = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const hint = z.string().max(1024);
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const jsonPointer = z.string().max(512).regex(/^(\/[^/]*)*$/);

const Image = z.strictObject({
    ref: z.string().max(512),
    digest: sha256Ref.optional(),
    pinned: z.boolean(),
    built_locally: z.boolean(),
});

const Service = z.strictObject({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    state: z.enum(["running", "exited", "paused", "restarting", "created", "dead", "absent"]),
    container_id: z.string().min(12).max(64).optional(),
    image: Image,
    ports: z.array(z.strictObject({target: z.number().int().min(0).max(65535), published: z.number().int().min(0).max(65535).optional(), protocol: z.enum(["tcp", "udp"])})).max(256),
    networks: z.array(z.string().max(128)).max(64),
    mounts: z.array(z.string().max(64)).max(256),
    env_keys: z.array(envKey).max(500), // NAMES ONLY
    depends_on: z.array(z.string().max(128)).max(100).optional(),
    privileged: z.boolean().optional(),
    network_mode: z.string().max(64).optional(),
});

const Ownership = z.enum(["stack_owned", "external_shared", "unknown"]);

const Mount = z.strictObject({
    id: z.string().regex(/^m:[0-9a-f]{16}$/),
    kind: z.enum(["named_volume", "anonymous_volume", "bind", "tmpfs"]),
    volume_name: z.string().max(256).optional(),
    host_path_hint: hint.optional(),
    destination: z.string().max(1024),
    rw: z.boolean(),
    consumers: z.array(z.string().max(128)).max(500),
    ownership: Ownership,
    driver: z.string().max(64).optional(),
    size_bytes: z.number().int().min(0).optional(),
});

const Volume = z.strictObject({
    name: z.string().max(256),
    driver: z.string().max(64),
    in_use_by: z.array(z.string().max(128)).max(500),
    ownership: Ownership,
    size_bytes: z.number().int().min(0).optional(),
});

const Network = z.strictObject({
    name: z.string().max(128),
    driver: z.string().max(64),
    internal: z.boolean(),
    external: z.boolean(),
    subnets: z.array(z.string().max(64)).max(32).optional(),
    members: z.array(z.string().max(128)).max(500),
});

const EnvFile = z.strictObject({
    path_hint: hint,
    key_names: z.array(envKey).max(500),
    referenced_by: z.array(z.string().max(128)).max(500),
});

const ExternalDependency = z.strictObject({
    kind: z.enum(["volume", "network", "host_path", "remote_service", "other"]),
    name: z.string().max(256),
    note_key: z.string().max(128),
});

const Warning = z.strictObject({
    code: z.string().max(128),
    severity: z.enum(["info", "warn", "blocker"]),
    path: jsonPointer.optional(),
    message_key: z.string().max(128),
});

const Provenance = z.record(jsonPointer, z.enum(["arcane_list", "arcane_compose", "container_label", "agent_probe", "user_override"]));

export const StackInventoryV1 = z.strictObject({
    schema_version: z.literal(INVENTORY_SCHEMA_VERSION),
    captured_at: iso,
    source: z.strictObject({
        arcane_version: z.string().max(64),
        openapi_sha256: sha256Ref,
        connection_id: z.uuid(),
        environment_id: z.string().max(256),
    }),
    stack: z.strictObject({
        compose_project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
        display_name: z.string().min(1).max(128),
        compose_read: z.enum(["none", "arcane_compose", "agent_files"]),
        working_dir_hint: hint.optional(), // HINT from a label (SEC-22, untrusted)
        config_files_hint: z.array(hint).max(32),
    }),
    services: z.array(Service).max(500),
    mounts: z.array(Mount).max(2000),
    volumes: z.array(Volume).max(2000),
    networks: z.array(Network).max(500),
    env_files: z.array(EnvFile).max(500),
    external_dependencies: z.array(ExternalDependency).max(500),
    provenance: Provenance,
    warnings: z.array(Warning).max(1000),
});
export type StackInventoryV1 = z.infer<typeof StackInventoryV1>;

export class InventoryRejectedError extends Error {
    constructor(public readonly reason: "too-large" | "invalid" | "unknown-major", detail?: string) {
        super(`inventory rejected: ${reason}${detail ? ` (${detail})` : ""}`);
        this.name = "InventoryRejectedError";
    }
}

function assertSize(v: unknown) {
    if (Buffer.byteLength(canonicalJson(v), "utf8") > INVENTORY_MAX_BYTES) throw new InventoryRejectedError("too-large");
}

function assertMajor(raw: unknown) {
    const v = (raw as {schema_version?: unknown} | null)?.schema_version;
    if (v !== INVENTORY_SCHEMA_VERSION) throw new InventoryRejectedError("unknown-major");
}

/** Write path: unknown keys, wrong types and oversize all reject. Error text carries paths/codes only, never values. */
export function parseInventoryStrict(raw: unknown): StackInventoryV1 {
    assertMajor(raw);
    assertSize(raw);
    const r = StackInventoryV1.safeParse(raw);
    if (!r.success) throw new InventoryRejectedError("invalid", r.error.issues.slice(0, 5).map((i) => `${i.code}@${i.path.join(".")}`).join(", "));
    return r.data;
}

/** Strips every key the schema does not name (recursively), then validates strictly. Ingest path for Arcane data. */
export function sanitizeIngest(raw: unknown): StackInventoryV1 {
    assertMajor(raw);
    const stripped = strip(raw, StackInventoryV1);
    return parseInventoryStrict(stripped);
}

// Recursive key-dropper driven by the schema shape (zod 4 `.strip()` is non-recursive for strictObject).
function strip(value: unknown, schema: z.ZodType): unknown {
    const def = (schema as unknown as {def: {type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; innerType?: z.ZodType; valueType?: z.ZodType}}).def;
    switch (def.type) {
        case "object": {
            if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
            const out: Record<string, unknown> = {};
            for (const [k, s] of Object.entries(def.shape ?? {})) if (k in (value as object)) out[k] = strip((value as Record<string, unknown>)[k], s);
            return out;
        }
        case "array":
            return Array.isArray(value) && def.element ? value.map((v) => strip(v, def.element as z.ZodType)) : value;
        case "optional":
        case "nullable":
            return def.innerType ? strip(value, def.innerType) : value;
        default:
            return value; // primitives, enums, records (record keys are validated, not dropped)
    }
}

/** `content_hash = sha256(canonical(inventory without captured_at/warnings))` (ADR-004 §4). */
export function contentHash(inv: StackInventoryV1): string {
    const {captured_at: _c, warnings: _w, ...rest} = inv;
    return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}
