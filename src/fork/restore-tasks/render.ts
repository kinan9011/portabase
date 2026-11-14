import {createHash} from "node:crypto";
import {and, desc, eq} from "drizzle-orm";
import {z} from "zod";
import {recordAudit} from "@/fork/audit";
import type {Enrollment} from "@/fork/agent-channel/auth";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkComposeRender} from "@/fork/db/schema/compose-render";
import type {ForkDb} from "@/fork/db/handle";
import {withForkLock} from "@/fork/locks";
import {evaluateRenderedCompose, type PolicyVerdictV1} from "@/fork/policy/engine";
import type {RawResult} from "@/fork/policy/raw";
import {isPolicyView} from "./view";

/**
 * Render upload (W17-ii E13, ADR-007 A14): the restore-target agent posts the POLICY VIEW of its sandboxed render here, bound to its own
 * `compose_render` task + lease. The dashboard re-checks the view (`isPolicyView`), stores it with the agent's raw-check result, and later (enqueue of
 * `restore_db` / `compose_up`) evaluates it again with the TS engine. Nothing in the view is trusted: a view that still carries a value in a blanked
 * field is refused `unredacted` and stored nowhere. Audit rows carry ids, hash and sizes only.
 */
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const RAW_KINDS = ["include", "include_env_file", "include_project_directory", "env_file", "extends", "label_file", "secret_file", "config_file", "missing"] as const;
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const RawSchema = z.strictObject({
    refused: z.boolean(),
    violations: z.array(z.strictObject({kind: z.enum(RAW_KINDS), service: z.string().max(128).nullable(), target: z.string().max(256)})).max(16),
    reason: z.enum(["yaml_invalid", "limits"]).nullable(),
});
const RenderBody = z.strictObject({
    lease_id: z.uuid(), restore_id: z.uuid(), view_b64: z.string().max(Math.ceil(MAX_VIEW_BYTES / 3) * 4 + 8), view_sha256: hex64, raw: RawSchema,
    roots: z.array(z.string().min(1).max(1024)).min(1).max(16), files: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)).max(16),
    compose_version: z.string().max(32).nullable(), rules_sha256: hex64.nullable(),
});

/** Task types whose agent uploads a policy view here: the restore render and (W22a) the mirror render / finalize (the FINAL view of the mirror project). */
export const RENDER_TASK_TYPES = ["compose_render", "mirror_render", "mirror_finalize"] as const;

export type RenderCallResult = {ok: true; duplicate?: boolean} | {ok: false; code: string; status: 400 | 404 | 409};
const refuse = (status: 400 | 404 | 409, code: string): RenderCallResult => ({ok: false, status, code});

export async function submitRender(db: ForkDb, e: Enrollment, a: {taskId: string; body: unknown; organizationId: string | null; now?: Date}): Promise<RenderCallResult> {
    const now = a.now ?? new Date();
    const parsed = RenderBody.safeParse(a.body);
    if (!parsed.success || !z.uuid().safeParse(a.taskId).success) return refuse(400, "invalid_input");
    const b = parsed.data;
    const view = Buffer.from(b.view_b64, "base64");
    if (view.length === 0 || view.length > MAX_VIEW_BYTES || view.toString("base64") !== b.view_b64) return refuse(400, "invalid_input");
    if (createHash("sha256").update(view).digest("hex") !== b.view_sha256) return refuse(400, "hash_mismatch");
    let doc: unknown;
    try { doc = JSON.parse(view.toString("utf8")); } catch { return refuse(400, "invalid_input"); }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return refuse(400, "invalid_input");
    if (!isPolicyView(doc)) return refuse(400, "unredacted");
    return withForkLock(db, `agent-task:${e.agentId}`, async (tx) => {
        const [t] = await tx.select().from(forkAgentTask).where(and(eq(forkAgentTask.id, a.taskId), eq(forkAgentTask.agentId, e.agentId!), eq(forkAgentTask.enrollId, e.enrollId)));
        if (!t) return refuse(404, "not_found");
        if (!(RENDER_TASK_TYPES as readonly string[]).includes(t.type)) return refuse(409, "wrong_type");
        const [prev] = await tx.select().from(forkComposeRender).where(eq(forkComposeRender.taskId, t.id));
        if (prev) return prev.renderedSha256 === b.view_sha256 ? {ok: true as const, duplicate: true} : refuse(409, "conflict");
        if (!["leased", "running"].includes(t.status) || t.leaseId !== b.lease_id) return refuse(409, t.status === "leased" || t.status === "running" ? "lease_mismatch" : "conflict");
        await tx.insert(forkComposeRender).values({taskId: t.id, agentId: e.agentId, restoreId: b.restore_id, policyView: view.toString("utf8"), renderedSha256: b.view_sha256, raw: b.raw, roots: b.roots,
            files: b.files, composeVersion: b.compose_version, agentRulesSha256: b.rules_sha256});
        await recordAudit(tx, {organizationId: a.organizationId, actorKind: "system", action: "fork.compose_render.received", resourceType: "agent_task", resourceId: t.id, result: "success",
            details: {taskId: t.id, restoreId: b.restore_id, sha256: b.view_sha256, bytes: view.length}, now});
        return {ok: true as const};
    });
}

export type RenderRow = typeof forkComposeRender.$inferSelect;

/** Newest render of this restore produced by `agentId` whose task SUCCEEDED (a failed / running render task is never trusted). */
export async function latestRender(db: ForkDb, a: {restoreId: string; agentId: string; type?: (typeof RENDER_TASK_TYPES)[number]}): Promise<RenderRow | null> {
    const rows = await db.select({r: forkComposeRender}).from(forkComposeRender).innerJoin(forkAgentTask, eq(forkAgentTask.id, forkComposeRender.taskId))
        .where(and(eq(forkComposeRender.restoreId, a.restoreId), eq(forkAgentTask.agentId, a.agentId), eq(forkAgentTask.type, a.type ?? "compose_render"), eq(forkAgentTask.status, "succeeded")))
        .orderBy(desc(forkComposeRender.createdAt)).limit(1);
    return rows[0]?.r ?? null;
}

/** Fresh TS verdict on a stored render (D-6: always recomputed, never trusted from the agent). */
export function renderVerdict(row: RenderRow, workspace: string): PolicyVerdictV1 {
    return evaluateRenderedCompose({rendered: row.policyView, roots: [workspace], raw: row.raw as RawResult, drift: null});
}
