import {artifactDownloadUrl} from "@/fork/upstream";
import {verifyArchiveStream, type ArchiveLimits, type ArchiveVerdict} from "./archive";

/**
 * Opens ONE stored archive object and verifies it. The URL comes from the upstream channel download path (never from a user), is never logged
 * or stored, `redirect: "error"`, wall-clock timeout. The result separates INTEGRITY (the object arrived and is bad) from INFRASTRUCTURE (it
 * could not be read) — the verify job must never mark an RP `failed` because a network hiccup looked like a truncated file:
 *   ok | integrity(code) | missing (404/410: the object is gone) | infra (anything else).
 */
export type ArtifactCheck =
    | {kind: "ok"; verdict: Extract<ArchiveVerdict, {ok: true}>}
    | {kind: "integrity"; code: Extract<ArchiveVerdict, {ok: false}>["code"]}
    | {kind: "missing"}
    | {kind: "infra"};

export type OpenArchive = (backupStorageId: string, o: {timeoutMs: number}) => Promise<{status: number; body: AsyncIterable<Uint8Array> | null; abort: () => void} | null>;

export const openArchiveViaUpstream: OpenArchive = async (backupStorageId, o) => {
    const url = await artifactDownloadUrl(backupStorageId);
    if (!url) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
    try {
        const resp = await fetch(url, {signal: ctl.signal, redirect: "error"});
        const body = resp.ok && resp.body ? (resp.body as unknown as AsyncIterable<Uint8Array>) : null;
        if (!body) clearTimeout(timer);
        return {status: resp.status, body, abort: () => { clearTimeout(timer); ctl.abort(); }};
    } catch {
        clearTimeout(timer);
        return null;
    }
};

export async function checkArchiveObject(open: OpenArchive, backupStorageId: string, masterKey: Buffer, limits: ArchiveLimits & {timeoutMs: number}): Promise<ArtifactCheck> {
    const h = await open(backupStorageId, {timeoutMs: limits.timeoutMs});
    if (!h) return {kind: "infra"};
    if (h.status === 404 || h.status === 410) return {kind: "missing"};
    if (!h.body) return {kind: "infra"};
    let transport = false;
    const guarded = (async function* () {
        try { yield* h.body as AsyncIterable<Uint8Array>; } catch (e) { transport = true; throw e; }
    })();
    try {
        const v = await verifyArchiveStream(guarded, masterKey, limits);
        if (transport) return {kind: "infra"};
        return v.ok ? {kind: "ok", verdict: v} : {kind: "integrity", code: v.code};
    } finally {
        h.abort();
    }
}
