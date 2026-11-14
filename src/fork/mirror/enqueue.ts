/**
 * The ONLY builder of `mirror_*` tasks (W22a, plan-W22a A5). Internal: called by the tick as the revision's STARTER (no rate limit, no browser input). Order (fail
 * closed, every denial audited without secrets): principal holds `mirrors.manage` on the mirror (SEC-12; skipped ONLY for the wipe steps: removing the copy of a
 * revision must still work after the starter lost their rights or while configuration is locked) → config lock → runner still eligible → manifest verified
 * against the trust anchors and the plan-bound hash → artifact URLs → strict payload → size → https → sign + insert (target = the revision's runner) → journal row
 * (same transaction) → audit with ids and codes only (never a URL, a path, a payload or a manifest).
 */
import {eq} from "drizzle-orm";
import {agent} from "@/db/schema/08_agent";
import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {loadTaskKey} from "@/fork/agent-channel/admin";
import {chEnv, chNow, type ChannelDeps} from "@/fork/agent-channel/deps";
import {insertSignedTask, validatePayload} from "@/fork/agent-channel/tasks";
import {checkChannelTransport} from "@/fork/agent-channel/transport-policy";
import {MAX_PAYLOAD_BYTES, TASK_REQUIRES, type TaskType} from "@/fork/agent-channel/vocab";
import {recordAudit} from "@/fork/audit";
import type {MirrorSpecV1} from "@/fork/compose-compiler/compile";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {forkEnv} from "@/fork/env";
import {withForkLock} from "@/fork/locks";
import {assertForkConfigAllowed} from "@/fork/mode";
import {assertForkResource} from "@/fork/resource-scope";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {BuildError, artifactIndexes} from "@/fork/restore-tasks/build";
import {resolveManifest} from "@/fork/restore-tasks/enqueue";
import {artifactDownloadUrl} from "@/fork/upstream/storage-read";
import {assertRunnerTarget} from "@/fork/runner/service";
import {type RouteArgs, buildMirrorApply, buildMirrorCheck, buildMirrorDb, buildMirrorFinalize, buildMirrorProbe, buildMirrorRender, buildMirrorRoute, buildMirrorStage, buildMirrorStop, buildMirrorUp, buildMirrorWipe, type MirrorBuildInput} from "./build";
import type {MirrorPolicyV1} from "./policy";
import {MIRROR_JOURNAL_STEPS, STEP_TASK_TYPE, type MirrorJournalStep} from "./vocab";

export type MirrorTaskDeps = ChannelDeps & {
    /** Presigned GET URL of one stored object (default: the upstream download path through the adapter). */
    artifactUrl?: (backupStorageId: string) => Promise<string | null>;
    /** Runs INSIDE the enqueue transaction right after the task row is written; a throw rolls the task back. The orchestrator writes its step journal here. */
    onTaskInserted: (tx: ForkDb, t: {taskId: string; type: TaskType}) => Promise<void>;
};

export type MirrorEnqueueCode = "forbidden" | "locked" | "runner_ineligible" | "not_enrolled" | "agent_disabled" | "capability_missing" | "insecure_transport" | "invalid_url" | "signing_unavailable"
    | "manifest_mismatch" | "artifact_unavailable" | "payload_too_large" | "mode_unsupported" | "invalid_input" | "internal_error";
/** Refusals that only mean "not now": the step waits (bounded by the revision deadline). Every other refusal is permanent. */
export const TRANSIENT_ENQUEUE_CODES: readonly string[] = ["locked", "signing_unavailable", "artifact_unavailable"];
export type MirrorEnqueueResult = {ok: true; taskId: string} | {ok: false; code: MirrorEnqueueCode};

export type EnqueueRevision = {id: string; mirrorId: string; organizationId: string; planId: string | null; planHash: string; runnerAgentId: string | null; startedBy: string; workspace: string};
export type EnqueueArgs = {
    revision: EnqueueRevision; plan: RestorePlanV1; step: Exclude<MirrorJournalStep, "isolation">; attempt: number;
    manifest?: {json: string; sigB64: string}; spec?: MirrorSpecV1; specSha256?: string; finalSha256?: string; policy?: MirrorPolicyV1;
    /** W24: `route` step only (`remove` is a safety step). `seedFrom`: finalize of a refresh revision (active revision's id + workspace). */
    route?: RouteArgs; seedFrom?: {revisionId: string; workspace: string};
};

