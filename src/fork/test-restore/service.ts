import {and, eq} from "drizzle-orm";
import {z} from "zod";
import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {forkRestoreRun} from "@/fork/db/schema/restore-run";
import {forkTestRestoreSchedule} from "@/fork/db/schema/test-restore";
import {assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkResource} from "@/fork/resource-scope";
import {nowOf} from "@/fork/restore-run/deps";
import {ScheduleSchema} from "@/fork/schedule/schedule";
import type {TestRestoreDeps} from "./deps";
import {checkTestTarget} from "./load";
import {startTestRestore} from "./start";
import type {TrRefusal} from "./vocab";

/**
 * User-facing W-TR services (plan D-10). ONE pipeline: principal → strict input → locked → resource gate (SEC-12: unknown and foreign resources are indistinguishable) →
 * rate limit → work → audit. Denials are audited as `fork.test_restore.denied` with a closed reason; audit details hold ids and codes only (never the restore root).
 */
export type TrRefusalResult = {ok: false; code: TrRefusal; retryAfterSeconds?: number};
export const SET_RATE = {limit: 20, windowMs: 60_000} as const;
export const RUN_RATE = {limit: 5, windowMs: 60_000} as const;
export const WIPE_RATE = {limit: 10, windowMs: 60_000} as const;

export const SetScheduleRequest = z.strictObject({
    stackId: z.uuid(), enabled: z.boolean(), schedule: ScheduleSchema, targetAgentId: z.uuid().nullable(),
    restoreRoot: z.string().min(1).max(1024).nullable(), staleAfterDays: z.number().int().min(1).max(90),
});
const StackReq = z.strictObject({stackId: z.uuid()});
const RunReq = z.strictObject({runId: z.uuid()});

