import {and, eq, inArray, isNull, sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import {forkRecoveryPoint, forkRecoveryPointArtifact} from "@/fork/db/schema/recovery";
import {RetentionPolicySchema} from "@/fork/recovery/retention-policy";
import {deleterOf, modeOf, nowOf, type RunDeps} from "@/fork/runs/deps";
import {loadStackFacts, reauthorize} from "@/fork/runs/reauth";
import {ScheduleSchema} from "@/fork/schedule/schedule";
import {backupsInRestoration, liveSuccessfulBackups, readBackupFacts} from "@/fork/upstream";
import {DEFAULT_MAX_AGE_DAYS, selectRetention, type RpFacts} from "./retention";

/**
 * D33 retention EXECUTOR. Selection is the pure `selectRetention`; this module only (1) re-authorizes (the activation user must still hold
 * `repository.prune`; NO pause here — a failed prune authorization just prunes nothing, and a paused/deactivated policy is never
 * pruned), (2) deletes each backup of an expired RP through the UPSTREAM delete path (storage object / restic forget + soft delete,
 * `deleteBackupService`), and (3) records the outcome without ever claiming a deletion that did not happen:
 *   expiring (`expires_at` set) → expired (`purged_at` set, row + artifact facts kept as a tombstone);
 *   any artifact deletion failing ⇒ the RP becomes `incomplete(retention_partial)` and is retried next time.
 * The manifest/snapshot `forget` of an expired RP belongs to W14 (the manifest does not exist yet). Runs in `locked` mode too (protective
 * housekeeping, ADR-010); never in `off`.
 */
export type RetentionResult = {stacks: number; selected: number; purged: number; partial: number; skipped: number; orphansDeleted: number};

export async function retentionTick(d: RunDeps): Promise<RetentionResult> {
    const out: RetentionResult = {stacks: 0, selected: 0, purged: 0, partial: 0, skipped: 0, orphansDeleted: 0};
    if ((await modeOf(d)) === "off") return out;
    const rows = await d.db.execute(sql`select stack_id from fork_stack_policy where activated_at is not null and deactivated_at is null and paused_at is null`);
    for (const r of rows.rows as {stack_id: string}[]) {
        try {
            const s = await pruneStack(d, r.stack_id);
            out.stacks++; out.selected += s.selected; out.purged += s.purged; out.partial += s.partial; out.orphansDeleted += s.orphansDeleted; if (s.skipped) out.skipped++;
        } catch {
            out.skipped++; // one stack never stops the others
        }
    }
    return out;
}

export type PruneStackResult = {selected: number; purged: number; partial: number; orphansDeleted: number; skipped: boolean};

export async function pruneStack(d: RunDeps, stackId: string): Promise<PruneStackResult> {
    const res: PruneStackResult = {selected: 0, purged: 0, partial: 0, orphansDeleted: 0, skipped: false};
    const now = nowOf(d);
    const facts = await loadStackFacts(d.db, stackId);
    if (!facts) return {...res, skipped: true};
    const auth = await reauthorize(d, facts, "repository.prune");
    if (!auth.ok) return {...res, skipped: true};
    const policy = RetentionPolicySchema.safeParse(facts.policy);
    const sched = ScheduleSchema.safeParse(facts.schedule);
    if (!policy.success || !sched.success) return {...res, skipped: true};

    const activeRun = (await d.db.execute(sql`select 1 from fork_stack_run where stack_id = ${stackId} and state in ('starting','running','finalizing') limit 1`)).rows.length > 0;
    const rps = await d.db.select().from(forkRecoveryPoint).where(and(eq(forkRecoveryPoint.stackId, stackId), isNull(forkRecoveryPoint.purgedAt)));
    const arts = rps.length ? await d.db.select().from(forkRecoveryPointArtifact).where(inArray(forkRecoveryPointArtifact.rpId, rps.map((r) => r.id))) : [];
    const backupIdsOfRp = new Map<string, string[]>();
    for (const a of arts) if (a.backupId) backupIdsOfRp.set(a.rpId, [...new Set([...(backupIdsOfRp.get(a.rpId) ?? []), a.backupId])]);
    const inRestore = await backupsInRestoration(d.db, [...new Set(arts.flatMap((a) => (a.backupId ? [a.backupId] : [])))]);

    const rpFacts: RpFacts[] = rps.map((r) => ({
        id: r.id, status: r.status as RpFacts["status"], sequence: r.sequence, finalizedAt: r.finalizedAt, createdAt: r.createdAt, purgedAt: r.purgedAt,
        channelIds: [...new Set(arts.filter((a) => a.rpId === r.id && a.presence === "present" && a.channelId).map((a) => a.channelId as string))],
        expiring: r.expiresAt !== null,
        inUse: activeRun || (backupIdsOfRp.get(r.id) ?? []).some((b) => inRestore.has(b)),
    }));
    const sel = selectRetention(rpFacts, policy.data, {now, timezone: sched.data.timezone, maxAgeDays: DEFAULT_MAX_AGE_DAYS});
    res.selected = sel.prune.length;

    for (const id of sel.prune) {
        const rp = rps.find((r) => r.id === id) as (typeof rps)[number];
        const ids = backupIdsOfRp.get(id) ?? [];
        const bf = await readBackupFacts(d.db, ids);
        await d.db.update(forkRecoveryPoint).set({expiresAt: rp.expiresAt ?? now}).where(eq(forkRecoveryPoint.id, id));
        let failed = 0;
        for (const b of ids) {
            const f = bf.get(b);
            if (!f) continue; // already hard-deleted upstream
            if (f.deletedAt !== null && f.storages.every((s) => s.deletedAt !== null)) continue; // already deleted
            const r = await deleterOf(d)(b, f.databaseId);
            if (!r.ok) failed++;
        }
        if (failed === 0) {
            await d.db.transaction(async (tx) => {
                const t = tx as unknown as RunDeps["db"];
                await t.update(forkRecoveryPoint).set({purgedAt: now}).where(eq(forkRecoveryPoint.id, id));
                await t.update(forkRecoveryPointArtifact).set({presence: "missing"}).where(eq(forkRecoveryPointArtifact.rpId, id));
                await recordAudit(t, {organizationId: facts.organizationId, actorUserId: auth.userId, actorKind: "system", action: "fork.recovery_point.purge", resourceType: "recovery_point", resourceId: id, result: "success", details: {stackId, sequence: rp.sequence, status: rp.status, why: "retention"}, now});
            });
            res.purged++;
        } else {
            if (rp.status === "pending_verification" || rp.status === "verified") await d.db.update(forkRecoveryPoint).set({status: "incomplete", downgradeReason: "retention_partial", verifiedAt: null}).where(eq(forkRecoveryPoint.id, id));
            else if (rp.status === "incomplete") await d.db.update(forkRecoveryPoint).set({downgradeReason: "retention_partial"}).where(eq(forkRecoveryPoint.id, id));
            await recordAudit(d.db, {organizationId: facts.organizationId, actorKind: "system", action: "fork.recovery_point.purge", resourceType: "recovery_point", resourceId: id, result: "failure", details: {stackId, sequence: rp.sequence, failedBackups: failed}, now});
            res.partial++;
        }
    }

    // Orphan sweep: member backups no RP references (a cancelled run's ongoing backup that finished late) are removed by age; never while a run is active.
    if (!activeRun) res.orphansDeleted = await sweepOrphans(d, stackId, facts.organizationId, now);
    return res;
}

async function sweepOrphans(d: RunDeps, stackId: string, organizationId: string, now: Date): Promise<number> {
    const links = (await d.db.execute(sql`select database_id from fork_stack_source where stack_id = ${stackId} and database_id is not null`)).rows as {database_id: string}[];
    const live = await liveSuccessfulBackups(d.db, links.map((l) => l.database_id));
    if (live.length === 0) return 0;
    const referenced = new Set((await d.db.select({b: forkRecoveryPointArtifact.backupId}).from(forkRecoveryPointArtifact).where(inArray(forkRecoveryPointArtifact.backupId, live.map((x) => x.id)))).map((x) => x.b));
    const old = live.filter((b) => !referenced.has(b.id) && now.getTime() - b.createdAt.getTime() > DEFAULT_MAX_AGE_DAYS * 86_400_000);
    const inRestore = await backupsInRestoration(d.db, old.map((b) => b.id));
    let n = 0;
    for (const b of old) {
        if (inRestore.has(b.id)) continue;
        if ((await deleterOf(d)(b.id, b.databaseId)).ok) n++;
    }
    if (n > 0) await recordAudit(d.db, {organizationId, actorKind: "system", action: "fork.recovery_point.orphan_sweep", resourceType: "stack", resourceId: stackId, result: "success", details: {deleted: n}, now});
    return n;
}
