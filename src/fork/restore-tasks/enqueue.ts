import {createHash} from "node:crypto";
import {and, eq, sql} from "drizzle-orm";
import {z} from "zod";
import {agent} from "@/db/schema/08_agent";
import {actorIn, ForkForbiddenError, ForkNotFoundError, forkCan} from "@/fork/acl";
import {loadTaskKey} from "@/fork/agent-channel/admin";
import {chEnv, chNow, type ChannelDeps} from "@/fork/agent-channel/deps";
import {insertSignedTask, validatePayload} from "@/fork/agent-channel/tasks";
import {checkChannelTransport} from "@/fork/agent-channel/transport-policy";
import {MAX_PAYLOAD_BYTES, TASK_REQUIRES, type TaskType} from "@/fork/agent-channel/vocab";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {forkRecoveryPointArtifact} from "@/fork/db/schema/recovery";
import {forkRestoreOverride} from "@/fork/db/schema/restore-override";
import {resolveOverridesForEnqueue, type ResolvedOverrides} from "@/fork/config/resolve";
import {purgeRestoreOverrides} from "@/fork/config/service";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {withForkLock} from "@/fork/locks";
import {loadTrustAnchors} from "@/fork/manifest/anchors";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkResource} from "@/fork/resource-scope";
import {loadFreshPlan, loadPlanRow, type PlanRow} from "@/fork/restore/service";
import type {RestorePlanV1} from "@/fork/restore/schema";
import type {ApprovalKind} from "@/fork/restore/vocab";
import {artifactDownloadUrl} from "@/fork/upstream/storage-read";
import {canonicalJson} from "@/fork/canonical";
import {checkPolicyApproval} from "@/fork/policy/approval";
import {checkRawCompose} from "@/fork/policy/raw";
import {BuildError, artifactIndexes, buildApplyPayload, buildCleanupPayload, buildComposeRef, buildDbPayload, buildProbePayload, buildRenderPayload, buildStagePayload, buildUpPayload, workspaceOf, type BuildInput} from "./build";
import {latestRender, renderVerdict} from "./render";

/**
 * The ONLY builder of restore tasks (W17-i, plan-W17 i-2; generic `enqueueTask` keeps refusing them). Called by tests today and by the W18a orchestrator
 * later; there is no server action and no UI here. Order (fail closed at every step, every denial audited without secrets):
 * principal → input → resource-scoped `restore.execute` (SEC-12) → config lock → rate limit → plan (fresh + untampered; `restore_cleanup` only needs the
 * untampered row) → ready + approvals bound to the hash → mode → enrolment/capability of the PLAN's target → manifest bytes verified against the trust
 * anchors and the plan's bound hash → artifact ↔ manifest index → presigned URLs → strict payload → size → https → sign + insert (target = plan target).
 * Audit rows hold ids, hashes, codes and counts: never URLs, the manifest, the payload or any path.
 */
export type RestoreTaskDeps = ChannelDeps & {
    /** Presigned GET URL of one stored object (default: the upstream download path through the adapter). */
    artifactUrl?: (backupStorageId: string) => Promise<string | null>;
    /** W18a (D-4): runs INSIDE the enqueue transaction right after the task row (and override binding) is written; a throw rolls the task back. The orchestrator writes its step journal here. */
    onTaskInserted?: (tx: ForkDb, t: {taskId: string; type: TaskType}) => Promise<void>;
};

export type RestoreRefusalCode = "forbidden" | "locked" | "rate_limited" | "invalid_input" | "not_enrolled" | "agent_disabled" | "capability_missing" | "insecure_transport" | "invalid_url" | "signing_unavailable"
    | "not_found" | "stale" | "expired" | "hash_mismatch" | "plan_tampered" | "plan_blocked" | "approval_missing" | "mode_unsupported" | "manifest_mismatch" | "artifact_unavailable" | "payload_too_large" | "target_mismatch"
    // W17-ii (compose types)
    | "raw_refused" | "render_missing" | "policy_refused" | "approval_invalid"
    // W16b (stored restore-time overrides)
    | "override_conflict" | "overrides_changed";
export type RestoreRefusal = {ok: false; code: RestoreRefusalCode; retryAfterSeconds?: number};
export type RestoreEnqueueResult = {ok: true; taskId: string; seq: number; notAfter: string} | RestoreRefusal;

