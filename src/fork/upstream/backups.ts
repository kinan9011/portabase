import {and, eq, inArray, isNull, sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {backup, database, restoration} from "@/db/schema/07_database";
import {backupStorage} from "@/db/schema/14_storage-backup";

/**
 * CONTROLLED COPY (D31) of the upstream backup lifecycle the stack runs need, session-free. Nothing here reads a session or calls a
 * `userAction`; the CALLER authorised the actor (run-time re-authorization, `runs/reauth.ts`).
 *  - `queueWaitingBackups` = the guards of `bulkBackupAction` (skip a source with a `waiting|ongoing` row, skip `method_conflict`) + one
 *    `backups(status='waiting')` row per source — the exact statement the D14 spike proved starts a NULL-cron source.
 *  - `readBackupFacts` reads upstream statuses by id INCLUDING soft-deleted rows (the upstream cleaning task soft-deletes `failed` backups).
 *  - `deleteBackupViaUpstream` calls the service `deleteBackupCronAction` wraps (`deleteBackupService`): the same code path upstream
 *    retention uses (restic forget / storage object delete, retry semantics included). Imported lazily so loading the fork never
 *    opens the upstream pool.
 */
export type BackupStatus = "waiting" | "ongoing" | "failed" | "success";
export type StorageFacts = {id: string; channelId: string; status: "pending" | "success" | "failed"; path: string | null; size: number | null; engine: string; presence: string; updatedAt: Date | null; deletedAt: Date | null};
export type BackupFacts = {id: string; databaseId: string; status: BackupStatus; deletedAt: Date | null; fileSize: number | null; updatedAt: Date | null; createdAt: Date; storages: StorageFacts[]};

export type QueueSkip = "busy" | "method_conflict" | "gone";
export type QueueResult = {queued: {databaseId: string; backupId: string}[]; skipped: {databaseId: string; reason: QueueSkip}[]};

export async function queueWaitingBackups(db: ForkDb, databaseIds: readonly string[]): Promise<QueueResult> {
    const out: QueueResult = {queued: [], skipped: []};
    if (databaseIds.length === 0) return out;
    return db.transaction(async (tx) => {
        const t = tx as unknown as ForkDb;
        // serialise concurrent triggers of the same sources (a second statement sees the first one's row)
        for (const id of [...databaseIds].sort()) await t.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"backup-queue:" + id}, 0))`);
        const dbs = await t.select({id: database.id, conflict: database.methodConflict, deletedAt: database.deletedAt}).from(database).where(inArray(database.id, [...databaseIds]));
        const byId = new Map(dbs.map((d) => [d.id, d]));
        const active = await t.select({databaseId: backup.databaseId}).from(backup).where(and(inArray(backup.databaseId, [...databaseIds]), inArray(backup.status, ["waiting", "ongoing"]), isNull(backup.deletedAt)));
        const busy = new Set(active.map((a) => a.databaseId));
        const toQueue: string[] = [];
        for (const id of databaseIds) {
            const d = byId.get(id);
            if (!d || d.deletedAt) out.skipped.push({databaseId: id, reason: "gone"});
            else if (busy.has(id)) out.skipped.push({databaseId: id, reason: "busy"});
            else if (d.conflict !== null) out.skipped.push({databaseId: id, reason: "method_conflict"});
            else toQueue.push(id);
        }
        if (toQueue.length > 0) {
            const rows = await t.insert(backup).values(toQueue.map((databaseId) => ({databaseId, status: "waiting" as const}))).returning({id: backup.id, databaseId: backup.databaseId});
            out.queued.push(...rows.map((r) => ({databaseId: r.databaseId, backupId: r.id})));
        }
        return out;
    });
}

export async function readBackupFacts(db: ForkDb, ids: readonly string[]): Promise<Map<string, BackupFacts>> {
    const res = new Map<string, BackupFacts>();
    if (ids.length === 0) return res;
    const rows = await db.select({id: backup.id, databaseId: backup.databaseId, status: backup.status, deletedAt: backup.deletedAt, fileSize: backup.fileSize, updatedAt: backup.updatedAt, createdAt: backup.createdAt}).from(backup).where(inArray(backup.id, [...ids]));
    for (const r of rows) res.set(r.id, {...r, storages: []});
    const st = await db.select({id: backupStorage.id, backupId: backupStorage.backupId, channelId: backupStorage.storageChannelId, status: backupStorage.status, path: backupStorage.path, size: backupStorage.size, engine: backupStorage.engine, presence: backupStorage.presence, updatedAt: backupStorage.updatedAt, deletedAt: backupStorage.deletedAt}).from(backupStorage).where(inArray(backupStorage.backupId, [...ids]));
    for (const s of st) res.get(s.backupId)?.storages.push({id: s.id, channelId: s.channelId, status: s.status, path: s.path, size: s.size, engine: s.engine, presence: s.presence, updatedAt: s.updatedAt, deletedAt: s.deletedAt});
    return res;
}

/** Cancels backups that have NOT been picked up yet (`waiting`); returns the ids it cancelled. Same end state upstream's cleaning gives a failed backup (failed + soft-deleted). An `ongoing` backup cannot be cancelled upstream: the agent runs it to the end. */
export async function cancelWaitingBackups(db: ForkDb, ids: readonly string[], now: Date = new Date()): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await db.update(backup).set({status: "failed", deletedAt: now, updatedAt: now}).where(and(inArray(backup.id, [...ids]), eq(backup.status, "waiting"))).returning({id: backup.id});
    return rows.map((r) => r.id);
}

/** Backup ids (of `ids`) that a restoration in flight still reads: never pruned (D33 "in use"). */
export async function backupsInRestoration(db: ForkDb, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db.select({id: restoration.backupId}).from(restoration).where(and(inArray(restoration.backupId, [...ids]), inArray(restoration.status, ["waiting", "ongoing"])));
    return new Set(rows.map((r) => r.id));
}

/** Successful, live backups of the given sources (orphan sweep input). */
export async function liveSuccessfulBackups(db: ForkDb, databaseIds: readonly string[]): Promise<{id: string; databaseId: string; createdAt: Date}[]> {
    if (databaseIds.length === 0) return [];
    return db.select({id: backup.id, databaseId: backup.databaseId, createdAt: backup.createdAt}).from(backup).where(and(inArray(backup.databaseId, [...databaseIds]), eq(backup.status, "success"), isNull(backup.deletedAt)));
}

export type DeleteBackupResult = {ok: boolean; error?: string};
export type DeleteBackup = (backupId: string, databaseId: string) => Promise<DeleteBackupResult>;

/** The upstream retention delete path (storage object / restic forget + soft delete). */
export const deleteBackupViaUpstream: DeleteBackup = async (backupId, databaseId) => {
    const {deleteBackupService} = await import("@/lib/tasks/database/utils/backup-delete.service");
    const r = await deleteBackupService(backupId, databaseId);
    return {ok: r.ok, ...(r.ok ? {} : {error: "delete_failed"})};
};
