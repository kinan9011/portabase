import {randomUUID} from "node:crypto";
import {lookup} from "node:dns/promises";
import {and, eq, inArray, or, sql, gte} from "drizzle-orm";
import {actorIn, forkCan} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {gate, loadTaskKey, stepUp, type Refusal as AdminRefusal} from "@/fork/agent-channel/admin";
import {chEnv, chNow, type ChannelDeps} from "@/fork/agent-channel/deps";
import {insertSignedTask} from "@/fork/agent-channel/tasks";
import {checkChannelTransport} from "@/fork/agent-channel/transport-policy";
import {RUNNER_CAPABILITY} from "@/fork/agent-channel/vocab";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment, forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkArcaneConnection, forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {forkRunner} from "@/fork/db/schema/runner";
import {forkEnv} from "@/fork/env";
import {withForkLock} from "@/fork/locks";
import {checkRate} from "@/fork/net/rate-limit";
import {countDatabasesOfAgent} from "@/fork/upstream/agents";
import {evaluateProbe, RunnerNotIsolatedError, type RunnerIsolation} from "./evaluate";
import {RunnerProbePayload} from "./payload-schema";
import {configOf, materialize, parseAdminTargets, targetsSha, type AdminTarget, type ProbeTarget, type Resolve} from "./targets";
import {PROBE_TASK_TTL_MS, PROBE_TIMEOUT_MS, RUNNER_PROBE_DEFAULT_MAX_AGE_MS, type RunnerRefusalCode} from "./vocab";
import {z} from "zod";

/**
 * Runner services (W21, ADR-008). Every mutation: flag (`FORK_MIRRORS_ENABLED`) → principal → ACL (`agents.channel.manage`, plus `host_role.manage` for designation) → D21 lock →
 * rate limit → (designate) password step-up → eligibility → one DB write → audit with CODES, ids, counts and a config sha only (NEVER a host, an IP, a payload or a key).
 * CSRF: the server-action origin check (same as every fork action).
 */
export type RunnerDeps = ChannelDeps & {
    /** Test seam; default `forkEnv().FORK_MIRRORS_ENABLED`. */
    mirrorsEnabled?: () => boolean;
    /** Hostname → addresses. The dashboard only RESOLVES (never connects). Default: `dns.lookup(all)` with a 3 s timeout. */
    resolve?: Resolve;
};
export type RunnerRefusal = {ok: false; code: RunnerRefusalCode | AdminRefusal["code"]; message: string; retryAfterSeconds?: number};
const refuse = (code: RunnerRefusal["code"], message: string, extra: Partial<RunnerRefusal> = {}): RunnerRefusal => ({ok: false, code, message, ...extra});

const MSG: Partial<Record<RunnerRefusalCode, string>> = {
    mirrors_disabled: "Test mirrors are not enabled on this instance.",
    not_enrolled: "This agent is not enrolled for the fork channel.",
    agent_disabled: "The task channel of this agent is switched off.",
    agent_mapped_to_environment: "This agent is mapped to an Arcane environment, so it cannot be a mirror runner. A runner is a dedicated host.",
    agent_has_databases: "This agent has databases assigned to it, so it cannot be a mirror runner. A runner is a dedicated host that holds nothing else.",
    already_designated: "This agent is already a mirror runner.",
    not_a_runner: "This agent is not designated as a mirror runner.",
    not_attested: "The agent has not reported the runner role yet. Start it with FORK_HOST_ROLE=runner.",
    probe_in_progress: "An isolation check is already running for this runner.",
    target_invalid: "One of the check targets is not valid.",
    too_many_targets: "There are too many check targets.",
};
const msg = (c: RunnerRefusalCode) => MSG[c] ?? "Refused.";

const enabled = (d: RunnerDeps) => (d.mirrorsEnabled ?? (() => forkEnv().FORK_MIRRORS_ENABLED))();

export const defaultResolve: Resolve = async (host) => {
    const r = await Promise.race([lookup(host, {all: true}), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), 3000).unref())]);
    return r.map((a) => a.address);
};

