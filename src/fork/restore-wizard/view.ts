import {inArray, sql} from "drizzle-orm";
import {z} from "zod";
import {DASHBOARD_THRESHOLDS} from "@/features/agents/utils/status/agent-status";
import {agentAclAllows} from "@/fork/upstream/agents";
import type {ForkPrincipal} from "@/fork/acl";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import type {ForkDb} from "@/fork/db/handle";
import {RP_STATUSES} from "@/fork/recovery/status";
import {loadProtectionByStackId} from "@/fork/stacks/protection-load";

/**
 * Read models of the restore wizard (W18b, B1 + B2). Strict DTOs parsed before return; every query is org-scoped IN SQL; `now` is a parameter.
 * B1 reads ONLY `{agentId, enabled, revokedAt, capabilities}` of an enrolment: no credential hash, key envelope, pin or enrolment generation.
 */

export const HostRoleSource = z.enum(["environment", "default"]);
export const TargetReadiness = z.enum(["ready", "archived", "revoked", "not_enrolled", "channel_disabled", "capability_missing"]);
export type TargetReadiness = z.infer<typeof TargetReadiness>;
export const HostRole = z.enum(["production", "test"]);

export const RestoreTarget = z.strictObject({
    id: z.uuid(), name: z.string(), status: z.enum(["online", "degraded", "offline"]),
    readiness: TargetReadiness, canCompose: z.boolean(), // compose.render.v1 present ("Start the app" needs it)
    hostRole: HostRole, hostRoleSource: HostRoleSource,
    environments: z.array(z.strictObject({name: z.string(), hostRole: HostRole, allowedPathRoots: z.array(z.string())})),
    wasSource: z.boolean(), lastRestoreRoot: z.string().nullable(),
});
export type RestoreTarget = z.infer<typeof RestoreTarget>;

/** Mirrors the planner (`restore/plan.ts`): no environment ⇒ production (by default), any production environment ⇒ production, else test. */
export function targetRole(envs: readonly {hostRole: string}[]): {hostRole: "production" | "test"; hostRoleSource: "environment" | "default"} {
    return {
        hostRole: envs.length === 0 || envs.some((e) => e.hostRole === "production") ? "production" : "test",
        hostRoleSource: envs.length === 0 ? "default" : "environment",
    };
}

/** archived > revoked > not_enrolled > channel_disabled > capability_missing (restore.target.v1) > ready — the planner's order. */
export function targetReadiness(a: {archived: boolean}, e: {enabled: boolean; revokedAt: Date | null; capabilities: readonly string[]} | null): TargetReadiness {
    if (a.archived) return "archived";
    if (!e) return "not_enrolled";
    if (e.revokedAt !== null) return "revoked";
    if (!e.enabled) return "channel_disabled";
    return e.capabilities.includes("restore.target.v1") ? "ready" : "capability_missing";
}

/** Same comparison as upstream `getAgentStatus`, with an injected clock (that one reads `Date.now()`). */
export function statusAt(lastContact: Date | null, now: Date): "online" | "degraded" | "offline" {
    if (lastContact === null || Number.isNaN(lastContact.getTime())) return "offline";
    const elapsed = now.getTime() - lastContact.getTime();
    if (elapsed < DASHBOARD_THRESHOLDS.online) return "online";
    if (elapsed <= DASHBOARD_THRESHOLDS.degraded) return "degraded";
    return "offline";
}

type AgentRow = {id: string; name: string; organization_id: string | null; last_contact: Date | null; is_archived: boolean | null; foreign_org: boolean};

