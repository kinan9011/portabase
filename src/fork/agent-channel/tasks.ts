import {randomBytes, randomUUID} from "node:crypto";
import {and, asc, eq, inArray, lt, sql} from "drizzle-orm";
import {z} from "zod";
import {actorIn, forkCan} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {agent} from "@/db/schema/08_agent";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment, forkAgentTask} from "@/fork/db/schema/agent-channel";
import {withForkLock} from "@/fork/locks";
import {assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {loadTaskKey} from "./admin";
import type {Enrollment} from "./auth";
import {chEnv, chNow, type ChannelDeps} from "./deps";
import {signEnvelope, type Envelope} from "./envelope";
import {encryptPayload, payloadSha256} from "./payload";
import {checkChannelTransport} from "./transport-policy";
import {RESTORE_REASONS} from "@/fork/restore-tasks/codes";
import {ApplyPayload, CleanupPayload, DbPayload, ProbePayload, RenderPayload, StagePayload, UpPayload} from "@/fork/restore-tasks/payload-schema";
import {CAPABILITY_RE, KID_RE, MAX_CAPABILITIES, MAX_PAYLOAD_BYTES, MAX_PINS, MAX_RESULT_BYTES, NOOP_ECHO_RE, PIN_PEM_MAX, PUBLIC_TASK_TYPES, TARGETED_TASK_TYPES, TASK_REQUIRES, type TaskType} from "./vocab";
import {redactDetails} from "@/fork/audit";

/**
 * Task queue (ADR-007 D1/D3/D4/D7). Enqueue is an audited, admin-gated MUTATION; lease / heartbeat / result are agent calls already authenticated by
 * `authenticateAgent`. All state changes of one agent run under one advisory lock (`agent-task:<agentId>`), so `seq` allocation, lease hand-out and
 * expiry never interleave. A task is leased only by the agent it was signed for: every query filters on `agent_id` AND the enrolment generation.
 */
const MAX_ATTEMPTS = 5;
const REASONS = ["bad_signature", "unknown_kid", "bad_envelope", "agent_mismatch", "enroll_mismatch", "expired", "not_yet_valid", "replayed", "seq_rollback", "unsupported_type", "capability_missing", "payload_hash", "payload_invalid", "channel_disabled", "state_unavailable", "target_mismatch", "execution_error", ...RESTORE_REASONS] as const;
export type ResultReason = (typeof REASONS)[number];

type Refusal = {ok: false; code: "forbidden" | "locked" | "rate_limited" | "invalid_input" | "not_enrolled" | "insecure_transport" | "invalid_url" | "capability_missing" | "agent_disabled" | "signing_unavailable"; message: string; retryAfterSeconds?: number};
const refuse = (code: Refusal["code"], message: string, extra: Partial<Refusal> = {}): Refusal => ({ok: false, code, message, ...extra});

const EnqueueInput = z.strictObject({
    agentId: z.uuid(),
    type: z.enum(PUBLIC_TASK_TYPES),
    payload: z.record(z.string(), z.unknown()).default({}),
});

const PAYLOAD_SCHEMAS: Record<TaskType, z.ZodType> = {
    noop: z.strictObject({echo: z.string().regex(NOOP_ECHO_RE)}),
    pin_add: z.strictObject({kid: z.string().regex(KID_RE), pem: z.string().max(PIN_PEM_MAX)}),
    pin_revoke: z.strictObject({kid: z.string().regex(KID_RE)}),
    rotate_credential: z.strictObject({credential: z.string().regex(/^fork\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)}),
    restore_probe: ProbePayload, restore_stage: StagePayload, restore_apply: ApplyPayload, restore_cleanup: CleanupPayload,
    compose_render: RenderPayload, restore_db: DbPayload, compose_up: UpPayload,
};

/** Per-type payload validation (closed: unknown keys are refused). */
export function validatePayload(type: TaskType, payload: Record<string, unknown>): string | null {
    return PAYLOAD_SCHEMAS[type].safeParse(payload).success ? null : "payload_invalid";
}

/** Agent-reported pinned kids (from a `pin_*` result): 1..MAX_PINS distinct kids, else `null` (the caller then keeps the old value). */
export function sanitizePinned(input: unknown): string[] | null {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_PINS) return null;
    if (!input.every((k): k is string => typeof k === "string" && KID_RE.test(k))) return null;
    const uniq = [...new Set(input)].sort();
    return uniq.length === input.length ? uniq : null;
}

