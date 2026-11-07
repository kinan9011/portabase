import {createHash} from "node:crypto";
import {and, eq, sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkRecoveryPoint, forkRecoveryPointArtifact} from "@/fork/db/schema/recovery";
import {parseInventoryStrict, type StackInventoryV1} from "@/fork/inventory/schema";
import {KeyUnavailableError, type KeyProvider} from "@/fork/keys";
import {acquireLease, releaseLease, withForkLock} from "@/fork/locks";
import {randomUUID} from "node:crypto";
import {loadTrustAnchors, registerLiveAnchor} from "@/fork/manifest/anchors";
import {buildManifest, type ArtifactFacts} from "@/fork/manifest/build";
import type {ResticRunner} from "@/fork/manifest/restic-runner";
import {kidOfPublicKey, signManifest} from "@/fork/manifest/sign";
import {readManifestSnapshot, writeManifestSnapshot, listManifestSnapshots, forgetManifestSnapshots} from "@/fork/manifest/store";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {canTransition} from "@/fork/recovery/status";
import {touchScheduleState} from "@/fork/schedule-state";
import {checkArchiveObject, type OpenArchive} from "./artifact";

/**
 * THE verify job's engine (D24, D43) — the ONLY module that writes RecoveryPoint status `verified` (pinned by `w14-static`).
 *
 * `pending_verification → verified` happens only on real evidence, in this order, for every required artifact: the stored object is read back, decrypted
 * server-side, a complete gzip stream with a valid tar, plaintext SHA-256 + size recorded; a restic artifact must open (`cat snapshot` + `ls`); then the
 * manifest is signed, written as a restic snapshot to EVERY channel that holds an artifact, READ BACK and re-verified with the same verifier a recovery
 * would use. Failure semantics: an INTEGRITY failure (bad tag, truncated, gzip/tar broken, size ≠ the agent-reported pre-encryption size, unencrypted) ⇒ `failed`
 * with a closed reason; an INFRASTRUCTURE failure (unreadable, channel down, signing key unavailable) ⇒ retried with backoff and `failed:verify_failed`
 * (code `infrastructure`) only after `maxAttempts`; a vanished object ⇒ downgraded `incomplete:artifact_missing`. Nothing is ever promoted on a guess.
 */
export const VERIFY_CODES = ["ok", "truncated", "auth_failed", "gzip_invalid", "tar_invalid", "bad_header", "unsupported_version", "empty", "too_large", "size_mismatch", "unencrypted", "restic_unreadable", "missing", "infrastructure", "signing_unavailable", "manifest_unreadable"] as const;
export type VerifyCode = (typeof VERIFY_CODES)[number];

export type VerifyDeps = {
    db: ForkDb;
    keys: KeyProvider;
    openArchive: OpenArchive;
    /** restic artifact repos: resolves true when the snapshot opens and lists ≥ 1 node */
    checkResticSnapshot: (a: {channelId: string; generatedId: string; snapshotId: string}) => Promise<boolean | "missing">;
    /** a runner on the manifest repo of (channel, stack) */
    manifestRunner: (channelId: string, stackId: string, master: Buffer) => Promise<{run: ResticRunner; cleanup: () => Promise<void>}>;
    now?: () => Date;
    limits: {maxPlaintextBytes: number; maxInflatedBytes: number; downloadTimeoutMs: number};
    maxAttempts: number;
    backoffMinutes: readonly number[];
    /** compare the decrypted size with the size the stock agent reported BEFORE encryption (lab-proven equal; see ADR-004 §17) */
    crossCheckAgentSize: boolean;
};

export type VerifyOutcome =
    | {outcome: "verified"; rpId: string; manifestChannels: number}
    | {outcome: "failed"; rpId: string; reason: "verify_failed" | "unencrypted" | "plaintext_hash_mismatch"; code: VerifyCode}
    | {outcome: "downgraded"; rpId: string; reason: string}
    | {outcome: "retry"; rpId: string; attempt: number; code: VerifyCode}
    | {outcome: "skipped"; rpId: string; why: "not_pending" | "not_found" | "busy"};

