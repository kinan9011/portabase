import {recordHashReport} from "@/fork/agent-channel/hash-report";
import {json, readJsonBody, withAgent} from "@/fork/agent-channel/route-kit";

/** D45: the agent's plaintext SHA-256 + size for one of its own backups (capability `plaintext-hash.v1`). A cross-check input, never a verdict. */
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: {params: Promise<{agentId: string}>}) {
    const {agentId} = await ctx.params;
    return withAgent(req, agentId, async ({enrollment, organizationId, db}) => {
        const b = await readJsonBody(req);
        if (!b.ok) return json({code: "invalid_input"}, 400);
        const r = await recordHashReport(db, enrollment, {body: b.body, organizationId});
        return r.ok ? json({ok: true, duplicate: r.duplicate ?? false}, 200) : json({code: r.code}, r.status);
    });
}
