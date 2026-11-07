import {eq, sql} from "drizzle-orm";
import {z} from "zod";
import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import type {ServiceDeps} from "@/fork/arcane/connection-service";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkStack, forkStackPolicy, forkStackSource} from "@/fork/db/schema/stack";
import {withForkLock} from "@/fork/locks";
import {parseInventoryStrict, type StackInventoryV1} from "@/fork/inventory/schema";
import {SERVICE_NAME} from "@/fork/inventory/labels";
import {ForkLockedError, assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkResource} from "@/fork/resource-scope";
import {
    agentAclAllows, channelsAvailableTo, createMemberSource, createStackProject, dockerAccessEvidence, encryptionEnabled, getProjectName, readAgent,
    readMembers, setProjectStoragePolicies, stackProjectName, updateMemberSource, upstreamMasterKey,
} from "@/fork/upstream";
import {isAgentVersionAtLeast} from "@/utils/status-crypto";
import {FORK_MIN_AGENT_FOR_STACKS} from "@/fork/versions";
import {planStack} from "./plan";
import {SelectionSchema} from "./types";

/**
 * Stack → Portabase sources (W10). ONE pipeline, same guarantees as the W05/W06 services:
 *   principal → resource-scoped `stacks.backup.manage` (system admin only; foreign/missing id ⇒ identical `not_found`, SEC-12)
 *   → upstream-equivalent AGENT ACL (D31) → D21 gate (`assertForkConfigAllowed`) → rate limit → gates (agent mapped, version ≥ 1.24,
 *   channels usable) → pure plan → ONE transaction under a per-stack advisory lock → audit.
 * Never deletes a source (orphans are marked; removal is `remove.ts`, confirmed, only for sources that never ran). DB passwords go from the
 * input straight into the upstream-encrypted config: not in `fork_stack_policy`, not in the audit, not in the result.
 */
export const MaterializeInputSchema = z.strictObject({
    stackId: z.uuid(),
    selection: SelectionSchema.default(SelectionSchema.parse({})),
    storageChannelIds: z.array(z.uuid()).max(20).default([]),
    /** DB service name → password. Written encrypted into the upstream config only. */
    secrets: z.record(z.string().regex(SERVICE_NAME), z.string().min(1).max(512)).default({}),
    /** The operator states the agent mounts the Docker socket (no agent-side probe exists in R1, ADR-001 §G): allows ONE canary docker-volume source. */
    confirmDockerAccess: z.boolean().default(false),
});
export type MaterializeInput = z.input<typeof MaterializeInputSchema>;

export type GateReason =
    | "no_agent" | "agent_unavailable" | "agent_version" | "environment_disabled" | "channels_unavailable" | "secret_required"
    | "project_name_taken" | "method_change" | "no_inventory" | "stack_gone";
export type MaterializeDeps = ServiceDeps & {masterKey?: () => Promise<Buffer>};
export type Deferred = {key: string; reason: "docker_access_unconfirmed" | "waiting_for_canary"};
export type MaterializeResult =
    | {ok: true; planHash: string; created: number; updated: number; unchanged: number; orphaned: number; deferred: Deferred[]; skipped: {key: string; reason: string}[]; sources: {key: string; role: string; name: string; status: string}[]; noop: boolean}
    | {ok: false; code: "forbidden" | "not_found" | "locked" | "rate_limited" | "invalid_input" | "refused"; reason?: GateReason; message: string; retryAfterSeconds?: number; services?: string[]};

export const MATERIALIZE_RATE = {limit: 20, windowMs: 60_000} as const;
const refuse = (code: Extract<MaterializeResult, {ok: false}>["code"], message: string, extra: {reason?: GateReason; retryAfterSeconds?: number; services?: string[]} = {}): MaterializeResult => ({ok: false, code, message, ...extra});

class Abort extends Error {
    constructor(public readonly result: MaterializeResult) { super("abort"); }
}

export type StackContext = {
    organizationId: string; stackId: string; environmentName: string; composeProject: string; runtimeState: string; projectId: string | null;
    environmentId: string | null; agentId: string | null; environmentEnabled: boolean; allowedRoots: string[];
    inventory: StackInventoryV1 | null;
};

