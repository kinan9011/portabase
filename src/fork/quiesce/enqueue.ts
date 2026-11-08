import {eq} from "drizzle-orm";
import {agent} from "@/db/schema/08_agent";
import {loadTaskKey} from "@/fork/agent-channel/admin";
import {chEnv, chNow, type ChannelDeps} from "@/fork/agent-channel/deps";
import {insertSignedTask} from "@/fork/agent-channel/tasks";
import {checkChannelTransport} from "@/fork/agent-channel/transport-policy";
import {MAX_PAYLOAD_BYTES, TASK_REQUIRES, type TaskType} from "@/fork/agent-channel/vocab";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {withForkLock} from "@/fork/locks";
import {buildQuiesceStartPayload, buildQuiescePayload, QuiescePayloadSchema, QuiesceStartPayloadSchema} from "./payload";
import type {OkPlan} from "./plan";
import {START_TIMEOUT_S, STOP_TIMEOUT_CAP_S} from "./vocab";

/**
 * The ONLY builder of `quiesce` / `quiesce_start` tasks (W17b, ADR-007 A15; the generic `enqueueTask` never accepts them, a static test pins that).
 * Callers: the run engine's `quiesce_stop` step (acts as the recorded ENABLER, rights re-checked by `decideQuiesce`), the admin "Start now" / dry-run actions
 * (principal + ACL checked in `service.ts`). Order, fail closed, every denial audited with ids and codes only: enrolment active + enabled → capability →
 * https → strict payload → size → signing key → sign + insert (targeted at the enrolled agent). Payloads carry NO secret and no free-form field.
 */
export type QuiesceTaskDeps = Omit<ChannelDeps, "principal"> & {principal?: ChannelDeps["principal"]};
export type QuiesceEnqueueRefusal = "not_enrolled" | "agent_disabled" | "capability_missing" | "insecure_transport" | "signing_unavailable" | "payload_too_large" | "invalid_input";
export type QuiesceEnqueueResult = {ok: true; taskId: string} | {ok: false; code: QuiesceEnqueueRefusal};

type Common = {agentId: string; actorUserId: string; stackId: string; runId: string | null; orgId?: string | null; onInserted?: (tx: ForkDb, taskId: string) => Promise<void>};

async function enqueue(deps: QuiesceTaskDeps, type: "quiesce" | "quiesce_start", plaintext: Buffer, c: Common, auditDetails: Record<string, unknown>): Promise<QuiesceEnqueueResult> {
    const d: ChannelDeps = {...deps, principal: deps.principal ?? null};
    const now = chNow(d);
    const audit = (result: "success" | "denied", details: Record<string, unknown>, db: ForkDb = d.db) =>
        recordAudit(db, {organizationId: c.orgId ?? null, actorUserId: c.actorUserId, action: result === "success" ? "fork.quiesce.enqueue" : "fork.quiesce.denied", resourceType: "stack", resourceId: c.stackId, result, details: {type, runId: c.runId, ...details}, now});
    const deny = async (code: QuiesceEnqueueRefusal, db: ForkDb = d.db): Promise<QuiesceEnqueueResult> => {
        await audit("denied", {reason: code}, db);
        return {ok: false, code};
    };
    const schema = type === "quiesce" ? QuiescePayloadSchema : QuiesceStartPayloadSchema;
    if (!schema.safeParse(JSON.parse(plaintext.toString("utf8"))).success) return deny("invalid_input");
    if (plaintext.length > MAX_PAYLOAD_BYTES) return deny("payload_too_large");
    const tp = checkChannelTransport(d.serverUrl(), chEnv(d));
    if (!tp.ok) return deny("insecure_transport");
    let signing: Awaited<ReturnType<ChannelDeps["keys"]["signing"]>>;
    try { signing = await d.keys.signing(); } catch { return deny("signing_unavailable"); }
    const {kidOfPublicKey} = await import("@/fork/manifest/sign");
    const kid = kidOfPublicKey(signing.publicKeyPem);
    const [a] = await d.db.select({name: agent.name}).from(agent).where(eq(agent.id, c.agentId));
    if (!a) return deny("not_enrolled");
    const ttlMs = chEnv(d).FORK_AGENT_TASK_TTL_MINUTES * 60_000;
    return withForkLock(d.db, `agent-task:${c.agentId}`, async (tx): Promise<QuiesceEnqueueResult> => {
        const [e] = await tx.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, c.agentId));
        if (!e || e.revokedAt) return deny("not_enrolled", tx);
        if (!e.enabled) return deny("agent_disabled", tx);
        if (!TASK_REQUIRES[type as TaskType].every((cap) => e.capabilities.includes(cap))) return deny("capability_missing", tx);
        const taskKey = await loadTaskKey(d, e);
        const t = await insertSignedTask(tx, {e, agentName: a.name, type, plaintext, targetAgentId: c.agentId, actorUserId: c.actorUserId, signing, kid, taskKey, now, ttlMs});
        if (c.onInserted) await c.onInserted(tx, t.taskId); // same transaction: a throw rolls the task back
        await audit("success", {taskId: t.taskId, ...auditDetails}, tx);
        return {ok: true, taskId: t.taskId};
    });
}

export async function enqueueQuiesceTask(d: QuiesceTaskDeps, i: Common & {project: string; plan: OkPlan; maxStopSeconds: number; dryRun?: boolean}): Promise<QuiesceEnqueueResult> {
    let payload: ReturnType<typeof buildQuiescePayload>;
    try {
        payload = buildQuiescePayload({runId: i.runId ?? "00000000-0000-4000-8000-000000000000", stackId: i.stackId, project: i.project, targets: i.plan.stopOrder, maxStopSeconds: i.maxStopSeconds,
            stopTimeoutCapSeconds: STOP_TIMEOUT_CAP_S, startTimeoutSeconds: START_TIMEOUT_S, dryRun: i.dryRun === true});
    } catch { return {ok: false, code: "invalid_input"}; }
    return enqueue(d, "quiesce", Buffer.from(JSON.stringify(payload), "utf8"), i, {services: i.plan.stopOrder.map((t) => t.service), count: i.plan.stopOrder.length, maxStopSeconds: i.maxStopSeconds, dryRun: i.dryRun === true});
}

export async function enqueueQuiesceStart(d: QuiesceTaskDeps, i: Common & {quiesceTaskId: string; project: string}): Promise<QuiesceEnqueueResult> {
    let payload: ReturnType<typeof buildQuiesceStartPayload>;
    try { payload = buildQuiesceStartPayload({quiesceTaskId: i.quiesceTaskId, project: i.project}); } catch { return {ok: false, code: "invalid_input"}; }
    return enqueue(d, "quiesce_start", Buffer.from(JSON.stringify(payload), "utf8"), i, {quiesceTaskId: i.quiesceTaskId});
}