const uuid = z.uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Plan = {planId: uuid, planHash: hex64, restoreId: uuid};
const Manifest = z.strictObject({json: z.string().min(2).max(2 * 1024 * 1024), sigB64: z.string().min(4).max(2048)});
/** Operator override of the restored stack (W16b supplies it; tests pass literals). Secret-bearing: goes into `payload_enc` only — never audited, never logged, never in an error. */
const Overrides = z.strictObject({env: z.record(z.string(), z.string()), overrideYml: z.string().nullable()}).nullable().optional();
const RestoreEnqueueInput = z.discriminatedUnion("type", [
    z.strictObject({type: z.literal("restore_probe"), agentId: uuid, workspace: z.string().max(1024).optional()}),
    z.strictObject({type: z.literal("restore_stage"), ...Plan, manifest: Manifest}),
    z.strictObject({type: z.literal("restore_apply"), ...Plan, manifest: Manifest}),
    z.strictObject({type: z.literal("compose_render"), ...Plan, manifest: Manifest, overrides: Overrides}),
    z.strictObject({type: z.enum(["restore_db", "compose_up"]), ...Plan, manifest: Manifest, approval: z.unknown().nullable(), overrides: Overrides}),
    z.strictObject({type: z.literal("restore_cleanup"), ...Plan, cleanup: z.strictObject({workspace: z.boolean(), volumes: z.boolean(), networks: z.boolean(), containers: z.boolean()})}),
]);

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const refuse = (code: RestoreRefusalCode, extra: Partial<RestoreRefusal> = {}): RestoreRefusal => ({ok: false, code, ...extra});
const RATE = {limit: 30, windowMs: 60_000} as const;