/** Loads the stack + its environment + the latest inventory. The organization comes from the ROW, never from the request. */
export async function loadStackContext(db: ForkDb, stackId: string): Promise<StackContext | null> {
    const r = await db.execute(sql`
        select s.id, s.organization_id, s.environment_name, s.compose_project, s.runtime_state, s.project_id, s.environment_id,
               e.agent_id, coalesce(e.enabled, false) as env_enabled, coalesce(e.allowed_path_roots, '{}'::text[]) as roots,
               (select i.inventory from fork_stack_inventory i where i.stack_id = s.id order by i.version desc limit 1) as inventory
          from fork_stack s left join fork_arcane_environment e on e.id = s.environment_id where s.id = ${stackId}`);
    const row = r.rows[0] as undefined | {id: string; organization_id: string; environment_name: string; compose_project: string; runtime_state: string; project_id: string | null; environment_id: string | null; agent_id: string | null; env_enabled: boolean; roots: string[]; inventory: unknown};
    if (!row) return null;
    let inventory: StackInventoryV1 | null = null;
    if (row.inventory) { try { inventory = parseInventoryStrict(row.inventory); } catch { inventory = null; } }
    return {organizationId: row.organization_id, stackId: row.id, environmentName: row.environment_name, composeProject: row.compose_project, runtimeState: row.runtime_state, projectId: row.project_id, environmentId: row.environment_id, agentId: row.agent_id, environmentEnabled: row.env_enabled, allowedRoots: row.roots ?? [], inventory};
}

/** Shared by apply/remove: authorise, gate, rate-limit. Returns the organization or a refusal. Denied attempts are audited. */
export async function authorizeMutation(d: MaterializeDeps, action: string, stackId: string, rateKey: string): Promise<{organizationId: string} | MaterializeResult> {
    const p = d.principal;
    const audit = (result: "denied", organizationId: string | null, details: Record<string, unknown>) =>
        recordAudit(d.db, {organizationId, actorUserId: p?.userId ?? null, action, resourceType: "stack", resourceId: stackId, result, details, now: d.now?.()});
    if (!p) return refuse("forbidden", "You must be signed in.");
    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(d.db, p, "stacks.backup.manage", {kind: "stack", id: stackId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) { await audit("denied", null, {reason: "not-found"}); return refuse("not_found", "Stack not found."); }
        if (e instanceof ForkForbiddenError) { await audit("denied", null, {reason: "forbidden", capability: e.capability}); return refuse("forbidden", "Only a system administrator can change Stack Recovery configuration."); }
        throw e;
    }
    try {
        await (d.assertConfigAllowed ?? assertForkConfigAllowed)();
    } catch (e) {
        if (e instanceof ForkLockedError) {
            await audit("denied", organizationId, {reason: e.mode === "locked" ? `locked:${e.lockReason ?? "unknown"}` : "mode-off"});
            return refuse("locked", e.mode === "locked" ? `Fork configuration is locked (${e.lockReason ?? "see status"}); fix the cause first.` : "Stack Recovery is not enabled.");
        }
        throw e;
    }
    const rate = (d.rate ?? checkRate)(`${p.userId}:${rateKey}`, MATERIALIZE_RATE.limit, MATERIALIZE_RATE.windowMs, d.now?.().getTime());
    if (!rate.ok) { await audit("denied", organizationId, {reason: "rate-limited"}); return refuse("rate_limited", `Too many attempts. Try again in ${rate.retryAfterSeconds} s.`, {retryAfterSeconds: rate.retryAfterSeconds}); }
    return {organizationId};
}