const actorOf = (d: RunnerDeps, orgId: string | null) => {
    const p = d.principal!;
    return (orgId ? actorIn(p, orgId) : null) ?? {systemRole: p.systemRole ?? null, orgRole: null};
};

// ---- eligibility (DD-2) -------------------------------------------------------------------------------------------------------------------
export type Eligible = {ok: true; enrollment: typeof forkAgentEnrollment.$inferSelect} | {ok: false; code: "not_a_runner" | "not_enrolled" | "agent_disabled" | "not_attested" | "agent_mapped_to_environment" | "agent_has_databases"};

/** An eligible runner: designation row AND active + enabled enrolment AND `runner.v1` reported AND no Arcane environment AND no upstream database. No row ⇒ not a runner (SEC-11). */
export async function assertRunnerTarget(db: ForkDb, agentId: string): Promise<Eligible> {
    const [row] = await db.select({agentId: forkRunner.agentId}).from(forkRunner).where(eq(forkRunner.agentId, agentId));
    if (!row) return {ok: false, code: "not_a_runner"};
    const [e] = await db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
    if (!e || e.revokedAt) return {ok: false, code: "not_enrolled"};
    if (!e.enabled) return {ok: false, code: "agent_disabled"};
    if (!e.capabilities.includes(RUNNER_CAPABILITY)) return {ok: false, code: "not_attested"};
    const [m] = await db.select({n: sql<number>`count(*)::int`}).from(forkArcaneEnvironment).where(eq(forkArcaneEnvironment.agentId, agentId));
    if (Number(m?.n ?? 0) > 0) return {ok: false, code: "agent_mapped_to_environment"};
    if ((await countDatabasesOfAgent(db, agentId)) > 0) return {ok: false, code: "agent_has_databases"};
    return {ok: true, enrollment: e};
}

// ---- designation ----------------------------------------------------------------------------------------------------------------------------
const DesignateInput = z.strictObject({agentId: z.uuid(), password: z.string().min(1).max(1024)});
const PlainInput = z.strictObject({agentId: z.uuid()});
const TargetsInput = z.strictObject({agentId: z.uuid(), targets: z.array(z.unknown()).max(64)});

type Gated = {organizationId: string | null; userId: string; agent: {id: string; name: string}};
async function gated(d: RunnerDeps, action: string, agentId: string, needsHostRole: boolean): Promise<Gated | RunnerRefusal> {
    // ACL + D21 + rate first (a forbidden caller is audited as forbidden whatever the flag says); the feature flag is checked once the caller is allowed
    const g = await gate(d, action, agentId);
    if ("ok" in g) return g;
    if (needsHostRole && !forkCan(actorOf(d, g.organizationId), "host_role.manage")) {
        await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: g.userId, action, resourceType: "agent", resourceId: agentId, result: "denied", details: {reason: "forbidden", capability: "host_role.manage"}, now: chNow(d)});
        return refuse("forbidden", "Only a system administrator can designate a mirror runner.");
    }
    if (!enabled(d)) return refuse("mirrors_disabled", msg("mirrors_disabled"));
    return g;
}
const denied = (d: RunnerDeps, g: Gated, action: string, reason: string, db: ForkDb = d.db) =>
    recordAudit(db, {organizationId: g.organizationId, actorUserId: g.userId, action, resourceType: "agent", resourceId: g.agent.id, result: "denied", details: {reason}, now: chNow(d)});

export type DesignateResult = {ok: true} | RunnerRefusal;