export async function enqueueRestoreTask(d: RestoreTaskDeps, raw: unknown): Promise<RestoreEnqueueResult> {
    const p = d.principal;
    if (!p) return refuse("forbidden");
    const parsed = RestoreEnqueueInput.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input");
    const input = parsed.data;
    const now = chNow(d);
    const type = input.type as TaskType;
    let orgId: string | null = null;
    let resourceId: string | null = input.type === "restore_probe" ? input.agentId : input.planId;
    const audit = (result: "success" | "denied", details: Record<string, unknown>, db: ForkDb = d.db) =>
        recordAudit(db, {organizationId: orgId, actorUserId: p.userId, action: result === "success" ? "fork.restore_task.enqueue" : "fork.restore_task.denied", resourceType: input.type === "restore_probe" ? "agent" : "restore_plan", resourceId, result, details: {type, ...details}, now});
    const deny = async (code: RestoreRefusalCode, details: Record<string, unknown> = {}, extra: Partial<RestoreRefusal> = {}, db: ForkDb = d.db): Promise<RestoreRefusal> => {
        await audit("denied", {reason: code, ...details}, db);
        return refuse(code, extra);
    };

    // 1. authorisation (no existence oracle: unknown and foreign resources are both `forbidden`)
    let targetAgentId: string;
    if (input.type === "restore_probe") {
        const [a] = await d.db.select({organizationId: agent.organizationId}).from(agent).where(eq(agent.id, input.agentId));
        orgId = a?.organizationId ?? null;
        if (!a || !a.organizationId || !forkCan(actorIn(p, a.organizationId) ?? {systemRole: p.systemRole ?? null, orgRole: null}, "restore.execute")) return deny("forbidden");
        targetAgentId = input.agentId;
    } else {
        try { orgId = (await assertForkResource(d.db, p, "restore.execute", {kind: "restore_plan", id: input.planId})).organizationId; } catch (e) {
            if (e instanceof ForkNotFoundError || e instanceof ForkForbiddenError) return deny("forbidden");
            throw e;
        }
        targetAgentId = "";
    }
    // 2. config lock, rate limit
    const allowed = d.configAllowed ? await d.configAllowed() : await assertForkConfigAllowed().then(() => true, () => false);
    if (!allowed) return deny("locked");
    const rl = (d.rate ?? checkRate)(`restore-task-enqueue:${p.userId}`, RATE.limit, RATE.windowMs, now.getTime());
    if (!rl.ok) return refuse("rate_limited", {retryAfterSeconds: rl.retryAfterSeconds});

    // 3. plan + payload
    let plaintext: Buffer;
    let restoreId = "";
    let extra: Record<string, unknown> = {};
    let stored: ResolvedOverrides | null = null; // W16b: the stored override set of this plan (server-side resolve helper only)
    if (input.type === "restore_probe") {
        plaintext = Buffer.from(JSON.stringify(buildProbePayload(input.workspace)), "utf8");
    } else {
        restoreId = input.restoreId;
        const loaded = input.type === "restore_cleanup" ? await loadPlanRow(d, input.planId, input.planHash) : await loadFreshPlan(d, input.planId, input.planHash);
        if (!loaded.ok) return deny(loaded.code === "forbidden" ? "forbidden" : (loaded.code as RestoreRefusalCode), {planHash: input.planHash});
        const {row, plan} = loaded;
        targetAgentId = plan.target.agent_id;
        if (input.type !== "restore_cleanup") {
            if (plan.outcome !== "ready") return deny("plan_blocked");
            const approved = approvalsOf(row);
            if (!plan.approvals_required.every((a) => approved.includes(a.kind))) return deny("approval_missing", {planHash: row.planHash});
        }
        if (plan.mode === "existing_stack") return deny("mode_unsupported", {reason2: "existing_stack"});
        const bi: BuildInput = {restoreId, planId: row.id, planHash: row.planHash, plan, approvals: approvalsOf(row), indexOf: new Map()};
        try {
            if (input.type === "restore_stage" || input.type === "restore_apply" || input.type === "compose_render" || input.type === "restore_db" || input.type === "compose_up") {
                const rm = await resolveManifest(d, plan, input.manifest);
                if ("code" in rm) return deny(rm.code, rm.detail ? {detail: rm.detail} : {});
                const withIndex: BuildInput = {...bi, indexOf: rm.indexOf};
                if (input.type === "compose_render" || input.type === "restore_db" || input.type === "compose_up") {
                    // W16b: a stored override set replaces the literal parameter; both at once is refused (no silent drop)
                    const st = await resolveOverridesForEnqueue(d.db, {planId: row.id, planHash: row.planHash, now, kekDir: d.kekDir});
                    if (!st.ok) return deny(st.code === "hash_mismatch" ? "hash_mismatch" : "invalid_input", {reason2: st.code});
                    if (st.value && input.overrides !== undefined) return deny("invalid_input", {reason2: "overrides_both"});
                    if (st.value?.restoreId && st.value.restoreId !== restoreId) return deny("override_conflict");
                    stored = st.value;
                    const literal = input.overrides ? {env: input.overrides.env, overrideYml: input.overrides.overrideYml} : null;
                    // W17-ii: override YAML is judged on BOTH sides (D46): the dashboard refuses a poisoned override before it is ever signed
                    const ref = buildComposeRef(withIndex, stored ? stored.payload : literal);
                    const ws = workspaceOf(plan);
                    if (ref.override_yml !== null) {
                        const file = `${ws}/.portabase/secret/override.yml`;
                        if (checkRawCompose({root: ws, entry: [file], files: [{path: file, text: ref.override_yml}]}).refused) return deny("raw_refused");
                    }
                    if (input.type === "compose_render") {
                        plaintext = Buffer.from(JSON.stringify(buildRenderPayload(withIndex, rm.sha256, ref)), "utf8");
                    } else {
                        // the render the operator saw, judged AGAIN right before enqueue (D-6): never trust a stored verdict
                        const row = await latestRender(d.db, {restoreId, agentId: plan.target.agent_id});
                        if (!row) return deny("render_missing");
                        if (stored && row.taskId !== stored.renderTaskId) return deny("render_missing", {detail: "overrides_changed"}); // W16b: the render the operator saw must be of THIS set
                        const verdict = renderVerdict(row, ws);
                        if (verdict.hard.length > 0) return deny("policy_refused", {composeSha256: row.renderedSha256, hard: verdict.hard.map((h) => h.code)});
                        let approval: unknown = null;
                        if (verdict.verdict === "allow") {
                            if (input.approval !== null) return deny("approval_invalid", {detail: "over_broad", composeSha256: row.renderedSha256});
                        } else {
                            const chk = checkPolicyApproval({verdict, token: input.approval, context: {stack_id: plan.rp.stack_id, rp_id: plan.rp.id, target_agent_id: plan.target.agent_id}});
                            if (!chk.ok) return deny("approval_invalid", {detail: chk.code, composeSha256: row.renderedSha256});
                            approval = input.approval;
                            extra = {approvalSha256: sha256(canonicalJson(approval))};
                        }
                        extra = {...extra, composeSha256: row.renderedSha256};
                        plaintext = Buffer.from(JSON.stringify(input.type === "restore_db" ? buildDbPayload(withIndex, rm.sha256, ref, row.renderedSha256, approval) : buildUpPayload(withIndex, rm.sha256, ref, row.renderedSha256, approval)), "utf8");
                    }
                } else if (input.type === "restore_apply") {
                    plaintext = Buffer.from(JSON.stringify(buildApplyPayload(withIndex, rm.sha256)), "utf8");
                } else {
                    const urls = new Map<number, string>();
                    for (const ix of artifactIndexes(withIndex)) {
                        const art = rm.byIndex.get(ix);
                        const u = art?.backupStorageId ? await (d.artifactUrl ?? artifactDownloadUrl)(art.backupStorageId) : null;
                        if (!u) return deny("artifact_unavailable", {artifactIndex: ix});
                        urls.set(ix, u);
                    }
                    plaintext = Buffer.from(JSON.stringify(buildStagePayload(withIndex, {manifest: {jsonB64: Buffer.from(input.manifest.json, "utf8").toString("base64"), sigB64: input.manifest.sigB64, sha256: rm.sha256}, urls})), "utf8");
                    extra = {artifacts: urls.size};
                }
            } else {
                if (input.type !== "restore_cleanup") throw new BuildError("invalid_input");
                plaintext = Buffer.from(JSON.stringify(buildCleanupPayload(bi, input.cleanup)), "utf8");
            }
        } catch (e) {
            if (e instanceof BuildError) return deny(e.code === "invalid_input" ? "invalid_input" : e.code);
            throw e;
        }
    }
    const bad = validatePayload(type, JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>);
    if (bad) return deny("invalid_input", {reason2: "payload_schema"});
    if (plaintext.length > MAX_PAYLOAD_BYTES) return deny("payload_too_large", {bytes: plaintext.length});
    const tp = checkChannelTransport(d.serverUrl(), chEnv(d));
    if (!tp.ok) return deny(tp.code);
    let signing: Awaited<ReturnType<ChannelDeps["keys"]["signing"]>>;
    try { signing = await d.keys.signing(); } catch { return refuse("signing_unavailable"); }
    const {kidOfPublicKey} = await import("@/fork/manifest/sign");
    const kid = kidOfPublicKey(signing.publicKeyPem);
    const [a] = await d.db.select({name: agent.name}).from(agent).where(eq(agent.id, targetAgentId));
    if (!a) return deny("not_enrolled");
    const ttlMs = chEnv(d).FORK_AGENT_TASK_TTL_MINUTES * 60_000;

    resourceId = input.type === "restore_probe" ? input.agentId : input.planId;
    try {
        const res = await withForkLock(d.db, `agent-task:${targetAgentId}`, async (tx): Promise<RestoreEnqueueResult> => {
            const [e] = await tx.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, targetAgentId));
            if (!e || e.revokedAt) return deny("not_enrolled", {}, {}, tx);
            if (!e.enabled) return deny("agent_disabled", {}, {}, tx);
            const requires = [...TASK_REQUIRES[type]];
            if (!requires.every((c) => e.capabilities.includes(c))) return deny("capability_missing", {requires}, {}, tx);
            const taskKey = await loadTaskKey(d, e);
            const t = await insertSignedTask(tx, {e, agentName: a.name, type, plaintext, targetAgentId, actorUserId: p.userId, signing, kid, taskKey, now, ttlMs});
            if (stored) await bindOverride(tx, {rowId: stored.rowId, revision: stored.revision, restoreId, type, taskId: t.taskId, now}); // throws OverrideRace ⇒ the insert rolls back
            if (d.onTaskInserted) await d.onTaskInserted(tx, {taskId: t.taskId, type}); // W18a: step journal in the same transaction (a throw rolls the task back)
            await audit("success", {taskId: t.taskId, seq: t.seq, restoreId: restoreId || null, planHash: input.type === "restore_probe" ? null : input.planHash, ...(stored ? {override_revision: stored.revision} : {}), ...extra}, tx);
            return {ok: true, taskId: t.taskId, seq: t.seq, notAfter: t.notAfter.toISOString()};
        });
        if (res.ok && input.type === "restore_cleanup") await purgeRestoreOverrides(d.db, input.planId, "cleanup", now, p.userId); // W16b: overrides die with the restore
        return res;
    } catch (e) {
        if (e instanceof OverrideRace) return deny("overrides_changed");
        throw e;
    }
}

