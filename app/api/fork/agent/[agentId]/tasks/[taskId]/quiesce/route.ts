import {leaseSeconds, readJsonBody, json, withAgent} from "@/fork/agent-channel/route-kit";
import {reportQuiesceProgress} from "@/fork/quiesce/progress";

export const dynamic = "force-dynamic";

/** W17b (ADR-007 A15): the agent's stop-window progress call (bearer-only, no cookies). Also renews the task lease; answers `{release}`. */
export async function POST(req: Request, ctx: {params: Promise<{agentId: string; taskId: string}>}) {
    const {agentId, taskId} = await ctx.params;
    return withAgent(req, agentId, async ({enrollment, db}) => {
        const b = await readJsonBody(req);
        if (!b.ok || typeof b.body !== "object" || b.body === null) return json({code: "invalid_input"}, 400);
        const r = await reportQuiesceProgress(db, enrollment, {taskId, body: b.body, leaseSeconds: leaseSeconds()});
        return r.ok ? json({release: r.release}, 200) : json({code: r.code}, r.status);
    });
}
