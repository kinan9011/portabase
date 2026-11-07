import {sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {downgradeIncoherentRecoveryPoints} from "./downgrade";

/**
 * Retention coherence (W14, D32/D33): fork RecoveryPoints must stay TRUE when upstream changes underneath them. Upstream retention, a manual delete, a
 * storage presence check that found the object gone, or a lost FK (`ON DELETE SET NULL`) all make an artifact unusable. This job:
 *  1. copies upstream's verdict into the fork artifact row — `backup_storage.presence = 'missing'`, a soft-deleted storage row/backup, or a status ≠ success ⇒
 *     artifact `presence = 'missing'` (an `unknown` upstream presence changes nothing: not yet checked ≠ gone);
 *  2. runs the D32 downgrade (`fk_null` → `artifact_missing` → `count_mismatch`): `pending_verification | verified` ⇒ `incomplete` + reason, `verified_at` cleared;
 *  3. audits every downgrade (system actor, codes only).
 * It NEVER promotes and never deletes (RP pruning stays fork-owned, W12).
 */
export type CoherenceResult = {artifactsMarkedMissing: number; downgraded: {id: string; reason: string}[]};

export async function runRetentionCoherence(db: ForkDb, now = new Date()): Promise<CoherenceResult> {
    const marked = await db.execute(sql`
        update fork_recovery_point_artifact a
           set presence = 'missing'
          from fork_recovery_point rp, backup_storage bs, backups b
         where a.rp_id = rp.id and rp.status in ('pending_verification', 'verified') and rp.purged_at is null
           and a.required and a.presence = 'present'
           and a.backup_storage_id = bs.id and bs.backup_id = b.id
           and (bs.deleted_at is not null or b.deleted_at is not null or bs.status <> 'success' or bs.presence = 'missing')
        returning a.id`);
    const downgraded = await downgradeIncoherentRecoveryPoints(db);
    for (const d of downgraded) {
        const [r] = (await db.execute(sql`select s.organization_id as org, rp.sequence from fork_recovery_point rp join fork_stack s on s.id = rp.stack_id where rp.id = ${d.id}`)).rows as {org: string; sequence: string}[];
        await recordAudit(db, {
            organizationId: r?.org ?? null, actorKind: "system", action: "fork.recovery_point.downgrade", resourceType: "recovery_point", resourceId: d.id, result: "denied",
            details: {reason: d.reason, sequence: r ? Number(r.sequence) : null}, now,
        });
    }
    return {artifactsMarkedMissing: marked.rows.length, downgraded};
}