/** Safety steps (reduce exposure of a production-data copy): no principal re-check and no config lock (OD-W23-2); runner eligibility + payload checks still run. */
const SAFETY_STEPS: readonly MirrorJournalStep[] = ["wipe", "wipe_check", "stop"];

export async function enqueueMirrorTask(d: MirrorTaskDeps, a: EnqueueArgs): Promise<MirrorEnqueueResult> {
    const {revision: rev, plan, step} = a;
    const type = STEP_TASK_TYPE[step] as TaskType;
    const now = chNow(d);
    const wipe = SAFETY_STEPS.includes(step) || (step === "route" && a.route?.action === "remove");
    const audit = (result: "success" | "denied", details: Record<string, unknown>, db: ForkDb = d.db) =>
        recordAudit(db, {organizationId: rev.organizationId, actorUserId: rev.startedBy, action: result === "success" ? "fork.mirror_task.enqueue" : "fork.mirror_task.denied", resourceType: "mirror", resourceId: rev.mirrorId, result,
            details: {revisionId: rev.id, type, step, attempt: a.attempt, ...details}, now});
    const deny = async (code: MirrorEnqueueCode, details: Record<string, unknown> = {}, db: ForkDb = d.db): Promise<MirrorEnqueueResult> => {
        await audit("denied", {reason: code, ...details}, db);
        return {ok: false, code};
    };
    if (!(MIRROR_JOURNAL_STEPS as readonly string[]).includes(step) || (step as string) === "isolation") return {ok: false, code: "invalid_input"};
    if (!rev.runnerAgentId) return deny("runner_ineligible");
    const agentId = rev.runnerAgentId;

    // 1. the starter's CURRENT right on THIS mirror (D31) — not for the wipe steps; 2. config lock — not for the wipe steps
    if (!wipe) {
        try { await assertForkResource(d.db, d.principal, "mirrors.manage", {kind: "mirror", id: rev.mirrorId}); } catch (e) {
            if (e instanceof ForkNotFoundError || e instanceof ForkForbiddenError) return deny("forbidden");
            throw e;
        }
        const allowed = d.configAllowed ? await d.configAllowed() : await assertForkConfigAllowed().then(() => true, () => false);
        if (!allowed) return deny("locked");
    }
    // 3. the runner is still a designated, enrolled, attested runner with no environment and no database
    const el = await assertRunnerTarget(d.db, agentId);
    if (!el.ok) return deny("runner_ineligible", {detail: el.code});

    // 4. payload
    const root = forkEnv().FORK_MIRROR_ROOT;
    if (plan.target.restore_root !== root || !rev.workspace.startsWith(`${root}/`) || rev.planId === null) return deny("invalid_input", {detail: "root"});
    let plaintext: Buffer;
    let extra: Record<string, unknown> = {};
    try {
        const bi: MirrorBuildInput = {revisionId: rev.id, planId: rev.planId, planHash: rev.planHash, plan, indexOf: new Map()};
        let body: unknown;
        if (step === "probe" || step === "wipe_check") body = buildMirrorProbe(rev.workspace);
        else if (step === "route") {
            if (!a.route) return deny("invalid_input", {detail: "route"});
            body = buildMirrorRoute(bi, a.route);
        } else if (step === "up" || step === "check" || step === "wipe" || step === "stop") {
            if (step === "wipe") body = buildMirrorWipe(bi);
            else if (step === "stop") body = buildMirrorStop(bi);
            else if (!a.finalSha256) return deny("invalid_input", {detail: "final_sha"});
            else if (step === "up") body = buildMirrorUp(bi, a.finalSha256);
            else if (!a.policy) return deny("invalid_input", {detail: "policy"});
            else body = buildMirrorCheck(bi, a.finalSha256, a.policy);
        } else {
            if (!a.manifest) return deny("invalid_input", {detail: "manifest"});
            const rm = await resolveManifest({...d, onTaskInserted: undefined} as never, plan, a.manifest);
            if ("code" in rm) return deny(rm.code === "mode_unsupported" ? "mode_unsupported" : "manifest_mismatch", rm.detail ? {detail: rm.detail} : {});
            const withIndex: MirrorBuildInput = {...bi, indexOf: rm.indexOf};
            if (step === "stage") {
                const urls = new Map<number, string>();
                for (const ix of artifactIndexes({restoreId: rev.id, planId: rev.planId, planHash: rev.planHash, plan, approvals: [], indexOf: rm.indexOf})) {
                    const art = rm.byIndex.get(ix);
                    const u = art?.backupStorageId ? await (d.artifactUrl ?? artifactDownloadUrl)(art.backupStorageId) : null;
                    if (!u) return deny("artifact_unavailable", {artifactIndex: ix});
                    urls.set(ix, u);
                }
                body = buildMirrorStage(withIndex, {manifest: {jsonB64: Buffer.from(a.manifest.json, "utf8").toString("base64"), sigB64: a.manifest.sigB64, sha256: rm.sha256}, urls});
                extra = {artifacts: urls.size};
            } else if (step === "apply") body = buildMirrorApply(withIndex, rm.sha256);
            else if (step === "render") body = buildMirrorRender(withIndex, rm.sha256);
            else if (step === "finalize") {
                if (!a.spec || !a.specSha256 || !a.policy) return deny("invalid_input", {detail: "spec"});
                if (a.seedFrom && !a.seedFrom.workspace.startsWith(`${root}/`)) return deny("invalid_input", {detail: "seed_from"});
                body = buildMirrorFinalize(withIndex, rm.sha256, a.spec, a.specSha256, a.policy.limits, a.seedFrom);
            } else if (step === "restore_db") {
                if (!a.spec || !a.finalSha256) return deny("invalid_input", {detail: "spec"});
                body = buildMirrorDb(withIndex, rm.sha256, a.finalSha256, a.spec);
            } else return deny("invalid_input");
        }
        plaintext = Buffer.from(JSON.stringify(body), "utf8");
    } catch (e) {
        if (e instanceof BuildError) return deny(e.code === "artifact_unavailable" ? "artifact_unavailable" : e.code === "manifest_mismatch" ? "manifest_mismatch" : e.code === "invalid_input" ? "invalid_input" : "mode_unsupported");
        throw e;
    }
    if (validatePayload(type, JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>)) return deny("invalid_input", {detail: "payload_schema"});
    if (plaintext.length > MAX_PAYLOAD_BYTES) return deny("payload_too_large", {bytes: plaintext.length});
    const tp = checkChannelTransport(d.serverUrl(), chEnv(d));
    if (!tp.ok) return deny(tp.code);
    let signing: Awaited<ReturnType<ChannelDeps["keys"]["signing"]>>;
    try { signing = await d.keys.signing(); } catch { return {ok: false, code: "signing_unavailable"}; }
    const {kidOfPublicKey} = await import("@/fork/manifest/sign");
    const kid = kidOfPublicKey(signing.publicKeyPem);
    const [ag] = await d.db.select({name: agent.name}).from(agent).where(eq(agent.id, agentId));
    if (!ag) return deny("not_enrolled");
    const ttlMs = chEnv(d).FORK_AGENT_TASK_TTL_MINUTES * 60_000;

    return withForkLock(d.db, `agent-task:${agentId}`, async (tx): Promise<MirrorEnqueueResult> => {
        const [e] = await tx.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
        if (!e || e.revokedAt) return deny("not_enrolled", {}, tx);
        if (!e.enabled) return deny("agent_disabled", {}, tx);
        const requires = [...TASK_REQUIRES[type]];
        if (!requires.every((c) => e.capabilities.includes(c))) return deny("capability_missing", {requires}, tx);
        const taskKey = await loadTaskKey(d, e);
        const t = await insertSignedTask(tx, {e, agentName: ag.name, type, plaintext, targetAgentId: agentId, actorUserId: rev.startedBy, signing, kid, taskKey, now, ttlMs});
        await d.onTaskInserted(tx, {taskId: t.taskId, type}); // the step journal row: same transaction (a throw rolls the task back)
        await audit("success", {taskId: t.taskId, seq: t.seq, planHash: rev.planHash, ...extra}, tx);
        return {ok: true, taskId: t.taskId};
    });
}
