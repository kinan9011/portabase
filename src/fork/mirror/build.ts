/**
 * Pure payload builders of the nine mirror tasks (W22a, plan-W22a §3.3 / A4): a verified MIRROR plan in, a strict payload out. NO I/O, no clock, no env, no DB.
 * The enqueue service resolves the manifest, the artifact index map and the download URLs and hands them in. A non-mirror plan is `BuildError("mode_unsupported")`.
 */
import type {z} from "zod";
import type {MirrorSpecV1} from "@/fork/compose-compiler/compile";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {applyBody, BuildError, buildComposeRef, stageBody, workspaceOf, type BuildInput} from "@/fork/restore-tasks/build";
import type {MirrorApplyPayload, MirrorCheckPayload, MirrorDbPayload, MirrorFinalizePayload, MirrorHeader, MirrorLimits, MirrorProbePayload, MirrorRenderPayload, MirrorStagePayload, MirrorUpPayload, MirrorWipePayload} from "./payload-schema";
import type {MirrorPolicyV1} from "./policy";

export type MirrorBuildInput = {revisionId: string; planId: string; planHash: string; plan: RestorePlanV1; indexOf: ReadonlyMap<string, number>};
const asRestore = (i: MirrorBuildInput): BuildInput => ({restoreId: i.revisionId, planId: i.planId, planHash: i.planHash, plan: i.plan, approvals: [], indexOf: i.indexOf});

export function mirrorHeader(i: MirrorBuildInput): z.infer<typeof MirrorHeader> {
    const {plan} = i;
    if (plan.purpose !== "mirror" || plan.mode !== "new_stack" || plan.target.host_role !== "runner") throw new BuildError("mode_unsupported");
    return {v: 1, restore_id: i.revisionId, plan_id: i.planId, plan_hash: i.planHash, stack_id: plan.rp.stack_id, rp_id: plan.rp.id, purpose: "mirror", mode: "new_stack",
        host_role: "runner", approvals: [], workspace: workspaceOf(plan), project: plan.target.project};
}

export const buildMirrorProbe = (workspace: string): z.infer<typeof MirrorProbePayload> => ({v: 1, workspace});

export function buildMirrorStage(i: MirrorBuildInput, a: {manifest: {jsonB64: string; sigB64: string; sha256: string; minSequence?: number}; urls: ReadonlyMap<number, string>}): z.infer<typeof MirrorStagePayload> {
    const header = mirrorHeader(i);
    return {...header, ...stageBody(asRestore(i), header.workspace, a)};
}

export function buildMirrorApply(i: MirrorBuildInput, manifestSha256: string): z.infer<typeof MirrorApplyPayload> {
    const header = mirrorHeader(i);
    const body = applyBody(asRestore(i), header.project, manifestSha256);
    if (body.networks.length > 0) throw new BuildError("mode_unsupported"); // a mirror restore never creates a network
    return {...header, ...body, networks: []};
}

/** Mirror compose reference: NO override, NO env (W20 D-2). */
export function mirrorComposeRef(i: MirrorBuildInput): z.infer<typeof MirrorRenderPayload>["compose"] {
    mirrorHeader(i);
    const ref = buildComposeRef(asRestore(i), null);
    return {...ref, override_yml: null, env: {}};
}

export function buildMirrorRender(i: MirrorBuildInput, manifestSha256: string): z.infer<typeof MirrorRenderPayload> {
    return {...mirrorHeader(i), manifest_sha256: manifestSha256, compose: mirrorComposeRef(i)};
}

export function buildMirrorFinalize(i: MirrorBuildInput, manifestSha256: string, spec: MirrorSpecV1, specSha256: string, limits: MirrorLimits): z.infer<typeof MirrorFinalizePayload> {
    return {...mirrorHeader(i), manifest_sha256: manifestSha256, compose: mirrorComposeRef(i), spec: spec as unknown as z.infer<typeof MirrorFinalizePayload>["spec"], spec_sha256: specSha256, limits};
}

/** The database work of a mirror: PostgreSQL dumps to restore + the credential resets of the compiled spec. Empty ⇒ the `restore_db` step is a no-op (no task is sent). */
export function mirrorDbWork(plan: RestorePlanV1, spec: MirrorSpecV1, indexOf: ReadonlyMap<string, number>): {dbs: {index: number; service: string}[]; resets: z.infer<typeof MirrorDbPayload>["resets"]} {
    const dbs = plan.actions.filter((a) => a.op !== "skip" && a.kind === "restore_db_dump" && a.source.dbms === "postgresql" && a.destination.kind === "db_service").map((a) => {
        const id = a.artifact_ids[0];
        const index = id === undefined ? undefined : indexOf.get(id);
        if (!a.destination.name || index === undefined) throw new BuildError("manifest_mismatch");
        return {index, service: a.destination.name};
    });
    const resets = spec.credential_resets.map((r) => ({service: r.service, engine: r.engine, user_key: r.user_key, password_key: r.password_key}));
    return {dbs, resets};
}

export function buildMirrorDb(i: MirrorBuildInput, manifestSha256: string, finalSha256: string, spec: MirrorSpecV1): z.infer<typeof MirrorDbPayload> {
    const {dbs, resets} = mirrorDbWork(i.plan, spec, i.indexOf);
    if (dbs.length + resets.length === 0) throw new BuildError("mode_unsupported");
    return {...mirrorHeader(i), manifest_sha256: manifestSha256, final_sha256: finalSha256, dbs, resets};
}

export function buildMirrorUp(i: MirrorBuildInput, finalSha256: string): z.infer<typeof MirrorUpPayload> {
    const volumes = i.plan.actions.filter((a) => a.op !== "skip" && a.kind === "restore_volume" && a.destination.kind === "volume").map((a) => {
        if (!a.destination.name) throw new BuildError("mode_unsupported");
        return a.destination.name;
    });
    return {...mirrorHeader(i), final_sha256: finalSha256, volumes};
}

export function buildMirrorCheck(i: MirrorBuildInput, finalSha256: string, policy: Pick<MirrorPolicyV1, "access" | "http_path">, waitSeconds = 120): z.infer<typeof MirrorCheckPayload> {
    return {...mirrorHeader(i), final_sha256: finalSha256, access: {service: policy.access.service, target: policy.access.target}, http_path: policy.http_path, wait_s: waitSeconds};
}

export const buildMirrorWipe = (i: MirrorBuildInput): z.infer<typeof MirrorWipePayload> => mirrorHeader(i);