/** Thrown inside the enqueue transaction when the override row changed after it was resolved: rolls the task insert back. */
class OverrideRace extends Error {}

/**
 * W16b: bind the stored set to this restore. `compose_render` records `restore_id` + the render task; `restore_db` / `compose_up` FREEZE it (set/clear refuse afterwards).
 * Conditional on the revision that was resolved, so a concurrent set/clear can never slip a different value under an already signed task.
 */
async function bindOverride(tx: ForkDb, a: {rowId: string; revision: number; restoreId: string; type: TaskType; taskId: string; now: Date}): Promise<void> {
    const render = a.type === "compose_render";
    const set = {
        restoreId: sql`coalesce(${forkRestoreOverride.restoreId}, ${a.restoreId}::uuid)`,
        ...(render ? {renderTaskId: a.taskId} : {frozenAt: sql`coalesce(${forkRestoreOverride.frozenAt}, ${a.now.toISOString()}::timestamptz)`}),
    };
    const rows = await tx.update(forkRestoreOverride).set(set).where(and(eq(forkRestoreOverride.id, a.rowId), eq(forkRestoreOverride.revision, a.revision))).returning({id: forkRestoreOverride.id});
    if (rows.length !== 1) throw new OverrideRace();
}

/** Approvals recorded on the plan row for THIS hash (a record for another hash never counts). */
export function approvalsOf(row: PlanRow): ApprovalKind[] {
    if (!Array.isArray(row.approvals)) return [];
    return (row.approvals as {kind?: unknown; plan_hash?: unknown}[]).flatMap((a) => (a && a.plan_hash === row.planHash && (a.kind === "production_target" || a.kind === "destructive_replace") ? [a.kind] : []));
}