const CLEAR_PENDING = {pendingCredentialHash: null, pendingTaskId: null, pendingValidUntil: null} as const;

/** Drop a pending rotation that can no longer be proven: its window passed, or its task ended without the agent ever receiving it (A12). */
export async function clearStalePending(tx: ForkDb, agentId: string, now: Date): Promise<void> {
    await tx.update(forkAgentEnrollment).set(CLEAR_PENDING).where(and(eq(forkAgentEnrollment.agentId, agentId), sql`${forkAgentEnrollment.pendingTaskId} IS NOT NULL`, sql`(
        ${forkAgentEnrollment.pendingValidUntil} < ${now}
        OR EXISTS (SELECT 1 FROM fork_agent_task t WHERE t.id = ${forkAgentEnrollment.pendingTaskId} AND t.attempts = 0 AND (t.status IN ('expired', 'cancelled', 'failed') OR (t.status = 'queued' AND t.not_after < ${now}))))`));
}

/** Sign + encrypt + insert one task for an enrolment (caller holds `agent-task:<agentId>` and has already authorised the action). */
export async function insertSignedTask(tx: ForkDb, a: {e: Enrollment; agentName: string; type: TaskType; plaintext: Buffer; targetAgentId?: string; actorUserId: string; signing: {privateKeyPem: string}; kid: string; taskKey: Buffer; now: Date; ttlMs: number}): Promise<{taskId: string; seq: number; notAfter: Date}> {
    const {e, type, plaintext, now} = a;
    const agentId = e.agentId!;
    // DD2: restore-class tasks are bound to the agent that must execute them; the agent refuses a missing / foreign target, we never sign one.
    const targeted = (TARGETED_TASK_TYPES as readonly string[]).includes(type);
    if (targeted && a.targetAgentId !== agentId) throw new Error("targeted task type needs target_agent_id equal to the enrolled agent");
    if (!targeted && a.targetAgentId !== undefined) throw new Error("target_agent_id is only for targeted task types");
    const requires = [...TASK_REQUIRES[type]];
    const taskId = randomUUID();
    const [{seq}] = await tx.update(forkAgentEnrollment).set({nextSeq: sql`${forkAgentEnrollment.nextSeq} + 1`}).where(eq(forkAgentEnrollment.id, e.id)).returning({seq: sql<number>`${forkAgentEnrollment.nextSeq} - 1`});
    const notAfter = new Date(now.getTime() + a.ttlMs);
    const envelope: Envelope = {v: 1, task_id: taskId, agent_id: agentId, enroll_id: e.enrollId, type, seq, issued_at: Math.floor(now.getTime() / 1000), not_after: Math.floor(notAfter.getTime() / 1000),
        nonce: randomBytes(16).toString("base64url"), payload_sha256: payloadSha256(plaintext), requires, kid: a.kid, ...(targeted ? {target_agent_id: agentId} : {})};
    const signed = signEnvelope(envelope, a.signing.privateKeyPem);
    await tx.insert(forkAgentTask).values({id: taskId, agentId, agentName: a.agentName, enrollId: e.enrollId, type, requires, seq, envelopeText: signed.text, signature: signed.signature, kid: a.kid,
        payloadEnc: encryptPayload(a.taskKey, {taskId, agentId, type}, plaintext), payloadSha256: envelope.payload_sha256, status: "queued", createdBy: a.actorUserId, createdAt: now, notAfter});
    return {taskId, seq, notAfter};
}

export type EnqueueResult = {ok: true; taskId: string; seq: number; notAfter: string} | Refusal;

