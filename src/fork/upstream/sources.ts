import {and, count, eq, inArray, isNull} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {alertPolicy} from "@/db/schema/10_alert-policy";
import {backup, database, retentionPolicy} from "@/db/schema/07_database";
import {storagePolicy} from "@/db/schema/13_storage-policy";
import {stripSecrets, withEncryptedSecrets} from "./credentials";

/**
 * CONTROLLED COPY (D31) of the upstream source lifecycle, session-free: `upsertDatabaseConfigAction` (create / update of a source row)
 * and the row part of `deleteDatabaseService`. Everything here assumes the CALLER already authorised the actor (fork capability AND the
 * agent ACL in `./agent.ts`); this module never reads a session and is never called from a `userAction`.
 *
 * What a member source looks like (wave file, D30/D33): `backup_policy` NULL, no retention row, `project_id` = the stack-owned Project,
 * `config` without `options.method` (the method lives in `backup_engine`), `container_name` never present (D29).
 */
export type MemberRow = {
    id: string; agentId: string | null; projectId: string | null; name: string; dbms: string; backupEngine: string;
    config: Record<string, unknown> | null; backupPolicy: string | null; deletedAt: Date | null; lastContact: Date | null; agentDatabaseId: string | null;
};

export type CreateMember = {
    agentId: string; projectId: string; name: string; dbms: string; engine: "archive" | "restic";
    config: Record<string, unknown>; secrets: Readonly<Record<string, string>>; masterKey?: Buffer;
};

export async function createMemberSource(db: ForkDb, i: CreateMember): Promise<{id: string; agentDatabaseId: string | null}> {
    const config = withEncryptedSecrets(i.dbms, i.config, i.secrets, null, i.masterKey);
    const [row] = await db.insert(database).values({agentId: i.agentId, projectId: i.projectId, name: i.name, dbms: i.dbms as never, config, backupEngine: i.engine, backupPolicy: null}).returning({id: database.id, agentDatabaseId: database.agentDatabaseId});
    return row;
}

/** Name/config only. dbms and engine are never changed (upstream: "The backup method cannot be changed after creation"). */
export async function updateMemberSource(db: ForkDb, i: {id: string; name: string; config: Record<string, unknown>; secrets: Readonly<Record<string, string>>; masterKey?: Buffer}): Promise<boolean> {
    const [cur] = await db.select({dbms: database.dbms, config: database.config}).from(database).where(and(eq(database.id, i.id), isNull(database.deletedAt)));
    if (!cur) return false;
    const config = withEncryptedSecrets(cur.dbms, i.config, i.secrets, (cur.config as Record<string, unknown> | null) ?? null, i.masterKey);
    await db.update(database).set({name: i.name, config, updatedAt: new Date()}).where(eq(database.id, i.id));
    return true;
}

export async function readMembers(db: ForkDb, ids: readonly string[]): Promise<Map<string, MemberRow>> {
    if (ids.length === 0) return new Map();
    const rows = await db.select({
        id: database.id, agentId: database.agentId, projectId: database.projectId, name: database.name, dbms: database.dbms, backupEngine: database.backupEngine,
        config: database.config, backupPolicy: database.backupPolicy, deletedAt: database.deletedAt, lastContact: database.lastContact, agentDatabaseId: database.agentDatabaseId,
    }).from(database).where(inArray(database.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r as MemberRow]));
}

/** The non-secret part of a stored config (what drift compares against the plan). */
export const nonSecretConfig = (m: Pick<MemberRow, "dbms" | "config">) => stripSecrets(m.dbms, m.config);

/** Members that carry their OWN storage policy (a channel edit made outside the stack's configuration). */
export async function membersWithStoragePolicy(db: ForkDb, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db.selectDistinct({id: storagePolicy.databaseId}).from(storagePolicy).where(inArray(storagePolicy.databaseId, [...ids]));
    return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
}

export async function backupCount(db: ForkDb, databaseId: string): Promise<number> {
    const [r] = await db.select({n: count()}).from(backup).where(eq(backup.databaseId, databaseId));
    return Number(r?.n ?? 0);
}

/**
 * Row part of `deleteDatabaseService` (policies removed, agent/project detached, soft-deleted). It does NOT purge backups: the caller
 * only invokes it for a source with zero backups (`backupCount === 0`); deleting a backed-up source needs the RP lifecycle (W12/W14).
 */
export async function removeMemberSource(db: ForkDb, id: string): Promise<boolean> {
    await db.delete(retentionPolicy).where(eq(retentionPolicy.databaseId, id));
    await db.delete(alertPolicy).where(eq(alertPolicy.databaseId, id));
    await db.delete(storagePolicy).where(eq(storagePolicy.databaseId, id));
    const [row] = await db.update(database).set({agentId: null, projectId: null, backupPolicy: null, deletedAt: new Date(), updatedAt: new Date()}).where(and(eq(database.id, id), isNull(database.deletedAt))).returning({id: database.id});
    return row !== undefined;
}