/** Shape check only (the planner / agent apply the real allowed-roots rules): absolute, canonical, no control characters, not `/`. */
export const rootShapeOk = (p: string): boolean => p.startsWith("/") && p !== "/" && !p.endsWith("/") && !p.includes("//") && !p.split("/").some((s) => s === ".." || s === ".")
    && ![...p].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) && !/[$~`\\]/.test(p);

const allowed = (d: TestRestoreDeps): Promise<boolean> => (d.configAllowed ? d.configAllowed() : assertForkConfigAllowed().then(() => true, () => false));

type Gate = {ok: true; organizationId: string; stackId: string} | {ok: false; code: "not_found" | "forbidden"};
async function gate(d: TestRestoreDeps, cap: string, ref: {kind: "stack" | "restore_run"; id: string}): Promise<Gate> {
    try {
        const r = await assertForkResource(d.db, d.principal ?? null, cap, ref);
        return {ok: true, organizationId: r.organizationId, stackId: ref.kind === "stack" ? ref.id : ""};
    } catch (e) {
        if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found"};
        if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden"};
        throw e;
    }
}

const denied = (d: TestRestoreDeps, resourceType: string, id: string | null, orgId: string | null, reason: string) =>
    recordAudit(d.db, {organizationId: orgId, actorUserId: d.principal?.userId ?? null, action: "fork.test_restore.denied", resourceType, resourceId: id, result: "denied", details: {reason}, now: nowOf(d)});

async function pre(d: TestRestoreDeps, resourceType: string, id: string | null, rate: {key: string; limit: number; windowMs: number}, orgId: string | null): Promise<TrRefusalResult | null> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const rl = (d.rate ?? checkRate)(`${rate.key}:${p.userId}`, rate.limit, rate.windowMs, nowOf(d).getTime());
    if (!rl.ok) { await denied(d, resourceType, id, orgId, "rate_limited"); return {ok: false, code: "rate_limited", retryAfterSeconds: rl.retryAfterSeconds}; }
    return null;
}

export async function setTestRestoreSchedule(d: TestRestoreDeps, raw: unknown): Promise<{ok: true} | TrRefusalResult> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const parsed = SetScheduleRequest.safeParse(raw);
    if (!parsed.success) { await denied(d, "stack", null, null, "invalid_input"); return {ok: false, code: "invalid_input"}; }
    const r = parsed.data;
    if (!(await allowed(d))) { await denied(d, "stack", r.stackId, null, "locked"); return {ok: false, code: "locked"}; }
    // D-10: a system admin (D21) who ALSO holds restore.execute in the stack's organization (runs execute as them, D31)
    const g = await gate(d, "stacks.backup.manage", {kind: "stack", id: r.stackId});
    if (!g.ok) { await denied(d, "stack", r.stackId, null, g.code); return g; }
    const g2 = await gate(d, "restore.execute", {kind: "stack", id: r.stackId});
    if (!g2.ok) { await denied(d, "stack", r.stackId, g.organizationId, g2.code); return {ok: false, code: g2.code}; }
    const refused = await pre(d, "stack", r.stackId, {key: "test-restore-set", ...SET_RATE}, g.organizationId);
    if (refused) return refused;
    if (r.restoreRoot !== null && !rootShapeOk(r.restoreRoot)) { await denied(d, "stack", r.stackId, g.organizationId, "invalid_root"); return {ok: false, code: "invalid_root"}; }
    if (r.enabled && (r.targetAgentId === null || r.restoreRoot === null)) { await denied(d, "stack", r.stackId, g.organizationId, "invalid_input"); return {ok: false, code: "invalid_input"}; }
    if (r.targetAgentId !== null) {
        // D-12 / D44: only a host whose environments are ALL host_role=test (repeated by the planner at every fire and by the agent's own FORK_HOST_ROLE)
        const t = await checkTestTarget(d.db, r.targetAgentId);
        if (t !== "ok" && (r.enabled || t === "target_not_test")) { await denied(d, "stack", r.stackId, g.organizationId, t); return {ok: false, code: t}; }
    }
    const now = nowOf(d);
    const [prev] = await d.db.select().from(forkTestRestoreSchedule).where(eq(forkTestRestoreSchedule.stackId, r.stackId));
    const enabling = r.enabled && (!prev || !prev.enabled || prev.pausedAt !== null);
    const values = {
        organizationId: g.organizationId, enabled: r.enabled, schedule: r.schedule, targetAgentId: r.targetAgentId, restoreRoot: r.restoreRoot, staleAfterDays: r.staleAfterDays,
        enabledBy: enabling ? p.userId : (prev?.enabledBy ?? null), enabledAt: enabling ? now : (prev?.enabledAt ?? null),
        pausedAt: r.enabled ? null : (prev?.pausedAt ?? null), pauseReason: r.enabled ? null : (prev?.pauseReason ?? null), updatedBy: p.userId, updatedAt: now,
    };
    await d.db.insert(forkTestRestoreSchedule).values({stackId: r.stackId, ...values}).onConflictDoUpdate({target: forkTestRestoreSchedule.stackId, set: values});
    await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: p.userId, action: "fork.test_restore.schedule.set", resourceType: "stack", resourceId: r.stackId, result: "success", now,
        details: {enabled: r.enabled, preset: r.schedule.preset, targetAgentId: r.targetAgentId, staleAfterDays: r.staleAfterDays}});
    return {ok: true};
}

export async function runTestRestoreNow(d: TestRestoreDeps, raw: unknown): Promise<{ok: true; runId: string} | TrRefusalResult> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const parsed = StackReq.safeParse(raw);
    if (!parsed.success) { await denied(d, "stack", null, null, "invalid_input"); return {ok: false, code: "invalid_input"}; }
    if (!(await allowed(d))) { await denied(d, "stack", parsed.data.stackId, null, "locked"); return {ok: false, code: "locked"}; }
    const g = await gate(d, "restore.execute", {kind: "stack", id: parsed.data.stackId});
    if (!g.ok) { await denied(d, "stack", parsed.data.stackId, null, g.code); return g; }
    const refused = await pre(d, "stack", parsed.data.stackId, {key: "test-restore-run", ...RUN_RATE}, g.organizationId);
    if (refused) return refused;
    const wipe = await blockedByWipe(d, parsed.data.stackId);
    if (wipe) { await denied(d, "stack", parsed.data.stackId, g.organizationId, "wipe_pending"); return {ok: false, code: "wipe_pending"}; }
    const res = await startTestRestore(d, {stackId: parsed.data.stackId, trigger: "manual", scheduledFor: null, principal: p});
    if (res.kind === "started") return {ok: true, runId: res.runId};
    const code = res.kind === "waiting" ? (res.reason === "rate_limited" ? "rate_limited" : "target_busy") : res.reason;
    const closed: TrRefusal = ((["not_configured", "personal_data_no_opt_in", "no_verified_rp", "plan_blocked", "locked", "not_enrolled", "capability_missing", "target_not_test", "forbidden", "not_found", "rate_limited", "target_busy"] as const) as readonly string[]).includes(code)
        ? (code as TrRefusal) : code === "test_restore_target_not_test" ? "target_not_test" : "internal_error";
    return {ok: false, code: closed};
}

async function blockedByWipe(d: TestRestoreDeps, stackId: string): Promise<boolean> {
    const rows = await d.db.select({wipe: forkRestoreRun.wipeState, state: forkRestoreRun.state}).from(forkRestoreRun).where(and(eq(forkRestoreRun.stackId, stackId), eq(forkRestoreRun.purpose, "test_restore")));
    return rows.some((r) => r.state !== "running" && r.state !== "awaiting_approval" && r.wipe === "failed");
}

/** "Wipe now": re-arms a FAILED wipe (state NULL ⇒ the wipe tick starts a new attempt as the caller). Org admin+ (`restore.execute`). */
export async function wipeTestRestoreNow(d: TestRestoreDeps, raw: unknown): Promise<{ok: true} | TrRefusalResult> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const parsed = RunReq.safeParse(raw);
    if (!parsed.success) { await denied(d, "restore_run", null, null, "invalid_input"); return {ok: false, code: "invalid_input"}; }
    if (!(await allowed(d))) { await denied(d, "restore_run", parsed.data.runId, null, "locked"); return {ok: false, code: "locked"}; }
    const g = await gate(d, "restore.execute", {kind: "restore_run", id: parsed.data.runId});
    if (!g.ok) { await denied(d, "restore_run", parsed.data.runId, null, g.code); return g; }
    const refused = await pre(d, "restore_run", parsed.data.runId, {key: "test-restore-wipe", ...WIPE_RATE}, g.organizationId);
    if (refused) return refused;
    const now = nowOf(d);
    const rows = await d.db.update(forkRestoreRun).set({wipeState: null, wipeReason: null, wipeFinishedAt: null, wipeStartedAt: now, wipeBy: p.userId, updatedAt: now})
        .where(and(eq(forkRestoreRun.id, parsed.data.runId), eq(forkRestoreRun.purpose, "test_restore"), eq(forkRestoreRun.wipeState, "failed"))).returning({id: forkRestoreRun.id});
    if (rows.length !== 1) { await denied(d, "restore_run", parsed.data.runId, g.organizationId, "not_failed"); return {ok: false, code: "not_failed"}; }
    await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: p.userId, action: "fork.test_restore.wipe_now", resourceType: "restore_run", resourceId: parsed.data.runId, result: "success", now, details: {runId: parsed.data.runId}});
    return {ok: true};
}
