import {and, eq, inArray} from "drizzle-orm";
import {z} from "zod";
import {recordAudit} from "@/fork/audit";
import {forkStackSource} from "@/fork/db/schema/stack";
import {withForkLock} from "@/fork/locks";
import {agentAclAllows, backupCount, readAgent, readMembers, removeMemberSource} from "@/fork/upstream";
import {authorizeMutation, loadStackContext, type MaterializeDeps} from "./apply";

/**
 * Confirmed removal of stack member sources (W10: "never deletes sources without confirm"). Only sources that NEVER ran are removable here:
 * deleting one that has backups would purge restore data, which belongs to the recovery-point lifecycle (W12/W14). Those are refused with
 * `has_backups` and stay (marked orphaned by the next apply when the plan no longer wants them).
 */
export const RemoveInputSchema = z.strictObject({
    stackId: z.uuid(),
    sourceIds: z.array(z.uuid()).min(1).max(50),
    confirm: z.literal(true),
});

export type RemoveResult =
    | {ok: true; removed: number; refused: {id: string; reason: "has_backups" | "not_in_stack" | "agent_acl"}[]}
    | {ok: false; code: "forbidden" | "not_found" | "locked" | "rate_limited" | "invalid_input" | "refused"; message: string; retryAfterSeconds?: number};

export async function removeStackSources(d: MaterializeDeps, raw: unknown): Promise<RemoveResult> {
    const parsed = RemoveInputSchema.safeParse(raw);
    if (!parsed.success) return {ok: false, code: "invalid_input", message: "Confirm the removal and select at least one source."};
    const input = parsed.data;
    const auth = await authorizeMutation(d, "fork.materialize.remove", input.stackId, "materialize");
    if (!("organizationId" in auth)) return auth as RemoveResult;
    const {organizationId} = auth;
    const p = d.principal!;
    const ctx = await loadStackContext(d.db, input.stackId);
    if (!ctx) return {ok: false, code: "not_found", message: "Stack not found."};

    const refused: {id: string; reason: "has_backups" | "not_in_stack" | "agent_acl"}[] = [];
    let removed = 0;
    await withForkLock(d.db, `materialize:${input.stackId}`, async (tx) => {
        const links = await tx.select().from(forkStackSource).where(and(eq(forkStackSource.stackId, input.stackId), inArray(forkStackSource.id, input.sourceIds)));
        const found = new Set(links.map((l) => l.id));
        for (const id of input.sourceIds) if (!found.has(id)) refused.push({id, reason: "not_in_stack"});
        for (const l of links) {
            if (l.databaseId) {
                const row = (await readMembers(tx, [l.databaseId])).get(l.databaseId);
                if (row?.agentId) {
                    const agent = await readAgent(tx, row.agentId);
                    if (!agent || !agentAclAllows(p, agent, organizationId)) { refused.push({id: l.id, reason: "agent_acl"}); continue; }
                }
                if ((await backupCount(tx, l.databaseId)) > 0) { refused.push({id: l.id, reason: "has_backups"}); continue; }
                if (row && row.deletedAt === null) await removeMemberSource(tx, l.databaseId);
            }
            await tx.delete(forkStackSource).where(eq(forkStackSource.id, l.id));
            removed++;
        }
        await recordAudit(tx, {organizationId, actorUserId: p.userId, action: "fork.materialize.remove", resourceType: "stack", resourceId: input.stackId, result: "success", details: {removed, refused: refused.length, reasons: [...new Set(refused.map((r) => r.reason))]}, now: d.now?.()});
    });
    return {ok: true, removed, refused};
}