type ArtRow = typeof forkRecoveryPointArtifact.$inferSelect;
type ResolvedManifest = {sha256: string; indexOf: Map<string, number>; byIndex: Map<number, ArtRow>};

/**
 * Verify the caller-supplied signed manifest exactly as a verifier would (trust anchors, canonical form, stack/RP/sequence binding) AND against the
 * hash the plan bound (`rp.manifest_sha256`), then map every plan artifact to its index in the manifest by (source_name, location, generated_id).
 * Missing, ambiguous or contradicting (hash/size) matches are `manifest_mismatch`; restic artifacts are `mode_unsupported` (W17-i-f1).
 */
export async function resolveManifest(d: RestoreTaskDeps, plan: RestorePlanV1, m: {json: string; sigB64: string}): Promise<ResolvedManifest | {code: RestoreRefusalCode; detail?: string}> {
    const v = verifyManifestBundle({json: m.json, sig: Buffer.from(m.sigB64, "base64")}, await loadTrustAnchors(d.db),
        {stackId: plan.rp.stack_id, rpId: plan.rp.id, sequence: plan.rp.sequence});
    if (!v.ok) return {code: "manifest_mismatch", detail: v.code};
    const sha = sha256(m.json);
    if (!plan.rp.manifest_sha256 || sha !== plan.rp.manifest_sha256) return {code: "manifest_mismatch", detail: "sha"};
    const rows = await d.db.select().from(forkRecoveryPointArtifact).where(eq(forkRecoveryPointArtifact.rpId, plan.rp.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const indexOf = new Map<string, number>();
    const byIndex = new Map<number, ArtRow>();
    for (const act of plan.actions) {
        if (act.op === "skip") continue;
        const id = act.artifact_ids[0];
        if (id === undefined || indexOf.has(id)) continue;
        const r = byId.get(id);
        if (!r) return {code: "manifest_mismatch", detail: "artifact_row"};
        if (r.archiveKind === "restic_snapshot") return {code: "mode_unsupported", detail: "restic"};
        const hits = v.manifest.artifacts.flatMap((a, ix) => (a.source_name === r.sourceName && (a.location ?? null) === (r.pathOrSnapshotId ?? null) && (a.generated_id ?? null) === (r.generatedId ?? null) ? [ix] : []));
        if (hits.length !== 1) return {code: "manifest_mismatch", detail: hits.length === 0 ? "no_match" : "ambiguous"};
        const ma = v.manifest.artifacts[hits[0]];
        if (ma.plaintext_sha256 !== (act.expect.plaintext_sha256 ?? ma.plaintext_sha256) || ma.plaintext_size !== (act.expect.plaintext_size ?? ma.plaintext_size)) return {code: "manifest_mismatch", detail: "expect"};
        indexOf.set(id, hits[0]);
        byIndex.set(hits[0], r);
    }
    return {sha256: sha, indexOf, byIndex};
}