type ArtRow = typeof forkRecoveryPointArtifact.$inferSelect;
type Result = {id: string; code: VerifyCode; infra: boolean; plaintextSha256?: string; plaintextSize?: number; dumpFormat?: string | null; formatVersion?: number | null};

const reportOf = (attempts: number, outcome: string, results: Result[], extra: Record<string, unknown> = {}) => ({
    version: 1, attempts, outcome, results: results.map((r) => ({artifact: r.id, code: r.code})), ...extra,
});

/** A long download cannot sit inside a transaction: one verifier per RP via a lease (expires on its own if the process dies). */
const LEASE_MS = 45 * 60_000;
export async function verifyRecoveryPoint(d: VerifyDeps, rpId: string): Promise<VerifyOutcome> {
    const owner = randomUUID();
    const name = `verify:${rpId}`;
    if (!(await acquireLease(d.db, name, owner, LEASE_MS, d.now?.()))) return {outcome: "skipped", rpId, why: "busy"};
    try { return await verifyLeased(d, rpId); } finally { await releaseLease(d.db, name, owner).catch(() => false); }
}

async function verifyLeased(d: VerifyDeps, rpId: string): Promise<VerifyOutcome> {
    const now = d.now ?? (() => new Date());
    const [rp] = await d.db.select().from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, rpId));
    if (!rp) return {outcome: "skipped", rpId, why: "not_found"};
    if (rp.status !== "pending_verification" || rp.purgedAt !== null) return {outcome: "skipped", rpId, why: "not_pending"};
    const arts = await d.db.select().from(forkRecoveryPointArtifact).where(eq(forkRecoveryPointArtifact.rpId, rpId));
    const required = arts.filter((a) => a.required);
    const prevAttempts = Number((rp.verifyReport as {attempts?: number} | null)?.attempts ?? 0);
    const attempt = prevAttempts + 1;

    const fail = async (reason: "verify_failed" | "unencrypted" | "plaintext_hash_mismatch", code: VerifyCode, results: Result[]): Promise<VerifyOutcome> => {
        await finish(d, rp, "failed", reason, reportOf(attempt, "failed", results, {code, finishedAt: now().toISOString()}), now());
        return {outcome: "failed", rpId, reason, code};
    };

    // 0. D32 coherence first: a required artifact with a lost FK / not present / wrong count is not verifiable at all
    const presentN = required.filter((a) => a.presence === "present").length;
    if (required.some((a) => a.backupStorageId === null && a.archiveKind !== "restic_snapshot") || required.some((a) => a.presence !== "present") || presentN !== rp.requiredArtifactCount || required.length === 0) {
        const reason = required.some((a) => a.backupId === null || a.backupStorageId === null) ? "fk_null" : required.some((a) => a.presence !== "present") ? "artifact_missing" : "count_mismatch";
        await finish(d, rp, "incomplete", reason, reportOf(attempt, "downgraded", [], {finishedAt: now().toISOString()}), now());
        return {outcome: "downgraded", rpId, reason};
    }

    // 1. keys (fail closed: no master ⇒ nothing can be decrypted or signed)
    let master: Buffer;
    try { master = await d.keys.master(); } catch { return retryOrFail(d, rp, attempt, "infrastructure", [], now()); }

    // 2. artifacts
    const results: Result[] = [];
    for (const a of required) {
        if (a.archiveKind === "archive_plain" || !a.encrypted) { results.push({id: a.id, code: "unencrypted", infra: false}); return fail("unencrypted", "unencrypted", results); }
        if (a.archiveKind === "restic_snapshot") {
            if (!a.channelId || !a.generatedId || !a.pathOrSnapshotId) { results.push({id: a.id, code: "restic_unreadable", infra: false}); return fail("verify_failed", "restic_unreadable", results); }
            let ok: boolean | "missing";
            try { ok = await d.checkResticSnapshot({channelId: a.channelId, generatedId: a.generatedId, snapshotId: a.pathOrSnapshotId}); } catch { ok = false; }
            if (ok === "missing") { await finish(d, rp, "incomplete", "artifact_missing", reportOf(attempt, "downgraded", [...results, {id: a.id, code: "missing", infra: false}], {finishedAt: now().toISOString()}), now(), [a.id]); return {outcome: "downgraded", rpId, reason: "artifact_missing"}; }
            results.push({id: a.id, code: ok ? "ok" : "infrastructure", infra: !ok});
            continue;
        }
        if (!a.backupStorageId) { results.push({id: a.id, code: "missing", infra: false}); continue; }
        const c = await checkArchiveObject(d.openArchive, a.backupStorageId, master, {...d.limits, timeoutMs: d.limits.downloadTimeoutMs});
        if (c.kind === "missing") {
            await finish(d, rp, "incomplete", "artifact_missing", reportOf(attempt, "downgraded", [...results, {id: a.id, code: "missing", infra: false}], {finishedAt: now().toISOString()}), now(), [a.id]);
            return {outcome: "downgraded", rpId, reason: "artifact_missing"};
        }
        if (c.kind === "infra") { results.push({id: a.id, code: "infrastructure", infra: true}); continue; }
        if (c.kind === "integrity") { results.push({id: a.id, code: c.code, infra: false}); return fail("verify_failed", c.code, results); }
        const v = c.verdict;
        if (d.crossCheckAgentSize && a.sizeBytes !== null && v.plaintextSize !== Number(a.sizeBytes)) {
            results.push({id: a.id, code: "size_mismatch", infra: false});
            return fail("verify_failed", "size_mismatch", results);
        }
        results.push({id: a.id, code: "ok", infra: false, plaintextSha256: v.plaintextSha256, plaintextSize: v.plaintextSize, dumpFormat: v.dumpFormat, formatVersion: v.formatVersion});
    }
    if (results.some((r) => r.infra)) return retryOrFail(d, rp, attempt, "infrastructure", results, now());

    // 3. sign (the manifest carries the plaintext hash + size only this job knows)
    let signing: Awaited<ReturnType<KeyProvider["signing"]>>;
    try { signing = await d.keys.signing(); } catch (e) { return retryOrFail(d, rp, attempt, e instanceof KeyUnavailableError ? "signing_unavailable" : "infrastructure", results, now()); }
    const verifiedAt = now();
    const anchor = await registerLiveAnchor(d.db, signing.publicKeyPem, verifiedAt);
    const [stackRow] = (await d.db.execute(sql`select organization_id from fork_stack where id = ${rp.stackId}`)).rows as {organization_id: string}[];
    const inv = await loadInventory(d.db, rp.stackId, rp.inventoryVersion);
    const byId = new Map(results.map((r) => [r.id, r]));
    const facts: ArtifactFacts[] = arts.map((a) => {
        const r = byId.get(a.id);
        return {
            sourceName: a.sourceName, engine: a.engine, archiveKind: a.archiveKind, dumpFormat: r?.dumpFormat ?? a.dumpFormat, archiveFormatVersion: r?.formatVersion ?? a.archiveFormatVersion, encrypted: a.encrypted,
            channelId: a.channelId, channelKind: a.channelKind, pathOrSnapshotId: a.pathOrSnapshotId, generatedId: a.generatedId, sizeBytes: a.sizeBytes === null ? null : Number(a.sizeBytes),
            ciphertextSha256: a.ciphertextSha256, plaintextSha256: r?.plaintextSha256 ?? a.plaintextSha256, plaintextSize: r?.plaintextSize ?? (a.plaintextSize === null ? null : Number(a.plaintextSize)), required: a.required,
        };
    });
    const manifest = buildManifest({
        id: rp.id, stackId: rp.stackId, stackName: rp.stackName, sequence: Number(rp.sequence), createdAt: rp.createdAt, finalizedAt: rp.finalizedAt, consistencyLevel: rp.consistencyLevel,
        inventoryVersion: rp.inventoryVersion, inventoryHash: rp.inventoryHash, requiredArtifactCount: rp.requiredArtifactCount,
    }, facts, inv, {kid: anchor.kid, signedAt: verifiedAt, verifiedAt});
    const signed = signManifest(manifest, signing.privateKeyPem);

    // 4. write the manifest snapshot into EVERY channel holding an artifact, read it back, verify with the recovery-side verifier
    const anchors = await loadTrustAnchors(d.db);
    const channels = [...new Set(required.map((a) => a.channelId).filter((c): c is string => !!c))];
    const refs: {channel_id: string; snapshot_id: string}[] = [];
    for (const channelId of channels) {
        let handle: Awaited<ReturnType<VerifyDeps["manifestRunner"]>> | null = null;
        try {
            handle = await d.manifestRunner(channelId, rp.stackId, master);
            // a retry after a half-finished attempt must not pile up snapshots of the same RP
            await forgetManifestSnapshots(handle.run, rp.id).catch(() => 0);
            const w = await writeManifestSnapshot(handle.run, {json: signed.json, sig: signed.sig, publicKeyPem: signing.publicKeyPem}, {rpId: rp.id, sequence: Number(rp.sequence)});
            const back = await readManifestSnapshot(handle.run, w.snapshotId);
            const vr = verifyManifestBundle({json: back.json, sig: back.sig}, anchors, {stackId: rp.stackId, rpId: rp.id, sequence: Number(rp.sequence)});
            if (!vr.ok || back.json !== signed.json) return retryOrFail(d, rp, attempt, "manifest_unreadable", results, now());
            refs.push({channel_id: channelId, snapshot_id: w.snapshotId});
        } catch {
            return retryOrFail(d, rp, attempt, "infrastructure", results, now());
        } finally {
            await handle?.cleanup().catch(() => undefined);
        }
    }

    // 5. promote — one transaction, only if still pending (a concurrent downgrade/retention wins)
    const promoted = await withForkLock(d.db, `rp:${rp.stackId}`, async (tx) => {
        const t = tx as ForkDb;
        const [cur] = await t.select().from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, rp.id));
        if (!cur || cur.status !== "pending_verification" || cur.purgedAt !== null || !canTransition("pending_verification", "verified")) return false;
        for (const r of results) {
            // a restic artifact has nothing to record (content-addressed): an empty SET is an error in the query builder, so it is skipped
            const facts = {
                ...(r.plaintextSha256 ? {plaintextSha256: r.plaintextSha256, plaintextSize: r.plaintextSize ?? null} : {}),
                ...(r.dumpFormat ? {dumpFormat: r.dumpFormat} : {}), ...(r.formatVersion ? {archiveFormatVersion: r.formatVersion} : {}),
            };
            if (Object.keys(facts).length > 0) await t.update(forkRecoveryPointArtifact).set(facts).where(eq(forkRecoveryPointArtifact.id, r.id));
        }
        await t.update(forkRecoveryPoint).set({
            status: "verified", downgradeReason: null, verifiedAt, manifestSha256: createHash("sha256").update(signed.json).digest("hex"), manifestSigKid: signed.kid,
            manifestRefs: refs, verifyReport: reportOf(attempt, "verified", results, {finishedAt: verifiedAt.toISOString(), manifestChannels: refs.length}),
        }).where(eq(forkRecoveryPoint.id, rp.id));
        await touchScheduleState(t, rp.stackId, {lastVerifiedRpAt: verifiedAt});
        await recordAudit(t, {
            organizationId: stackRow?.organization_id ?? null, actorKind: "system", action: "fork.recovery_point.verify", resourceType: "recovery_point", resourceId: rp.id, result: "success",
            details: {sequence: Number(rp.sequence), artifacts: results.length, manifestChannels: refs.length, kid: signed.kid}, now: verifiedAt,
        });
        return true;
    });
    if (!promoted) return {outcome: "skipped", rpId, why: "not_pending"};
    return {outcome: "verified", rpId, manifestChannels: refs.length};
}

