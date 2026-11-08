import {eq} from "drizzle-orm";
import type {ForkPrincipal} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {forkStack} from "@/fork/db/schema/stack";
import {nowOf} from "@/fork/restore-run/deps";
import {startRestoreRun} from "@/fork/restore-run/service";
import {createRestorePlan} from "@/fork/restore/service";
import type {TestRestoreDeps} from "./deps";
import {latestVerifiedRp, scheduleRow} from "./load";
import {REASON_OK, testRestoreProject} from "./vocab";

export type StartOutcome = {kind: "started"; runId: string} | {kind: "skipped"; reason: string} | {kind: "waiting"; reason: "target_busy" | "rate_limited"};

const safe = (code: string): string => (REASON_OK.test(code) ? code : "internal_error");

/**
 * ONE path for scheduled and manual test restores (plan D-1). `principal` = the schedule's enabler or the caller; every gate (restore.plan on the RP, restore.execute on the plan,
 * rate limits, locked mode, D44 refusals, personal-data rule, one-active-run-per-agent) is enforced by the existing services this calls. Never writes RP status.
 */
export async function startTestRestore(d: TestRestoreDeps, i: {stackId: string; trigger: "schedule" | "manual"; scheduledFor: Date | null; principal: ForkPrincipal}): Promise<StartOutcome> {
    const now = nowOf(d);
    const [stack] = await d.db.select().from(forkStack).where(eq(forkStack.id, i.stackId));
    if (!stack) return {kind: "skipped", reason: "internal_error"};
    const audit = (action: string, details: Record<string, unknown>, result: "success" | "denied" = "success") =>
        recordAudit(d.db, {organizationId: stack.organizationId, actorUserId: i.principal.userId, action, resourceType: "stack", resourceId: stack.id, result, details: {trigger: i.trigger, ...details}, now});
    const skip = async (reason: string, details: Record<string, unknown> = {}): Promise<StartOutcome> => {
        await audit("fork.test_restore.skipped", {reason, ...details}, "denied");
        return {kind: "skipped", reason};
    };
    const sched = await scheduleRow(d.db, i.stackId);
    if (!sched || !sched.targetAgentId || !sched.restoreRoot) return skip("not_configured");
    // D44 / §4.8: personal data (declared or NOT declared) needs the per-stack opt-in BEFORE any plan exists (the planner repeats this rule)
    if (stack.containsPersonalData !== false && stack.testRestoreOptInAt === null) return skip("personal_data_no_opt_in");
    const rp = await latestVerifiedRp(d.db, i.stackId);
    if (!rp) return skip("no_verified_rp");
    const {trEnv: _t, ...base} = d;
    const principalDeps = {...base, principal: i.principal};
    const plan = await createRestorePlan({db: d.db, principal: i.principal, now: d.now, rate: d.rate, configAllowed: d.configAllowed}, {
        rpId: rp.id, targetAgentId: sched.targetAgentId, purpose: "test_restore", mode: "new_stack",
        mappings: {target_project: testRestoreProject(stack.composeProject), restore_root: sched.restoreRoot, volumes: null, select: null, sqlite: null},
    });
    if (!plan.ok) return plan.code === "rate_limited" ? {kind: "waiting", reason: "rate_limited"} : skip(safe(plan.code));
    if (plan.outcome !== "ready") return skip("plan_blocked", {planId: plan.planId});
    const run = await startRestoreRun(principalDeps, {planId: plan.planId, planHash: plan.planHash}, {trigger: i.trigger, scheduledFor: i.scheduledFor ?? undefined});
    if (!run.ok) {
        if (run.code === "already_running") return {kind: "waiting", reason: "target_busy"};
        if (run.code === "rate_limited") return {kind: "waiting", reason: "rate_limited"};
        return skip(safe(run.code), {planId: plan.planId});
    }
    await audit("fork.test_restore.start", {runId: run.runId, planId: plan.planId, scheduledFor: i.scheduledFor ? i.scheduledFor.toISOString() : null});
    return {kind: "started", runId: run.runId};
}
