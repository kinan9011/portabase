import {json, readJsonBody, withAgent} from "@/fork/agent-channel/route-kit";
import {RENDER_MAX_BODY_BYTES} from "@/fork/agent-channel/vocab";
import {submitRender} from "@/fork/restore-tasks/render";

export const dynamic = "force-dynamic";

/** W17-ii E13: the restore-target agent uploads the policy view of its sandboxed compose render. Bearer API (no cookies, no CSRF). */
export async function POST(req: Request, ctx: {params: Promise<{agentId: string; taskId: string}>}) {
    const {agentId, taskId} = await ctx.params;
    return withAgent(req, agentId, async ({enrollment, organizationId, db}) => {
        const b = await readJsonBody(req, {maxBytes: RENDER_MAX_BODY_BYTES});
        if (!b.ok) return json({code: "invalid_input"}, 400);
        const r = await submitRender(db, enrollment, {taskId, body: b.body, organizationId});
        return r.ok ? json({ok: true, duplicate: r.duplicate ?? false}, 200) : json({code: r.code}, r.status);
    });
}
