import {heartbeatTask} from "@/fork/agent-channel/tasks";
import {json, leaseSeconds, readJsonBody, withAgent} from "@/fork/agent-channel/route-kit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: {params: Promise<{agentId: string; taskId: string}>}) {
    const {agentId, taskId} = await ctx.params;
    return withAgent(req, agentId, async ({enrollment, db}) => {
        const b = await readJsonBody(req);
        if (!b.ok || typeof b.body !== "object" || b.body === null) return json({code: "invalid_input"}, 400);
        const r = await heartbeatTask(db, enrollment, {taskId, leaseId: (b.body as Record<string, unknown>).lease_id, leaseSeconds: leaseSeconds()});
        return r.ok ? json({lease_until: r.leaseUntil}, 200) : json({code: r.code}, r.status);
    });
}
