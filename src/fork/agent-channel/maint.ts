import {createPublicKey} from "node:crypto";
import {eq} from "drizzle-orm";
import {z} from "zod";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {withForkLock} from "@/fork/locks";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {gate, loadTaskKey, refuse, stepUp, type Gate, type Refusal} from "./admin";
import type {Enrollment} from "./auth";
import {generateCredential} from "./credential";
import {chEnv, chNow, type ChannelDeps} from "./deps";
import {pinFingerprint} from "./envelope";
import {clearStalePending, insertSignedTask} from "./tasks";
import {checkChannelTransport} from "./transport-policy";
import {KID_RE, MAINT_CAPABILITY, MAX_PINS, PIN_PEM_MAX, ROTATION_OVERLAP_HOURS, type TaskType} from "./vocab";

/**
 * Channel maintenance (ADR-007 A11/A12, W15b): signed `rotate_credential`, `pin_add`, `pin_revoke`. The ONLY task types that may change an agent's
 * credential or pinned keys; they are never reachable through the generic `enqueueTask`. Every service: system admin → fork not locked → rate limit →
 * password step-up → https check → one locked DB transaction → audit with CODES, ids, kid and fingerprint only (never a credential or a PEM).
 * Results are bookkeeping of the reporting agent's own row (see `submitResult`); nothing here executes because of a result.
 */
const RotateInput = z.strictObject({agentId: z.uuid(), password: z.string().min(1).max(1024)});
const PinInput = RotateInput.extend({pem: z.string().min(1).max(PIN_PEM_MAX)}).strict();
const UnpinInput = RotateInput.extend({kid: z.string().regex(KID_RE)}).strict();

type Prepared = {g: Exclude<Gate, Refusal>; signing: {privateKeyPem: string; publicKeyPem: string}; signingKid: string; now: Date; ttlMs: number};

/** Shared front half of all three services (gate, step-up, transport, signing key). */
async function prepare(d: ChannelDeps, action: string, agentId: string, password: string): Promise<Prepared | Refusal> {
    const g = await gate(d, action, agentId);
    if ("ok" in g) return g;
    const su = await stepUp(d, g, action, password);
    if (su) return su;
    const tp = checkChannelTransport(d.serverUrl(), chEnv(d));
    if (!tp.ok) {
        await recordAudit(d.db, {organizationId: g.organizationId, actorUserId: g.userId, action, resourceType: "agent", resourceId: agentId, result: "denied", details: {reason: tp.code}, now: chNow(d)});
        return tp.code === "insecure_transport" ? refuse("insecure_transport", "Agent tasks need an https:// dashboard URL.") : refuse("invalid_url", "The dashboard URL is not valid.");
    }
    let signing: Awaited<ReturnType<ChannelDeps["keys"]["signing"]>>;
    try { signing = await d.keys.signing(); } catch { return refuse("signing_unavailable", "The dashboard signing key is not available."); }
    return {g, signing, signingKid: kidOfPublicKey(signing.publicKeyPem), now: chNow(d), ttlMs: chEnv(d).FORK_AGENT_TASK_TTL_MINUTES * 60_000};
}

/** Enrolment checks every maintenance service needs, under the agent lock. */
function usable(e: Enrollment | undefined): Refusal | null {
    if (!e || e.revokedAt) return refuse("not_enrolled", "This agent is not enrolled for the fork channel.");
    if (!e.enabled) return refuse("agent_disabled", "The task channel of this agent is switched off.");
    if (!e.capabilities.includes(MAINT_CAPABILITY)) return refuse("capability_missing", "This agent has not reported that it can do this yet.");
    return null;
}

type Queued = {taskId: string; notAfter: string};
async function queue(d: ChannelDeps, p: Prepared, type: TaskType, payload: Record<string, unknown>, auditAction: string,
    check: (e: Enrollment) => Refusal | null, extra: (tx: ForkDb, e: Enrollment, t: {taskId: string; notAfter: Date}) => Promise<Record<string, unknown>>): Promise<(Queued & {details: Record<string, unknown>}) | Refusal> {
    const agentId = p.g.agent.id;
    return withForkLock(d.db, `agent-task:${agentId}`, async (tx) => {
        await clearStalePending(tx, agentId, p.now);
        const [e] = await tx.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
        const bad = usable(e) ?? check(e!);
        if (bad) {
            await recordAudit(tx, {organizationId: p.g.organizationId, actorUserId: p.g.userId, action: auditAction, resourceType: "agent", resourceId: agentId, result: "denied", details: {reason: bad.code}, now: p.now});
            return bad;
        }
        const taskKey = await loadTaskKey(d, e!);
        const t = await insertSignedTask(tx, {e: e!, agentName: p.g.agent.name, type, plaintext: Buffer.from(JSON.stringify(payload), "utf8"), actorUserId: p.g.userId, signing: p.signing, kid: p.signingKid, taskKey, now: p.now, ttlMs: p.ttlMs});
        const details = await extra(tx, e!, t);
        await recordAudit(tx, {organizationId: p.g.organizationId, actorUserId: p.g.userId, action: auditAction, resourceType: "agent", resourceId: agentId, result: "success", details: {taskId: t.taskId, enrollId: e!.enrollId, ...details}, now: p.now});
        return {taskId: t.taskId, notAfter: t.notAfter.toISOString(), details};
    });
}

