import {and, desc, eq, inArray, isNotNull, sql} from "drizzle-orm";
import {z} from "zod";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {forkRestoreRun} from "@/fork/db/schema/restore-run";
import {forkStackRun} from "@/fork/db/schema/runs";
import {forkStack, forkStackPolicy, forkStackSource} from "@/fork/db/schema/stack";
import {forkEnv} from "@/fork/env";
import {withForkLock} from "@/fork/locks";
import {authorizeMutation, loadStackContext, type MaterializeDeps} from "@/fork/materialize/apply";
import {currentForkMode} from "@/fork/mode";
import {assertForkResource} from "@/fork/resource-scope";
import {ACTIVE_RESTORE_RUN_STATES} from "@/fork/restore-run/vocab";
import {readPrincipal, type PrincipalLookup} from "@/fork/upstream";
import {quiesceAlert} from "./alert";
import {decideQuiesce, type QuiesceDecision, type QuiesceDecisionInput} from "./decide";
import {enqueueQuiesceStart, type QuiesceEnqueueRefusal} from "./enqueue";
import {defaultQuiesceServices, planQuiesce, type QuiesceMember, type QuiescePlan} from "./plan";
import {QuiesceResultSchema} from "./payload";
import type {QuiesceViewDto} from "./view";
import {DEFAULT_MAX_STOP_S, MAX_STOP_CHOICES_S, QUIESCE_CAPABILITY, type PlanBlockerCode, type QuiesceState} from "./vocab";
import type {StackInventoryV1} from "@/fork/inventory/schema";

/**
 * W17b dashboard services: the run-time inputs of `decideQuiesce` and the admin mutations (enable / disable / Start now). Mutations go through
 * `authorizeMutation` (signed-in principal → resource-scoped `stacks.backup.manage` = system admin, IDOR ⇒ not_found → D21 config lock → rate limit), then the
 * quiesce flag, an ACTIVE policy and the typed stack name on a `production` host role (D44, verified here, server-side). Everything is audited with ids, codes
 * and service names only.
 */
export type QuiesceAdminDeps = MaterializeDeps & {
    channel?: {keys: ChannelDeps["keys"]; serverUrl: () => string; env?: ChannelDeps["env"]; kekDir?: string};
    flag?: () => boolean;
    mode?: () => Promise<"on" | "locked" | "off">;
    leaseSeconds?: number;
};
type Rd = {db: ForkDb; now?: () => Date; mode?: () => Promise<"on" | "locked" | "off">; principalOf?: (userId: string) => Promise<PrincipalLookup>; flag?: () => boolean};
const nowOf = (d: {now?: () => Date}) => d.now?.() ?? new Date();
const flagOn = (d: {flag?: () => boolean}) => (d.flag ? d.flag() : forkEnv().FORK_QUIESCE_ENABLED);
const modeOf = async (d: {mode?: () => Promise<"on" | "locked" | "off">}) => (d.mode ? d.mode() : (await currentForkMode()).mode);

export type Loaded = {
    input: QuiesceDecisionInput;
    inventory: StackInventoryV1 | null;
    project: string | null;
    agentId: string | null;
    orgId: string;
    stackName: string;
    members: QuiesceMember[];
    policy: {enabled: boolean; services: string[]; maxStopSeconds: number; enabledBy: string | null; enabledAt: Date | null; selectionStop: string[]} | null;
    hostRole: "production" | "test" | null;
    lastSeenAt: Date | null;
};