export async function enqueueTask(d: ChannelDeps, raw: unknown): Promise<EnqueueResult> {
    const parsed = EnqueueInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const {agentId, type, payload} = parsed.data;
    const p = d.principal;
    const [a] = await d.db.select({id: agent.id, name: agent.name, organizationId: agent.organizationId}).from(agent).where(eq(agent.id, agentId));
    const orgId = a?.organizationId ?? null;
    const actor = p ? (orgId ? actorIn(p, orgId) : null) ?? {systemRole: p.systemRole ?? null, orgRole: null} : null;
    const audit = (result: "success" | "denied", details: Record<string, unknown>, db: ForkDb = d.db) =>
        recordAudit(db, {organizationId: orgId, actorUserId: p?.userId ?? null, action: "fork.agent_task.enqueue", resourceType: "agent", resourceId: agentId, result, details, now: chNow(d)});
    // W17+ adds restore/compose types with their own capability (`restore.execute`); `noop` is a channel diagnostic.
    if (!p || !forkCan(actor, "agents.channel.manage")) { if (p) await audit("denied", {reason: "forbidden", type}); return refuse("forbidden", "You are not allowed to queue agent tasks."); }
    if (!a) return refuse("not_enrolled", "This agent is not enrolled for the fork channel.");
    const allowed = d.configAllowed ? await d.configAllowed() : await assertForkConfigAllowed().then(() => true, () => false);
    if (!allowed) { await audit("denied", {reason: "locked", type}); return refuse("locked", "Fork configuration is locked or switched off."); }
    const rl = (d.rate ?? checkRate)(`agent-task-enqueue:${p.userId}`, 30, 60_000, chNow(d).getTime());
    if (!rl.ok) return refuse("rate_limited", `Too many attempts. Try again in ${rl.retryAfterSeconds} s.`, {retryAfterSeconds: rl.retryAfterSeconds});
    const bad = validatePayload(type, payload);
    if (bad) return refuse("invalid_input", "The task payload is not valid for this task type.");
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    if (plaintext.length > MAX_PAYLOAD_BYTES) return refuse("invalid_input", "The task payload is too large.");
    const tp = checkChannelTransport(d.serverUrl(), chEnv(d));
    if (!tp.ok) { await audit("denied", {reason: tp.code, type}); return tp.code === "insecure_transport" ? refuse("insecure_transport", "Agent tasks need an https:// dashboard URL.") : refuse("invalid_url", "The dashboard URL is not valid."); }
    let signing: Awaited<ReturnType<ChannelDeps["keys"]["signing"]>>;
    try { signing = await d.keys.signing(); } catch { return refuse("signing_unavailable", "The dashboard signing key is not available."); }
    const {kidOfPublicKey} = await import("@/fork/manifest/sign");
    const kid = kidOfPublicKey(signing.publicKeyPem);
    const now = chNow(d);
    const ttlMs = chEnv(d).FORK_AGENT_TASK_TTL_MINUTES * 60_000;

    return withForkLock(d.db, `agent-task:${agentId}`, async (tx): Promise<EnqueueResult> => {
        const [e] = await tx.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
        if (!e || e.revokedAt) return refuse("not_enrolled", "This agent is not enrolled for the fork channel.");
        if (!e.enabled) return refuse("agent_disabled", "The task channel of this agent is switched off.");
        const requires = [...TASK_REQUIRES[type]];
        if (!requires.every((c) => e.capabilities.includes(c))) { await audit("denied", {reason: "capability_missing", type, requires}, tx); return refuse("capability_missing", "This agent has not reported that it can do this yet."); }
        const taskKey = await loadTaskKey(d, e);
        const {taskId, seq, notAfter} = await insertSignedTask(tx, {e, agentName: a.name, type, plaintext, actorUserId: p.userId, signing, kid, taskKey, now, ttlMs});
        await audit("success", {taskId, type, seq, enrollId: e.enrollId}, tx);
        return {ok: true, taskId, seq, notAfter: notAfter.toISOString()};
    });
}

export type LeasedTask = {task_id: string; envelope: string; signature: string; kid: string; payload_enc: string | null; lease_id: string; lease_until: string};

/** Reported capabilities: grammar-checked, de-duplicated, bounded. Anything else is dropped (never trusted as free text). */
export function sanitizeCapabilities(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return [...new Set(input.filter((c): c is string => typeof c === "string" && c.length <= 80 && CAPABILITY_RE.test(c)))].slice(0, MAX_CAPABILITIES).sort();
}

