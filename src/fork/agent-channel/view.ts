import {desc, eq, isNull, sql} from "drizzle-orm";
import {agent} from "@/db/schema/08_agent";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment, forkAgentTask} from "@/fork/db/schema/agent-channel";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {MAINT_CAPABILITY} from "./vocab";

/**
 * Read model of the admin page (W15b). STRICT DTO: only the columns named below are ever selected — never `credential_hash`, `prev_credential_hash`,
 * `pending_credential_hash`, `task_key_enc`, `envelope_text`, `signature` or `payload_enc` — so nothing secret can reach the RSC payload.
 */
export type AgentChannelTask = {id: string; type: string; status: string; reason: string | null; createdAt: string; finishedAt: string | null};
export type AgentChannelRow = {
    id: string; name: string; enrolled: boolean; enabled: boolean; revoked: boolean; lastSeenAt: string | null; enrolledAt: string | null;
    capabilities: string[]; pinnedKids: string[]; pinFingerprint: string | null;
    rotation: "none" | "pending" | "overlap"; canMaint: boolean; recentTasks: AgentChannelTask[];
};
export type AgentChannelView = {signingKid: string | null; agents: AgentChannelRow[]};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function loadAgentChannelView(db: ForkDb, a: {signingPublicKeyPem: string | null; now?: Date}): Promise<AgentChannelView> {
    const now = a.now ?? new Date();
    const rows = await db.select({
        id: agent.id, name: agent.name,
        eId: forkAgentEnrollment.id, enabled: forkAgentEnrollment.enabled, revokedAt: forkAgentEnrollment.revokedAt, lastSeenAt: forkAgentEnrollment.lastSeenAt, enrolledAt: forkAgentEnrollment.enrolledAt,
        capabilities: forkAgentEnrollment.capabilities, pinnedKids: forkAgentEnrollment.pinnedKids, pinFingerprint: forkAgentEnrollment.pinFingerprint,
        pendingTaskId: forkAgentEnrollment.pendingTaskId, prevValidUntil: forkAgentEnrollment.prevValidUntil,
    }).from(agent).leftJoin(forkAgentEnrollment, eq(forkAgentEnrollment.agentId, agent.id)).where(isNull(agent.deletedAt)).orderBy(agent.name);
    const out: AgentChannelRow[] = [];
    for (const r of rows) {
        const tasks = r.eId
            ? await db.select({id: forkAgentTask.id, type: forkAgentTask.type, status: forkAgentTask.status, result: sql<string | null>`${forkAgentTask.result}->>'reason'`, createdAt: forkAgentTask.createdAt, finishedAt: forkAgentTask.finishedAt})
                .from(forkAgentTask).where(eq(forkAgentTask.agentId, r.id)).orderBy(desc(forkAgentTask.createdAt)).limit(5)
            : [];
        out.push({
            id: r.id, name: r.name, enrolled: !!r.eId, enabled: r.enabled ?? false, revoked: !!r.revokedAt, lastSeenAt: iso(r.lastSeenAt), enrolledAt: iso(r.enrolledAt),
            capabilities: r.capabilities ?? [], pinnedKids: r.pinnedKids ?? [], pinFingerprint: r.pinFingerprint ?? null,
            rotation: r.pendingTaskId ? "pending" : r.prevValidUntil && r.prevValidUntil > now ? "overlap" : "none",
            canMaint: !!r.eId && !r.revokedAt && !!r.enabled && (r.capabilities ?? []).includes(MAINT_CAPABILITY),
            recentTasks: tasks.map((t) => ({id: t.id, type: t.type, status: t.status, reason: t.result, createdAt: t.createdAt.toISOString(), finishedAt: iso(t.finishedAt)})),
        });
    }
    return {signingKid: a.signingPublicKeyPem ? kidOfPublicKey(a.signingPublicKeyPem) : null, agents: out};
}