/** Source → the mounts it copies (D2 fallback: `mount:<id>` ↔ id, `volume:<name>` ↔ `Mount.volume_name`, `file:`/`bind:`/`manual:` paths ↔ `host_path_hint` prefix). */
export function mountIdsOf(inv: StackInventoryV1, keys: readonly string[]): string[] {
    const out = new Set<string>();
    for (const k of keys) {
        const [kind, ...rest] = k.split(":");
        const v = rest.join(":");
        for (const m of inv.mounts) {
            if (kind === "mount" && m.id === v) out.add(m.id);
            else if (kind === "volume" && m.volume_name === v) out.add(m.id);
            else if ((kind === "file" || kind === "bind" || kind === "manual") && m.kind === "bind" && m.host_path_hint && (v === m.host_path_hint || v.startsWith(`${m.host_path_hint}/`) || m.host_path_hint.startsWith(`${v}/`))) out.add(m.id);
        }
    }
    return [...out];
}

export async function loadQuiesce(d: Rd, stackId: string, o: {light?: boolean} = {}): Promise<Loaded | null> {
    const ctx = await loadStackContext(d.db, stackId);
    if (!ctx) return null;
    const [stack] = await d.db.select({name: forkStack.displayName}).from(forkStack).where(eq(forkStack.id, stackId));
    const [pol] = await d.db.select().from(forkStackPolicy).where(eq(forkStackPolicy.stackId, stackId));
    const active = !!pol?.activatedAt && !pol.deactivatedAt;
    const sel = (pol?.selection ?? {}) as {stop?: unknown};
    const policy = pol && active ? {enabled: pol.quiesceEnabled, services: (pol.quiesceServices as string[] | null) ?? [], maxStopSeconds: pol.quiesceMaxStopSeconds, enabledBy: pol.quiesceEnabledBy, enabledAt: pol.quiesceEnabledAt,
        selectionStop: Array.isArray(sel.stop) ? (sel.stop as unknown[]).filter((x): x is string => typeof x === "string") : []} : null;
    if (o.light && !policy?.enabled) {
        // run start of a plain policy: nothing else is needed to know "quiesce is off" (keeps the W12 hot path cheap)
        return {input: {flagOn: flagOn(d), mode: "on", policy: policy ? {enabled: false, services: [], maxStopSeconds: policy.maxStopSeconds, enabledBy: null} : null, enablerHasRight: false, agentEnrolled: false, agentCapabilities: [], activeRestoreOnAgent: false, plan: null},
            inventory: ctx.inventory, project: ctx.composeProject, agentId: ctx.agentId, orgId: ctx.organizationId, stackName: stack?.name ?? "", members: [], policy, hostRole: null, lastSeenAt: null};
    }
    const [enr] = ctx.agentId ? await d.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, ctx.agentId)) : [];
    const agentEnrolled = !!enr && !enr.revokedAt && enr.enabled;
    let hostRole: "production" | "test" | null = null;
    if (ctx.environmentId) {
        const [env] = await d.db.select({hostRole: forkArcaneEnvironment.hostRole}).from(forkArcaneEnvironment).where(eq(forkArcaneEnvironment.id, ctx.environmentId));
        hostRole = env?.hostRole === "test" ? "test" : env ? "production" : null;
    }
    let enablerHasRight = false;
    if (policy?.enabledBy) {
        const who = await (d.principalOf ?? ((u: string) => readPrincipal(d.db, u)))(policy.enabledBy);
        enablerHasRight = who.kind === "ok" && forkCan(actorIn(who.principal, ctx.organizationId), "stacks.backup.manage");
    }
    let restoreBusy = false;
    if (ctx.agentId) {
        const r = await d.db.select({id: forkRestoreRun.id}).from(forkRestoreRun).where(and(eq(forkRestoreRun.targetAgentId, ctx.agentId), inArray(forkRestoreRun.state, [...ACTIVE_RESTORE_RUN_STATES]))).limit(1);
        restoreBusy = r.length > 0;
    }
    const srcs = await d.db.select().from(forkStackSource).where(eq(forkStackSource.stackId, stackId));
    const inv = ctx.inventory;
    const members: QuiesceMember[] = srcs.filter((s) => s.status !== "orphaned").map((s) => ({name: s.memberName, dbms: s.dbms, active: s.status === "active" && s.databaseId !== null, mountIds: inv ? mountIdsOf(inv, [s.resourceKey, ...s.coversKeys]) : []}));
    const plan: QuiescePlan | null = inv && policy?.enabled ? planQuiesce(inv, policy.services, members) : null;
    const [last] = ctx.agentId ? await d.db.select({lastSeenAt: forkAgentEnrollment.lastSeenAt}).from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, ctx.agentId)) : [];
    return {
        input: {flagOn: flagOn(d), mode: await modeOf(d), policy: policy ? {enabled: policy.enabled, services: policy.services, maxStopSeconds: policy.maxStopSeconds, enabledBy: policy.enabledBy} : null, enablerHasRight,
            agentEnrolled, agentCapabilities: agentEnrolled ? enr.capabilities : [], activeRestoreOnAgent: restoreBusy, plan},
        inventory: inv, project: ctx.composeProject, agentId: ctx.agentId, orgId: ctx.organizationId, stackName: stack?.name ?? "", members, policy, hostRole, lastSeenAt: last?.lastSeenAt ?? null,
    };
}

