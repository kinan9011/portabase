import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import type {ResticRunner} from "@/fork/manifest/restic-runner";
import {forgetManifestSnapshots} from "@/fork/manifest/store";

/**
 * Manifest `forget` for purged RPs (W12 handoff → W14). W12 retention tombstones an expired RP (`purged_at`) and deletes its backups through the upstream
 * path; the manifest snapshots live in the fork's own repos, so they are forgotten here, per channel, idempotently. Each `manifest_refs[]` entry gets
 * `forgotten_at` only after restic confirmed; a channel that is down keeps the entry pending for the next tick (never silently dropped). `restic prune` is
 * left to the repo's own maintenance (a manifest is a few KB).
 */
export type ForgetDeps = {
    db: ForkDb;
    master: () => Promise<Buffer>;
    manifestRunner: (channelId: string, stackId: string, master: Buffer) => Promise<{run: ResticRunner; cleanup: () => Promise<void>}>;
    now?: () => Date;
    limit?: number;
};
type Ref = {channel_id: string; snapshot_id: string; forgotten_at?: string};

export async function sweepManifestForgets(d: ForgetDeps): Promise<{forgotten: number; pending: number}> {
    const rows = (await d.db.execute(sql`
        select id, stack_id, manifest_refs from fork_recovery_point
         where purged_at is not null and jsonb_array_length(manifest_refs) > 0
           and exists (select 1 from jsonb_array_elements(manifest_refs) e where e->>'forgotten_at' is null)
         order by purged_at limit ${d.limit ?? 25}`)).rows as {id: string; stack_id: string; manifest_refs: Ref[]}[];
    let forgotten = 0; let pending = 0;
    if (rows.length === 0) return {forgotten, pending};
    const master = await d.master();
    for (const rp of rows) {
        const refs = rp.manifest_refs.map((r) => ({...r}));
        for (const ref of refs.filter((r) => !r.forgotten_at)) {
            let h: Awaited<ReturnType<ForgetDeps["manifestRunner"]>> | null = null;
            try {
                h = await d.manifestRunner(ref.channel_id, rp.stack_id, master);
                await forgetManifestSnapshots(h.run, rp.id);
                ref.forgotten_at = (d.now?.() ?? new Date()).toISOString();
                forgotten++;
            } catch { pending++; } finally { await h?.cleanup().catch(() => undefined); }
        }
        await d.db.execute(sql`update fork_recovery_point set manifest_refs = ${JSON.stringify(refs)}::jsonb where id = ${rp.id}`);
    }
    return {forgotten, pending};
}
