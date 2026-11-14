import {sql} from "drizzle-orm";
import {z} from "zod";
import type {ForkPrincipal} from "@/fork/acl";
import type {ForkDb} from "@/fork/db/handle";
import {classifyEnvKey} from "@/fork/compose-compiler/rules";
import {parseInventoryStrict} from "@/fork/inventory/schema";
import {RP_STATUSES} from "@/fork/recovery/status";
import {statusAt} from "@/fork/restore-wizard/view";
import {adminTargetCount, assertRunnerTarget, runnerIsolation} from "@/fork/runner/service";
import {agentAclAllows} from "@/fork/upstream/agents";
import {ACTIVE_REVISION_STATES, PORT_RANGE, RUNNER_PRECHECK_MAX_AGE_MS} from "./vocab";

/**
 * Read models of the Create-mirror wizard (W22b, plan §4 Step 2). Strict DTOs parsed before return; every query is org-scoped IN SQL (or ACL-filtered per agent row);
 * `now` / `serverUrl` are parameters. No env VALUE, path, host, IP, URL, key material or enrolment hash is ever read into a DTO: env KEY NAMES (from the pinned inventory) only.
 */
export const MirrorRunnerChoice = z.strictObject({
    id: z.uuid(), name: z.string(), status: z.enum(["online", "degraded", "offline"]),
    eligible: z.boolean(), ineligible: z.enum(["not_a_runner", "not_enrolled", "agent_disabled", "not_attested", "agent_mapped_to_environment", "agent_has_databases"]).nullable(),
    isolation: z.enum(["isolated", "not_isolated", "unknown"]), isolationUnknown: z.string().nullable(), probedAt: z.string().nullable(), reachableCount: z.number().int(),
    targetCount: z.number().int(), probePending: z.boolean(), busy: z.boolean(), mirrorsHeld: z.number().int(), freePorts: z.number().int(),
});
export type MirrorRunnerChoice = z.infer<typeof MirrorRunnerChoice>;

type AgentRow = {id: string; name: string; organization_id: string | null; last_contact: Date | null; foreign_org: boolean};

/** Designated runner agents the principal may see (ACL per row, like the restore targets). ponytail: per-row queries, tens of runners (D21 single operator). */
async function visibleRunnerAgents(db: ForkDb, principal: ForkPrincipal | null, organizationId: string): Promise<AgentRow[]> {
    if (!principal) return [];
    const rows = (await db.execute(sql`
        select a.id, a.name, a.organization_id, a.last_contact,
               exists (select 1 from organization_agents oa where oa.agent_id = a.id and oa.organization_id is distinct from a.organization_id) as foreign_org
          from fork_runner r join agents a on a.id = r.agent_id where a.deleted_at is null order by a.name, a.id`)).rows as AgentRow[];
    return rows.filter((r) => agentAclAllows(principal, {organizationId: r.organization_id, foreignOrg: r.foreign_org}, organizationId));
}

export async function loadMirrorRunners(db: ForkDb, principal: ForkPrincipal | null, organizationId: string, o: {now: Date; serverUrl: string}): Promise<MirrorRunnerChoice[]> {
    const out: MirrorRunnerChoice[] = [];
    const active = sql.join(ACTIVE_REVISION_STATES.map((s) => sql`${s}`), sql`, `);
    for (const a of await visibleRunnerAgents(db, principal, organizationId)) {
        const el = await assertRunnerTarget(db, a.id);
        const iso = await runnerIsolation(db, a.id, {now: o.now, maxAgeMs: RUNNER_PRECHECK_MAX_AGE_MS, serverUrl: o.serverUrl});
        const counts = (await db.execute(sql`
            select count(*) filter (where state in (${active}))::int as active,
                   count(*) filter (where coalesce(wipe_state, '') not in ('verified', 'not_needed'))::int as held
              from fork_mirror_revision where runner_agent_id = ${a.id}`)).rows[0] as {active: number; held: number};
        const probe = (await db.execute(sql`
            select r.last_probe_requested_at, t.status from fork_runner r left join fork_agent_task t on t.id = r.last_probe_task_id where r.agent_id = ${a.id}`)).rows[0] as {last_probe_requested_at: Date | null; status: string | null} | undefined;
        const held = Number(counts.held);
        out.push(MirrorRunnerChoice.parse({
            id: a.id, name: a.name, status: statusAt(a.last_contact ? new Date(a.last_contact) : null, o.now),
            eligible: el.ok, ineligible: el.ok ? null : el.code,
            isolation: iso.state, isolationUnknown: iso.state === "unknown" ? iso.reason : null,
            probedAt: iso.state === "isolated" ? iso.probedAt.toISOString() : iso.state === "not_isolated" && iso.probedAt ? iso.probedAt.toISOString() : null,
            reachableCount: iso.state === "not_isolated" ? iso.reachable.length : 0,
            targetCount: await adminTargetCount(db, a.id),
            probePending: !!probe?.last_probe_requested_at && ["queued", "leased", "running"].includes(probe.status ?? ""),
            busy: Number(counts.active) > 0, mirrorsHeld: held, freePorts: Math.max(0, PORT_RANGE.max - PORT_RANGE.min + 1 - held),
        }));
    }
    return out;
}

