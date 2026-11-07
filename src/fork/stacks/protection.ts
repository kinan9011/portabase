import {sql} from "drizzle-orm";
import {validateCompleteness} from "@/fork/completeness";
import {EMPTY_CONTEXT, type CompletenessContext} from "@/fork/completeness/types";
import {toConfigurationView, toProtectionView, type ConfigurationView, type ProtectionView} from "@/fork/completeness/view";
import type {ForkDb} from "@/fork/db/handle";
import type {StackInventoryV1} from "@/fork/inventory/schema";

/**
 * Gathers the inputs of the protection model for ONE stack (already authorised and org-scoped by the caller) and returns the
 * browser views. The ONLY part of W09 that touches Postgres.
 *
 * Inputs that no wave feeds yet are passed as "unknown", never invented: coverage + probes (stack sources and agent probes = W10),
 * accepted exclusions (W11), kit state (W14, so `false`: fail closed), storage-channel deletion checks (F4/W14P), schedule
 * interval (W11, so never Stale), test-restore age (R2). `ctxOverride` lets tests and later waves inject real coverage.
 */
const HOUR = 3_600_000;

export type ProtectionInputs = {configLocked: boolean; now?: Date; ctxOverride?: Partial<CompletenessContext>; staleAfterHours?: number | null};

export async function loadProtectionViews(
    db: ForkDb, stack: {id: string; staleSince: string | null; environmentId: string | null; protectionState: string},
    inventory: {stored: StackInventoryV1; contentHash: string | null}, o: ProtectionInputs,
): Promise<{protection: ProtectionView; configuration: ConfigurationView}> {
    const now = o.now ?? new Date();
    const pol = await db.execute(sql`select 1 as x from fork_stack_policy where stack_id = ${stack.id} and activated_at is not null and deactivated_at is null`);
    const hasActivePolicy = pol.rows.length > 0;

    const rp = await db.execute(sql`
        select count(*) filter (where status = 'verified')::int as verified,
               count(*) filter (where status = 'pending_verification')::int as pending,
               max(verified_at) filter (where status = 'verified') as last_verified,
               max(created_at) filter (where status = 'pending_verification') as last_pending,
               (select r.status from fork_recovery_point r where r.stack_id = ${stack.id} order by r.sequence desc limit 1) as latest_status
          from fork_recovery_point where stack_id = ${stack.id} and purged_at is null`);
    const r = rp.rows[0] as {verified: number; pending: number; last_verified: Date | null; last_pending: Date | null; latest_status: string | null};

    let allowedRoots: string[] = [];
    if (stack.environmentId) {
        const env = await db.execute(sql`select allowed_path_roots from fork_arcane_environment where id = ${stack.environmentId}`);
        allowedRoots = ((env.rows[0] as {allowed_path_roots: string[] | null} | undefined)?.allowed_path_roots) ?? [];
    }

    const ctx: CompletenessContext = {...EMPTY_CONTEXT, allowedRoots, ...(o.ctxOverride ?? {})};
    const report = validateCompleteness(inventory.stored, ctx);
    const hoursSince = r.last_verified ? Math.max(0, (now.getTime() - new Date(r.last_verified).getTime()) / HOUR) : null;
    const verifying = r.last_pending !== null && (r.last_verified === null || new Date(r.last_pending).getTime() > new Date(r.last_verified).getTime());

    const protection = toProtectionView(
        report,
        {
            hasActivePolicy, lastRunFailed: r.latest_status === "failed", coverageGap: !report.complete,
            verifiedRpCount: r.verified, pendingRpCount: r.pending, hoursSinceLastVerified: hoursSince,
            staleAfterHours: o.staleAfterHours ?? null, kitVerified: false,
        },
        {
            hasActivePolicy, hoursSinceLastVerified: hoursSince, verifying, daysSinceTestRestore: null, channelDeletable: [],
            pausedAfterReauthorization: stack.protectionState === "paused", inventoryStale: stack.staleSince !== null, configLocked: o.configLocked,
        },
    );
    return {protection, configuration: toConfigurationView(inventory.stored, report, inventory.contentHash)};
}
