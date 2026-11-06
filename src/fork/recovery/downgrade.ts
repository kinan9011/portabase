import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";

/**
 * D32 downgrade (ADR-004 §2): any `pending_verification` / `verified` RP whose required artifacts have a NULL FK, a
 * presence ≠ present, or a present-count ≠ required_artifact_count becomes `incomplete` with the reason — never to
 * `verified`, never silently. Pure SQL so the W14 retention-coherence job and tests share one definition.
 * Reason precedence matches `deriveDowngrade()` in `./status`: fk_null → artifact_missing → count_mismatch.
 * Returns the ids it downgraded.
 */
export async function downgradeIncoherentRecoveryPoints(db: ForkDb): Promise<{id: string; reason: string}[]> {
    const r = await db.execute(sql`
        with facts as (
            select rp.id,
                   bool_or(a.required and (a.backup_id is null or a.backup_storage_id is null)) as fk_null,
                   bool_or(a.required and a.presence <> 'present') as missing,
                   count(*) filter (where a.required and a.presence = 'present') as present_n,
                   rp.required_artifact_count as req_n
              from fork_recovery_point rp
              left join fork_recovery_point_artifact a on a.rp_id = rp.id
             where rp.status in ('pending_verification', 'verified') and rp.purged_at is null
          group by rp.id, rp.required_artifact_count
        ), bad as (
            select id, case when coalesce(fk_null, false) then 'fk_null'
                            when coalesce(missing, false) then 'artifact_missing'
                            when present_n <> req_n then 'count_mismatch' end as reason
              from facts
        )
        update fork_recovery_point rp
           set status = 'incomplete', downgrade_reason = bad.reason, verified_at = null,
               present_artifact_count = (select count(*) from fork_recovery_point_artifact a where a.rp_id = rp.id and a.required and a.presence = 'present')
          from bad
         where rp.id = bad.id and bad.reason is not null
        returning rp.id, rp.downgrade_reason as reason`);
    return r.rows as {id: string; reason: string}[];
}