async function loadInventory(db: ForkDb, stackId: string, version: number | null): Promise<StackInventoryV1 | null> {
    if (version === null) return null;
    const r = await db.execute(sql`select inventory as content from fork_stack_inventory where stack_id = ${stackId} and version = ${version}`);
    const row = r.rows[0] as {content: unknown} | undefined;
    if (!row) return null;
    try { return parseInventoryStrict(row.content); } catch { return null; }
}

async function retryOrFail(d: VerifyDeps, rp: typeof forkRecoveryPoint.$inferSelect, attempt: number, code: VerifyCode, results: Result[], now: Date): Promise<VerifyOutcome> {
    if (attempt >= d.maxAttempts) {
        await finish(d, rp, "failed", "verify_failed", reportOf(attempt, "failed", results, {code: code === "signing_unavailable" ? code : "infrastructure", finishedAt: now.toISOString()}), now);
        return {outcome: "failed", rpId: rp.id, reason: "verify_failed", code: code === "signing_unavailable" ? code : "infrastructure"};
    }
    const delayMin = d.backoffMinutes[Math.min(attempt - 1, d.backoffMinutes.length - 1)] ?? 60;
    const next = new Date(now.getTime() + delayMin * 60_000);
    await d.db.update(forkRecoveryPoint).set({verifyReport: reportOf(attempt, "retry", results, {code, nextAttemptAt: next.toISOString()})}).where(and(eq(forkRecoveryPoint.id, rp.id), eq(forkRecoveryPoint.status, "pending_verification")));
    return {outcome: "retry", rpId: rp.id, attempt, code};
}

