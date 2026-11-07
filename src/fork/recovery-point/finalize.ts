import {eq, sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkStackRun, forkStackRunItem} from "@/fork/db/schema/runs";
import {forkRecoveryPoint, forkRecoveryPointArtifact} from "@/fork/db/schema/recovery";
import {withForkLock} from "@/fork/locks";
import {enqueueForkNotification} from "@/fork/notify";
import {touchScheduleState} from "@/fork/schedule-state";
import {encryptionOf, nowOf, type RunDeps} from "@/fork/runs/deps";
import {loadStackFacts} from "@/fork/runs/reauth";
import {TIMEOUT_REASONS} from "@/fork/runs/steps";
import type {RunReason} from "@/fork/runs/vocab";
import {channelsByIds, readBackupFacts, readMembers} from "@/fork/upstream";
import {buildArtifacts, type ItemFacts} from "./build";
import {consistencyOf, decideRecoveryPoint} from "./decide";

/**
 * The finaliser (W12): ONE RecoveryPoint per run, written in ONE transaction under the per-stack lock that also assigns the
 * monotonic `sequence` (anti-rollback, D24). Idempotent (`UNIQUE(run_id)`): a second call returns the existing RP. The status comes
 * from the pure `decideRecoveryPoint` — this module has NO code path that writes `verified` (D43, asserted by `w12-runs-static`).
 * Manifest, signature and verification belong to W14: `manifest_*` stay empty and the RP waits in `pending_verification`.
 */
export type FinalizeForced = "cancelled" | "internal_error";
export type FinalizeOutcome = {rpId: string; status: string; reason: string | null; runState: string; created: boolean};