export async function loadQuiesceDecision(d: Rd, stackId: string): Promise<{decision: QuiesceDecision; loaded: Loaded | null}> {
    const loaded = await loadQuiesce(d, stackId, {light: true});
    if (!loaded) return {decision: {use: false, reason: null}, loaded: null};
    return {decision: decideQuiesce(loaded.input), loaded};
}

// ---- admin ----------------------------------------------------------------------------------------------------------------------------
export type QuiesceAdminRefusal = "forbidden" | "not_found" | "locked" | "rate_limited" | "invalid_input" | "flag_off" | "not_active" | "plan_blocked" | "confirmation_mismatch"
    | "nothing_stopped" | "agent_offline" | "start_in_progress" | "not_enabled" | QuiesceEnqueueRefusal;
export type QuiesceAdminResult =
    | {ok: true; noop?: boolean; mode?: "release" | "start_task"}
    | {ok: false; code: QuiesceAdminRefusal; message: string; blockers?: {code: PlanBlockerCode; service?: string; member?: string}[]; retryAfterSeconds?: number; manual?: {projectLabel: string; containers: string[]}};

const refuse = (code: QuiesceAdminRefusal, message: string, extra: Partial<Extract<QuiesceAdminResult, {ok: false}>> = {}): QuiesceAdminResult => ({ok: false, code, message, ...extra});
const EnableInput = z.strictObject({stackId: z.uuid(), services: z.array(z.string().max(128)).min(1).max(32), maxStopSeconds: z.number().int().refine((n) => (MAX_STOP_CHOICES_S as readonly number[]).includes(n)), confirmName: z.string().max(256).optional()});
const StackOnly = z.strictObject({stackId: z.uuid()});