export async function designateRunner(d: RunnerDeps, raw: unknown): Promise<DesignateResult> {
    const parsed = DesignateInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const {agentId, password} = parsed.data;
    const ACTION = "fork.runner.designate";
    const g = await gated(d, ACTION, agentId, true);
    if ("ok" in g) return g;
    const su = await stepUp(d, g, ACTION, password);
    if (su) return su;
    return withForkLock(d.db, `runner:${agentId}`, async (tx): Promise<DesignateResult> => {
        const [existing] = await tx.select({a: forkRunner.agentId}).from(forkRunner).where(eq(forkRunner.agentId, agentId));
        if (existing) { await denied(d, g, ACTION, "already_designated", tx); return refuse("already_designated", msg("already_designated")); }
        const [e] = await tx.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
        if (!e || e.revokedAt) { await denied(d, g, ACTION, "not_enrolled", tx); return refuse("not_enrolled", msg("not_enrolled")); }
        if (!e.enabled) { await denied(d, g, ACTION, "agent_disabled", tx); return refuse("agent_disabled", msg("agent_disabled")); }
        const [m] = await tx.select({n: sql<number>`count(*)::int`}).from(forkArcaneEnvironment).where(eq(forkArcaneEnvironment.agentId, agentId));
        if (Number(m?.n ?? 0) > 0) { await denied(d, g, ACTION, "agent_mapped_to_environment", tx); return refuse("agent_mapped_to_environment", msg("agent_mapped_to_environment")); }
        if ((await countDatabasesOfAgent(tx, agentId)) > 0) { await denied(d, g, ACTION, "agent_has_databases", tx); return refuse("agent_has_databases", msg("agent_has_databases")); }
        const now = chNow(d);
        await tx.insert(forkRunner).values({agentId, designatedBy: g.userId, designatedAt: now, updatedAt: now});
        await recordAudit(tx, {organizationId: g.organizationId, actorUserId: g.userId, action: ACTION, resourceType: "agent", resourceId: agentId, result: "success", details: {}, now});
        return {ok: true};
    });
}

/** Remove the designation. (W22a adds "refuse while mirrors exist".) */
export async function undesignateRunner(d: RunnerDeps, raw: unknown): Promise<DesignateResult> {
    const parsed = PlainInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const {agentId} = parsed.data;
    const ACTION = "fork.runner.undesignate";
    const g = await gated(d, ACTION, agentId, true);
    if ("ok" in g) return g;
    return withForkLock(d.db, `runner:${agentId}`, async (tx): Promise<DesignateResult> => {
        const gone = await tx.delete(forkRunner).where(eq(forkRunner.agentId, agentId)).returning({a: forkRunner.agentId});
        if (gone.length === 0) { await denied(d, g, ACTION, "not_a_runner", tx); return refuse("not_a_runner", msg("not_a_runner")); }
        await recordAudit(tx, {organizationId: g.organizationId, actorUserId: g.userId, action: ACTION, resourceType: "agent", resourceId: agentId, result: "success", details: {}, now: chNow(d)});
        return {ok: true};
    });
}

// ---- admin targets -------------------------------------------------------------------------------------------------------------------------
export type TargetsResult = {ok: true; count: number; configSha256: string} | RunnerRefusal;

async function arcaneUrls(db: ForkDb): Promise<string[]> {
    return (await db.select({u: forkArcaneConnection.baseUrl}).from(forkArcaneConnection)).map((r) => r.u);
}
export async function loadConfig(db: ForkDb, serverUrl: string, adminRaw: unknown) {
    const admin = parseAdminTargets(adminRaw);
    return configOf({serverUrl, arcaneUrls: await arcaneUrls(db), admin: Array.isArray(admin) ? admin : []});
}

export async function setRunnerTargets(d: RunnerDeps, raw: unknown): Promise<TargetsResult> {
    const parsed = TargetsInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const {agentId, targets} = parsed.data;
    const ACTION = "fork.runner.targets_set";
    const g = await gated(d, ACTION, agentId, true);
    if ("ok" in g) return g;
    const admin = parseAdminTargets(targets);
    if (typeof admin === "string") { await denied(d, g, ACTION, admin); return refuse(admin, msg(admin)); }
    return withForkLock(d.db, `runner:${agentId}`, async (tx): Promise<TargetsResult> => {
        const [row] = await tx.select({a: forkRunner.agentId}).from(forkRunner).where(eq(forkRunner.agentId, agentId));
        if (!row) { await denied(d, g, ACTION, "not_a_runner", tx); return refuse("not_a_runner", msg("not_a_runner")); }
        const now = chNow(d);
        await tx.update(forkRunner).set({probeTargets: admin as AdminTarget[], updatedAt: now}).where(eq(forkRunner.agentId, agentId));
        const {sha256} = await loadConfig(tx, d.serverUrl(), admin);
        await recordAudit(tx, {organizationId: g.organizationId, actorUserId: g.userId, action: ACTION, resourceType: "agent", resourceId: agentId, result: "success", details: {count: admin.length, configSha256: sha256}, now});
        return {ok: true, count: admin.length, configSha256: sha256};
    });
}

