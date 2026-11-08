import {and, desc, eq, isNotNull, isNull, max, sql} from "drizzle-orm";
import {TEST_RESTORE_CAPABILITY, RESTORE_CAPABILITY} from "@/fork/agent-channel/vocab";
import {agent} from "@/db/schema/08_agent";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {forkRecoveryPoint} from "@/fork/db/schema/recovery";
import {forkRestoreRun} from "@/fork/db/schema/restore-run";
import {forkTestRestoreSchedule} from "@/fork/db/schema/test-restore";
import {forkEnv} from "@/fork/env";
import {DEFAULT_STALE_DAYS} from "./vocab";

/** Plan D-7: newest finished test restore that succeeded, was data-verified AND whose scratch wipe was verified (uses `fork_restore_run_test_facet_idx`). */
export async function lastTestRestoreVerifiedAt(db: ForkDb, stackId: string): Promise<Date | null> {
    const [r] = await db.select({at: max(forkRestoreRun.finishedAt)}).from(forkRestoreRun).where(and(
        eq(forkRestoreRun.stackId, stackId), eq(forkRestoreRun.purpose, "test_restore"), eq(forkRestoreRun.state, "succeeded"),
        eq(forkRestoreRun.verification, "data_verified"), eq(forkRestoreRun.wipeState, "verified")));
    return r?.at ?? null;
}

export async function scheduleRow(db: ForkDb, stackId: string): Promise<typeof forkTestRestoreSchedule.$inferSelect | null> {
    const [r] = await db.select().from(forkTestRestoreSchedule).where(eq(forkTestRestoreSchedule.stackId, stackId));
    return r ?? null;
}

export async function staleAfterDaysOf(db: ForkDb, stackId: string, env: {FORK_TEST_RESTORE_STALE_DAYS: number} = forkEnv()): Promise<number> {
    const row = await scheduleRow(db, stackId);
    return row?.staleAfterDays ?? env.FORK_TEST_RESTORE_STALE_DAYS ?? DEFAULT_STALE_DAYS;
}

/** Latest verified, not purged recovery point of a stack (D43). */
export async function latestVerifiedRp(db: ForkDb, stackId: string): Promise<{id: string} | null> {
    const [r] = await db.select({id: forkRecoveryPoint.id}).from(forkRecoveryPoint).where(and(eq(forkRecoveryPoint.stackId, stackId), eq(forkRecoveryPoint.status, "verified"), isNull(forkRecoveryPoint.purgedAt)))
        .orderBy(desc(forkRecoveryPoint.sequence)).limit(1);
    return r ?? null;
}

/** Plan D-12 (same rule as the planner, `plan.ts`): ≥ 1 environment and ALL of them `host_role = test`. */
export async function agentIsTestHost(db: ForkDb, agentId: string): Promise<boolean> {
    const envs = await db.select({role: forkArcaneEnvironment.hostRole}).from(forkArcaneEnvironment).where(eq(forkArcaneEnvironment.agentId, agentId));
    return envs.length > 0 && envs.every((e) => e.role === "test");
}

export type TargetCheck = "ok" | "target_not_test" | "not_enrolled" | "capability_missing";
export async function checkTestTarget(db: ForkDb, agentId: string): Promise<TargetCheck> {
    const [a] = await db.select({id: agent.id}).from(agent).where(eq(agent.id, agentId));
    if (!a) return "not_enrolled";
    if (!(await agentIsTestHost(db, agentId))) return "target_not_test";
    const [e] = await db.select({enabled: forkAgentEnrollment.enabled, revokedAt: forkAgentEnrollment.revokedAt, capabilities: forkAgentEnrollment.capabilities}).from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
    if (!e || e.revokedAt || !e.enabled) return "not_enrolled";
    if (!e.capabilities.includes(RESTORE_CAPABILITY) || !e.capabilities.includes(TEST_RESTORE_CAPABILITY)) return "capability_missing";
    return "ok";
}

/** Agents of the organization that could be a test-restore target (admin projection only). */
export async function testHostCandidates(db: ForkDb, organizationId: string): Promise<{id: string; name: string}[]> {
    const rows = await db.select({id: agent.id, name: agent.name}).from(agent).where(and(eq(agent.organizationId, organizationId), isNotNull(agent.id)));
    const out: {id: string; name: string}[] = [];
    for (const r of rows) if ((await checkTestTarget(db, r.id)) === "ok") out.push(r);
    return out;
}
void sql;