export async function enableQuiesce(d: QuiesceAdminDeps, raw: unknown): Promise<QuiesceAdminResult> {
    const parsed = EnableInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const i = parsed.data;
    const auth = await authorizeMutation(d, "fork.quiesce.enable", i.stackId, "stack-quiesce");
    if (!("organizationId" in auth)) return auth as QuiesceAdminResult;
    const p = d.principal!;
    const now = nowOf(d);
    const audit = (result: "success" | "denied", details: Record<string, unknown>, db: ForkDb = d.db, action = "fork.quiesce.enable") =>
        recordAudit(db, {organizationId: auth.organizationId, actorUserId: p.userId, action, resourceType: "stack", resourceId: i.stackId, result, details, now});
    const deny = async (code: QuiesceAdminRefusal, message: string, details: Record<string, unknown> = {}, extra: Partial<Extract<QuiesceAdminResult, {ok: false}>> = {}) => {
        await audit("denied", {reason: code, ...details}, d.db, "fork.quiesce.enable");
        return refuse(code, message, extra);
    };
    if (!flagOn(d)) return deny("flag_off", "Stop + copy is switched off on this dashboard.");
    const loaded = await loadQuiesce(d, i.stackId);
    if (!loaded?.policy) return deny("not_active", "This stack has no active backup policy. Configure and activate one first.");
    if (!loaded.inventory) return deny("plan_blocked", "There is no inventory of this stack yet.", {}, {blockers: []});
    const plan = planQuiesce(loaded.inventory, i.services, loaded.members);
    if (!plan.ok) return deny("plan_blocked", "These services cannot be stopped safely.", {blockers: plan.blockers.map((b) => b.code)}, {blockers: plan.blockers});
    if (loaded.hostRole !== "test" && i.confirmName !== loaded.stackName) return deny("confirmation_mismatch", "Type the stack name exactly to confirm.", {hostRole: loaded.hostRole ?? "production"});
    return withForkLock(d.db, `materialize:${i.stackId}`, async (tx): Promise<QuiesceAdminResult> => {
        const services = plan.stopOrder.map((t) => t.service).sort();
        await tx.update(forkStackPolicy).set({quiesceEnabled: true, quiesceServices: services, quiesceMaxStopSeconds: i.maxStopSeconds, quiesceEnabledBy: p.userId, quiesceEnabledAt: now, updatedAt: now}).where(eq(forkStackPolicy.stackId, i.stackId));
        await audit("success", {services, maxStopSeconds: i.maxStopSeconds, hostRole: loaded.hostRole ?? "production"}, tx);
        return {ok: true};
    });
}

export async function disableQuiesce(d: QuiesceAdminDeps, raw: unknown): Promise<QuiesceAdminResult> {
    const parsed = StackOnly.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const auth = await authorizeMutation(d, "fork.quiesce.disable", parsed.data.stackId, "stack-quiesce");
    if (!("organizationId" in auth)) return auth as QuiesceAdminResult;
    const now = nowOf(d);
    return withForkLock(d.db, `materialize:${parsed.data.stackId}`, async (tx): Promise<QuiesceAdminResult> => {
        const [cur] = await tx.select({enabled: forkStackPolicy.quiesceEnabled}).from(forkStackPolicy).where(eq(forkStackPolicy.stackId, parsed.data.stackId));
        if (!cur?.enabled) return {ok: true, noop: true};
        await tx.update(forkStackPolicy).set({quiesceEnabled: false, updatedAt: now}).where(eq(forkStackPolicy.stackId, parsed.data.stackId));
        await recordAudit(tx, {organizationId: auth.organizationId, actorUserId: d.principal!.userId, action: "fork.quiesce.disable", resourceType: "stack", resourceId: parsed.data.stackId, result: "success", details: {}, now});
        return {ok: true};
    });
}

/**
 * "Start now" (D14, OD-W17b-13). In flight (`requested|stopped`): set `quiesce_release_at` (the agent sees it on its next route poll). After the task ended with
 * containers not verified (`restart_failed|unconfirmed|stop_failed`): enqueue the journal-bound `quiesce_start` (no ids in the payload). Offline agent ⇒ honest refusal + manual fallback.
 */
