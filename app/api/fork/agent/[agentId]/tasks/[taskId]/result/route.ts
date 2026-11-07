import {submitResult} from "@/fork/agent-channel/tasks";
import {json, readJsonBody, withAgent} from "@/fork/agent-channel/route-kit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: {params: Promise<{agentId: string; taskId: string}>}) {
    const {agentId, taskId} = await ctx.params;
    return withAgent(req, agentId, async ({enrollment, organizationId, db}) => {
        const b = await readJsonBody(req);
        if (!b.ok) return json({code: "invalid_input"}, 400);
        const r = await submitResult(db, enrollment, {taskId, body: b.body, organizationId});
        return r.ok ? json({ok: true, duplicate: r.duplicate ?? false}, 200) : json({code: r.code}, r.status);
    });
}