// ---- the probe ---------------------------------------------------------------------------------------------------------------------------------
export type ProbeRequestResult = {ok: true; taskId: string; probeId: string; targetCount: number; skipped: number; configSha256: string} | RunnerRefusal;

export async function requestRunnerProbe(d: RunnerDeps, raw: unknown): Promise<ProbeRequestResult> {
    const parsed = PlainInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const {agentId} = parsed.data;
    const ACTION = "fork.runner.probe";
    const g = await gated(d, ACTION, agentId, false);
    if ("ok" in g) return g;
    const rl = (d.rate ?? checkRate)(`runner-probe:${g.userId}`, 10, 60_000, chNow(d).getTime());
    if (!rl.ok) return refuse("rate_limited", `Too many attempts. Try again in ${rl.retryAfterSeconds} s.`, {retryAfterSeconds: rl.retryAfterSeconds});
    const el = await assertRunnerTarget(d.db, agentId);
    if (!el.ok) { await denied(d, g, ACTION, el.code); return refuse(el.code, msg(el.code)); }
    const serverUrl = d.serverUrl();
    const tp = checkChannelTransport(serverUrl, chEnv(d));
    if (!tp.ok) { await denied(d, g, ACTION, tp.code); return tp.code === "insecure_transport" ? refuse("insecure_transport", "Agent tasks need an https:// dashboard URL.") : refuse("invalid_url", "The dashboard URL is not valid."); }
    let signing: Awaited<ReturnType<ChannelDeps["keys"]["signing"]>>;
    try { signing = await d.keys.signing(); } catch { return refuse("signing_unavailable", "The dashboard signing key is not available."); }
    const {kidOfPublicKey} = await import("@/fork/manifest/sign");
    const kid = kidOfPublicKey(signing.publicKeyPem);

    const [run] = await d.db.select({probeTargets: forkRunner.probeTargets}).from(forkRunner).where(eq(forkRunner.agentId, agentId));
    const {config, sha256} = await loadConfig(d.db, serverUrl, run?.probeTargets ?? []);
    const m = await materialize(config, d.resolve ?? defaultResolve);
    if (!m.ok) { await denied(d, g, ACTION, m.code); return refuse(m.code, msg(m.code)); }
    const probeId = randomUUID();
    const payload = {v: 1 as const, probe_id: probeId, targets_sha256: targetsSha(m.targets), timeout_ms: PROBE_TIMEOUT_MS,
        targets: m.targets.map((t) => ({id: t.id, kind: t.kind, host: t.host, ...(t.port !== undefined ? {port: t.port} : {})}))};
    if (!RunnerProbePayload.safeParse(payload).success) { await denied(d, g, ACTION, "target_invalid"); return refuse("target_invalid", msg("target_invalid")); }
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const now = chNow(d);
    const ttlMs = Math.min(chEnv(d).FORK_AGENT_TASK_TTL_MINUTES * 60_000, PROBE_TASK_TTL_MS);

    return withForkLock(d.db, `agent-task:${agentId}`, async (tx): Promise<ProbeRequestResult> => {
        const [e] = await tx.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
        if (!e || e.revokedAt) return refuse("not_enrolled", msg("not_enrolled"));
        if (!e.enabled) return refuse("agent_disabled", msg("agent_disabled"));
        if (!e.capabilities.includes(RUNNER_CAPABILITY)) { await denied(d, g, ACTION, "not_attested", tx); return refuse("not_attested", msg("not_attested")); }
        const [busy] = await tx.select({n: sql<number>`count(*)::int`}).from(forkAgentTask).where(and(eq(forkAgentTask.agentId, agentId), eq(forkAgentTask.type, "runner_probe"),
            or(inArray(forkAgentTask.status, ["leased", "running"]), and(eq(forkAgentTask.status, "queued"), gte(forkAgentTask.notAfter, now)))));
        if (Number(busy?.n ?? 0) > 0) { await denied(d, g, ACTION, "probe_in_progress", tx); return refuse("probe_in_progress", msg("probe_in_progress")); }
        const taskKey = await loadTaskKey(d, e);
        const {taskId} = await insertSignedTask(tx, {e, agentName: g.agent.name, type: "runner_probe", plaintext, targetAgentId: agentId, actorUserId: g.userId, signing, kid, taskKey, now, ttlMs});
        await tx.update(forkRunner).set({lastProbeTaskId: taskId, lastProbeTargets: {probeId, targets: m.targets}, lastProbeConfigSha256: sha256, lastProbeRequestedAt: now, updatedAt: now}).where(eq(forkRunner.agentId, agentId));
        await recordAudit(tx, {organizationId: g.organizationId, actorUserId: g.userId, action: ACTION, resourceType: "agent", resourceId: agentId, result: "success", details: {taskId, targetCount: m.targets.length, configSha256: sha256}, now});
        return {ok: true, taskId, probeId, targetCount: m.targets.length, skipped: m.skipped.length, configSha256: sha256};
    });
}

