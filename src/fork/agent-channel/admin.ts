import {randomBytes, randomUUID} from "node:crypto";
import {and, eq, inArray, isNull, sql} from "drizzle-orm";
import {z} from "zod";
import {actorIn, forkCan} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import {forkAgentEnrollment, forkAgentTask} from "@/fork/db/schema/agent-channel";
import {agent} from "@/db/schema/08_agent";
import {decryptForkSecret, encryptForkSecret} from "@/fork/kek";
import {verifyPasswordStepUp} from "@/fork/kit/stepup";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkConfigAllowed} from "@/fork/mode";
import {encodeBundle} from "./bundle";
import {DUMMY_HASH, generateCredential, sha256Hex} from "./credential";
import {chEnv, chNow, type ChannelDeps} from "./deps";
import {pinFingerprint} from "./envelope";
import {checkChannelTransport} from "./transport-policy";
import {ROTATION_OVERLAP_HOURS} from "./vocab";

/**
 * Admin side of the channel (ADR-007 D2): enrol / re-enrol, rotate credential, revoke, enable/disable.
 * Every mutation: signed-in principal → system admin (`agents.channel.manage`, D21) → fork not locked → rate limit → (enrol/rotate) password step-up →
 * https-only check → one DB write → audit with CODES and ids only (NEVER the credential, task key, bundle or password).
 * The credential / task key appear exactly once, in the returned bundle; the DB holds `SHA-256(secret)` and a fork-KEK envelope.
 */
type Refusal = {ok: false; code: "forbidden" | "locked" | "rate_limited" | "invalid_input" | "step_up_failed" | "no_password" | "not_found" | "insecure_transport" | "invalid_url" | "already_enrolled" | "signing_unavailable" | "not_enrolled"; message: string; retryAfterSeconds?: number};
const refuse = (code: Refusal["code"], message: string, extra: Partial<Refusal> = {}): Refusal => ({ok: false, code, message, ...extra});

const AdminInput = z.strictObject({agentId: z.uuid(), password: z.string().min(1).max(1024)});
const EnrolInput = AdminInput.extend({reenroll: z.boolean().optional()}).strict();
const PlainInput = z.strictObject({agentId: z.uuid()});
const EnableInput = z.strictObject({agentId: z.uuid(), enabled: z.boolean()});

type Gate = {organizationId: string | null; userId: string; agent: {id: string; name: string}} | Refusal;

async function gate(d: ChannelDeps, action: string, agentId: string): Promise<Gate> {
    const p = d.principal;
    const [a] = await d.db.select({id: agent.id, name: agent.name, organizationId: agent.organizationId}).from(agent).where(eq(agent.id, agentId));
    const orgId = a?.organizationId ?? null;
    const actor = p ? (orgId ? actorIn(p, orgId) : null) ?? {systemRole: p.systemRole ?? null, orgRole: null} : null;
    if (!p || !forkCan(actor, "agents.channel.manage")) {
        if (p) await recordAudit(d.db, {organizationId: orgId, actorUserId: p.userId, action, resourceType: "agent", resourceId: agentId, result: "denied", details: {reason: "forbidden"}, now: chNow(d)});
        return refuse("forbidden", "You are not allowed to manage the agent task channel.");
    }
    if (!a) return refuse("not_found", "This agent does not exist.");
    const allowed = d.configAllowed ? await d.configAllowed() : await assertForkConfigAllowed().then(() => true, () => false);
    if (!allowed) {
        await recordAudit(d.db, {organizationId: orgId, actorUserId: p.userId, action, resourceType: "agent", resourceId: agentId, result: "denied", details: {reason: "locked"}, now: chNow(d)});
        return refuse("locked", "Fork configuration is locked or switched off.");
    }
    const r = (d.rate ?? checkRate)(`agent-channel-admin:${p.userId}`, 20, 60_000, chNow(d).getTime());
    if (!r.ok) return refuse("rate_limited", `Too many attempts. Try again in ${r.retryAfterSeconds} s.`, {retryAfterSeconds: r.retryAfterSeconds});
    return {organizationId: orgId, userId: p.userId, agent: {id: a.id, name: a.name}};
}

async function stepUp(d: ChannelDeps, g: Exclude<Gate, Refusal>, action: string, password: string): Promise<Refusal | null> {
    const v = await (d.stepUp ?? verifyPasswordStepUp)(d.db, g.userId, password);
    if (v === "ok") return null;
    await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: g.userId, action, resourceType: "agent", resourceId: g.agent.id, result: "denied", details: {reason: v === "no_password" ? "no_password" : "step_up_failed"}, now: chNow(d)});
    return v === "no_password" ? refuse("no_password", "This account has no password, so it cannot confirm this action.") : refuse("step_up_failed", "The password is not correct.");
}

