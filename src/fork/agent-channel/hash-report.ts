import {and, eq} from "drizzle-orm";
import {z} from "zod";
import {recordAudit} from "@/fork/audit";
import {backup, database} from "@/db/schema/07_database";
import type {ForkDb} from "@/fork/db/handle";
import {forkAgentHashReport} from "@/fork/db/schema/agent-channel";
import type {Enrollment} from "./auth";

/**
 * D45: the agent reports the SHA-256 + size of the PLAINTEXT archive it computed before encryption. It is a cross-check INPUT for the W14 verify job and nothing
 * else: it never marks anything verified. Gated by the capability the agent reported (`plaintext-hash.v1`), scoped to backups of THIS agent's own databases,
 * first report wins (a later different value is refused and audited — a compromised agent cannot rewrite what it said when the backup ran).
 */
const Input = z.strictObject({backup_id: z.uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/), size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)});
export type HashReportResult = {ok: true; duplicate?: boolean} | {ok: false; status: 400 | 403 | 404 | 409; code: "invalid_input" | "capability_missing" | "not_found" | "conflict"};

export async function recordHashReport(db: ForkDb, e: Enrollment, a: {body: unknown; organizationId: string | null; now?: Date}): Promise<HashReportResult> {
    const now = a.now ?? new Date();
    const p = Input.safeParse(a.body);
    if (!p.success) return {ok: false, status: 400, code: "invalid_input"};
    if (!e.capabilities.includes("plaintext-hash.v1")) return {ok: false, status: 403, code: "capability_missing"};
    const [own] = await db.select({id: backup.id}).from(backup).innerJoin(database, eq(database.id, backup.databaseId)).where(and(eq(backup.id, p.data.backup_id), eq(database.agentId, e.agentId!)));
    if (!own) return {ok: false, status: 404, code: "not_found"}; // same answer for "not yours" and "does not exist"
    const ins = await db.insert(forkAgentHashReport).values({backupId: p.data.backup_id, agentId: e.agentId, sha256: p.data.sha256, sizeBytes: p.data.size_bytes, reportedAt: now}).onConflictDoNothing().returning({id: forkAgentHashReport.id});
    if (ins.length) return {ok: true};
    const [cur] = await db.select().from(forkAgentHashReport).where(eq(forkAgentHashReport.backupId, p.data.backup_id));
    if (cur && cur.sha256 === p.data.sha256 && cur.sizeBytes === p.data.size_bytes) return {ok: true, duplicate: true};
    await recordAudit(db, {organizationId: a.organizationId, actorKind: "system", action: "fork.agent_hash.conflict", resourceType: "backup", resourceId: p.data.backup_id, result: "denied", details: {agentId: e.agentId}, now});
    return {ok: false, status: 409, code: "conflict"};
}