export async function materializeStack(d: MaterializeDeps, raw: unknown): Promise<MaterializeResult> {
    const parsed = MaterializeInputSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const input = parsed.data;
    const auth = await authorizeMutation(d, "fork.materialize.apply", input.stackId, "materialize");
    if (!("organizationId" in auth)) return auth;
    const {organizationId} = auth;
    const p = d.principal!;
    const audit = (result: "success" | "denied" | "failure", details: Record<string, unknown>, db: ForkDb = d.db) =>
        recordAudit(db, {organizationId, actorUserId: p.userId, action: "fork.materialize.apply", resourceType: "stack", resourceId: input.stackId, result, details, now: d.now?.()});
    const deny = async (reason: GateReason, message: string, code: "refused" | "forbidden" = "refused", extra: {services?: string[]} = {}) => {
        await audit("denied", {reason});
        return refuse(code, message, {reason, ...extra});
    };

    const ctx = await loadStackContext(d.db, input.stackId);
    if (!ctx) return refuse("not_found", "Stack not found.");
    if (ctx.runtimeState === "absent") return deny("stack_gone", "This stack is no longer on the host; nothing to protect.");
    if (!ctx.inventory) return deny("no_inventory", "No usable inventory for this stack yet; run a sync first.");
    if (!ctx.agentId) return deny("no_agent", "This environment is not mapped to a Portabase agent.");
    if (!ctx.environmentEnabled) return deny("environment_disabled", "This environment is not enabled.");
    const agent = await readAgent(d.db, ctx.agentId);
    if (!agent || agent.deleted || agent.archived) return deny("agent_unavailable", "The mapped agent is not available.");
    // D31: authorization = fork capability (checked above) AND the upstream-equivalent agent ACL.
    if (!agentAclAllows(p, agent, organizationId)) return deny("agent_unavailable", "You are not allowed to manage this agent.", "forbidden");
    if (!isAgentVersionAtLeast(agent.version ?? undefined, FORK_MIN_AGENT_FOR_STACKS)) return deny("agent_version", `Stack sources need agent ${FORK_MIN_AGENT_FOR_STACKS} or newer.`);
    if (!(await channelsAvailableTo(d.db, organizationId, input.storageChannelIds))) return deny("channels_unavailable", "A selected storage channel is not available to this organization.");

    const plan = planStack(ctx.inventory, input.selection, ctx.allowedRoots);
    const existing = await d.db.select().from(forkStackSource).where(eq(forkStackSource.stackId, input.stackId));
    const byKey = new Map(existing.map((l) => [l.resourceKey, l]));

    // Method is fixed after creation upstream: a different engine for an existing member is a conflict the operator must resolve.
    for (const s of plan.sources) {
        const cur = byKey.get(s.resourceKey);
        if (cur && cur.status !== "planned" && cur.databaseId && cur.engine !== s.engine) return deny("method_change", "The backup method of an existing source cannot be changed. Remove the source first (only possible before its first backup).");
    }
    // Secrets only for sources that will be CREATED now (an existing member keeps its stored credential).
    const needSecret = plan.sources.filter((s) => s.needsSecret && s.secretFor && !byKey.get(s.resourceKey)?.databaseId && input.secrets[s.secretFor] === undefined);
    if (needSecret.length) return deny("secret_required", "A database credential is required for the selected database source.", "refused", {services: needSecret.map((s) => s.secretFor as string)});

    const masterKey = await (d.masterKey ?? upstreamMasterKey)();
    const evidence = await dockerAccessEvidence(d.db, agent.id, existing.flatMap((l) => (l.databaseId && l.status === "canary" ? [l.databaseId] : [])));
    const deferred: Deferred[] = [];
    const counts = {created: 0, updated: 0, unchanged: 0, orphaned: 0};
    const now = d.now?.() ?? new Date();

    try {
        const out = await withForkLock(d.db, `materialize:${input.stackId}`, async (tx) => {
            // ---- Project (stack-owned, no cron, no retention: D30/D33) --------------------------------------------------------
            let projectId = ctx.projectId && (await getProjectName(tx, ctx.projectId)) ? ctx.projectId : null;
            if (!projectId) {
                const name = stackProjectName(ctx.environmentName, ctx.composeProject);
                const created = await createStackProject(tx, {organizationId, name});
                if (!created) throw new Abort(refuse("refused", "A project with this name already exists and is not managed by this stack.", {reason: "project_name_taken"}));
                projectId = created.id;
                await tx.update(forkStack).set({projectId, projectName: name, updatedAt: now}).where(eq(forkStack.id, input.stackId));
            }
            const channels = await setProjectStoragePolicies(tx, projectId, input.storageChannelIds);

            // ---- sources ---------------------------------------------------------------------------------------------------------
            let canaryAvailable = true; // at most ONE docker-volume source is created without evidence
            const wanted = new Set(plan.sources.map((s) => s.resourceKey));
            const result: {key: string; role: string; name: string; status: string}[] = [];
            for (const s of plan.sources) {
                const cur = byKey.get(s.resourceKey);
                const secretsFor: Record<string, string> = s.secretFor && input.secrets[s.secretFor] ? {password: input.secrets[s.secretFor]} : {};
                const sameShape = cur && cur.desiredHash === s.configHash && [...cur.coversKeys].sort().join("\n") === [...s.covers].sort().join("\n") && cur.role === s.role && cur.origin === s.origin;

                if (cur?.databaseId && cur.status !== "orphaned" && cur.status !== "drifted" && sameShape && Object.keys(secretsFor).length === 0) {
                    counts.unchanged++;
                    result.push({key: s.resourceKey, role: s.role, name: cur.memberName, status: cur.status});
                    continue;
                }
                const live = cur?.databaseId ? (await readMembers(tx, [cur.databaseId])).get(cur.databaseId) : undefined;
                if (cur && live && live.deletedAt === null && live.projectId === projectId) {
                    // repair/update an existing member: config + name only, never dbms/engine
                    await updateMemberSource(tx, {id: live.id, name: s.memberName, config: s.config, secrets: secretsFor, masterKey});
                    await tx.update(forkStackSource).set({status: cur.status === "canary" ? "canary" : "active", memberName: s.memberName, coversKeys: [...s.covers], desiredHash: s.configHash, driftReason: null, origin: s.origin, role: s.role, required: true, updatedAt: now}).where(eq(forkStackSource.id, cur.id));
                    counts.updated++;
                    result.push({key: s.resourceKey, role: s.role, name: s.memberName, status: cur.status === "canary" ? "canary" : "active"});
                    continue;
                }
                // needs an upstream row: the Docker gate (CH-22c) applies to docker-volume only
                let createNow = true; let status: "active" | "canary" = "active";
                if (s.requiresDocker && !evidence) {
                    if (input.confirmDockerAccess && canaryAvailable && !existing.some((l) => l.status === "canary" && l.databaseId)) { status = "canary"; canaryAvailable = false; }
                    else { createNow = false; deferred.push({key: s.resourceKey, reason: input.confirmDockerAccess ? "waiting_for_canary" : "docker_access_unconfirmed"}); }
                }
                if (!createNow && cur && cur.status === "planned" && !cur.databaseId && sameShape) {
                    counts.unchanged++; // still waiting for Docker evidence: nothing to write
                    result.push({key: s.resourceKey, role: s.role, name: cur.memberName, status: "planned"});
                    continue;
                }
                let databaseId: string | null = null;
                if (createNow) {
                    databaseId = (await createMemberSource(tx, {agentId: agent.id, projectId, name: s.memberName, dbms: s.dbms, engine: s.engine, config: s.config, secrets: secretsFor, masterKey})).id;
                }
                const st = createNow ? status : "planned";
                const row = {stackId: input.stackId, role: s.role, resourceKey: s.resourceKey, origin: s.origin, required: true, status: st, databaseId, dbms: s.dbms, engine: s.engine, memberName: s.memberName, coversKeys: [...s.covers], desiredHash: s.configHash, driftReason: null, lastProbe: null, lastProbeAt: null, updatedAt: now};
                if (cur) await tx.update(forkStackSource).set(row).where(eq(forkStackSource.id, cur.id));
                else await tx.insert(forkStackSource).values(row);
                counts.created++;
                result.push({key: s.resourceKey, role: s.role, name: s.memberName, status: st});
            }
            // Sources the plan no longer wants: marked, NEVER deleted (confirmed removal is a separate action).
            for (const l of existing) {
                if (wanted.has(l.resourceKey) || l.status === "orphaned") continue;
                await tx.update(forkStackSource).set({status: "orphaned", driftReason: "not_in_plan", updatedAt: now}).where(eq(forkStackSource.id, l.id));
                counts.orphaned++;
                result.push({key: l.resourceKey, role: l.role, name: l.memberName, status: "orphaned"});
            }

            const hasDump = plan.sources.some((s) => s.coverage === "engine_dump" && s.role === "db");
            await tx.insert(forkStackPolicy).values({stackId: input.stackId, selection: input.selection, storageChannelIds: input.storageChannelIds, consistencyProfile: hasDump ? "dump" : "crash", appliedPlanHash: plan.planHash, materializedAt: now, materializeState: "ready", updatedAt: now})
                .onConflictDoUpdate({target: forkStackPolicy.stackId, set: {selection: input.selection, storageChannelIds: input.storageChannelIds, consistencyProfile: hasDump ? "dump" : "crash", appliedPlanHash: plan.planHash, materializedAt: now, materializeState: "ready", updatedAt: now}});

            const noop = counts.created + counts.updated + counts.orphaned + channels.added + channels.removed === 0;
            // names only: no config, no credential, no secret-bearing key (redaction also applies)
            await audit("success", {planHash: plan.planHash, ...counts, deferred: deferred.length, skipped: plan.skipped.length, channels: input.storageChannelIds.length, canary: input.confirmDockerAccess && !evidence, dockerEvidence: evidence, noop}, tx);
            return {result, noop};
        });
        return {ok: true, planHash: plan.planHash, ...counts, deferred, skipped: plan.skipped, sources: out.result, noop: out.noop};
    } catch (e) {
        if (e instanceof Abort) { await audit("denied", {reason: e.result.ok ? "unknown" : (e.result.reason ?? "refused")}); return e.result; }
        await audit("failure", {error: e instanceof Error ? e.name : "unknown"});
        throw e;
    }
}

/** D39: a stack policy can only be ACTIVATED while `setting.encryption = true` (W11 calls this before activation; also surfaced as a blocker). */
export async function assertEncryptionForActivation(db: ForkDb): Promise<{ok: true} | {ok: false; reason: "encryption_required"}> {
    return (await encryptionEnabled(db)) ? {ok: true} : {ok: false, reason: "encryption_required"};
}