/** Returns zero or one signed task (ADR-007 D1). The caller (route) is already authenticated; `e` is the authenticated enrolment. */
export async function leaseTask(db: ForkDb, e: Enrollment, a: {capabilities: unknown; leaseSeconds: number; now?: Date}): Promise<LeasedTask | null> {
    const now = a.now ?? new Date();
    const caps = sanitizeCapabilities(a.capabilities);
    return withForkLock(db, `agent-task:${e.agentId}`, async (tx) => {
        await tx.update(forkAgentEnrollment).set({capabilities: caps, capabilitiesSeenAt: now}).where(eq(forkAgentEnrollment.id, e.id));
        const mine = and(eq(forkAgentTask.agentId, e.agentId!), eq(forkAgentTask.enrollId, e.enrollId));
        // 1. never-started tasks past their start deadline expire (payload purged, SEC-08)
        //    `attempts = 0`: `not_after` only limits STARTING (ADR-007 D3). A task the agent already accepted (attempts ≥ 1) whose lease lapsed is re-queued and
        //    handed out again so the agent re-reports its stored outcome (A2 Duplicate) instead of the result being lost to an expiry (W17 G9).
        await tx.update(forkAgentTask).set({status: "expired", finishedAt: now, leaseId: null, leaseUntil: null, payloadEnc: null})
            .where(and(mine, inArray(forkAgentTask.status, ["queued", "leased"]), lt(forkAgentTask.notAfter, now), eq(forkAgentTask.attempts, 0)));
        // 2. an unrenewed lease returns the task to the queue (at-least-once); too many attempts ⇒ failed
        await tx.update(forkAgentTask).set({status: "failed", finishedAt: now, leaseId: null, leaseUntil: null, payloadEnc: null, result: {reason: "lease_lost"}})
            .where(and(mine, inArray(forkAgentTask.status, ["leased", "running"]), lt(forkAgentTask.leaseUntil, now), sql`${forkAgentTask.attempts} >= ${MAX_ATTEMPTS}`));
        await tx.update(forkAgentTask).set({status: "queued", leaseId: null, leaseUntil: null})
            .where(and(mine, inArray(forkAgentTask.status, ["leased", "running"]), lt(forkAgentTask.leaseUntil, now)));
        await clearStalePending(tx, e.agentId!, now);
        // 3. one task in flight at a time: an unexpired lease is handed out again (same lease id) — the agent dedups by task id
        const [inflight] = await tx.select().from(forkAgentTask).where(and(mine, inArray(forkAgentTask.status, ["leased", "running"]))).orderBy(asc(forkAgentTask.seq)).limit(1);
        const leaseUntil = new Date(now.getTime() + a.leaseSeconds * 1000);
        const t = inflight ?? (await tx.select().from(forkAgentTask).where(and(mine, eq(forkAgentTask.status, "queued"))).orderBy(asc(forkAgentTask.seq)).limit(1))[0];
        if (!t) return null;
        const leaseId = inflight?.leaseId ?? randomUUID();
        await tx.update(forkAgentTask).set({status: inflight?.status ?? "leased", leaseId, leaseUntil, attempts: sql`${forkAgentTask.attempts} + ${inflight ? 0 : 1}`}).where(eq(forkAgentTask.id, t.id));
        return {task_id: t.id, envelope: t.envelopeText, signature: t.signature, kid: t.kid, payload_enc: t.payloadEnc, lease_id: leaseId, lease_until: leaseUntil.toISOString()};
    });
}

export type TaskCallResult = {ok: true; leaseUntil?: string; duplicate?: boolean} | {ok: false; status: 404 | 409 | 400; code: "not_found" | "lease_mismatch" | "conflict" | "invalid_input"};

