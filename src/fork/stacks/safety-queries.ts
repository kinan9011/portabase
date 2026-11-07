import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {loadProtectionByStackId} from "@/fork/stacks/protection-load";
import {classifyStack, groupAgentIssues, SafetyStripSchema, type SafetyStrip, type StripItem} from "@/fork/stacks/safety";

/** Ceiling of the strip: stacks are evaluated one by one (each a full §4.6 derivation), so a very large estate is capped, visibly (`capped`). */
export const STRIP_STACK_LIMIT = 200;

/**
 * Data of the "Am I safe?" strip for ONE organization (the caller passes the organization the principal was authorised for). The per-stack state comes
 * from `loadProtectionByStackId` — the same §4.6 code as the details page — then the pure `classifyStack`. The agent issues are read once, grouped by agent.
 */
export async function loadSafetyStrip(db: ForkDb, organizationId: string, o: {configLocked: boolean; now?: Date}): Promise<SafetyStrip> {
    const stacks = (await db.execute(sql`select id, display_name from fork_stack where organization_id = ${organizationId} order by lower(display_name), id limit ${STRIP_STACK_LIMIT + 1}`)).rows as {id: string; display_name: string}[];
    const capped = stacks.length > STRIP_STACK_LIMIT;
    const evaluated = stacks.slice(0, STRIP_STACK_LIMIT);
    const total = capped ? ((await db.execute(sql`select count(*)::int as n from fork_stack where organization_id = ${organizationId}`)).rows[0] as {n: number}).n : evaluated.length;

    const poll = (await db.execute(sql`
        select distinct a.id as agent_id, a.name as agent_name, s.id as stack_id, s.display_name as stack_name
          from fork_stack_source l
          join fork_stack s on s.id = l.stack_id
          join fork_arcane_environment e on e.id = s.environment_id
          join agents a on a.id = e.agent_id
         where s.organization_id = ${organizationId} and l.drift_reason = 'agent_poll_failing'`)).rows as {agent_id: string; agent_name: string; stack_id: string; stack_name: string}[];
    const failing = new Set(poll.map((r) => r.stack_id));

    const items: StripItem[] = [];
    for (const s of evaluated) {
        const c = classifyStack(await loadProtectionByStackId(db, s.id, {configLocked: o.configLocked, now: o.now}), failing.has(s.id));
        items.push({stackId: s.id, name: s.display_name, bucket: c.bucket, reasons: c.reasons});
    }
    const n = (b: StripItem["bucket"]) => items.filter((i) => i.bucket === b).length;
    return SafetyStripSchema.parse({
        counts: {safe: n("safe"), needsAttention: n("needs_attention"), notProtected: n("not_protected")},
        items,
        agentIssues: groupAgentIssues(poll.map((r) => ({agentId: r.agent_id, agentName: r.agent_name, stackId: r.stack_id, stackName: r.stack_name}))),
        capped, total,
    });
}