export async function loadRestoreTargets(db: ForkDb, principal: ForkPrincipal | null, organizationId: string, o: {stackId?: string | null; now: Date}): Promise<RestoreTarget[]> {
    if (!principal) return [];
    // ponytail: one row per upstream agent, ACL per row; fine for the tens of agents of a single-operator install (D21).
    const rows = (await db.execute(sql`
        select a.id, a.name, a.organization_id, a.last_contact, a.is_archived,
               exists (select 1 from organization_agents oa where oa.agent_id = a.id and oa.organization_id is distinct from a.organization_id) as foreign_org
          from agents a where a.deleted_at is null order by a.name, a.id`)).rows as AgentRow[];
    const allowed = rows.filter((r) => agentAclAllows(principal, {organizationId: r.organization_id, foreignOrg: r.foreign_org}, organizationId));
    if (allowed.length === 0) return [];
    const ids = allowed.map((r) => r.id);

    const enrols = await db.select({agentId: forkAgentEnrollment.agentId, enabled: forkAgentEnrollment.enabled, revokedAt: forkAgentEnrollment.revokedAt, capabilities: forkAgentEnrollment.capabilities})
        .from(forkAgentEnrollment).where(inArray(forkAgentEnrollment.agentId, ids));
    const enrolOf = new Map(enrols.map((e) => [e.agentId, e]));
    // same filter as the planner's target block (`restore/load.ts`): every environment mapped to the agent, enabled or not
    const envs = await db.select({agentId: forkArcaneEnvironment.agentId, name: forkArcaneEnvironment.name, hostRole: forkArcaneEnvironment.hostRole, allowedPathRoots: forkArcaneEnvironment.allowedPathRoots})
        .from(forkArcaneEnvironment).where(inArray(forkArcaneEnvironment.agentId, ids));

    let sourceAgent: string | null = null;
    if (o.stackId) {
        const r = await db.execute(sql`select e.agent_id from fork_stack s join fork_arcane_environment e on e.id = s.environment_id where s.id = ${o.stackId} and s.organization_id = ${organizationId}`);
        sourceAgent = (r.rows[0] as {agent_id: string | null} | undefined)?.agent_id ?? null;
    }
    const last = await db.execute(sql`
        select distinct on (target_agent_id) target_agent_id, plan->'target'->>'restore_root' as root
          from fork_restore_plan where organization_id = ${organizationId} and plan->'target'->>'restore_root' is not null and target_agent_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
         order by target_agent_id, created_at desc, id`);
    const rootOf = new Map((last.rows as {target_agent_id: string; root: string | null}[]).map((r) => [r.target_agent_id, r.root]));

    return allowed.map((a) => {
        const mine = envs.filter((e) => e.agentId === a.id).map((e) => ({name: e.name, hostRole: HostRole.catch("production").parse(e.hostRole), allowedPathRoots: e.allowedPathRoots}));
        const enr = enrolOf.get(a.id) ?? null;
        return RestoreTarget.parse({
            id: a.id, name: a.name, status: statusAt(a.last_contact ? new Date(a.last_contact) : null, o.now),
            readiness: targetReadiness({archived: a.is_archived === true}, enr),
            canCompose: enr?.capabilities.includes("compose.render.v1") ?? false,
            ...targetRole(mine), environments: mine,
            wasSource: sourceAgent === a.id, lastRestoreRoot: rootOf.get(a.id) ?? null,
        });
    });
}

// ---- B2: choices + points --------------------------------------------------------------------------------------------------------

export const RestoreChoice = z.strictObject({
    stackId: z.uuid(), name: z.string(), environmentName: z.string(), runtime: z.string(),
    lastGood: z.strictObject({hoursAgo: z.number().nullable(), verifying: z.boolean()}), testRestoreDaysAgo: z.number().nullable(), testRestoreStale: z.boolean().optional(),
    verifiedCount: z.number().int(), pendingCount: z.number().int(),
});
export type RestoreChoice = z.infer<typeof RestoreChoice>;