export type RotationRequested = {ok: true; taskId: string; notAfter: string} | Refusal;

/** Ask the agent (by signed task) to switch to a NEW credential. The old one stays valid until the agent proves the new one. Returns NO secret. */
export async function requestCredentialRotation(d: ChannelDeps, raw: unknown): Promise<RotationRequested> {
    const parsed = RotateInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const p = await prepare(d, "fork.agent_channel.rotate_task", parsed.data.agentId, parsed.data.password);
    if ("ok" in p) return p;
    const cred = generateCredential(p.g.agent.id); // goes out of scope below; never logged, never returned
    const r = await queue(d, p, "rotate_credential", {credential: cred.bearer}, "fork.agent_channel.rotate_task",
        (e) => (e.pendingCredentialHash || (e.prevCredentialHash && e.prevValidUntil && e.prevValidUntil > p.now) ? refuse("rotation_in_progress", "A credential rotation is still in progress for this agent.") : null),
        async (tx, e, t) => {
            const until = new Date(t.notAfter.getTime() + ROTATION_OVERLAP_HOURS * 3_600_000);
            await tx.update(forkAgentEnrollment).set({pendingCredentialHash: cred.hash, pendingTaskId: t.taskId, pendingValidUntil: until}).where(eq(forkAgentEnrollment.id, e.id));
            return {};
        });
    return "ok" in r ? r : {ok: true, taskId: r.taskId, notAfter: r.notAfter};
}

export type PinResult = {ok: true; taskId: string; kid: string; fingerprint: string} | Refusal;

/** Normalise an operator-supplied PEM to an SPKI RSA 2048..8192 public key (what the agent accepts), or `null`. */
function normaliseRsaPublicKey(pem: string): string | null {
    try {
        const k = createPublicKey(pem);
        const bits = k.asymmetricKeyDetails?.modulusLength ?? 0;
        if (k.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 8192) return null;
        return k.export({type: "spki", format: "pem"}).toString();
    } catch { return null; }
}

/** Pin an additional dashboard public key on the agent (signed with the CURRENT key, ADR-013 §3 K2 rotation step 1). */
export async function pinDashboardKey(d: ChannelDeps, raw: unknown): Promise<PinResult> {
    const parsed = PinInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const spki = normaliseRsaPublicKey(parsed.data.pem);
    const p = await prepare(d, "fork.agent_channel.pin_add", parsed.data.agentId, parsed.data.password);
    if ("ok" in p) return p;
    if (!spki || spki.length > PIN_PEM_MAX) return refuse("invalid_key", "That is not an RSA public key (2048 to 8192 bits).");
    const kid = kidOfPublicKey(spki);
    const fingerprint = pinFingerprint(spki);
    const r = await queue(d, p, "pin_add", {kid, pem: spki}, "fork.agent_channel.pin_add",
        (e) => (e.pinnedKids.includes(kid) ? refuse("already_pinned", "That key is already pinned on this agent.") : e.pinnedKids.length >= MAX_PINS ? refuse("pin_limit", `An agent can pin at most ${MAX_PINS} keys.`) : null),
        async () => ({kid, fingerprint}));
    return "ok" in r ? r : {ok: true, taskId: r.taskId, kid, fingerprint};
}

/** Remove one pinned dashboard key (never the key that signs this very task, never the last pin). */
export async function unpinDashboardKey(d: ChannelDeps, raw: unknown): Promise<{ok: true; taskId: string; kid: string} | Refusal> {
    const parsed = UnpinInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the values you entered.");
    const {kid} = parsed.data;
    const p = await prepare(d, "fork.agent_channel.pin_revoke", parsed.data.agentId, parsed.data.password);
    if ("ok" in p) return p;
    const r = await queue(d, p, "pin_revoke", {kid}, "fork.agent_channel.pin_revoke",
        (e) => (kid === p.signingKid ? refuse("pin_in_use", "That is the key signing this request; pin the new key and swap files first.")
            : !e.pinnedKids.includes(kid) ? refuse("not_pinned", "That key is not pinned on this agent.")
            : e.pinnedKids.length <= 1 ? refuse("last_pin", "An agent must keep at least one pinned key.") : null),
        async () => ({kid}));
    return "ok" in r ? r : {ok: true, taskId: r.taskId, kid};
}
