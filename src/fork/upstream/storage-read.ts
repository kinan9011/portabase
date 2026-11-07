import {createHash} from "node:crypto";

/**
 * Ciphertext hashing of ONE archive object (W12 finaliser). The agent's upload path reports no checksum (`backup/upload/status`
 * writes status/path/size only), so the dashboard reads the stored object back through the upstream download path
 * (`getBackupDownloadUrlService`, session-free: presigned URL of the channel) and hashes it while streaming.
 * Hard limits: size cap, wall-clock timeout, byte count must equal the size the agent reported. The URL is never logged or stored.
 * `null` = unreadable / over the cap / size mismatch ⇒ the RP says `checksum_unavailable` (never a made-up checksum).
 */
export type HashRequest = {backupStorageId: string; expectedSize: number | null; maxBytes: number; timeoutMs: number};
export type HashResult = {sha256: string; bytes: number} | null;
export type HashArtifact = (r: HashRequest) => Promise<HashResult>;

export const hashViaUpstream: HashArtifact = async (r) => {
    try {
        const {getBackupDownloadUrlService} = await import("@/features/database/services/backup-download.service");
        const res = await getBackupDownloadUrlService(r.backupStorageId);
        if (!res.ok) return null;
        return await hashUrl(res.url, r);
    } catch {
        return null;
    }
};

/** Streams `url` through SHA-256. Exported for tests (local http server); never receives a user-controlled URL (it comes from the channel config). */
export async function hashUrl(url: string, r: Omit<HashRequest, "backupStorageId">): Promise<HashResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), r.timeoutMs);
    try {
        const resp = await fetch(url, {signal: ctl.signal, redirect: "error"});
        if (!resp.ok || !resp.body) return null;
        const declared = Number(resp.headers.get("content-length") ?? NaN);
        if (Number.isFinite(declared) && declared > r.maxBytes) return null;
        const h = createHash("sha256");
        let bytes = 0;
        const reader = resp.body.getReader();
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > r.maxBytes) { await reader.cancel(); return null; }
            h.update(value);
        }
        if (r.expectedSize !== null && bytes !== r.expectedSize) return null;
        return {sha256: h.digest("hex"), bytes};
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
