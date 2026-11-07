import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {createCipheriv, createPrivateKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {Client as Minio} from "minio";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {enrolAgent} from "@/fork/agent-channel/admin";
import {decodeBundle, type ChannelBundle} from "@/fork/agent-channel/bundle";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {EnvelopeSchema} from "@/fork/agent-channel/envelope";
import {pinDashboardKey, requestCredentialRotation, unpinDashboardKey} from "@/fork/agent-channel/maint";
import {encryptPayload, payloadSha256} from "@/fork/agent-channel/payload";
import {enqueueTask} from "@/fork/agent-channel/tasks";
import {MAINT_CAPABILITY, SIGN_DOMAIN} from "@/fork/agent-channel/vocab";
import {canonicalJson} from "@/fork/canonical";
import type {ForkDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {queueWaitingBackups} from "@/fork/upstream/backups";
import {verifyRecoveryPoint, type VerifyDeps} from "@/fork/verify/service";
import {freshForkDb, seedAgent, seedArtifact, seedProject, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {localRepos} from "@/fork/__tests__/w14-verify-helpers";

/**
 * LIVE W15b test (FORK_LAB=1, docker-bridge lab ONLY, synthetic data, throw-away random credentials, never the owner's hosts):
 * the REAL fork dashboard (production build, real routes) + ONE REAL fork agent (image `W15B_AGENT_IMAGE`, built by `scripts/fork/build-image.sh`) +
 * a lab Postgres source + MinIO, all on a dedicated docker network.
 *   L1 D45 match: real backup → real A03 hook → real hash-report route → the REAL verify job over an RP planted around that backup ⇒ `verified`, agent_hash: match.
 *   L2 D45 mismatch: a REAL storage-object swap ⇒ RP `failed:plaintext_hash_mismatch`.
 *   L3 pins: signed pin_add / pin_revoke against the real agent (persisted across a restart, revoked key refused).
 *   L4 rotation: signed rotate_credential (old bearer 401, agent keeps working after a restart, D45 hook uses the rotated credential).
 *   L5 canary: no secret in any log.
 * HONEST NOTE (recorded in the evidence): the RP row is planted around the real backup (the W12 run/finaliser path is live-proven in W12/W14); what this adds
 * is "hash the agent computed BEFORE encryption ⇄ hash the dashboard computed AFTER decryption" on a real archive.
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, restic on the host, and the agent image.
 */
const LAB = process.env.FORK_LAB === "1";
const IMAGE = process.env.W15B_AGENT_IMAGE ?? "portabase-agent-fork:w15b-lab";
const NET = "w15b-lab-net", SUBNET = "172.31.251.0/24", GW = "172.31.251.1";
const AGENT_C = "w15b-agent", PG_C = "w15b-src-pg", MINIO_C = "w15b-minio", VOL = "w15b-agent-state";
const PG_IMAGE = "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b";
const MINIO_IMAGE = "coollabsio/minio@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9";
const BUCKET = "w15b-primary";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync("docker", args, {encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"]}).trim();
const freePort = (host = GW) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const logs = (name: string) => { try { return execFileSync("docker", ["logs", name], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}); } catch (e) { return String(e); } };
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let priv = ""; let tmp = ""; let base = ""; let org = ""; let adminId = ""; let minio: Minio; let minioPort = 0;
const RUN: string[] = [];
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const URL_FOR_AGENTS = () => `http://forklab-dashboard.localhost:${new URL(base).port}`;
const rnd = (n = 18) => randomBytes(n).toString("base64url");

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard (fork lines) ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-12).join("\n").slice(-2500)}\n--- agent ---\n${stripAnsi(logs(AGENT_C)).split("\n").filter((l) => /[Ff]ork|rror|WARN/.test(l)).slice(-10).join(" | ").slice(-2500)}`);
        await sleep(1000);
    }
}

const PW = "lab-step-up-not-checked";
const deps = (): ChannelDeps => ({db, principal: {userId: adminId, systemRole: "superadmin", memberships: []}, keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok",
    env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 60}), configAllowed: async () => true});

async function startAgent(agentId: string, bundle: string) {
    const master = readFileSync(path.join(priv, "keys", "master_key.bin"));
    const edge = Buffer.from(JSON.stringify({serverUrl: URL_FOR_AGENTS(), agentId, masterKeyB64: master.toString("base64")})).toString("base64url");
    const f = path.join(tmp, "agent.bundle");
    writeFileSync(f, bundle, {mode: 0o600}); chmodSync(f, 0o600);
    docker(["run", "-d", "--name", AGENT_C, "--network", NET, "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production",
        "-e", "FORK_CHANNEL_ENABLED=true", "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2",
        "-v", `${f}:/run/fork/bundle:ro`, "-v", `${VOL}:/config`, IMAGE], {...process.env, EDGE_KEY: edge});
}
const task = async (id: string) => (await q("select status, result, attempts, agent_id from fork_agent_task where id=$1", [id]))[0];
const finished = (id: string, ms = 90_000) => waitFor(`task ${id} final`, async () => { const x = await task(id); return x && !["queued", "leased", "running"].includes(x.status) ? x : null; }, ms);

/** A signed noop for the agent, signed with `signWith` (default: the dashboard's real key), planted as a queued row (the dashboard hands it out as-is; the AGENT decides). */
async function plantNoop(agentId: string, signWith: {privateKey: string; kid: string}, echo: string) {
    const [e] = await q("select enroll_id from fork_agent_enrollment where agent_id=$1", [agentId]);
    const [{seq}] = await q("update fork_agent_enrollment set next_seq=next_seq+1 where agent_id=$1 returning next_seq-1 as seq", [agentId]);
    const taskId = randomUUID();
    const taskKey = Buffer.from(decodeBundle(bundleOf).task_key_b64, "base64");
    const pt = Buffer.from(JSON.stringify({echo}));
    const now = Math.floor(Date.now() / 1000);
    const env = EnvelopeSchema.parse({v: 1, task_id: taskId, agent_id: agentId, enroll_id: e.enroll_id, type: "noop", seq, issued_at: now - 5, not_after: now + 600, nonce: randomBytes(16).toString("base64url"),
        payload_sha256: payloadSha256(pt), requires: ["noop.v1"], kid: signWith.kid});
    const text = canonicalJson(env);
    const signature = rsaSign("sha256", Buffer.from(SIGN_DOMAIN + text), createPrivateKey(signWith.privateKey)).toString("base64");
    await q(`insert into fork_agent_task (id, agent_id, agent_name, enroll_id, type, requires, seq, envelope_text, signature, kid, payload_enc, payload_sha256, status, created_by, not_after)
             values ($1,$2,'planted',$3,'noop','{noop.v1}',$4,$5,$6,$7,$8,$9,'queued','lab', now() + interval '10 minutes')`,
        [taskId, agentId, e.enroll_id, seq, text, signature, signWith.kid, encryptPayload(taskKey, {taskId, agentId, type: "noop"}, pt), env.payload_sha256]);
    return taskId;
}
let bundleOf = ""; // the ORIGINAL bundle string (its task key never changes; its credential is what rotation retires)

describe.skipIf(!LAB)("W15b live: fork agent image + real backups (D45) + signed maintenance (pins, rotation)", () => {
    let agentId = ""; let bundle: ChannelBundle; let projectId = ""; let channelId = ""; let databaseId = ""; let generatedId = ""; let signingKid = "";
    const dbPassword = rnd(); const minioUser = `u${rnd(8)}`; const minioSecret = rnd(24);
    let b1 = {backupId: "", storageId: "", path: "", fileSize: 0, sha: "", size: 0};
    const verifyDeps = (): VerifyDeps => ({
        db, now: () => new Date(), keys: fileKeyProvider,
        openArchive: async (id) => {
            const [s] = await q("select path from backup_storage where id=$1", [id]);
            const resp = await fetch(await minio.presignedGetObject(BUCKET, s.path as string, 600));
            return {status: resp.status, body: resp.ok && resp.body ? (resp.body as unknown as AsyncIterable<Uint8Array>) : null, abort() {}};
        },
        checkResticSnapshot: async () => true,
        manifestRunner: (async (...a: [string, string, Buffer]) => repos.runnerFor(a[2])(a[0], a[1])) as VerifyDeps["manifestRunner"],
        limits: {maxPlaintextBytes: 1 << 30, maxInflatedBytes: 4 * 1024 * 1024 * 1024, downloadTimeoutMs: 120_000}, maxAttempts: 2, backoffMinutes: [1], crossCheckAgentSize: true,
    });
    const repos = localRepos();

    async function realBackup(): Promise<{backupId: string; storageId: string; path: string; fileSize: number; report: {sha256: string; size_bytes: number}}> {
        const r = await queueWaitingBackups(db, [databaseId]);
        const backupId = r.queued[0]?.backupId;
        if (!backupId) throw new Error(`not queued: ${JSON.stringify(r.skipped)}`);
        const ready = await waitFor(`backup ${backupId} success + stored + hash report`, async () => {
            const [b] = await q("select b.status, b.file_size, s.id as sid, s.status as sstatus, s.path from backups b left join backup_storage s on s.backup_id=b.id where b.id=$1", [backupId]);
            const [h] = await q("select sha256, size_bytes from fork_agent_hash_report where backup_id=$1 and agent_id=$2", [backupId, agentId]);
            return b?.status === "success" && b.sstatus === "success" && b.path && h ? {b, h} : null;
        }, 240_000);
        return {backupId, storageId: ready.b.sid, path: ready.b.path, fileSize: Number(ready.b.file_size), report: {sha256: ready.h.sha256, size_bytes: Number(ready.h.size_bytes)}};
    }
    async function plantRp(label: string, b: {backupId: string; storageId: string; path: string}, artifactSize: number) {
        const stackId = await seedStack(t.pool, org, null, label);
        const rpId = await seedRp(t.pool, stackId, {status: "pending_verification", required: 1});
        const artId = await seedArtifact(t.pool, rpId, {backupId: b.backupId, backupStorageId: b.storageId, channelId});
        await q("update fork_recovery_point_artifact set size_bytes=$1, path_or_snapshot_id=$2, generated_id=$3, channel_kind='s3' where id=$4", [artifactSize, b.path, generatedId, artId]);
        return {stackId, rpId, artId};
    }

    beforeAll(async () => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "w15b-lab-")); priv = path.join(tmp, "private");
        for (const n of [AGENT_C, PG_C, MINIO_C]) { try { docker(["rm", "-f", n]); } catch { /* none */ } }
        try { docker(["volume", "rm", "-f", VOL]); } catch { /* none */ }
        try { docker(["network", "create", "--subnet", SUBNET, NET]); } catch { /* exists */ }
        // storage + source (throw-away random credentials, lab network only)
        minioPort = await freePort("127.0.0.1");
        docker(["run", "-d", "--name", MINIO_C, "--network", NET, "-p", `127.0.0.1:${minioPort}:9000`, "-e", `MINIO_ROOT_USER=${minioUser}`, "-e", `MINIO_ROOT_PASSWORD=${minioSecret}`,
            "-e", "MINIO_ROOT_USER_FILE=", "-e", "MINIO_ROOT_PASSWORD_FILE=", "-e", "MINIO_ACCESS_KEY_FILE=", "-e", "MINIO_SECRET_KEY_FILE=", MINIO_IMAGE, "server", "/data"]);
        docker(["run", "-d", "--name", PG_C, "--network", NET, "-e", "POSTGRES_DB=demo", "-e", "POSTGRES_USER=demo", "-e", `POSTGRES_PASSWORD=${dbPassword}`, PG_IMAGE]);
        minio = new Minio({endPoint: "127.0.0.1", port: minioPort, useSSL: false, accessKey: minioUser, secretKey: minioSecret});
        await waitFor("minio up", async () => { try { await minio.listBuckets(); return true; } catch { return false; } }, 60_000);
        await minio.makeBucket(BUCKET);
        await waitFor("source postgres ready", async () => { try { docker(["exec", PG_C, "pg_isready", "-U", "demo", "-d", "demo"]); return true; } catch { return false; } }, 60_000);
        const psql = (sql: string) => docker(["exec", PG_C, "psql", "-U", "demo", "-d", "demo", "-v", "ON_ERROR_STOP=1", "-c", sql]);
        psql("create table t(id int, v text); insert into t select g, 'row-' || g from generate_series(1, 200) g;");

        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        const port = await freePort(); base = `http://${GW}:${port}`;
        child = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {...process.env, NODE_ENV: "production", DATABASE_URL: t.url,
            PROJECT_URL: URL_FOR_AGENTS(), PROJECT_SECRET: `w15b-lab-${rnd(24)}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
            AUTH_DEFAULT_USER_NAME: "W15b Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
            FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300"}});
        child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
        await waitFor("dashboard ready", async () => out.includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
        process.env.PRIVATE_PATH = priv; // the test-side key provider reads the SAME key files the server generated
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;
        signingKid = kidOfPublicKey((await fileKeyProvider.signing()).publicKeyPem);

        agentId = await seedAgent(t.pool, org, "w15b-edge");
        const r = await enrolAgent(deps(), {agentId, password: PW});
        if (!r.ok) throw new Error(`enrol: ${r.code}`);
        bundleOf = r.bundle; bundle = decodeBundle(r.bundle);
        await startAgent(agentId, r.bundle);

        // rows exactly like dev/fork-lab/drills/bootstrap-dashboard.sh + provision-sources.sh write them (the dashboard has no create API)
        projectId = await seedProject(t.pool, org, "w15b-demo");
        channelId = (await q("insert into storage_channel (provider, name, config, enabled) values ('s3','w15b-minio',$1::jsonb,true) returning id",
            [JSON.stringify({ssl: false, port: 9000, region: "us-east-1", accessKey: minioUser, secretKey: minioSecret, bucketName: BUCKET, endPointUrl: MINIO_C})]))[0].id;
        await q("insert into storage_policy (storage_channel_id, project_id) values ($1,$2)", [channelId, projectId]);
        const mk = readFileSync(path.join(priv, "keys", "master_key.bin"));
        const iv = randomBytes(12); const ci = createCipheriv("aes-256-gcm", mk, iv);
        const ct = Buffer.concat([ci.update(dbPassword, "utf8"), ci.final()]);
        const envelope = {__encrypted: true, version: 1, kid: "credentials-v1", iv: iv.toString("base64"), ciphertext: ct.toString("base64"), tag: ci.getAuthTag().toString("base64")};
        generatedId = randomUUID();
        databaseId = (await q(`insert into databases (id, agent_database_id, name, dbms, agent_id, project_id, config, backup_engine)
            values (gen_random_uuid(), $1, 'w15b-demo-postgres', 'postgresql', $2, $3, $4::jsonb, 'archive') returning id`,
            [generatedId, agentId, projectId, JSON.stringify({host: PG_C, port: 5432, database: "demo", username: "demo", password: envelope})]))[0].id;
        await q("update settings set encryption=true"); // D39: archives are encrypted, so the D45 hook fires
        await waitFor("agent reported plaintext-hash.v1 + channel-maint.v1", async () => {
            const [e] = await q("select capabilities from fork_agent_enrollment where agent_id=$1", [agentId]);
            return e?.capabilities.includes("plaintext-hash.v1") && e.capabilities.includes(MAINT_CAPABILITY);
        }, 120_000);
    }, 480_000);

    afterAll(async () => {
        const evidence = process.env.W15B_EVIDENCE_DIR;
        const clean = canaryClean();
        if (evidence && clean) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(path.join(evidence, "w15b-agent.log"), stripAnsi(logs(AGENT_C)));
            writeFileSync(path.join(evidence, "dashboard-fork.log"), out.split("\n").filter((l) => /[Ff]ork|agent-channel/.test(l) && !/Received POST/.test(l)).join("\n"));
            writeFileSync(path.join(evidence, "lab-run.txt"), RUN.join("\n") + "\n");
        } else if (evidence) { writeFileSync(path.join(tmp, "NOT-WRITTEN"), "canary found a secret in a log: evidence withheld"); }
        for (const n of [AGENT_C, PG_C, MINIO_C]) { try { docker(["rm", "-f", n]); } catch { /* gone */ } }
        try { docker(["volume", "rm", "-f", VOL]); } catch { /* gone */ }
        try { docker(["network", "rm", NET]); } catch { /* in use / gone */ }
        child?.kill("SIGTERM"); await sleep(500); if (child?.exitCode === null) child?.kill("SIGKILL");
        repos.drop();
        await t?.drop(); rmSync(tmp, {recursive: true, force: true});
    });

    it("L1 D45 match: a REAL agent backup is reported by the agent BEFORE encryption, and the REAL verify job promotes the RP with agent_hash: match", async () => {
        const b = await realBackup();
        b1 = {backupId: b.backupId, storageId: b.storageId, path: b.path, fileSize: b.fileSize, sha: b.report.sha256, size: b.report.size_bytes};
        expect(b.report.size_bytes).toBe(b.fileSize); // the agent's own two numbers agree
        const {rpId, artId} = await plantRp("w15b-d45", b, b.fileSize);
        const outcome = await verifyRecoveryPoint(verifyDeps(), rpId);
        RUN.push(`L1 verify outcome: ${JSON.stringify(outcome)}`);
        expect(outcome).toMatchObject({outcome: "verified", manifestChannels: 1});
        const [rp] = await q("select status, downgrade_reason, verify_report from fork_recovery_point where id=$1", [rpId]);
        expect(rp).toMatchObject({status: "verified", downgrade_reason: null});
        expect(rp.verify_report.results[0]).toMatchObject({code: "ok", agent_hash: "match"});
        const [art] = await q("select plaintext_sha256, plaintext_size from fork_recovery_point_artifact where id=$1", [artId]);
        expect(art.plaintext_sha256).toBe(b.report.sha256); // Rust (before encryption) == TS (after decryption)
        expect(Number(art.plaintext_size)).toBe(b.report.size_bytes);
        RUN.push(`L1 agent sha256=${b.report.sha256} size=${b.report.size_bytes} == dashboard plaintext_sha256 after decryption; verify_report=${JSON.stringify(rp.verify_report.results)}`);
    }, 360_000);

    it("L2 D45 mismatch: swapping the stored object for another real archive makes the RP failed:plaintext_hash_mismatch", async () => {
        docker(["exec", PG_C, "psql", "-U", "demo", "-d", "demo", "-c", "insert into t select g, 'more-' || g from generate_series(1000, 1100) g;"]);
        const b2 = await realBackup();
        expect(b2.report.sha256).not.toBe(b1.sha); // a different dataset ⇒ a different archive
        // REAL swap: B2's object is overwritten with B1's bytes (valid, correctly encrypted — only NOT what the agent read for B2)
        const chunks: Buffer[] = [];
        for await (const c of await minio.getObject(BUCKET, b1.path)) chunks.push(c as Buffer);
        const b1Bytes = Buffer.concat(chunks);
        await minio.putObject(BUCKET, b2.path, b1Bytes);
        // the size cross-check is given the swapped object's real plaintext size so that THIS test isolates the D45 hash check
        const {rpId} = await plantRp("w15b-d45-mismatch", b2, b1.size);
        const outcome = await verifyRecoveryPoint(verifyDeps(), rpId);
        RUN.push(`L2 verify outcome: ${JSON.stringify(outcome)}`);
        expect(outcome).toMatchObject({outcome: "failed", reason: "plaintext_hash_mismatch", code: "agent_hash_mismatch"});
        const [rp] = await q("select status, downgrade_reason, manifest_refs from fork_recovery_point where id=$1", [rpId]);
        expect(rp).toMatchObject({status: "failed", downgrade_reason: "plaintext_hash_mismatch", manifest_refs: null});
        const audit = await q("select result from fork_audit_event where action='fork.recovery_point.verify' and resource_id=$1", [rpId]);
        expect(audit.map((a) => a.result)).toEqual(["failure"]);
        RUN.push(`L2 agent(B2) sha256=${b2.report.sha256} != swapped object plaintext (B1 ${b1.sha}) ⇒ RP failed:plaintext_hash_mismatch, audit failure`);
    }, 360_000);

    it("L3 pins: signed pin_add is applied, persists across an agent restart, pin_revoke makes the key unknown again; the signing key cannot be unpinned", async () => {
        const k2 = testKeypair();
        const add = await pinDashboardKey(deps(), {agentId, password: PW, pem: k2.publicKey});
        expect(add).toMatchObject({ok: true, kid: k2.kid});
        expect((await finished((add as {taskId: string}).taskId)).status).toBe("succeeded");
        expect((await q("select pinned_kids from fork_agent_enrollment where agent_id=$1", [agentId]))[0].pinned_kids.sort()).toEqual([signingKid, k2.kid].sort());
        const ok1 = await plantNoop(agentId, k2, "pinned-key-ok");
        expect((await finished(ok1)).status).toBe("succeeded");
        docker(["restart", AGENT_C]);
        const ok2 = await plantNoop(agentId, k2, "pinned-key-after-restart");
        expect((await finished(ok2, 120_000)).status).toBe("succeeded"); // the pin was persisted in the agent's state file
        const rev = await unpinDashboardKey(deps(), {agentId, password: PW, kid: k2.kid});
        expect(rev).toMatchObject({ok: true});
        expect((await finished((rev as {taskId: string}).taskId)).status).toBe("succeeded");
        expect((await q("select pinned_kids from fork_agent_enrollment where agent_id=$1", [agentId]))[0].pinned_kids).toEqual([signingKid]);
        const refused = await plantNoop(agentId, k2, "revoked-key");
        const x = await finished(refused);
        expect(x.status).toBe("rejected"); expect(x.result).toMatchObject({reason: "unknown_kid"});
        expect(await unpinDashboardKey(deps(), {agentId, password: PW, kid: signingKid})).toMatchObject({ok: false, code: "pin_in_use"});
        RUN.push(`L3 pin_add(${k2.kid}) succeeded; k2-signed noop succeeded (also after docker restart); pin_revoke succeeded; k2-signed noop rejected unknown_kid; unpin of the signing kid refused pin_in_use`);
    }, 420_000);

    it("L4 rotation: signed rotate_credential switches the agent; the old bearer is 401; the agent keeps working after a restart; the D45 hook uses the rotated credential", async () => {
        const [before] = await q("select credential_hash from fork_agent_enrollment where agent_id=$1", [agentId]);
        const rot = await requestCredentialRotation(deps(), {agentId, password: PW});
        expect(rot).toMatchObject({ok: true});
        expect((await finished((rot as {taskId: string}).taskId)).status).toBe("succeeded");
        const [after] = await q("select credential_hash, pending_credential_hash, pending_task_id, pending_valid_until, prev_credential_hash from fork_agent_enrollment where agent_id=$1", [agentId]);
        expect(after.credential_hash).not.toBe(before.credential_hash);
        expect([after.pending_credential_hash, after.pending_task_id, after.pending_valid_until, after.prev_credential_hash]).toEqual([null, null, null, null]);
        const old = await fetch(`${base}/api/fork/agent/${agentId}/lease`, {method: "POST", headers: {authorization: `Bearer ${bundle.credential}`, "content-type": "application/json"}, body: "{}"});
        expect(old.status).toBe(401);
        const n1 = await enqueueTask(deps(), {agentId, type: "noop", payload: {echo: "after-rotation"}});
        expect((await finished((n1 as {taskId: string}).taskId)).status).toBe("succeeded");
        docker(["restart", AGENT_C]);
        const n2 = await enqueueTask(deps(), {agentId, type: "noop", payload: {echo: "after-rotation-restart"}});
        expect((await finished((n2 as {taskId: string}).taskId, 120_000)).status).toBe("succeeded");
        const b3 = await realBackup(); // the hash report of a LATER real backup still arrives: the D45 hook uses the rotated credential
        RUN.push(`L4 rotate_credential succeeded; credential_hash changed; pending cleared; old bearer ⇒ 401; noop succeeded before and after docker restart; backup ${b3.backupId} hash report arrived with the rotated credential`);
    }, 480_000);

    const canaryClean = () => {
        try {
            const agentLog = logs(AGENT_C);
            const secrets = [bundle.credential, bundle.credential.split(".")[2], bundle.task_key_b64, dbPassword, minioSecret];
            const shape = new RegExp(`fork\\.${agentId}\\.[A-Za-z0-9_-]{43}`);
            return [agentLog, out].every((l) => secrets.every((s) => !l.includes(s)) && !shape.test(l) && !l.includes("BEGIN PUBLIC KEY"));
        } catch { return false; }
    };
    it("L5 canary: no credential, task key, key PEM, source password or storage secret in the agent or dashboard log", () => {
        const agentLog = logs(AGENT_C);
        for (const [name, l] of [["agent", agentLog], ["dashboard", out]] as const) {
            expect(l, `${name}: old credential`).not.toContain(bundle.credential);
            expect(l, `${name}: old credential secret`).not.toContain(bundle.credential.split(".")[2]);
            expect(l, `${name}: task key`).not.toContain(bundle.task_key_b64);
            expect(l, `${name}: credential shape`).not.toMatch(new RegExp(`fork\\.${agentId}\\.[A-Za-z0-9_-]{43}`));
            expect(l, `${name}: pem`).not.toContain("BEGIN PUBLIC KEY");
            expect(l, `${name}: source db password`).not.toContain(dbPassword);
            expect(l, `${name}: storage secret`).not.toContain(minioSecret);
        }
        RUN.push("L5 canary: agent + dashboard logs contain no old/new credential shape, task key, PEM, source password or storage secret");
    });
});
