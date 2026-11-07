import {createHash} from "node:crypto";
import {and, eq, inArray, isNotNull, isNull, or, sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {project} from "@/db/schema/06_project";
import {database, retentionPolicy} from "@/db/schema/07_database";
import {storagePolicy} from "@/db/schema/13_storage-policy";

/**
 * CONTROLLED COPY (D31) of the project / policy parts of upstream: `createProjectAction` (insert, slug rule) and the policy
 * resolution `db.backupPolicy ?? db.project?.backupPolicy`, `db.retentionPolicy ?? db.project?.retentionPolicy`
 * (`policy-resolution.ts`). Session-free; authorisation is the caller's (fork capability + agent ACL).
 */
const slugify = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/_/g, "-").replace(/\s+/g, "-").replace(/[^\w-]+/g, "").replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");

export const stackProjectName = (environmentName: string, composeProject: string) => `stack:${environmentName}/${composeProject}`;

/** Upstream slugs come from the name alone, so `stack:a/bc` and `stack:ab/c` would collide (unique): a name hash keeps ours distinct. */
export const stackProjectSlug = (name: string) => `${slugify(name).slice(0, 80)}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;

export async function getProjectName(db: ForkDb, id: string): Promise<{id: string; name: string; organizationId: string} | null> {
    const [r] = await db.select({id: project.id, name: project.name, organizationId: project.organizationId}).from(project).where(and(eq(project.id, id), isNull(project.deletedAt)));
    return r ?? null;
}

/** Creates the stack-owned Project: no cron, no retention, no policy of any kind (D30/D33). `null` when the name is taken by something else. */
export async function createStackProject(db: ForkDb, i: {organizationId: string; name: string}): Promise<{id: string} | null> {
    const [dup] = await db.select({id: project.id}).from(project).where(and(eq(project.name, i.name), isNull(project.deletedAt)));
    if (dup) return null;
    const [row] = await db.insert(project).values({name: i.name, slug: stackProjectSlug(i.name), organizationId: i.organizationId, backupPolicy: null}).returning({id: project.id});
    return row;
}

/** Makes the Project's storage policies exactly `channelIds` (upstream project-level `storage_policy`, what the project page writes). */
export async function setProjectStoragePolicies(db: ForkDb, projectId: string, channelIds: readonly string[]): Promise<{added: number; removed: number}> {
    const cur = await db.select({id: storagePolicy.id, channel: storagePolicy.storageChannelId}).from(storagePolicy).where(eq(storagePolicy.projectId, projectId));
    const want = new Set(channelIds);
    const have = new Set(cur.map((c) => c.channel));
    const drop = cur.filter((c) => !want.has(c.channel)).map((c) => c.id);
    if (drop.length) await db.delete(storagePolicy).where(inArray(storagePolicy.id, drop));
    const add = [...want].filter((c) => !have.has(c));
    if (add.length) await db.insert(storagePolicy).values(add.map((c) => ({storageChannelId: c, projectId, enabled: true})));
    return {added: add.length, removed: drop.length};
}

export async function projectChannelIds(db: ForkDb, projectId: string): Promise<string[]> {
    const rows = await db.select({c: storagePolicy.storageChannelId}).from(storagePolicy).where(and(eq(storagePolicy.projectId, projectId), eq(storagePolicy.enabled, true)));
    return rows.map((r) => r.c).sort();
}

export type EffectiveSeen = {
    memberCrons: {databaseId: string; cron: string}[];
    projectCron: string | null;
    memberRetention: {databaseId: string; type: string}[];
    projectRetention: {type: string} | null;
};

/** What the EFFECTIVE policy currently is for the members + their Project (read only). */
export async function readEffectivePolicy(db: ForkDb, o: {databaseIds: readonly string[]; projectId: string | null}): Promise<EffectiveSeen> {
    const ids = [...o.databaseIds];
    const crons = ids.length ? await db.select({id: database.id, cron: database.backupPolicy}).from(database).where(and(inArray(database.id, ids), isNotNull(database.backupPolicy))) : [];
    const [pc] = o.projectId ? await db.select({cron: project.backupPolicy}).from(project).where(eq(project.id, o.projectId)) : [];
    const ret = ids.length || o.projectId
        ? await db.select({databaseId: retentionPolicy.databaseId, projectId: retentionPolicy.projectId, type: retentionPolicy.type}).from(retentionPolicy)
            .where(or(ids.length ? inArray(retentionPolicy.databaseId, ids) : sql`false`, o.projectId ? eq(retentionPolicy.projectId, o.projectId) : sql`false`))
        : [];
    return {
        memberCrons: crons.map((c) => ({databaseId: c.id, cron: c.cron as string})),
        projectCron: pc?.cron ?? null,
        memberRetention: ret.filter((r) => r.databaseId !== null).map((r) => ({databaseId: r.databaseId as string, type: r.type})),
        projectRetention: ret.find((r) => r.projectId !== null) ? {type: ret.find((r) => r.projectId !== null)?.type as string} : null,
    };
}

/** D30: reverts the EFFECTIVE cron and retention of the members and of the stack Project to nothing. Returns what was found (for the audit). */
export async function revertEffectivePolicy(db: ForkDb, o: {databaseIds: readonly string[]; projectId: string | null}): Promise<EffectiveSeen> {
    const seen = await readEffectivePolicy(db, o);
    const ids = [...o.databaseIds];
    if (seen.memberCrons.length) await db.update(database).set({backupPolicy: null, updatedAt: new Date()}).where(inArray(database.id, seen.memberCrons.map((c) => c.databaseId)));
    if (o.projectId && seen.projectCron !== null) await db.update(project).set({backupPolicy: null, updatedAt: new Date()}).where(eq(project.id, o.projectId));
    if (seen.memberRetention.length && ids.length) await db.delete(retentionPolicy).where(inArray(retentionPolicy.databaseId, ids));
    if (o.projectId && seen.projectRetention) await db.delete(retentionPolicy).where(eq(retentionPolicy.projectId, o.projectId));
    return seen;
}

/** Live members of a project that the fork does NOT know (someone moved a source into the stack Project): informational drift. */
export async function projectMemberIds(db: ForkDb, projectId: string): Promise<string[]> {
    const rows = await db.select({id: database.id}).from(database).where(and(eq(database.projectId, projectId), isNull(database.deletedAt)));
    return rows.map((r) => r.id);
}