export async function heartbeatTask(db: ForkDb, e: Enrollment, a: {taskId: string; leaseId: unknown; leaseSeconds: number; now?: Date}): Promise<TaskCallResult> {
    const now = a.now ?? new Date();
    if (typeof a.leaseId !== "string" || !z.uuid().safeParse(a.leaseId).success || !z.uuid().safeParse(a.taskId).success) return {ok: false, status: 400, code: "invalid_input"};
    return withForkLock(db, `agent-task:${e.agentId}`, async (tx) => {
        const [t] = await tx.select().from(forkAgentTask).where(and(eq(forkAgentTask.id, a.taskId), eq(forkAgentTask.agentId, e.agentId!), eq(forkAgentTask.enrollId, e.enrollId)));
        if (!t) return {ok: false as const, status: 404 as const, code: "not_found" as const};
        if (!["leased", "running"].includes(t.status) || t.leaseId !== a.leaseId || !t.leaseUntil || t.leaseUntil < now) return {ok: false as const, status: 409 as const, code: "lease_mismatch" as const};
        const leaseUntil = new Date(now.getTime() + a.leaseSeconds * 1000);
        await tx.update(forkAgentTask).set({status: "running", leaseUntil}).where(eq(forkAgentTask.id, t.id));
        return {ok: true as const, leaseUntil: leaseUntil.toISOString()};
    });
}

const ResultInput = z.strictObject({
    lease_id: z.uuid(),
    status: z.enum(["succeeded", "failed", "rejected"]),
    reason: z.enum(REASONS).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
});

/** Final result (idempotent): the same terminal status again is `ok` + `duplicate`; a different one is `409`. Result is data only: redacted, ≤ 64 KiB, never acted upon. */
export async function submitResult(db: ForkDb, e: Enrollment, a: {taskId: string; body: unknown; organizationId: string | null; now?: Date}): Promise<TaskCallResult> {
    const now = a.now ?? new Date();
    const parsed = ResultInput.safeParse(a.body);
    if (!parsed.success || !z.uuid().safeParse(a.taskId).success) return {ok: false, status: 400, code: "invalid_input"};
    const b = parsed.data;
    const result = redactDetails({...(b.result ?? {}), ...(b.reason ? {reason: b.reason} : {})});
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) return {ok: false, status: 400, code: "invalid_input"};
    return withForkLock(db, `agent-task:${e.agentId}`, async (tx) => {
        const [t] = await tx.select().from(forkAgentTask).where(and(eq(forkAgentTask.id, a.taskId), eq(forkAgentTask.agentId, e.agentId!), eq(forkAgentTask.enrollId, e.enrollId)));
        if (!t) return {ok: false as const, status: 404 as const, code: "not_found" as const};
        if (["succeeded", "failed", "rejected"].includes(t.status)) return t.status === b.status ? {ok: true as const, duplicate: true} : {ok: false as const, status: 409 as const, code: "conflict" as const};
        if (!["leased", "running"].includes(t.status) || t.leaseId !== b.lease_id) return {ok: false as const, status: 409 as const, code: "lease_mismatch" as const};
        await tx.update(forkAgentTask).set({status: b.status, result, finishedAt: now, leaseId: null, leaseUntil: null, payloadEnc: null}).where(eq(forkAgentTask.id, t.id));
        // bookkeeping of the REPORTING agent's own enrolment row only; nothing is executed because of a result (ADR-007 A11)
        if ((t.type === "pin_add" || t.type === "pin_revoke") && b.status === "succeeded") {
            const pinned = sanitizePinned((b.result ?? {}).pinned);
            if (pinned) await tx.update(forkAgentEnrollment).set({pinnedKids: pinned}).where(eq(forkAgentEnrollment.id, e.id));
        }
        if (t.type === "rotate_credential" && b.status !== "succeeded") await tx.update(forkAgentEnrollment).set(CLEAR_PENDING).where(and(eq(forkAgentEnrollment.id, e.id), eq(forkAgentEnrollment.pendingTaskId, t.id)));
        await recordAudit(tx, {organizationId: a.organizationId, actorKind: "system", action: "fork.agent_task.result", resourceType: "agent_task", resourceId: t.id, result: b.status === "succeeded" ? "success" : "failure",
            details: {agentId: e.agentId, type: t.type, status: b.status, reason: b.reason ?? null}, now});
        return {ok: true as const};
    });
}