export async function startNow(d: QuiesceAdminDeps, raw: unknown): Promise<QuiesceAdminResult> {
    const parsed = StackOnly.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const stackId = parsed.data.stackId;
    const auth = await authorizeMutation(d, "fork.quiesce.start_now", stackId, "stack-quiesce");
    if (!("organizationId" in auth)) return auth as QuiesceAdminResult;
    const p = d.principal!;
    const now = nowOf(d);
    const audit = (result: "success" | "denied", details: Record<string, unknown>) =>
        recordAudit(d.db, {organizationId: auth.organizationId, actorUserId: p.userId, action: result === "success" ? "fork.quiesce.start_now" : "fork.quiesce.denied", resourceType: "stack", resourceId: stackId, result, details, now});
    const [run] = await d.db.select().from(forkStackRun).where(and(eq(forkStackRun.stackId, stackId), isNotNull(forkStackRun.quiesceTaskId))).orderBy(desc(forkStackRun.startedAt)).limit(1);
    if (!run || !run.quiesceState || !["requested", "stopped", "restart_failed", "unconfirmed", "stop_failed"].includes(run.quiesceState)) { await audit("denied", {reason: "nothing_stopped"}); return refuse("nothing_stopped", "No containers are waiting to be started by a backup."); }
    if (run.quiesceState === "requested" || run.quiesceState === "stopped") {
        await d.db.update(forkStackRun).set({quiesceReleaseAt: run.quiesceReleaseAt ?? now, quiesceReleaseReason: run.quiesceReleaseReason ?? "start_now", updatedAt: now}).where(eq(forkStackRun.id, run.id));
        await audit("success", {runId: run.id, mode: "release"});
        return {ok: true, mode: "release"};
    }
    const loaded = await loadQuiesce(d, stackId);
    const result = QuiesceResultSchema.safeParse(run.quiesceResult ?? {});
    const ids = result.success ? (result.data.containers ?? []).filter((c) => c.was_running && c.outcome !== "verified").map((c) => `${c.id12}`) : [];
    const manual = {projectLabel: loaded?.project ?? "", containers: ids};
    if (run.quiesceStartTaskId) {
        const open = await d.db.execute(sql`select 1 from fork_agent_task where id = ${run.quiesceStartTaskId} and status in ('queued','leased','running') limit 1`);
        if (open.rows.length > 0) { await audit("denied", {reason: "start_in_progress", runId: run.id}); return refuse("start_in_progress", "A start request is already waiting for the agent."); }
    }
    const leaseS = d.leaseSeconds ?? forkEnv().FORK_AGENT_LEASE_SECONDS;
    if (!loaded?.agentId || !loaded.lastSeenAt || now.getTime() - loaded.lastSeenAt.getTime() > 2 * leaseS * 1000) { await audit("denied", {reason: "agent_offline", runId: run.id}); return refuse("agent_offline", "The agent is not reachable right now.", {manual}); }
    if (!run.quiesceTaskId || !loaded.project) return refuse("nothing_stopped", "No containers are waiting to be started by a backup.");
    const ch = d.channel;
    if (!ch) return refuse("signing_unavailable", "The start request could not be sent.", {manual}); // the server action always wires the real keys
    const r = await enqueueQuiesceStart({db: d.db, keys: ch.keys, serverUrl: ch.serverUrl, env: ch.env, now: d.now, kekDir: ch.kekDir ?? d.kekDir, principal: p}, {runId: run.id, stackId, orgId: auth.organizationId, quiesceTaskId: run.quiesceTaskId, project: loaded.project, agentId: loaded.agentId, actorUserId: p.userId,
        onInserted: async (tx, taskId) => { await tx.update(forkStackRun).set({quiesceStartTaskId: taskId, updatedAt: now}).where(eq(forkStackRun.id, run.id)); }});
    if (!r.ok) return refuse(r.code, "The start request could not be sent.", {manual});
    await audit("success", {runId: run.id, mode: "start_task", taskId: r.taskId});
    return {ok: true, mode: "start_task"};
}

