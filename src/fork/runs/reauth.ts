import {sql} from "drizzle-orm";
import {actorIn, forkCan} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {enqueueForkNotification} from "@/fork/notify";
import {agentAclAllows, channelsAvailableTo, readAgent} from "@/fork/upstream";
import {encryptionOf, nowOf, principalOfUser, type RunDeps} from "./deps";
import type {PauseReason} from "./vocab";

/**
 * F7 / D31 — run-time re-authorization. The authorization record written at activation (`fork_stack_policy.activation`) names the
 * user; at EVERY run their CURRENT rights are checked again: fork capability AND the upstream-equivalent agent ACL, plus the two
 * preconditions that can change underneath a schedule (D39 encryption on, channels still usable). No ambient service account.
 * A failure pauses the policy (visible: facet 6, `protection_state='paused'`), audits, and queues one alert; only an authorized
 * re-activation (`activateStackPolicy`) clears the pause.
 */
export type StackFacts = {
    stackId: string; organizationId: string; displayName: string; protectionState: string; environmentId: string | null; connectionId: string | null; agentId: string | null;
    activatedAt: Date | null; deactivatedAt: Date | null; pausedAt: Date | null; activation: {userId?: string} | null; storageChannelIds: string[];
    schedule: unknown; policy: unknown; staleSince: Date | null;
};

export async function loadStackFacts(db: RunDeps["db"], stackId: string): Promise<StackFacts | null> {
    const r = await db.execute(sql`
        select s.id, s.organization_id, s.display_name, s.protection_state, s.environment_id, s.stale_since, e.connection_id, e.agent_id,
               p.activated_at, p.deactivated_at, p.paused_at, p.activation, p.storage_channel_ids, p.schedule, p.policy
          from fork_stack s
          left join fork_arcane_environment e on e.id = s.environment_id
          left join fork_stack_policy p on p.stack_id = s.id
         where s.id = ${stackId}`);
    const x = r.rows[0] as undefined | Record<string, unknown>;
    if (!x) return null;
    return {
        stackId: x.id as string, organizationId: x.organization_id as string, displayName: x.display_name as string, protectionState: x.protection_state as string,
        environmentId: (x.environment_id as string | null) ?? null, connectionId: (x.connection_id as string | null) ?? null, agentId: (x.agent_id as string | null) ?? null,
        activatedAt: x.activated_at ? new Date(x.activated_at as string) : null, deactivatedAt: x.deactivated_at ? new Date(x.deactivated_at as string) : null,
        pausedAt: x.paused_at ? new Date(x.paused_at as string) : null, activation: (x.activation as {userId?: string} | null) ?? null,
        storageChannelIds: (x.storage_channel_ids as string[] | null) ?? [], schedule: x.schedule, policy: x.policy, staleSince: x.stale_since ? new Date(x.stale_since as string) : null,
    };
}

export type ReauthResult =
    | {ok: true; userId: string; facts: StackFacts}
    | {ok: false; kind: "not_active" | "paused"}
    | {ok: false; kind: "denied"; reason: PauseReason};

export const isActivePolicy = (f: StackFacts): boolean => f.activatedAt !== null && f.deactivatedAt === null;

export async function reauthorize(d: RunDeps, facts: StackFacts, capability: "stacks.backup.manage" | "repository.prune"): Promise<ReauthResult> {
    if (!isActivePolicy(facts)) return {ok: false, kind: "not_active"};
    if (facts.pausedAt !== null || facts.protectionState === "paused") return {ok: false, kind: "paused"};
    const userId = facts.activation?.userId;
    if (typeof userId !== "string" || userId.length === 0) return {ok: false, kind: "denied", reason: "user_missing"};
    const who = await principalOfUser(d, userId);
    if (who.kind === "missing") return {ok: false, kind: "denied", reason: "user_missing"};
    if (who.kind === "blocked") return {ok: false, kind: "denied", reason: "user_blocked"};
    if (!forkCan(actorIn(who.principal, facts.organizationId), capability)) return {ok: false, kind: "denied", reason: "capability_lost"};
    const agent = facts.agentId ? await readAgent(d.db, facts.agentId) : null;
    if (!agent || agent.archived || agent.deleted) return {ok: false, kind: "denied", reason: "agent_gone"};
    if (!agentAclAllows(who.principal, agent, facts.organizationId)) return {ok: false, kind: "denied", reason: "agent_acl_lost"};
    if (!(await encryptionOf(d))) return {ok: false, kind: "denied", reason: "encryption_off"};
    if (!(await channelsAvailableTo(d.db, facts.organizationId, facts.storageChannelIds))) return {ok: false, kind: "denied", reason: "channels_unavailable"};
    return {ok: true, userId, facts};
}

/** Pauses the policy (idempotent), audits (system actor) and queues ONE alert per activation. Codes only. */
export async function pausePolicy(d: RunDeps, facts: StackFacts, reason: PauseReason): Promise<void> {
    const now = nowOf(d);
    await d.db.transaction(async (tx) => {
        const t = tx as unknown as RunDeps["db"];
        const upd = await t.execute(sql`update fork_stack_policy set paused_at = ${now}, pause_reason = ${reason}, updated_at = ${now} where stack_id = ${facts.stackId} and paused_at is null returning stack_id`);
        await t.execute(sql`update fork_stack set protection_state = 'paused', updated_at = ${now} where id = ${facts.stackId} and protection_state = 'active'`);
        if (upd.rows.length === 0) return; // already paused: no second audit / alert
        await recordAudit(t, {organizationId: facts.organizationId, actorKind: "system", action: "fork.stack_run.paused", resourceType: "stack", resourceId: facts.stackId, result: "denied", details: {reason}, now});
        await enqueueForkNotification(t, {kind: "run.policy_paused", dedupeKey: `policy_paused:${facts.stackId}:${facts.activatedAt?.toISOString() ?? "none"}`, payload: {state: "paused", reason, stackId: facts.stackId, link: `/dashboard/stacks/${facts.stackId}`}});
    });
}