export type EnrolResult = {ok: true; bundle: string; pinFingerprint: string; kid: string; enrollId: string; insecureLab: boolean; reenrolled: boolean} | Refusal;

/** Issue (or, with `reenroll`, replace) the enrolment of one agent. The bundle is returned ONCE. */
export async function enrolAgent(d: ChannelDeps, raw: unknown): Promise<EnrolResult> {
    const parsed = EnrolInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const {agentId, password, reenroll} = parsed.data;
    const g = await gate(d, "fork.agent_channel.enrol", agentId);
    if ("ok" in g) return g;
    const su = await stepUp(d, g, "fork.agent_channel.enrol", password);
    if (su) return su;
    const serverUrl = d.serverUrl();
    const tp = checkChannelTransport(serverUrl, chEnv(d));
    if (!tp.ok) {
        await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: g.userId, action: "fork.agent_channel.enrol", resourceType: "agent", resourceId: agentId, result: "denied", details: {reason: tp.code}, now: chNow(d)});
        return tp.code === "insecure_transport"
            ? refuse("insecure_transport", "The fork agent channel needs an https:// dashboard URL. Put the dashboard behind TLS first.")
            : refuse("invalid_url", "The dashboard URL is not valid.");
    }
    let signing;
    try { signing = await d.keys.signing(); } catch { return refuse("signing_unavailable", "The dashboard signing key is not available."); }
    const {kidOfPublicKey} = await import("@/fork/manifest/sign");
    const kid = kidOfPublicKey(signing.publicKeyPem);

    const now = chNow(d);
    const cred = generateCredential(agentId);
    const taskKey = randomBytes(32);
    const enrollId = randomUUID();
    const rowId = randomUUID();

    const [existing] = await d.db.select({id: forkAgentEnrollment.id, revokedAt: forkAgentEnrollment.revokedAt}).from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
    if (existing && !reenroll) return refuse("already_enrolled", "This agent is already enrolled. Re-enrol to replace its credential and keys.");
    const id = existing?.id ?? rowId;
    const envelope = await encryptForkSecret(taskKey.toString("base64"), {table: "fork_agent_enrollment", rowId: id, column: "task_key_enc"}, d.kekDir);
    const fp = pinFingerprint(signing.publicKeyPem);

    await d.db.transaction(async (tx) => {
        if (existing) {
            // a new generation: every open task of the old one is cancelled (it was signed for a different enrol_id and could never run again)
            await tx.update(forkAgentTask).set({status: "cancelled", finishedAt: now, leaseId: null, leaseUntil: null, payloadEnc: null})
                .where(and(eq(forkAgentTask.agentId, agentId), inArray(forkAgentTask.status, ["queued", "leased", "running"])));
            await tx.update(forkAgentEnrollment).set({enrollId, credentialHash: cred.hash, prevCredentialHash: null, prevValidUntil: null, taskKeyEnc: envelope, pinnedKids: [kid], pinFingerprint: fp,
                enabled: true, revokedAt: null, capabilities: [], capabilitiesSeenAt: null, nextSeq: 1, enrolledBy: g.userId, enrolledAt: now}).where(eq(forkAgentEnrollment.id, id));
        } else {
            await tx.insert(forkAgentEnrollment).values({id, agentId, enrollId, credentialHash: cred.hash, taskKeyEnc: envelope, pinnedKids: [kid], pinFingerprint: fp, enrolledBy: g.userId, enrolledAt: now});
        }
        await recordAudit(tx, {organizationId: g.organizationId, actorUserId: g.userId, action: "fork.agent_channel.enrol", resourceType: "agent", resourceId: agentId, result: "success",
            details: {enrollId, kid, reenrolled: Boolean(existing), insecureLab: tp.insecureLab}, now});
    });
    const bundle = encodeBundle({v: 1, enroll_id: enrollId, server_url: serverUrl, agent_id: agentId, credential: cred.bearer, task_key_b64: taskKey.toString("base64"), pins: [{kid, pem: signing.publicKeyPem}], pin_fingerprint: fp});
    return {ok: true, bundle, pinFingerprint: fp, kid, enrollId, insecureLab: tp.insecureLab, reenrolled: Boolean(existing)};
}

