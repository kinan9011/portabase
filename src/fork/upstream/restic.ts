import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {manifestRepoPassword, manifestRepoRel} from "@/fork/manifest/repo-password";
import {createResticRunner, type ResticRunner} from "@/fork/manifest/restic-runner";

/**
 * CONTROLLED COPY (D31) of how upstream opens a restic repo on a storage channel (`src/lib/restic/{index,repo}.ts`): channel row → `toRcloneTarget` →
 * rclone-backed repo. The fork adds ONE repo kind (`<folder>/fork-manifest/<stackId>`, password HKDF(master, "portabase-fork/manifest/v1/<stackId>"))
 * and a read-only handle on the artifact repos (`<folder>/restic/<generatedId>`, upstream HKDF) for the verify job. The channel `config` (credentials) is
 * read here, written to a 0600 temp rclone.conf that is removed at once, and never leaves this module. Imported lazily; pinned by the contract test.
 */
export type RepoHandle = {run: ResticRunner; cleanup: () => Promise<void>};

async function channelTarget(db: ForkDb, channelId: string) {
    const r = await db.execute(sql`select provider::text as provider, config from storage_channel where id = ${channelId}::uuid and deleted_at is null`);
    const ch = r.rows[0] as {provider: string; config: unknown} | undefined;
    if (!ch) throw new Error("channel_not_found");
    const {toRcloneTarget} = await import("@/features/channel/components/storages/rclone/target");
    const target = await toRcloneTarget(ch.provider as never, ch.config);
    return target;
}

async function openRepo(db: ForkDb, channelId: string, rel: string, password: string): Promise<RepoHandle> {
    const target = await channelTarget(db, channelId);
    const dir = await mkdtemp(path.join(tmpdir(), "fork-restic-"));
    try {
        const {remotePath} = await import("@/lib/restic/repo");
        const {maxConnections} = await import("@/features/channel/components/storages/rclone/config");
        const conf = path.join(dir, "rclone.conf");
        await writeFile(conf, target.rclone.configText, {mode: 0o600});
        const conns = maxConnections(target.rclone.configText);
        const run = createResticRunner({
            repository: `rclone:${remotePath(target.rclone, rel)}`, password,
            env: {RCLONE_CONFIG: conf, RESTIC_CACHE_DIR: path.join(tmpdir(), "portabase-restic-cache")},
            extraArgs: conns ? ["-o", `rclone.connections=${conns}`] : [],
        });
        return {run, cleanup: async () => { await rm(dir, {recursive: true, force: true}); target.cleanup(); }};
    } catch (e) {
        await rm(dir, {recursive: true, force: true});
        target.cleanup();
        throw e;
    }
}

export async function openManifestRepo(db: ForkDb, channelId: string, stackId: string, masterKey: Buffer): Promise<RepoHandle> {
    const {getBackupFolderName} = await import("@/utils/file-prefix");
    return openRepo(db, channelId, manifestRepoRel(getBackupFolderName(), stackId), manifestRepoPassword(masterKey, stackId));
}

/** Upstream artifact repo (restic engine members): used READ-ONLY by the verify job (`cat`/`ls`). */
export async function openArtifactRepo(db: ForkDb, channelId: string, generatedId: string, masterKey: Buffer): Promise<RepoHandle> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(generatedId)) throw new Error("bad_generated_id");
    const {getBackupFolderName} = await import("@/utils/file-prefix");
    const {resticPassword} = await import("@/lib/restic/repo");
    const folder = getBackupFolderName().trim().replace(/^\/+|\/+$/g, "") || "backups";
    return openRepo(db, channelId, `${folder}/restic/${generatedId}`, resticPassword(masterKey, generatedId));
}
