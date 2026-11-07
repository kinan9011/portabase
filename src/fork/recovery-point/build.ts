import type {BackupFacts, StorageFacts} from "@/fork/upstream";
import {artifactPresent, type ArtifactInput} from "./decide";

/**
 * Pure builder of the RecoveryPoint artifact rows (D32: every fact a recovery needs is denormalised). One artifact SLOT per
 * (required member, policy storage channel): a slot whose storage row is missing/failed/pending is still a row (presence
 * `missing`/`unknown`, FKs NULL) so `required_artifact_count` and the downgrade rule stay honest.
 */
export type ItemFacts = {
    itemId: string; stackSourceId: string | null; sourceName: string; dbms: string; required: boolean; state: string; backupId: string | null;
    generatedId: string | null; checksums: Record<string, {sha256?: string; bytes?: number; attempts?: number} | undefined>;
};
export type ChannelFacts = {id: string; provider: string};

export type ArtifactRow = {
    stackSourceId: string | null; backupId: string | null; backupStorageId: string | null; sourceName: string; engine: string;
    archiveKind: "restic_snapshot" | "archive_enc" | "archive_plain"; encrypted: boolean; channelId: string | null; channelKind: string | null;
    pathOrSnapshotId: string | null; generatedId: string | null; sizeBytes: number | null; ciphertextSha256: string | null; required: boolean;
    presence: "present" | "missing" | "unknown";
};
export type BuiltArtifacts = {rows: ArtifactRow[]; inputs: ArtifactInput[]; requiredCount: number; presentCount: number; totalSize: number | null};

const HEX64 = /^[0-9a-f]{64}$/;

export function buildArtifacts(items: readonly ItemFacts[], backups: ReadonlyMap<string, BackupFacts>, policyChannels: readonly ChannelFacts[]): BuiltArtifacts {
    const rows: ArtifactRow[] = [];
    const inputs: ArtifactInput[] = [];
    const providerOf = new Map(policyChannels.map((c) => [c.id, c.provider]));
    for (const it of items.filter((i) => i.required)) {
        const b = it.backupId ? backups.get(it.backupId) : undefined;
        const live = (b?.storages ?? []).filter((s) => s.deletedAt === null);
        const channelIds = policyChannels.length > 0 ? policyChannels.map((c) => c.id) : [...new Set(live.map((s) => s.channelId))];
        for (const channelId of channelIds.length > 0 ? channelIds : [null]) {
            const s: StorageFacts | undefined = channelId ? live.find((x) => x.channelId === channelId) : undefined;
            const sizeBytes = s?.size ?? (s ? b?.fileSize ?? null : null);
            const restic = s?.engine === "restic";
            const archive: ArtifactInput["archive"] = !s ? "archive" : restic ? "restic" : s.engine === "archive" ? "archive" : "other";
            const enc = !!s?.path && s.path.endsWith(".enc");
            const sum = s ? it.checksums[s.id]?.sha256 : undefined;
            // an item that did NOT succeed (timeout, agent failure, skipped) never contributes a present artifact, whatever half-written rows exist
            const storageStatus: ArtifactInput["storageStatus"] = it.state !== "succeeded" ? (s?.status === "pending" ? "pending" : "failed") : s ? s.status : "none";
            const input: ArtifactInput = {
                hasBackupFk: !!b && it.backupId !== null, hasStorageFk: !!s, storageStatus,
                archive, encrypted: enc, ciphertextSha256: sum && HEX64.test(sum) ? sum : null, snapshotId: restic && s?.path && HEX64.test(s.path) ? s.path : null,
            };
            const present = artifactPresent(input);
            rows.push({
                stackSourceId: it.stackSourceId, backupId: s ? it.backupId : null, backupStorageId: s?.id ?? null, sourceName: it.sourceName, engine: it.dbms,
                archiveKind: restic ? "restic_snapshot" : enc ? "archive_enc" : "archive_plain", encrypted: restic ? true : enc, channelId,
                channelKind: channelId ? providerOf.get(channelId) ?? null : null, pathOrSnapshotId: s?.path ?? null, generatedId: it.generatedId, sizeBytes,
                ciphertextSha256: restic ? null : input.ciphertextSha256, required: true,
                presence: present ? "present" : s && s.status === "pending" ? "unknown" : "missing",
            });
            inputs.push(input);
        }
    }
    const presentRows = rows.filter((r) => r.presence === "present");
    const sizes = presentRows.map((r) => r.sizeBytes).filter((n): n is number => n !== null);
    return {rows, inputs, requiredCount: rows.length, presentCount: presentRows.length, totalSize: sizes.length ? sizes.reduce((a, b) => a + b, 0) : null};
}
