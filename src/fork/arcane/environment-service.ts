import {and, eq, sql} from "drizzle-orm";
import {z} from "zod";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import type {Refusal, RefusalCode, ServiceDeps} from "@/fork/arcane/connection-service";
import {EnvironmentDtoSchema, ENVIRONMENT_PUBLIC_COLUMNS, toEnvironmentDto, type EnvironmentDto} from "@/fork/arcane/environment-dto";
import {recordAudit} from "@/fork/audit";
import {HOST_ROLES} from "@/fork/db/enums";
import type {ForkDb} from "@/fork/db/handle";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {ForkLockedError, assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkResource} from "@/fork/resource-scope";

/**
 * Per-environment settings (W06, scope "enable toggle, agent mapping, host role"): `enabled`, `agent_id`, `host_role`.
 * Same pipeline and guarantees as the connection use-cases (W05, ADR-012 S8):
 *   principal → resource-scoped `arcane.manage` (system admin only, foreign/missing id ⇒ identical `not_found`, SEC-12)
 *   → `host_role.manage` too when the role changes (SEC-11) → D21 gate (`assertForkConfigAllowed`) → rate limit
 *   → agent must be unbound or bound to THIS organization (D21 self-check rule) → ONE transaction = update + audit row.
 * Denied attempts are audited. Never touches the Arcane key or the network.
 */
export const EnvironmentUpdateSchema = z.strictObject({
    environmentId: z.uuid(),
    enabled: z.boolean().optional(),
    agentId: z.uuid().nullable().optional(),
    hostRole: z.enum(HOST_ROLES).optional(),
}).refine((v) => v.enabled !== undefined || v.agentId !== undefined || v.hostRole !== undefined, {message: "nothing to change"});

export const ENV_RATE_LIMIT = {limit: 30, windowMs: 60_000} as const;
const ACTION = "fork.arcane.environment.update";

export type EnvironmentOutcome = {ok: true; environment: EnvironmentDto; changed: string[]} | Refusal;
const refuse = (code: RefusalCode, message: string, extra: Partial<Refusal> = {}): Refusal => ({ok: false, code, message, ...extra});

export async function updateEnvironment(d: ServiceDeps, raw: unknown): Promise<EnvironmentOutcome> {
    const parsed = EnvironmentUpdateSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const input = parsed.data;
    const p = d.principal;
    const audit = (result: "success" | "denied" | "failure", organizationId: string | null, details: Record<string, unknown>, db: ForkDb = d.db) =>
        recordAudit(db, {organizationId, actorUserId: p?.userId ?? null, action: ACTION, resourceType: "arcane_environment", resourceId: input.environmentId, result, details, now: d.now?.()});
    if (!p) return refuse("forbidden", "You must be signed in.");

    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(d.db, p, "arcane.manage", {kind: "environment", id: input.environmentId}));
        if (input.hostRole !== undefined && !forkCan(actorIn(p, organizationId), "host_role.manage")) throw new ForkForbiddenError("host_role.manage");
    } catch (e) {
        if (e instanceof ForkNotFoundError) {
            await audit("denied", null, {reason: "not-found"});
            return refuse("not_found", "Environment not found.");
        }
        if (e instanceof ForkForbiddenError) {
            await audit("denied", null, {reason: "forbidden", capability: e.capability});
            return refuse("forbidden", "Only a system administrator can change Stack Recovery configuration.");
        }
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
    const rate = (d.rate ?? checkRate)(`${p.userId}:arcane:env`, ENV_RATE_LIMIT.limit, ENV_RATE_LIMIT.windowMs, d.now?.().getTime());
    if (!rate.ok) {
        await audit("denied", organizationId, {reason: "rate-limited"});
        return refuse("rate_limited", `Too many attempts. Try again in ${rate.retryAfterSeconds} s.`, {retryAfterSeconds: rate.retryAfterSeconds});
    }

    let agentName: string | null | undefined;
    if (input.agentId) {
        // D21: an environment may only be mapped to an agent that is unbound or belongs to the single organization.
        const r = await d.db.execute(sql`
            select a.name from agents a
             where a.id = ${input.agentId} and a.deleted_at is null and coalesce(a.is_archived, false) = false
               and (a.organization_id is null or a.organization_id = ${organizationId})
               and not exists (select 1 from organization_agents oa where oa.agent_id = a.id and oa.organization_id <> ${organizationId})`);
        if (!r.rows.length) {
            await audit("denied", organizationId, {reason: "agent-not-available"});
            return refuse("invalid_input", "That agent is not available for this organization.");
        }
        // FORK(w21): a designated mirror runner is a dedicated host and never an Arcane environment's agent (ADR-008 DD-1/DD-2)
        const runner = await d.db.execute(sql`select 1 from fork_runner where agent_id = ${input.agentId}`);
        if (runner.rows.length) {
            await audit("denied", organizationId, {reason: "agent-is-runner"});
            return refuse("invalid_input", "That agent is a mirror runner, so it cannot be mapped to an Arcane environment.");
        }
        agentName = String((r.rows[0] as {name: string}).name).slice(0, 256);
    } else if (input.agentId === null) {
        agentName = null;
    }

    return d.db.transaction(async (tx0) => {
        const tx = tx0 as unknown as ForkDb;
        const [before] = await tx.select(ENVIRONMENT_PUBLIC_COLUMNS).from(forkArcaneEnvironment).where(eq(forkArcaneEnvironment.id, input.environmentId));
        if (!before) return refuse("not_found", "Environment not found.");
        const set: Partial<typeof forkArcaneEnvironment.$inferInsert> = {updatedAt: new Date()};
        const changed: string[] = [];
        const from: Record<string, unknown> = {};
        const to: Record<string, unknown> = {};
        if (input.enabled !== undefined && input.enabled !== before.enabled) { set.enabled = input.enabled; changed.push("enabled"); from.enabled = before.enabled; to.enabled = input.enabled; }
        if (input.agentId !== undefined && input.agentId !== before.agentId) { set.agentId = input.agentId; set.agentName = agentName ?? null; changed.push("agent"); from.agentId = before.agentId; to.agentId = input.agentId; }
        if (input.hostRole !== undefined && input.hostRole !== before.hostRole) { set.hostRole = input.hostRole; changed.push("hostRole"); from.hostRole = before.hostRole; to.hostRole = input.hostRole; }
        if (changed.length) await tx.update(forkArcaneEnvironment).set(set).where(eq(forkArcaneEnvironment.id, input.environmentId));
        await audit("success", organizationId, {changed, from, to, noop: changed.length === 0}, tx);
        const [after] = await tx.select(ENVIRONMENT_PUBLIC_COLUMNS).from(forkArcaneEnvironment).where(and(eq(forkArcaneEnvironment.id, input.environmentId)));
        return {ok: true as const, environment: EnvironmentDtoSchema.parse(toEnvironmentDto(after)), changed};
    });
}
