import {z} from "zod";
import type {ForkDb} from "@/fork/db/handle";
import {fileKeyProvider, type KeyProvider} from "@/fork/keys";
import {readManifestSnapshot} from "@/fork/manifest/store";
import {openManifestRepo} from "@/fork/upstream/restic";

/**
 * Signed-manifest fetch of the orchestrator (W18a a-6). The manifest is the one thing a restore must NOT take on the dashboard's word: this returns
 * the raw signed bytes; they are verified (trust anchors, canonical form, stack/RP/sequence, plan-bound sha256, per-artifact facts) by `verify_manifest`
 * and AGAIN inside every `enqueueRestoreTask`. Nothing here logs content. `null` = not readable right now (storage unreachable / refs malformed): the step waits.
 */
export type ManifestBundle = {json: string; sigB64: string};
export type ManifestFetch = (rp: {id: string; stackId: string; manifestRefs: unknown}) => Promise<ManifestBundle | null>;

const Refs = z.array(z.strictObject({channel_id: z.uuid(), snapshot_id: z.string().regex(/^[0-9a-f]{8,64}$/)})).max(16);

export function defaultManifestFetch(db: ForkDb, o: {keys?: KeyProvider; open?: typeof openManifestRepo} = {}): ManifestFetch {
    return async (rp) => {
        const refs = Refs.safeParse(rp.manifestRefs);
        if (!refs.success || refs.data.length === 0) return null;
        let master: Buffer;
        try { master = await (o.keys ?? fileKeyProvider).master(); } catch { return null; }
        const open = o.open ?? openManifestRepo;
        for (const ref of refs.data) {
            let h: Awaited<ReturnType<typeof openManifestRepo>> | null = null;
            try {
                h = await open(db, ref.channel_id, rp.stackId, master);
                const f = await readManifestSnapshot(h.run, ref.snapshot_id);
                return {json: f.json, sigB64: f.sig.toString("base64")};
            } catch {
                continue; // this channel is unreadable: try the next copy
            } finally {
                if (h) await h.cleanup().catch(() => undefined);
            }
        }
        return null;
    };
}
