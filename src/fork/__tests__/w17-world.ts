import {createHash, randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {enrolAgent} from "@/fork/agent-channel/admin";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {registerLiveAnchor} from "@/fork/manifest/anchors";
import {buildManifest} from "@/fork/manifest/build";
import {signManifest} from "@/fork/manifest/sign";
import {createRestorePlan, approveRestorePlan} from "@/fork/restore/service";
import {seedBackup, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {P, req, seedUser, seedWorld, type World} from "@/fork/__tests__/w16-world";

/** W17 test world: a plannable world (w16-world) whose RP has a REAL signed manifest and whose target agent is REALLY enrolled on the channel (task key, credential). */
export const PASSWORD = `pw-${randomUUID()}`;
export const ENV = {FORK_ALLOW_INSECURE_LOOPBACK: false, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 60};
export type W17 = World & {key: ReturnType<typeof testKeypair>; manifestJson: string; manifestSig: string; manifestSha: string; agentBundle: string};

export const deps = (t: W04Db, kek: string, key: ReturnType<typeof testKeypair>, userId: string | null, p: {role?: string; memberships?: [string, string][]; now?: () => Date; over?: Partial<ChannelDeps>} = {}): ChannelDeps => ({
    db: t.db, principal: userId ? {userId, systemRole: p.role ?? null, memberships: (p.memberships ?? []).map(([organizationId, role]) => ({organizationId, role}))} : null,
    kekDir: kek, now: p.now ?? (() => new Date()), serverUrl: () => "https://dash.example.test", env: () => ENV,
    keys: {master: async () => Buffer.alloc(32), signing: async () => ({privateKeyPem: key.privateKey, publicKeyPem: key.publicKey})}, configAllowed: async () => true, ...p.over});

export async function adminUser(pool: Pool): Promise<string> {
    const id = await seedUser(pool, "admin");
    const {hashPassword} = await import("better-auth/crypto");
    await pool.query(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), id, id, await hashPassword(PASSWORD)]);
    return id;
}
export const newKek = () => mkdtempSync(path.join(tmpdir(), "w17-kek-"));

export async function seedW17World(t: W04Db, kek: string, key: ReturnType<typeof testKeypair>, admin: string, o: {org: string; hostRole?: "production" | "test"; extraManifestArtifacts?: number; caps?: string[]}): Promise<W17> {
    const pool = t.pool;
    const w = await seedWorld(pool, {org: o.org, hostRole: o.hostRole ?? "test", caps: o.caps});
    // real enrolment (task key + credential) instead of the stub row of seedWorld
    await pool.query("delete from fork_agent_enrollment where agent_id=$1", [w.agent]);
    const r = await enrolAgent(deps(t, kek, key, admin, {role: "admin"}), {agentId: w.agent, password: PASSWORD});
    if (!r.ok) throw new Error(`enrol: ${r.code}`);
    await pool.query("update fork_agent_enrollment set capabilities=$2 where agent_id=$1", [w.agent, o.caps ?? ["channel.v1", "noop.v1", "restore.target.v1"]]);
    // real signed manifest over the seeded RP + artifacts
    const rp = (await pool.query("select * from fork_recovery_point where id=$1", [w.rp])).rows[0];
    const arts = (await pool.query("select * from fork_recovery_point_artifact where rp_id=$1 order by source_name", [w.rp])).rows;
    const facts = arts.map((a) => ({sourceName: a.source_name, engine: a.engine, archiveKind: a.archive_kind, dumpFormat: a.dump_format, archiveFormatVersion: a.archive_format_version, encrypted: a.encrypted, channelId: a.channel_id, channelKind: a.channel_kind,
        pathOrSnapshotId: a.path_or_snapshot_id, generatedId: a.generated_id, sizeBytes: a.size_bytes === null ? null : Number(a.size_bytes), ciphertextSha256: a.ciphertext_sha256, plaintextSha256: a.plaintext_sha256, plaintextSize: a.plaintext_size === null ? null : Number(a.plaintext_size), required: a.required}));
    for (let i = 0; i < (o.extraManifestArtifacts ?? 0); i++) facts.push({...facts[0], sourceName: `pad_${i}`, pathOrSnapshotId: "p".repeat(1000)});
    await registerLiveAnchor(t.db, key.publicKey);
    const m = buildManifest({id: w.rp, stackId: w.stack, stackName: "app", sequence: Number(rp.sequence), createdAt: rp.created_at, finalizedAt: rp.created_at, consistencyLevel: "mixed", inventoryVersion: 1, inventoryHash: rp.inventory_hash, requiredArtifactCount: 3}, facts, null,
        {kid: key.kid, signedAt: new Date("2026-11-07T10:10:00Z"), verifiedAt: new Date("2026-11-07T10:09:00Z")});
    const signed = signManifest(m, key.privateKey);
    const manifestSha = createHash("sha256").update(signed.json).digest("hex");
    await pool.query("update fork_recovery_point set manifest_sha256=$2, manifest_sig_kid=$3 where id=$1", [w.rp, manifestSha, key.kid]);
    const chan = arts[0].channel_id as string;
    for (const a of arts) await pool.query("update fork_recovery_point_artifact set backup_storage_id=$2 where id=$1", [a.id, (await seedBackup(pool, w.agent, chan)).backupStorageId]);
    return {...w, key, manifestJson: signed.json, manifestSig: signed.sig.toString("base64"), manifestSha, agentBundle: r.bundle};
}

export {P, req, approveRestorePlan, createRestorePlan};
