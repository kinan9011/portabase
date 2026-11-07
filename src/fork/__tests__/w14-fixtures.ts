import {generateKeyPairSync, randomUUID} from "node:crypto";
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {buildManifest, type ArtifactFacts, type RpFacts} from "@/fork/manifest/build";
import {kidOfPublicKey, publicKeyPemOf, signManifest} from "@/fork/manifest/sign";

/**
 * THROW-AWAY TEST-ONLY KEYS (generated in memory per test run; nothing here is a real key and none is ever written to the repo).
 * Fixture material is labelled `TEST-ONLY` wherever it could be mistaken for a real value.
 */
export const testKeypair = () => {
    const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength: 2048, publicKeyEncoding: {type: "spki", format: "pem"}, privateKeyEncoding: {type: "pkcs1", format: "pem"}});
    return {privateKey, publicKey, kid: kidOfPublicKey(publicKey)};
};
export const testMaster = () => Buffer.from("TEST-ONLY-master-key-0123456789ab".padEnd(32, "x").slice(0, 32), "utf8");

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);

export function rpFacts(o: Partial<RpFacts> = {}): RpFacts {
    return {id: randomUUID(), stackId: randomUUID(), stackName: "forklab-demo", sequence: 3, createdAt: new Date("2026-11-07T10:00:00Z"), finalizedAt: new Date("2026-11-07T10:05:00Z"),
        consistencyLevel: "engine_dump", inventoryVersion: 1, inventoryHash: SHA_A, requiredArtifactCount: 1, ...o};
}
export function artifactFacts(o: Partial<ArtifactFacts> = {}): ArtifactFacts {
    return {sourceName: "db-main", engine: "postgresql", archiveKind: "archive_enc", dumpFormat: "pg_custom", archiveFormatVersion: 1, encrypted: true, channelId: randomUUID(), channelKind: "s3",
        pathOrSnapshotId: "backups/abc/def.tar.gz.enc", generatedId: "gen-1", sizeBytes: 1234, ciphertextSha256: SHA_A, plaintextSha256: SHA_B, plaintextSize: 1234, required: true, ...o};
}

export function signedFixture(o: {rp?: Partial<RpFacts>; artifacts?: ArtifactFacts[]; inventory?: StackInventoryV1 | null; key?: ReturnType<typeof testKeypair>} = {}) {
    const key = o.key ?? testKeypair();
    const rp = rpFacts(o.rp);
    const manifest = buildManifest(rp, o.artifacts ?? [artifactFacts()], o.inventory ?? null, {kid: key.kid, signedAt: new Date("2026-11-07T10:10:00Z"), verifiedAt: new Date("2026-11-07T10:09:00Z")});
    const signed = signManifest(manifest, key.privateKey);
    return {key, rp, manifest, signed, anchors: [{kid: key.kid, publicKeyPem: publicKeyPemOf(key.privateKey)}]};
}
