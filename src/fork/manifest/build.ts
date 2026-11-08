import type {StackInventoryV1} from "@/fork/inventory/schema";
import {MANIFEST_VERSION, type ManifestArtifact, type ManifestV1} from "./schema";

/** Pure builder: DB facts in, strict manifest out. `kid` is the signing key's id; `verifiedAt` = the moment the verify job proved the artifacts. */
export type RpFacts = {
    id: string; stackId: string; stackName: string; sequence: number; createdAt: Date; finalizedAt: Date | null; consistencyLevel: string;
    inventoryVersion: number | null; inventoryHash: string | null; requiredArtifactCount: number;
};
export type ArtifactFacts = {
    sourceName: string; engine: string; archiveKind: string; dumpFormat: string | null; archiveFormatVersion: number | null; encrypted: boolean;
    channelId: string | null; channelKind: string | null; pathOrSnapshotId: string | null; generatedId: string | null; sizeBytes: number | null;
    ciphertextSha256: string | null; plaintextSha256: string | null; plaintextSize: number | null; required: boolean;
};

const iso = (d: Date) => d.toISOString();
const CONSISTENCY = ["crash_consistent_files", "engine_dump", "mixed", "unknown", "stopped"] as const;

export function buildManifest(rp: RpFacts, artifacts: readonly ArtifactFacts[], inventory: StackInventoryV1 | null, o: {kid: string; signedAt: Date; verifiedAt: Date}): ManifestV1 {
    const rows: ManifestArtifact[] = artifacts.map((a) => ({
        source_name: a.sourceName, engine: a.engine, archive_kind: a.archiveKind as ManifestArtifact["archive_kind"],
        dump_format: (a.dumpFormat as ManifestArtifact["dump_format"]) ?? null, archive_format_version: a.archiveFormatVersion, encrypted: a.encrypted,
        channel_id: a.channelId, channel_kind: a.channelKind, location: a.pathOrSnapshotId, generated_id: a.generatedId, size_bytes: a.sizeBytes,
        ciphertext_sha256: a.ciphertextSha256, plaintext_sha256: a.plaintextSha256, plaintext_size: a.plaintextSize,
        plaintext_hash_source: a.archiveKind === "restic_snapshot" ? "not_applicable_restic" : "dashboard_verify_job", required: a.required,
    }));
    return {
        manifest_version: MANIFEST_VERSION, kid: o.kid, signed_at: iso(o.signedAt),
        rp: {
            id: rp.id, stack_id: rp.stackId, stack_name: rp.stackName, sequence: rp.sequence, created_at: iso(rp.createdAt),
            finalized_at: rp.finalizedAt ? iso(rp.finalizedAt) : null, verified_at: iso(o.verifiedAt),
            consistency_level: (CONSISTENCY as readonly string[]).includes(rp.consistencyLevel) ? (rp.consistencyLevel as (typeof CONSISTENCY)[number]) : "unknown",
            inventory_version: rp.inventoryVersion, inventory_hash: rp.inventoryHash, required_artifact_count: rp.requiredArtifactCount,
        },
        artifacts: rows, inventory,
    };
}