const SourceService = z.strictObject({
    name: z.string(),
    ports: z.array(z.strictObject({target: z.number().int(), protocol: z.enum(["tcp", "udp"]), published: z.boolean()})),
    database: z.string().nullable(),
    env: z.array(z.strictObject({key: z.string(), recommended: z.enum(["rotate", "disable", "keep"])})),
});
export const MirrorSourceFacts = z.strictObject({
    inventoryVersion: z.number().int().nullable(),
    services: z.array(SourceService),
    privacy: z.strictObject({containsPersonalData: z.boolean().nullable(), optIn: z.boolean()}),
});
export type MirrorSourceFacts = z.infer<typeof MirrorSourceFacts>;

/** Services, ports and env KEY NAMES of the recovery point's pinned inventory (plus the stack's privacy facts); `null` = the RP is not a recovery point of this stack in this organization. */
export async function loadMirrorSource(db: ForkDb, organizationId: string, stackId: string, rpId: string): Promise<MirrorSourceFacts | null> {
    const rp = (await db.execute(sql`
        select p.inventory_version, s.contains_personal_data, s.mirror_opt_in_at
          from fork_recovery_point p join fork_stack s on s.id = p.stack_id
         where p.id = ${rpId} and p.stack_id = ${stackId} and s.organization_id = ${organizationId}`)).rows[0] as {inventory_version: number | null; contains_personal_data: boolean | null; mirror_opt_in_at: Date | null} | undefined;
    if (!rp) return null;
    let services: z.infer<typeof SourceService>[] = [];
    if (rp.inventory_version !== null) {
        const row = (await db.execute(sql`select inventory from fork_stack_inventory where stack_id = ${stackId} and version = ${rp.inventory_version}`)).rows[0] as {inventory: unknown} | undefined;
        try {
            if (row) {
                services = parseInventoryStrict(row.inventory).services.map((s) => ({
                    name: s.name,
                    ports: s.ports.map((p) => ({target: p.target, protocol: p.protocol, published: p.published !== undefined})),
                    database: s.database_hint?.engine ?? null,
                    env: s.env_keys.map((key) => ({key, recommended: classifyEnvKey(key)})),
                }));
            }
        } catch { services = []; } // the Review preview then shows `inventory_missing`
    }
    return MirrorSourceFacts.parse({inventoryVersion: rp.inventory_version, services, privacy: {containsPersonalData: rp.contains_personal_data, optIn: rp.mirror_opt_in_at !== null}});
}

/** Facts for the entry precedence of the stack page: verified recovery points and ACL-visible, eligible runners. */
export async function loadMirrorEntryFacts(db: ForkDb, principal: ForkPrincipal | null, organizationId: string, stackId: string): Promise<{verifiedCount: number; runnerCount: number}> {
    const v = (await db.execute(sql`
        select count(*)::int as n from fork_recovery_point p join fork_stack s on s.id = p.stack_id
         where p.stack_id = ${stackId} and s.organization_id = ${organizationId} and p.status = ${RP_STATUSES[2]} and p.purged_at is null`)).rows[0] as {n: number};
    let runnerCount = 0;
    for (const a of await visibleRunnerAgents(db, principal, organizationId)) if ((await assertRunnerTarget(db, a.id)).ok) runnerCount++;
    return {verifiedCount: Number(v.n), runnerCount};
}