/** Terminal non-verified transition (failed / downgraded) under the stack lock, audited. `missingArtifactIds` get `presence='missing'`. */
async function finish(d: VerifyDeps, rp: typeof forkRecoveryPoint.$inferSelect, to: "failed" | "incomplete", reason: string, report: Record<string, unknown>, now: Date, missingArtifactIds: string[] = []): Promise<void> {
    await withForkLock(d.db, `rp:${rp.stackId}`, async (tx) => {
        const t = tx as ForkDb;
        const [cur] = await t.select().from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, rp.id));
        if (!cur || cur.status !== "pending_verification" || !canTransition("pending_verification", to)) return;
        for (const id of missingArtifactIds) await t.update(forkRecoveryPointArtifact).set({presence: "missing"}).where(eq(forkRecoveryPointArtifact.id, id));
        const present = (await t.execute(sql`select count(*)::int as n from fork_recovery_point_artifact where rp_id = ${rp.id} and required and presence = 'present'`)).rows[0] as {n: number};
        await t.update(forkRecoveryPoint).set({status: to, downgradeReason: reason, verifiedAt: null, verifyReport: report, presentArtifactCount: present.n}).where(eq(forkRecoveryPoint.id, rp.id));
        const [stack] = (await t.execute(sql`select organization_id from fork_stack where id = ${rp.stackId}`)).rows as {organization_id: string}[];
        await recordAudit(t, {
            organizationId: stack?.organization_id ?? null, actorKind: "system", action: "fork.recovery_point.verify", resourceType: "recovery_point", resourceId: rp.id,
            result: to === "failed" ? "failure" : "denied", details: {sequence: Number(rp.sequence), outcome: to, reason, attempts: (report as {attempts?: number}).attempts}, now,
        });
    });
}

export const verifiedKid = (publicKeyPem: string) => kidOfPublicKey(publicKeyPem);
export {listManifestSnapshots};