/** All stacks of the organization with their recovery-point counts; the UI splits restorable (verifiedCount > 0) from the rest. */
export async function loadRestoreChoices(db: ForkDb, organizationId: string, o: {now: Date; configLocked: boolean}): Promise<RestoreChoice[]> {
    const rows = (await db.execute(sql`
        select s.id, s.display_name, s.environment_name, s.runtime_state,
               count(p.id) filter (where p.status = 'verified')::int as verified,
               count(p.id) filter (where p.status = 'pending_verification')::int as pending
          from fork_stack s left join fork_recovery_point p on p.stack_id = s.id and p.purged_at is null
         where s.organization_id = ${organizationId}
         group by s.id order by s.display_name, s.id`)).rows as {id: string; display_name: string; environment_name: string; runtime_state: string; verified: number; pending: number}[];
    const out: RestoreChoice[] = [];
    for (const r of rows) {
        // ponytail: N per-stack protection loads; batch when an org has > 50 stacks.
        const prot = await loadProtectionByStackId(db, r.id, {configLocked: o.configLocked, now: o.now});
        out.push(RestoreChoice.parse({
            stackId: r.id, name: r.display_name, environmentName: r.environment_name, runtime: r.runtime_state,
            lastGood: prot ? {hoursAgo: prot.facets.lastGoodBackup.hoursAgo, verifying: prot.facets.lastGoodBackup.verifying} : {hoursAgo: null, verifying: Number(r.pending) > 0},
            testRestoreDaysAgo: prot ? prot.facets.testRestore.daysAgo : null, testRestoreStale: prot ? prot.facets.testRestore.stale : false,
            verifiedCount: Number(r.verified), pendingCount: Number(r.pending),
        }));
    }
    return out;
}

export const RestorePoint = z.strictObject({
    id: z.uuid(), sequence: z.number().int(), createdAt: z.string(), verifiedAt: z.string().nullable(),
    status: z.enum(RP_STATUSES), reason: z.string().nullable(), consistency: z.string(), sizeBytes: z.number().nullable(), destinations: z.array(z.string()),
});
export type RestorePoint = z.infer<typeof RestorePoint>;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
export const RESTORE_POINTS_LIMIT = 50;

/** Same SQL as the Backups tab (`backups-view.ts`) plus the RP id; `null` = no such stack in this organization. */
export async function loadRestorePoints(db: ForkDb, organizationId: string, stackId: string): Promise<{stackName: string; timezone: string; points: RestorePoint[]} | null> {
    const own = await db.execute(sql`select s.display_name, p.schedule->>'timezone' as tz from fork_stack s left join fork_stack_policy p on p.stack_id = s.id where s.id = ${stackId} and s.organization_id = ${organizationId}`);
    if (own.rows.length === 0) return null;
    const {display_name, tz} = own.rows[0] as {display_name: string; tz: string | null};
    const rows = (await db.execute(sql`
        select p.id, p.sequence, p.created_at, p.status, p.downgrade_reason, p.consistency_level, p.total_size_bytes, p.verified_at
          from fork_recovery_point p
         where p.stack_id = ${stackId} and p.purged_at is null order by p.sequence desc limit ${RESTORE_POINTS_LIMIT}`)).rows as
        {id: string; sequence: string | number; created_at: Date; status: string; downgrade_reason: string | null; consistency_level: string; total_size_bytes: string | number | null; verified_at: Date | null}[];
    const arts = rows.length === 0 ? [] : (await db.execute(sql`
        select a.rp_id, a.channel_id, c.name as channel_name from fork_recovery_point_artifact a left join storage_channel c on c.id = a.channel_id
         where a.rp_id in (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)})`)).rows as {rp_id: string; channel_id: string | null; channel_name: string | null}[];
    return {
        stackName: display_name, timezone: tz ?? "UTC",
        points: rows.map((r) => RestorePoint.parse({
            id: r.id, sequence: Number(r.sequence), createdAt: iso(r.created_at), verifiedAt: iso(r.verified_at), status: r.status, reason: r.downgrade_reason, consistency: r.consistency_level,
            sizeBytes: r.total_size_bytes === null ? null : Number(r.total_size_bytes),
            destinations: [...new Set(arts.filter((a) => a.rp_id === r.id && a.channel_id).map((a) => a.channel_name ?? "Removed storage channel"))],
        })),
    };
}

/** DD-W18b-14: the run page needs the app name only. */
export async function loadStackName(db: ForkDb, organizationId: string, stackId: string): Promise<string | null> {
    const r = await db.execute(sql`select display_name from fork_stack where id = ${stackId} and organization_id = ${organizationId}`);
    return (r.rows[0] as {display_name: string} | undefined)?.display_name ?? null;
}
