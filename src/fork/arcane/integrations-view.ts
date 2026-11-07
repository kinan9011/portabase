import {and, asc, eq, sql} from "drizzle-orm";
import {z} from "zod";
import {agent} from "@/db/schema/08_agent";
import {DASHBOARD_THRESHOLDS, getAgentStatus, type AgentStatus} from "@/features/agents/utils/status/agent-status";
import {ENVIRONMENT_PUBLIC_COLUMNS, EnvironmentDtoSchema, toEnvironmentDto} from "@/fork/arcane/environment-dto";
import {CONNECTION_PUBLIC_COLUMNS, toConnectionDto} from "@/fork/db/dto";
import {isSyncRunning, stackCountsByEnvironment} from "@/fork/discovery/sync-state";
import {HEALTH_STATUSES} from "@/fork/db/enums";
import type {ForkDb} from "@/fork/db/handle";
import {forkArcaneConnection, forkArcaneEnvironment} from "@/fork/db/schema/arcane";

/**
 * Read model of the Integrations page (W06). ONE strict, JSON-serialisable object that crosses from the server component to
 * the client: dates are ISO strings, and every field is allowlisted. There is no place for the Arcane key in it — the
 * `ConnectionDto` allowlist excludes the encrypted-key column, the schema below is `strictObject`, and `w06-integrations-view` asserts a
 * canary key is absent from the serialised result (and the rendered page). Only the caller's authorisation (system admin)
 * decides whether this is loaded at all: callers must check `arcane.manage` first.
 */
export const IntegrationsViewSchema = z.strictObject({
    connection: z.strictObject({
        id: z.uuid(), name: z.string(), baseUrl: z.string(), healthStatus: z.enum(HEALTH_STATUSES), lastErrorClass: z.string().nullable(),
        tlsInsecure: z.boolean(), allowProjectsRead: z.boolean(), pinnedApiVersion: z.string().nullable(), keyStored: z.literal(true),
        lastCheckedAt: z.string().nullable(), updatedAt: z.string(),
        /** W07: a sync holds the lease right now (cron, another tab, another replica). */
        syncing: z.boolean(), lastSyncAttemptAt: z.string().nullable(), syncFailureStreak: z.number().int().min(0), circuitOpenUntil: z.string().nullable(),
    }).nullable(),
    /** Connections beyond the first (nothing creates them in the UI; shown so none is hidden). */
    additionalConnections: z.number().int().min(0),
    environments: z.array(EnvironmentDtoSchema.omit({lastSyncAt: true}).extend({
        lastSyncAt: z.string().nullable(), agentStatus: z.enum(["online", "degraded", "offline"]).nullable(),
        /** W07: stacks in the fork DB for this environment (found = not absent, stale = data older than the last failed sync, protected = active policy). */
        stacks: z.strictObject({found: z.number().int().min(0), stale: z.number().int().min(0), protectedCount: z.number().int().min(0)}),
    })),
    agents: z.array(z.strictObject({id: z.uuid(), name: z.string(), status: z.enum(["online", "degraded", "offline"])})),
});
export type IntegrationsView = z.infer<typeof IntegrationsViewSchema>;
export type IntegrationsEnvironment = IntegrationsView["environments"][number];
export type IntegrationsConnection = NonNullable<IntegrationsView["connection"]>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const status = (lastContact: Date | null): AgentStatus => getAgentStatus(lastContact, DASHBOARD_THRESHOLDS);

export async function loadIntegrationsView(db: ForkDb, organizationId: string, now: Date = new Date()): Promise<IntegrationsView> {
    const conns = await db.select(CONNECTION_PUBLIC_COLUMNS).from(forkArcaneConnection)
        .where(eq(forkArcaneConnection.organizationId, organizationId)).orderBy(asc(forkArcaneConnection.createdAt), asc(forkArcaneConnection.id));
    const first = conns[0] ? toConnectionDto(conns[0]) : null;

    const envs = first
        ? await db.select({...ENVIRONMENT_PUBLIC_COLUMNS, lastContact: agent.lastContact}).from(forkArcaneEnvironment)
            .leftJoin(agent, eq(agent.id, forkArcaneEnvironment.agentId))
            .where(eq(forkArcaneEnvironment.connectionId, first.id)).orderBy(asc(forkArcaneEnvironment.name), asc(forkArcaneEnvironment.externalId))
        : [];

    const counts = await stackCountsByEnvironment(db, organizationId);
    const syncing = first ? await isSyncRunning(db, first.id, now) : false;

    // Candidate agents = D21 self-check rule: unbound or bound to this organization only; live rows only.
    const agents = await db.select({id: agent.id, name: agent.name, lastContact: agent.lastContact}).from(agent)
        .where(and(
            sql`${agent.deletedAt} is null and coalesce(${agent.isArchived}, false) = false`,
            sql`(${agent.organizationId} is null or ${agent.organizationId} = ${organizationId})`,
            sql`not exists (select 1 from organization_agents oa where oa.agent_id = ${agent.id} and oa.organization_id <> ${organizationId})`,
        )).orderBy(asc(agent.name), asc(agent.id));

    return IntegrationsViewSchema.parse({
        connection: first && {
            id: first.id, name: first.name, baseUrl: first.baseUrl, healthStatus: first.healthStatus, lastErrorClass: first.lastErrorClass,
            tlsInsecure: first.tlsInsecure, allowProjectsRead: first.allowProjectsRead, pinnedApiVersion: first.pinnedApiVersion, keyStored: true,
            lastCheckedAt: iso(first.lastCheckedAt), updatedAt: first.updatedAt.toISOString(),
            syncing, lastSyncAttemptAt: iso(first.lastSyncAttemptAt), syncFailureStreak: first.syncFailureStreak, circuitOpenUntil: iso(first.circuitOpenUntil),
        },
        additionalConnections: Math.max(0, conns.length - 1),
        environments: envs.map(({lastContact, ...row}) => {
            const e = toEnvironmentDto(row);
            return {...e, lastSyncAt: iso(e.lastSyncAt), agentStatus: e.agentId ? status(lastContact) : null, stacks: counts.get(e.id) ?? {found: 0, stale: 0, protectedCount: 0}};
        }),
        agents: agents.map((a) => ({id: a.id, name: a.name, status: status(a.lastContact)})),
    });
}
