import {and, eq, inArray, isNull, sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {agent} from "@/db/schema/08_agent";
import {setting} from "@/db/schema/01_setting";
import {database} from "@/db/schema/07_database";
import type {ForkPrincipal} from "@/fork/acl";

export {isAgentVersionAtLeast} from "@/utils/status-crypto";

/**
 * CONTROLLED COPY (D31) of the upstream agent ACL (`database-acl.ts#assertCanManageAgentDatabases`, :75-100) as a PURE decision plus
 * the reads the materializer needs (agent row, Docker-source evidence, channel availability, `setting.encryption`). Session-free.
 *
 * Upstream rule: agent with no organization ⇒ system admin; otherwise the agent belongs to the ACTIVE organization and the actor is a
 * member with `canManageAgents` (owner | admin). The fork adds its own capability (`stacks.backup.manage`, system admin) in the service.
 */
export type AgentRow = {id: string; name: string; version: string | null; organizationId: string | null; lastContact: Date | null; archived: boolean; deleted: boolean; foreignOrg: boolean};

export async function readAgent(db: ForkDb, agentId: string): Promise<AgentRow | null> {
    const [a] = await db.select({id: agent.id, name: agent.name, version: agent.version, organizationId: agent.organizationId, lastContact: agent.lastContact, archived: agent.isArchived, deleted: agent.deletedAt}).from(agent).where(eq(agent.id, agentId));
    if (!a) return null;
    const other = await db.execute(sql`select 1 from organization_agents oa where oa.agent_id = ${agentId} and oa.organization_id is distinct from ${a.organizationId} limit 1`);
    return {id: a.id, name: a.name, version: a.version, organizationId: a.organizationId, lastContact: a.lastContact, archived: a.archived === true, deleted: a.deleted !== null, foreignOrg: other.rows.length > 0};
}

/** The upstream-equivalent decision. `orgId` = the stack's organization (single tenant, never assumed from the session). */
export function agentAclAllows(p: ForkPrincipal | null | undefined, a: Pick<AgentRow, "organizationId" | "foreignOrg">, orgId: string): boolean {
    if (!p) return false;
    const isAdmin = p.systemRole === "admin" || p.systemRole === "superadmin";
    if (a.foreignOrg) return false;
    if (a.organizationId === null) return isAdmin;
    if (a.organizationId !== orgId) return false;
    const role = p.memberships.find((m) => m.organizationId === orgId)?.role;
    return role === "owner" || role === "admin";
}

export async function encryptionEnabled(db: ForkDb): Promise<boolean> {
    const [s] = await db.select({e: setting.encryption}).from(setting).limit(1);
    return s?.e === true;
}

/** Channels the organization may use (same availability the project page offers): enabled, org-owned or shared with it. */
export async function channelsAvailableTo(db: ForkDb, organizationId: string, ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const r = await db.execute(sql`
        select count(*)::int as n from storage_channel c
         where c.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) and c.deleted_at is null and c.enabled
           and (c.organization_id = ${organizationId} or c.organization_id is null
                or exists (select 1 from organization_storage_channels os where os.storage_channel_id = c.id and os.organization_id = ${organizationId}))`);
    return Number((r.rows[0] as {n: number}).n) === new Set(ids).size;
}

/**
 * Evidence that this agent can use Docker (CH-22c, no agent-side probe exists in R1): a live docker-volume source of the SAME agent that
 * the agent has reported contact for (`last_contact` is set only when the ping succeeded) newer than its creation AND recent (the agent is
 * reporting NOW: a stale contact proves nothing about today's socket), excluding `exceptIds` (the sources we are about to create/judge).
 */
export const DOCKER_EVIDENCE_MAX_AGE_MS = 5 * 60_000;
export async function dockerAccessEvidence(db: ForkDb, agentId: string, exceptIds: readonly string[] = [], now: Date = new Date()): Promise<boolean> {
    const rows = await db.select({id: database.id, created: database.createdAt, last: database.lastContact}).from(database)
        .where(and(eq(database.agentId, agentId), eq(database.dbms, "docker-volume"), isNull(database.deletedAt)));
    return rows.some((r) => !exceptIds.includes(r.id) && r.last !== null && r.last.getTime() > r.created.getTime() && now.getTime() - r.last.getTime() <= DOCKER_EVIDENCE_MAX_AGE_MS);
}

export async function agentsLastContact(db: ForkDb, ids: readonly string[]): Promise<Map<string, {lastContact: Date | null; version: string | null; name: string}>> {
    if (ids.length === 0) return new Map();
    const rows = await db.select({id: agent.id, lastContact: agent.lastContact, version: agent.version, name: agent.name}).from(agent).where(inArray(agent.id, [...ids]));
    return new Map(rows.map((r) => [r.id, {lastContact: r.lastContact, version: r.version, name: r.name}]));
}

/** W21: how many (non-deleted) upstream databases are assigned to this agent. A designated mirror runner must own none (ADR-008 DD-2), so the stock loop never pushes it storage credentials. */
export async function countDatabasesOfAgent(db: ForkDb, agentId: string): Promise<number> {
    const [r] = await db.select({n: sql<number>`count(*)::int`}).from(database).where(and(eq(database.agentId, agentId), isNull(database.deletedAt)));
    return Number(r?.n ?? 0);
}
