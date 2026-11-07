import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/**
 * W14 upstream pins (run on every W-SYNC, D31): the fork reads upstream's restic helpers, rclone target builder, backup-folder name and download service through
 * `src/fork/upstream/restic.ts` + `verify/artifact.ts` (`storage-read.ts`). If upstream renames or reshapes one of them, this fails at sync time, not at the first
 * verify run. Source-level pins (the modules import the dashboard env, so they are not loaded here).
 */
const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("W14 upstream contract pins", () => {
    it("restic repo helpers the manifest/artifact adapter relies on", () => {
        const repo = src("src/lib/restic/repo.ts");
        expect(repo).toMatch(/export function remotePath\(rclone: RcloneConfig, rel: string\)/);
        expect(repo).toMatch(/export function resticPassword\(masterKey: Buffer, generatedId: string\)/);
        expect(repo).toContain("`portabase/restic/v1/${generatedId}`");
        expect(repo).toMatch(/hkdfSync\("sha256", masterKey, Buffer\.alloc\(0\)/);
    });
    it("rclone target builder, connection cap and folder name", () => {
        expect(src("src/features/channel/components/storages/rclone/target.ts")).toMatch(/export async function toRcloneTarget\(provider: StorageProviderKind, config: unknown\): Promise<RcloneTarget>/);
        expect(src("src/features/channel/components/storages/rclone/config.ts")).toMatch(/export function maxConnections\(configText: string\): number \| undefined/);
        expect(src("src/utils/file-prefix.ts")).toMatch(/export function getBackupFolderName\(\)/);
        expect(src("src/features/channel/components/storages/rclone/types.ts")).toMatch(/type RcloneConfig = \{\s*configText: string;\s*remoteName: string;\s*remotePath: string;\s*\}/);
    });
    it("the download service the verify job reads objects through, and the credential envelope the kit does NOT touch", () => {
        expect(src("src/features/database/services/backup-download.service.ts")).toMatch(/export (async )?function getBackupDownloadUrlService|export const getBackupDownloadUrlService/);
        expect(src("src/utils/rsa-keys.ts")).toMatch(/server_private\.pem/);
        expect(src("src/utils/rsa-keys.ts")).toMatch(/modulusLength: 2048/); // RSA-2048 PKCS#1 — what the manifest signature + `openssl dgst -verify` assume (ADR-013 §2)
        expect(src("src/utils/rsa-keys.ts")).toMatch(/type: "pkcs1"/);
    });
    it("agent archive format v1 constants the verify pipeline hard-codes (decrypt-archive v0 is the executable spec)", () => {
        const py = src("scripts/fork/recover/decrypt-archive");
        expect(py).toContain('KEYS = {"version", "cipher", "chunk_size", "base_nonce"}');
        expect(py).toContain('h["cipher"] != "AES-256-GCM"');
    });
    it("upstream backup_storage keeps the presence column the coherence job copies", () => {
        const s = src("src/db/schema/14_storage-backup.ts");
        expect(s).toMatch(/backupPresenceEnum = pgEnum\("backup_presence", \[\s*"present",\s*"missing",\s*"unknown",?\s*\]\)/);
        expect(s).toMatch(/presence: backupPresenceEnum\("presence"\)/);
    });
});