export type RotateResult = {ok: true; credential: string; overlapUntil: string} | Refusal;
/** New credential secret; the old one keeps working until the agent first presents the new one or `ROTATION_OVERLAP_HOURS` elapse (D2). Returned once. */
export async function rotateCredential(d: ChannelDeps, raw: unknown): Promise<RotateResult> {
    const parsed = AdminInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const g = await gate(d, "fork.agent_channel.rotate", parsed.data.agentId);
    if ("ok" in g) return g;
    const su = await stepUp(d, g, "fork.agent_channel.rotate", parsed.data.password);
    if (su) return su;
    const now = chNow(d);
    const cred = generateCredential(g.agent.id);
    const until = new Date(now.getTime() + ROTATION_OVERLAP_HOURS * 3_600_000);
    const [row] = await d.db.update(forkAgentEnrollment)
        .set({prevCredentialHash: sql`${forkAgentEnrollment.credentialHash}`, prevValidUntil: until, credentialHash: cred.hash})
        .where(and(eq(forkAgentEnrollment.agentId, g.agent.id), isNull(forkAgentEnrollment.revokedAt))).returning({id: forkAgentEnrollment.id});
    if (!row) return refuse("not_enrolled", "This agent is not enrolled for the fork channel.");
    await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: g.userId, action: "fork.agent_channel.rotate", resourceType: "agent", resourceId: g.agent.id, result: "success", details: {overlapHours: ROTATION_OVERLAP_HOURS}, now});
    return {ok: true, credential: cred.bearer, overlapUntil: until.toISOString()};
}

/** Immediate revocation (suspected compromise): the credential hash is replaced by a hash nobody can match, open tasks are cancelled. The agent needs a new bundle (re-enrol). */
export async function revokeEnrollment(d: ChannelDeps, raw: unknown): Promise<{ok: true} | Refusal> {
    const parsed = PlainInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const g = await gate(d, "fork.agent_channel.revoke", parsed.data.agentId);
    if ("ok" in g) return g;
    const now = chNow(d);
    const done = await d.db.transaction(async (tx) => {
        const [row] = await tx.update(forkAgentEnrollment).set({credentialHash: sha256Hex(randomBytes(32)), prevCredentialHash: null, prevValidUntil: null, enabled: false, revokedAt: now})
            .where(eq(forkAgentEnrollment.agentId, g.agent.id)).returning({id: forkAgentEnrollment.id});
        if (!row) return false;
        await tx.update(forkAgentTask).set({status: "cancelled", finishedAt: now, leaseId: null, leaseUntil: null, payloadEnc: null})
            .where(and(eq(forkAgentTask.agentId, g.agent.id), inArray(forkAgentTask.status, ["queued", "leased", "running"])));
        await recordAudit(tx, {organizationId: g.organizationId, actorUserId: g.userId, action: "fork.agent_channel.revoke", resourceType: "agent", resourceId: g.agent.id, result: "success", details: {}, now});
        return true;
    });
    return done ? {ok: true} : refuse("not_enrolled", "This agent is not enrolled for the fork channel.");
}

/** Per-agent switch. Disabled ⇒ the agent's lease calls get `channel_disabled` and nothing is delivered; queued tasks stay queued (they expire on their own). */
export async function setChannelEnabled(d: ChannelDeps, raw: unknown): Promise<{ok: true; enabled: boolean} | Refusal> {
    const parsed = EnableInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const g = await gate(d, "fork.agent_channel.set_enabled", parsed.data.agentId);
    if ("ok" in g) return g;
    const [row] = await d.db.update(forkAgentEnrollment).set({enabled: parsed.data.enabled})
        .where(and(eq(forkAgentEnrollment.agentId, g.agent.id), isNull(forkAgentEnrollment.revokedAt))).returning({id: forkAgentEnrollment.id});
    if (!row) return refuse("not_enrolled", "This agent is not enrolled for the fork channel.");
    await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: g.userId, action: "fork.agent_channel.set_enabled", resourceType: "agent", resourceId: g.agent.id, result: "success", details: {enabled: parsed.data.enabled}, now: chNow(d)});
    return {ok: true, enabled: parsed.data.enabled};
}

/** Task key of an enrolment (dashboard-internal; used only to encrypt payloads). */
export async function loadTaskKey(d: Pick<ChannelDeps, "kekDir">, row: {id: string; taskKeyEnc: unknown}): Promise<Buffer> {
    const b64 = await decryptForkSecret(row.taskKeyEnc, {table: "fork_agent_enrollment", rowId: row.id, column: "task_key_enc"}, d.kekDir);
    const k = Buffer.from(b64, "base64");
    if (k.length !== 32) throw new Error("task key length");
    return k;
}

export {DUMMY_HASH};
