import {createHash, randomUUID} from "node:crypto";
import {buildManifest} from "@/fork/manifest/build";
import {signManifest} from "@/fork/manifest/sign";
import {seedBackup, type W04Db} from "@/fork/__tests__/w04-helpers";
import type {testKeypair} from "@/fork/__tests__/w14-fixtures";
import type {W17} from "@/fork/__tests__/w17-world";

/**
 * W24 test world helper: a SECOND verified recovery point of the SAME stack (the refresh source). A copy of the base RP and its artifacts (new ids, `sequence = max + 1`), the manifest re-built and signed
 * exactly like `seedW17World` does, fresh stored objects per artifact. `plain` overrides the plaintext hash / size per source name (a different image), `plaintextSize` sets every artifact's plaintext size
 * (the insufficient-disk case). The returned world is the base world with the new `rp` and its manifest; mirror deps for a refresh revision must serve that manifest (`manifestFor`).
 */
// ponytail: a copy of the seedW17World tail; extract if a third caller appears.
export async function nextRp(t: W04Db, base: W17, key: ReturnType<typeof testKeypair>, o: {plain?: Record<string, {sha: string; size: number; dump?: "pg_custom" | "pg_directory"}>; plaintextSize?: number; status?: string} = {}): Promise<W17> {
    const pool = t.pool;
    const rows = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[]; // biome-ignore lint/suspicious/noExplicitAny: row copy
    const [src] = await rows("select * from fork_recovery_point where id=$1", [base.rp]);
    const [{max}] = await rows("select max(sequence)::bigint as max from fork_recovery_point where stack_id=$1", [base.stack]);
    const rpId = randomUUID();
    const seq = Number(max) + 1;
    const copy = async (table: string, row: Record<string, unknown>) => {
        const cols = Object.keys(row);
        await pool.query(`insert into ${table} (${cols.map((c) => `"${c}"`).join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => row[c]));
    };
    await copy("fork_recovery_point", {...src, id: rpId, sequence: seq, status: o.status ?? src.status, manifest_sha256: null, manifest_sig_kid: null});
    const arts = await rows("select * from fork_recovery_point_artifact where rp_id=$1 order by source_name", [base.rp]);
    for (const a of arts) {
        const id = randomUUID();
        await copy("fork_recovery_point_artifact", {...a, id, rp_id: rpId, backup_storage_id: (await seedBackup(pool, base.agent, a.channel_id as string)).backupStorageId});
        const p = o.plain?.[a.source_name as string];
        if (p) await pool.query("update fork_recovery_point_artifact set plaintext_sha256=$2, plaintext_size=$3, dump_format=$4 where id=$1", [id, p.sha, p.size, p.dump ?? a.dump_format ?? null]);
        if (o.plaintextSize !== undefined) await pool.query("update fork_recovery_point_artifact set plaintext_size=$2 where id=$1", [id, o.plaintextSize]);
    }
    const newArts = await rows("select * from fork_recovery_point_artifact where rp_id=$1 order by source_name", [rpId]);
    const facts = newArts.map((a) => ({sourceName: a.source_name, engine: a.engine, archiveKind: a.archive_kind, dumpFormat: a.dump_format, archiveFormatVersion: a.archive_format_version, encrypted: a.encrypted, channelId: a.channel_id, channelKind: a.channel_kind,
        pathOrSnapshotId: a.path_or_snapshot_id, generatedId: a.generated_id, sizeBytes: a.size_bytes === null ? null : Number(a.size_bytes), ciphertextSha256: a.ciphertext_sha256, plaintextSha256: a.plaintext_sha256, plaintextSize: a.plaintext_size === null ? null : Number(a.plaintext_size), required: a.required}));
    const [rp] = await rows("select * from fork_recovery_point where id=$1", [rpId]);
    const m = buildManifest({id: rpId, stackId: base.stack, stackName: "app", sequence: seq, createdAt: rp.created_at, finalizedAt: rp.created_at, consistencyLevel: "mixed", inventoryVersion: 1, inventoryHash: rp.inventory_hash,
        requiredArtifactCount: newArts.filter((a) => a.required).length}, facts, null, {kid: key.kid, signedAt: new Date("2026-11-07T10:10:00Z"), verifiedAt: new Date("2026-11-07T10:09:00Z")});
    const signed = signManifest(m, key.privateKey);
    const manifestSha = createHash("sha256").update(signed.json).digest("hex");
    await pool.query("update fork_recovery_point set manifest_sha256=$2, manifest_sig_kid=$3 where id=$1", [rpId, manifestSha, key.kid]);
    return {...base, rp: rpId, manifestJson: signed.json, manifestSig: signed.sig.toString("base64"), manifestSha};
}

/** `deps(...).manifest` that serves the right manifest per recovery point (the first world + every `nextRp` world). */
export const manifestFor = (...worlds: W17[]) => async (rp: {id: string}) => {
    const w = worlds.find((x) => x.rp === rp.id);
    return w ? {json: w.manifestJson, sigB64: w.manifestSig} : null;
};