// ---- read model -----------------------------------------------------------------------------------------------------------------------
export async function previewQuiesce(d: QuiesceAdminDeps, raw: unknown): Promise<{ok: true; dto: QuiesceViewDto} | {ok: false; code: "not_found" | "invalid_input"}> {
    const parsed = z.strictObject({stackId: z.uuid(), services: z.array(z.string().max(128)).max(32).optional()}).safeParse(raw);
    if (!parsed.success) return {ok: false, code: "invalid_input"};
    try { await assertForkResource(d.db, d.principal, "stacks.view", {kind: "stack", id: parsed.data.stackId}); } catch (e) {
        if (e instanceof ForkNotFoundError || e instanceof ForkForbiddenError) return {ok: false, code: "not_found"};
        throw e;
    }
    const loaded = await loadQuiesce(d, parsed.data.stackId);
    if (!loaded) return {ok: false, code: "not_found"};
    const now = nowOf(d);
    const inv = loaded.inventory;
    const defaults = inv ? defaultQuiesceServices(inv, loaded.policy?.selectionStop ?? []) : [];
    const chosen = parsed.data.services ?? (loaded.policy?.enabled ? loaded.policy.services : defaults);
    const plan = inv && chosen.length ? planQuiesce(inv, chosen, loaded.members) : null;
    // availability = everything `decideQuiesce` checks except the plan, plus the plan itself
    const i = loaded.input;
    let availability: QuiesceViewDto["availability"] = {state: "available"};
    if (!i.flagOn) availability = {state: "unavailable", reason: "flag_off"};
    else if (!loaded.policy) availability = {state: "unavailable", reason: "no_policy"};
    else if (i.mode !== "on") availability = {state: "unavailable", reason: "locked"};
    else if (!loaded.agentId) availability = {state: "unavailable", reason: "no_agent"};
    else if (!i.agentEnrolled) availability = {state: "unavailable", reason: "agent_unenrolled"};
    else if (!i.agentCapabilities.includes(QUIESCE_CAPABILITY)) availability = {state: "unavailable", reason: "capability_missing"};
    else if (!inv) availability = {state: "unavailable", reason: "no_inventory"};
    else if (plan && !plan.ok) availability = {state: "unavailable", reason: "plan_blocked"};
    const [run] = await d.db.select().from(forkStackRun).where(and(eq(forkStackRun.stackId, parsed.data.stackId), isNotNull(forkStackRun.quiesceState))).orderBy(desc(forkStackRun.startedAt)).limit(1);
    const res = run ? QuiesceResultSchema.safeParse(run.quiesceResult ?? {}) : null;
    const alert = quiesceAlert(run ? {state: run.quiesceState as QuiesceState | null, stoppedAt: run.quiesceStoppedAt, maxStopSeconds: loaded.policy?.maxStopSeconds ?? DEFAULT_MAX_STOP_S} : null, now);
    const dto: QuiesceViewDto = {
        stackId: parsed.data.stackId, stackName: loaded.stackName, flagOn: i.flagOn, hostRole: loaded.hostRole, availability, enabled: !!loaded.policy?.enabled, enabledAt: loaded.policy?.enabledAt?.toISOString() ?? null,
        services: loaded.policy?.services ?? [], maxStopSeconds: loaded.policy?.maxStopSeconds ?? DEFAULT_MAX_STOP_S, defaults,
        allServices: (inv?.services ?? []).map((s) => ({name: s.name, running: s.state === "running"})),
        plan: plan ? (plan.ok ? {ok: true, stopOrder: plan.stopOrder.map((t) => t.service), startOrder: plan.startOrder, windowMembers: plan.windowMembers, preMembers: plan.preMembers, notRunning: plan.notRunning} : {ok: false, blockers: plan.blockers}) : null,
        last: run ? {runId: run.id, state: run.quiesceState as QuiesceState | null, reason: run.quiesceReason as never, releasedBy: res?.success ? res.data.released_by ?? null : null, windowIntact: res?.success ? res.data.window_intact ?? null : null,
            downtimeMs: res?.success ? res.data.downtime_ms ?? null : null, stoppedAt: run.quiesceStoppedAt?.toISOString() ?? null, startedAt: run.startedAt.toISOString(),
            containers: res?.success ? (res.data.containers ?? []).map((c) => ({service: c.service, outcome: c.outcome})) : []} : null,
        alert: {active: alert.active, since: alert.since?.toISOString() ?? null, canStartNow: alert.active || run?.quiesceState === "requested" || run?.quiesceState === "stopped"},
    };
    return {ok: true, dto};
}