// ---- the verdict ---------------------------------------------------------------------------------------------------------------------------
const StoredTargets = z.object({probeId: z.uuid(), targets: z.array(z.custom<ProbeTarget>((v) => typeof v === "object" && v !== null))});

export type IsolationOpts = {now?: Date; maxAgeMs?: number; serverUrl: string};

/** Isolation of one runner right now: loads the designation, the last probe task and the CURRENT config sha, then asks the pure evaluator. Unknown/never-probed on any gap. */
export async function runnerIsolation(db: ForkDb, agentId: string, o: IsolationOpts): Promise<RunnerIsolation> {
    const [row] = await db.select().from(forkRunner).where(eq(forkRunner.agentId, agentId));
    const el = await assertRunnerTarget(db, agentId);
    const eligibility = el.ok ? ({ok: true} as const) : ({ok: false, reason: el.code === "not_attested" ? "not_attested" : "not_a_runner"} as const);
    if (!row) return evaluateProbe({eligibility: {ok: false, reason: "not_a_runner"}, last: null, task: null, expectedConfigSha: "", now: o.now ?? new Date(), maxAgeMs: o.maxAgeMs ?? RUNNER_PROBE_DEFAULT_MAX_AGE_MS});
    const st = StoredTargets.safeParse(row.lastProbeTargets);
    const [task] = row.lastProbeTaskId ? await db.select({id: forkAgentTask.id, status: forkAgentTask.status, result: forkAgentTask.result, finishedAt: forkAgentTask.finishedAt, agentId: forkAgentTask.agentId}).from(forkAgentTask).where(eq(forkAgentTask.id, row.lastProbeTaskId)) : [];
    const {sha256} = await loadConfig(db, o.serverUrl, row.probeTargets);
    return evaluateProbe({
        eligibility,
        last: {taskId: row.lastProbeTaskId, probeId: st.success ? st.data.probeId : null, targets: st.success ? st.data.targets : null, configSha256: row.lastProbeConfigSha256},
        task: task && task.agentId === agentId ? task : null,
        expectedConfigSha: sha256,
        now: o.now ?? new Date(),
        maxAgeMs: o.maxAgeMs ?? RUNNER_PROBE_DEFAULT_MAX_AGE_MS,
    });
}

/** THE gate W22a calls before a mirror may become READY ("probe failure → mirror cannot become READY"): throws unless the runner is `isolated`. */
export async function assertRunnerReady(db: ForkDb, agentId: string, o: IsolationOpts): Promise<Extract<RunnerIsolation, {state: "isolated"}>> {
    const iso = await runnerIsolation(db, agentId, o);
    if (iso.state !== "isolated") throw new RunnerNotIsolatedError(iso);
    return iso;
}
export {RunnerNotIsolatedError};
