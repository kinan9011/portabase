import {z} from "zod";
import {StackInventoryV1} from "@/fork/inventory/schema";

/**
 * Manifest v1 (D24, ADR-013 §2). The WHOLE canonical document is signed (a superset of D24's list: RP id, stack id, monotonic sequence,
 * restic snapshot ids, artifact checksums incl. plaintext SHA-256 + size). Strict: an unknown key is a rejection, so a signed manifest can
 * not smuggle fields a verifier would ignore. NO secret values by construction — every field is a name, id, hash, size, time or a code; the
 * embedded inventory is the already-scrubbed strict inventory v1 (env KEY NAMES only). `manifest-canary` tests plant secrets and scan.
 */
export const MANIFEST_VERSION = 1 as const;
export const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const ManifestArtifact = z.strictObject({
    source_name: z.string().min(1).max(256),
    engine: z.string().min(1).max(64),
    archive_kind: z.enum(["restic_snapshot", "archive_enc", "archive_plain"]),
    dump_format: z.enum(["pg_custom", "pg_directory"]).nullable(),
    archive_format_version: z.number().int().min(1).nullable(),
    encrypted: z.boolean(),
    channel_id: uuid.nullable(),
    channel_kind: z.string().max(64).nullable(),
    /** object path (archive) or 64-hex snapshot id (restic) */
    location: z.string().max(1024).nullable(),
    generated_id: z.string().max(128).nullable(),
    /** size the stock agent reported (BEFORE encryption); null when not reported */
    size_bytes: z.number().int().min(0).nullable(),
    ciphertext_sha256: hex64.nullable(),
    plaintext_sha256: hex64.nullable(),
    plaintext_size: z.number().int().min(0).nullable(),
    /** how the plaintext hash was obtained: R1 = this dashboard's verify job; R2 (D45) adds the agent-reported cross-check */
    plaintext_hash_source: z.enum(["dashboard_verify_job", "not_applicable_restic"]),
    required: z.boolean(),
});
export type ManifestArtifact = z.infer<typeof ManifestArtifact>;

export const ManifestV1 = z.strictObject({
    manifest_version: z.literal(MANIFEST_VERSION),
    kid: z.string().regex(/^[0-9a-f]{12}$/),
    signed_at: iso,
    rp: z.strictObject({
        id: uuid,
        stack_id: uuid,
        stack_name: z.string().min(1).max(256),
        /** monotonic per stack (anti-rollback) */
        sequence: z.number().int().min(1),
        created_at: iso,
        finalized_at: iso.nullable(),
        verified_at: iso,
        consistency_level: z.enum(["crash_consistent_files", "engine_dump", "mixed", "unknown", "stopped"]),
        inventory_version: z.number().int().min(0).nullable(),
        inventory_hash: z.string().max(128).nullable(),
        required_artifact_count: z.number().int().min(0),
    }),
    artifacts: z.array(ManifestArtifact).max(2000),
    inventory: StackInventoryV1.nullable(),
});
export type ManifestV1 = z.infer<typeof ManifestV1>;
