import {eq} from "drizzle-orm";
import {agent} from "@/db/schema/08_agent";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {checkRate} from "@/fork/net/rate-limit";
import {matchCredential, parseBearer} from "./credential";
import {RATE} from "./vocab";

export type Enrollment = typeof forkAgentEnrollment.$inferSelect;
export type AuthResult =
    | {ok: true; enrollment: Enrollment; organizationId: string | null; agentName: string}
    | {ok: false; status: 401 | 403 | 429; code: "unauthorized" | "channel_disabled" | "rate_limited"; retryAfterSeconds?: number};

/**
 * Per-request authentication of an agent call (ADR-007 D2). Properties pinned by tests:
 *  - every failure (malformed header, wrong agent id, unknown agent, wrong secret, revoked, orphaned) is the SAME `401 unauthorized`;
 *  - an unknown agent is compared against a dummy hash, so unknown vs wrong credential do the same work;
 *  - the agent VERSION is never read — there is no unsigned or version-gated path (the upstream gap `agent/[agentId]/backup/helpers.ts`);
 *  - rate limits per agent id and per source (the source is a caller-supplied opaque key, never stored).
 * A disabled channel answers 403 `channel_disabled` only AFTER the credential matched (it discloses nothing to a stranger).
 */
export async function authenticateAgent(db: ForkDb, a: {agentId: string; authorization: string | null; source: string; now?: Date; rate?: typeof checkRate}): Promise<AuthResult> {
    const now = a.now ?? new Date();
    const rate = a.rate ?? checkRate;
    const ip = rate(`agent-channel-ip:${a.source}`, RATE.ip.limit, RATE.ip.windowMs, now.getTime());
    if (!ip.ok) return {ok: false, status: 429, code: "rate_limited", retryAfterSeconds: ip.retryAfterSeconds};
    const bearer = parseBearer(a.authorization);
    const fail = (): AuthResult => {
        const f = rate(`agent-channel-fail:${a.source}`, RATE.failedIp.limit, RATE.failedIp.windowMs, now.getTime());
        return f.ok ? {ok: false, status: 401, code: "unauthorized"} : {ok: false, status: 429, code: "rate_limited", retryAfterSeconds: f.retryAfterSeconds};
    };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const pathId = uuid.test(a.agentId) ? a.agentId : null;
    const [row] = pathId
        ? await db.select({e: forkAgentEnrollment, org: agent.organizationId, name: agent.name}).from(forkAgentEnrollment)
            .leftJoin(agent, eq(agent.id, forkAgentEnrollment.agentId)).where(eq(forkAgentEnrollment.agentId, pathId))
        : [];
    // always run the comparison, with the real hashes or with dummies
    const secret = bearer && bearer.agentId === pathId ? bearer.secret : "x".repeat(43);
    const prevOk = row?.e.prevCredentialHash && row.e.prevValidUntil && row.e.prevValidUntil > now ? row.e.prevCredentialHash : null;
    const m = matchCredential(secret, row?.e.credentialHash ?? null, prevOk);
    if (!row || !bearer || bearer.agentId !== pathId || !m || row.e.revokedAt) return fail();
    const per = rate(`agent-channel-agent:${row.e.id}`, RATE.agent.limit, RATE.agent.windowMs, now.getTime());
    if (!per.ok) return {ok: false, status: 429, code: "rate_limited", retryAfterSeconds: per.retryAfterSeconds};
    if (!row.e.enabled) return {ok: false, status: 403, code: "channel_disabled"};
    const patch: Partial<typeof forkAgentEnrollment.$inferInsert> = {lastSeenAt: now};
    // the agent presented the NEW secret: the old one stops working now (D2: "until the agent acks with the new one or 24 h")
    if (m === "current" && row.e.prevCredentialHash) { patch.prevCredentialHash = null; patch.prevValidUntil = null; }
    await db.update(forkAgentEnrollment).set(patch).where(eq(forkAgentEnrollment.id, row.e.id));
    return {ok: true, enrollment: row.e, organizationId: row.org ?? null, agentName: row.name ?? "agent"};
}
