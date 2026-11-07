import {createHash} from "node:crypto";
import {artifactDownloadUrl} from "@/fork/upstream";

/**
 * Ciphertext hashing of ONE archive object (W12 finaliser). The agent's upload path reports no checksum (`backup/upload/status` writes
 * status/path/size only), so the dashboard reads the stored object back (presigned URL from the upstream download path) and hashes it while
 * streaming. Hard limits: size cap, wall-clock timeout, the stored object must be AT LEAST as large as the size the agent reported (observed in the
 * lab: the agent reports the size BEFORE encryption, the stored `.enc` object is larger by its header + tags, ≈ 122 bytes; a truncated object is smaller).
 * `null` = unreadable / over the cap / truncated ⇒ the RP says `checksum_unavailable` (never a made-up checksum). The URL is never logged or stored.
 */
export type HashRequest = {backupStorageId: string; expectedSize: number | null; maxBytes: number; timeoutMs: number};
export type HashResult = {sha256: string; bytes: number} | null;
export type HashArtifact = (r: HashRequest) => Promise<HashResult>;

export const hashViaUpstream: HashArtifact = async (r) => {
    const url = await artifactDownloadUrl(r.backupStorageId);
    return url ? hashUrl(url, r) : null;
};

/** Streams `url` through SHA-256. Exported for tests (local http server); the URL comes from the channel config, never from a user. */
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
        if (bytes === 0 || (r.expectedSize !== null && bytes < r.expectedSize)) return null; // truncated / empty: never a checksum
        return {sha256: h.digest("hex"), bytes};
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
