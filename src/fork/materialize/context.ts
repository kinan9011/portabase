import {eq, sql} from "drizzle-orm";
import type {CoverageKind, ProbeResult, SourceIssue} from "@/fork/completeness/types";
import type {SourceView} from "@/fork/completeness/view";
import type {ForkDb} from "@/fork/db/handle";
import {forkStackPolicy, forkStackSource} from "@/fork/db/schema/stack";
import {agentsLastContact, encryptionEnabled} from "@/fork/upstream";
import {intervalHours, ScheduleSchema} from "@/fork/schedule/schedule";
import {AGENT_FRESH_MS} from "./drift";

/**
 * What the materializer feeds the W09 completeness model (read-only; the ONLY writer of this state is apply/remove/the drift job):
 *  - `coverage`: keys covered by a LIVE member (active/canary with an upstream row). planned / drifted / orphaned / blocked members cover NOTHING.
 *  - `probes`: the member's persisted probe, trusted only while fresh (10 min): a silent drift job fails closed to "unknown".
 *  - `sourceIssues`: drifted members, channel/inventory drift, agent not mapped, poll failing (once per agent, with the affected stacks),
 *    encryption off while a policy is active (D39).
 */
export const PROBE_TTL_MS = 10 * 60_000;

export type MaterializedContext = {
    coverage: Record<string, CoverageKind>; probes: Record<string, ProbeResult>; sourceIssues: SourceIssue[]; sources: SourceView[];
    /** W11: gaps the operator accepted (UX-20), by item key. */
    acceptedExclusions: string[];
    /** W11: dead-man threshold = 1.5 × the schedule interval (§4.7); null = no activated schedule ⇒ never Stale. */
    staleAfterHours: number | null;
};
export const NO_MATERIALIZATION: MaterializedContext = {coverage: {}, probes: {}, sourceIssues: [], sources: [], acceptedExclusions: [], staleAfterHours: null};

const kindOf = (l: {role: string; origin: string; dbms: string}): CoverageKind => (l.origin === "manual" ? "manual_files" : l.role === "db" ? "engine_dump" : "files");
const rank: Record<CoverageKind, number> = {manual_files: 0, files: 1, engine_dump: 2};

export async function loadMaterializedContext(db: ForkDb, stack: {id: string; environmentId: string | null}, now: Date = new Date()): Promise<MaterializedContext> {
    const links = await db.select().from(forkStackSource).where(eq(forkStackSource.stackId, stack.id));
    const [policy] = await db.select().from(forkStackPolicy).where(eq(forkStackPolicy.stackId, stack.id));
    if (links.length === 0 && !policy) return NO_MATERIALIZATION;

    const coverage: Record<string, CoverageKind> = {};
    const probes: Record<string, ProbeResult> = {};
    const issues: SourceIssue[] = [];
    const sources: SourceView[] = [];
    const docker = (l: (typeof links)[number]) => l.dbms === "docker-volume";
    for (const l of links) {
        sources.push({name: l.memberName, role: l.role as SourceView["role"], origin: l.origin as SourceView["origin"], status: l.status as SourceView["status"], probe: (l.lastProbe as SourceView["probe"]) ?? null, reason: (l.driftReason as SourceView["reason"]) ?? null});
        if ((l.status === "active" || l.status === "canary") && l.databaseId) {
            const k = kindOf(l);
            const fresh = l.lastProbeAt !== null && now.getTime() - l.lastProbeAt.getTime() <= PROBE_TTL_MS && l.status === "active";
            for (const key of l.coversKeys) {
                if (coverage[key] === undefined || rank[k] > rank[coverage[key]]) coverage[key] = k;
                if (fresh && l.lastProbe) probes[key] = probes[key] === "unreadable" || l.lastProbe === "unreadable" ? "unreadable" : (l.lastProbe as ProbeResult);
            }
        }
        if (l.status === "drifted") issues.push({key: `source:${l.resourceKey}`, kind: "member_source", name: l.memberName, reason: "source_drifted", status: "unknown", severity: "blocker"});
    }
    if (policy?.materializeState === "blocked") issues.push({key: "policy:channels", kind: "member_source", name: "Storage channels", reason: "source_drifted", status: "unknown", severity: "blocker"});
    if (policy?.materializeState === "inventory_changed") issues.push({key: "policy:inventory", kind: "policy", name: "Stack configuration", reason: "inventory_changed", status: "unknown", severity: "warn"});

    // ---- agent ----------------------------------------------------------------------------------------------------------------------
    const env = stack.environmentId ? (await db.execute(sql`select agent_id from fork_arcane_environment where id = ${stack.environmentId}`)).rows[0] as {agent_id: string | null} | undefined : undefined;
    const agentId = env?.agent_id ?? null;
    if (links.length > 0 && !agentId) issues.push({key: "agent:none", kind: "agent", name: "Agent", reason: "agent_unavailable", status: "unsupported", severity: "blocker"});
    if (agentId && links.length > 0) {
        const a = (await agentsLastContact(db, [agentId])).get(agentId);
        if (!a) issues.push({key: `agent:${agentId}`, kind: "agent", name: "Agent", reason: "agent_unavailable", status: "unsupported", severity: "blocker"});
        else {
            const stalled = a.lastContact === null || now.getTime() - a.lastContact.getTime() > AGENT_FRESH_MS;
            // Culprits: this stack's docker-volume members (the only kind whose ping can ERROR and stop the agent's reports, ADR-001 §G) —
            // live ones, plus a canary we just rolled back while the agent is still silent.
            const culprits = links.filter((l) => docker(l) && ((l.databaseId && ["active", "canary"].includes(l.status)) || (l.status === "blocked" && l.driftReason === "agent_poll_failing"))).map((l) => l.memberName);
            if (culprits.length && stalled) {
                // ONE finding per agent (P-2): the other stacks behind the same agent are listed, not repeated as separate blockers.
                const others = await db.execute(sql`
                    select distinct s.display_name from fork_stack_source l join fork_stack s on s.id = l.stack_id join fork_arcane_environment e on e.id = s.environment_id
                     where e.agent_id = ${agentId} and l.stack_id <> ${stack.id} and l.dbms = 'docker-volume' and (l.database_id is not null or l.drift_reason = 'agent_poll_failing') order by 1 limit 20`);
                issues.push({key: `agent:${agentId}`, kind: "agent", name: culprits.slice(0, 3).join(", "), reason: "agent_poll_failing", status: "inaccessible", severity: "blocker", consumers: (others.rows as {display_name: string}[]).map((r) => r.display_name)});
            }
        }
    }
    // D39: an active stack policy with encryption off is a blocker (activation is refused earlier; this catches it being switched off afterwards).
    if (policy?.activatedAt && !policy.deactivatedAt && !(await encryptionEnabled(db))) issues.push({key: "policy:encryption", kind: "policy", name: "Encryption", reason: "encryption_off", status: "unsupported", severity: "blocker"});
    const active = !!policy?.activatedAt && !policy.deactivatedAt;
    const sched = active ? ScheduleSchema.safeParse(policy?.schedule) : null;
    const interval = sched?.success ? intervalHours(sched.data, now) : null;
    return {coverage, probes, sourceIssues: issues, sources, acceptedExclusions: active ? (policy?.acceptedExclusions ?? []) : [], staleAfterHours: interval === null ? null : interval * 1.5};
}
