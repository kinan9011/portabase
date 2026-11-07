import {NextResponse} from "next/server";
import {leaseTask} from "@/fork/agent-channel/tasks";
import {json, leaseSeconds, readJsonBody, withAgent} from "@/fork/agent-channel/route-kit";

/** ADR-007 D1: `POST /api/fork/agent/{agentId}/lease` — zero or one signed task (200) or 204. Bearer `fork.<agentId>.<secret>` on EVERY call; never version-gated. */
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: {params: Promise<{agentId: string}>}) {
    const {agentId} = await ctx.params;
    return withAgent(req, agentId, async ({enrollment, db}) => {
        const b = await readJsonBody(req);
        if (!b.ok || typeof b.body !== "object" || b.body === null || Array.isArray(b.body)) return json({code: "invalid_input"}, 400);
        const body = b.body as Record<string, unknown>;
        const task = await leaseTask(db, enrollment, {capabilities: body.capabilities, leaseSeconds: leaseSeconds()});
        return task ? json(task, 200) : new NextResponse(null, {status: 204, headers: {"Cache-Control": "no-store"}});
    });
}
