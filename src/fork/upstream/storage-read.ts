/**
 * Download URL of ONE stored backup object, through the upstream download path (`getBackupDownloadUrlService`, session-free: the presigned
 * URL of the channel). The adapter only LOOKS the URL up; reading and hashing the object happens in `recovery-point/hash.ts` (the adapter has
 * no network access of its own, `w10-static`). The URL is never logged or stored.
 */
export async function artifactDownloadUrl(backupStorageId: string): Promise<string | null> {
    try {
        const {getBackupDownloadUrlService} = await import("@/features/database/services/backup-download.service");
        const res = await getBackupDownloadUrlService(backupStorageId);
        return res.ok ? res.url : null;
    } catch {
        return null;
    }
}
