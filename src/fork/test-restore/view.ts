import {desc, eq, and} from "drizzle-orm";
import {z} from "zod";
import {actorIn, forkCan} from "@/fork/acl";
import {agent} from "@/db/schema/08_agent";
import {forkRestoreRun} from "@/fork/db/schema/restore-run";
import {forkStack} from "@/fork/db/schema/stack";
import {nowOf} from "@/fork/restore-run/deps";
import {nextRuns, toCron, ScheduleSchema} from "@/fork/schedule/schedule";
import {testRestoreFacet} from "./facet";
import {lastTestRestoreVerifiedAt, scheduleRow, staleAfterDaysOf, testHostCandidates} from "./load";
import {assertViewable, type TestRestoreDeps} from "./view-gate";
import {REASON_OK} from "./vocab";

/**
 * Strict allow-list of the Schedule-tab panel (plan D4 view.ts): never an env value, URL, manifest, task payload or user id. The restore root and the candidate agents are
 * part of the ADMIN projection only (`admin`), a member sees neither.
 */
const iso = z.string();
export const TestRestoreView = z.strictObject({
    schedule: z.strictObject({
        configured: z.boolean(), enabled: z.boolean(), preset: z.string().nullable(), timezone: z.string().nullable(), cron: z.string().nullable(), nextRuns: z.array(iso).max(3),
        targetAgentName: z.string().nullable(), staleAfterDays: z.number(), paused: z.strictObject({reason: z.string()}).nullable(),
        lastOutcome: z.strictObject({kind: z.string(), reason: z.string().nullable(), at: iso}).nullable(),
    }),
    privacy: z.strictObject({containsPersonalData: z.boolean().nullable(), optIn: z.boolean()}),
    facet: z.strictObject({daysAgo: z.number().nullable(), stale: z.boolean()}),
    last: z.strictObject({
        runId: z.string(), state: z.string(), reason: z.string().nullable(), trigger: z.string(), startedAt: iso, finishedAt: iso.nullable(), durationSeconds: z.number().nullable(),
        integrity: z.strictObject({checked: z.number(), failed: z.number(), notSupported: z.number()}).nullable(),
        wipe: z.strictObject({state: z.string().nullable(), reason: z.string().nullable(), finishedAt: iso.nullable()}),
    }).nullable(),
    admin: z.strictObject({restoreRoot: z.string().nullable(), candidates: z.array(z.strictObject({id: z.string(), name: z.string()})).max(200)}).nullable(),
    can: z.strictObject({configure: z.boolean(), runNow: z.boolean(), wipeNow: z.boolean()}),
});
export type TestRestoreView = z.infer<typeof TestRestoreView>;

const countsOf = (v: unknown): NonNullable<TestRestoreView["last"]>["integrity"] => {
    const r = z.object({checked: z.number(), failed: z.number(), not_supported: z.number()}).safeParse(v);
    return r.success ? {checked: r.data.checked, failed: r.data.failed, notSupported: r.data.not_supported} : null;
};
const safe = (s: string | null): string | null => (s && REASON_OK.test(s) ? s : null);

export async function getTestRestoreView(d: TestRestoreDeps, raw: unknown): Promise<{ok: true; view: TestRestoreView} | {ok: false; code: "forbidden" | "not_found" | "invalid_input"}> {
    const parsed = z.strictObject({stackId: z.uuid()}).safeParse(raw);
    if (!parsed.success) return {ok: false, code: "invalid_input"};
    const g = await assertViewable(d, parsed.data.stackId);
    if (!g.ok) return g;
    const now = nowOf(d);
    const stackId = parsed.data.stackId;
    const [stack] = await d.db.select().from(forkStack).where(eq(forkStack.id, stackId));
    if (!stack) return {ok: false, code: "not_found"};
    const row = await scheduleRow(d.db, stackId);
    const parsedSched = row ? ScheduleSchema.safeParse(row.schedule) : null;
    const sched = parsedSched?.success ? parsedSched.data : null;
    let targetName: string | null = null;
    if (row?.targetAgentId) targetName = (await d.db.select({n: agent.name}).from(agent).where(eq(agent.id, row.targetAgentId)))[0]?.n ?? null;
    const staleAfterDays = await staleAfterDaysOf(d.db, stackId, d.trEnv);
    const f = testRestoreFacet({lastVerifiedAt: await lastTestRestoreVerifiedAt(d.db, stackId), now, staleAfterDays});
    const [run] = await d.db.select().from(forkRestoreRun).where(and(eq(forkRestoreRun.stackId, stackId), eq(forkRestoreRun.purpose, "test_restore"))).orderBy(desc(forkRestoreRun.createdAt)).limit(1);
    const actor = actorIn(d.principal ?? null, g.organizationId);
    const can = {configure: forkCan(actor, "stacks.backup.manage") && forkCan(actor, "restore.execute"), runNow: forkCan(actor, "restore.execute") && row !== null, wipeNow: forkCan(actor, "restore.execute")};
    const view: TestRestoreView = {
        schedule: {
            configured: row !== null, enabled: row?.enabled === true, preset: sched?.preset ?? null, timezone: sched?.timezone ?? null, cron: sched ? toCron(sched) : null,
            nextRuns: sched && row?.enabled ? nextRuns(sched, now, 3).map((x) => x.toISOString()) : [], targetAgentName: targetName, staleAfterDays,
            paused: row?.pausedAt ? {reason: safe(row.pauseReason) ?? "paused"} : null,
            lastOutcome: row?.lastOutcome && row.lastOutcomeAt ? {kind: row.lastOutcome, reason: safe(row.lastReason), at: row.lastOutcomeAt.toISOString()} : null,
        },
        privacy: {containsPersonalData: stack.containsPersonalData, optIn: stack.testRestoreOptInAt !== null},
        facet: f,
        last: run ? {
            runId: run.id, state: run.state, reason: safe(run.reason), trigger: run.trigger, startedAt: run.createdAt.toISOString(), finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            durationSeconds: run.finishedAt ? Math.max(0, Math.round((run.finishedAt.getTime() - run.createdAt.getTime()) / 1000)) : null, integrity: countsOf(run.integrity),
            wipe: {state: run.wipeState, reason: safe(run.wipeReason), finishedAt: run.wipeFinishedAt ? run.wipeFinishedAt.toISOString() : null},
        } : null,
        admin: can.configure ? {restoreRoot: row?.restoreRoot ?? null, candidates: await testHostCandidates(d.db, g.organizationId)} : null,
        can,
    };
    return {ok: true, view: TestRestoreView.parse(view)};
}