export async function finalizeRun(d: RunDeps, runId: string, forced?: FinalizeForced): Promise<FinalizeOutcome> {
    const now = nowOf(d);
    const [run] = await d.db.select().from(forkStackRun).where(eq(forkStackRun.id, runId));
    if (!run) throw new Error("run_not_found");
    const [existing] = await d.db.select().from(forkRecoveryPoint).where(eq(forkRecoveryPoint.runId, runId));
    if (existing) return {rpId: existing.id, status: existing.status, reason: existing.downgradeReason, runState: run.state, created: false};
    const facts = await loadStackFacts(d.db, run.stackId);
    if (!facts) throw new Error("stack_not_found");

    const items = await d.db.select().from(forkStackRunItem).where(eq(forkStackRunItem.runId, runId));
    const backupIds = items.flatMap((i) => (i.backupId ? [i.backupId] : []));
    const backups = await readBackupFacts(d.db, backupIds);
    const sourceIds = items.flatMap((i) => (i.stackSourceId ? [i.stackSourceId] : []));
    const links = sourceIds.length ? (await d.db.execute(sql`select id, database_id from fork_stack_source where id in (${sql.join(sourceIds.map((s) => sql`${s}::uuid`), sql`, `)})`)).rows as {id: string; database_id: string | null}[] : [];
    const dbIds = links.flatMap((l) => (l.database_id ? [l.database_id] : []));
    const members = await readMembers(d.db, dbIds);
    const dbOfSource = new Map(links.map((l) => [l.id, l.database_id]));
    const channels = (await channelsByIds(d.db, facts.storageChannelIds)).map((c) => ({id: c.id, provider: c.provider}));
    const encryptionOn = await encryptionOf(d);

    const itemFacts: ItemFacts[] = items.map((i) => ({
        itemId: i.id, stackSourceId: i.stackSourceId, sourceName: i.sourceName, dbms: i.dbms, required: i.required, state: i.state, backupId: i.backupId,
        generatedId: (i.stackSourceId && dbOfSource.get(i.stackSourceId) ? members.get(dbOfSource.get(i.stackSourceId) as string)?.agentDatabaseId : null) ?? null,
        checksums: i.checksums as ItemFacts["checksums"],
    }));
    const built = buildArtifacts(itemFacts, backups, channels);
    const decision = decideRecoveryPoint({
        cancelled: forced === "cancelled", errored: forced === "internal_error",
        timedOut: items.some((i) => i.reason !== null && TIMEOUT_REASONS.includes(i.reason as RunReason)),
        timeoutReason: items.map((i) => i.reason as RunReason | null).find((r): r is RunReason => r !== null && TIMEOUT_REASONS.includes(r)),
        queuedMembers: items.filter((i) => i.backupId !== null).length, validatorComplete: !run.validatorBlocked, encryptionOn, artifacts: built.inputs,
    });
    const consistency = consistencyOf(built.rows.filter((r) => r.presence === "present").map((r) => r.engine));
    const [inv] = run.inventoryVersion !== null ? (await d.db.execute(sql`select content_hash from fork_stack_inventory where stack_id = ${run.stackId} and version = ${run.inventoryVersion}`)).rows as {content_hash: string}[] : [];

    return withForkLock(d.db, `rp:${run.stackId}`, async (tx) => {
        const t = tx as ForkDb;
        const [again] = await t.select().from(forkRecoveryPoint).where(eq(forkRecoveryPoint.runId, runId));
        if (again) return {rpId: again.id, status: again.status, reason: again.downgradeReason, runState: run.state, created: false};
        const seqRow = await t.execute(sql`select coalesce(max(sequence), 0)::bigint + 1 as next from fork_recovery_point where stack_id = ${run.stackId}`);
        const sequence = Number((seqRow.rows[0] as {next: string}).next);
        const [rp] = await t.insert(forkRecoveryPoint).values({
            stackId: run.stackId, stackName: facts.displayName, runId, sequence, inventoryVersion: run.inventoryVersion, inventoryHash: inv?.content_hash ?? null,
            status: decision.status, downgradeReason: decision.reason, consistencyLevel: consistency, requiredArtifactCount: built.requiredCount,
            presentArtifactCount: built.presentCount, totalSizeBytes: built.totalSize, createdAt: run.startedAt, finalizedAt: now,
        }).returning({id: forkRecoveryPoint.id});
        if (built.rows.length > 0) {
            await t.insert(forkRecoveryPointArtifact).values(built.rows.map((r) => ({
                rpId: rp.id, stackSourceId: r.stackSourceId, backupId: r.backupId, backupStorageId: r.backupStorageId, sourceName: r.sourceName, engine: r.engine,
                dumpFormat: null, archiveKind: r.archiveKind, encrypted: r.encrypted, channelId: r.channelId, channelKind: r.channelKind, pathOrSnapshotId: r.pathOrSnapshotId,
                generatedId: r.generatedId, sizeBytes: r.sizeBytes, ciphertextSha256: r.ciphertextSha256, required: r.required, presence: r.presence,
            })));
        }
        await t.update(forkStackRun).set({state: decision.runState, reason: decision.runReason, finishedAt: now, updatedAt: now}).where(eq(forkStackRun.id, runId));
        await touchScheduleState(t, run.stackId, {
            lastRunFinishedAt: now, ...(decision.runState === "cancelled" ? {} : {lastRunStatus: decision.runState === "succeeded" ? "success" : decision.runState === "incomplete" ? "partial" : "failed"}),
        });
        await recordAudit(t, {
            organizationId: facts.organizationId, actorKind: "system", action: "fork.stack_run.finish", resourceType: "stack_run", resourceId: runId,
            result: decision.status === "failed" ? "failure" : "success", details: {state: decision.runState, rpStatus: decision.status, reason: decision.reason, required: built.requiredCount, present: built.presentCount, sequence},
            now,
        });
        // §4.7 events: failed run; skipped/blocked run that still produced an INCOMPLETE RP. Codes + stack id for the link only (names/paths/raw errors never).
        const ev = decision.status === "failed" ? "run.failed" : decision.reason === "validator_blocked" ? "run.blocked" : decision.status === "incomplete" ? "run.incomplete" : null;
        if (ev) await enqueueForkNotification(t, {kind: ev, dedupeKey: `${ev}:${runId}`, payload: {state: decision.status, reason: decision.reason, stackId: run.stackId, link: `/dashboard/stacks/${run.stackId}`}});
        return {rpId: rp.id, status: decision.status, reason: decision.reason, runState: decision.runState, created: true};
    });
}
