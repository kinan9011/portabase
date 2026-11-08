import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as Minio from "minio";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {enrolAgent} from "@/fork/agent-channel/admin";
import {decodeBundle} from "@/fork/agent-channel/bundle";
import {setRestoreOverrides, type OverrideDeps} from "@/fork/config/service";
import type {ForkDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {buildManifest} from "@/fork/manifest/build";
import {kidOfPublicKey, signManifest} from "@/fork/manifest/sign";
import {writeManifestSnapshot} from "@/fork/manifest/store";
import {createRestorePlan, approveRestorePlan, loadPlanRow} from "@/fork/restore/service";
import {cleanupRestoreRun, approveRestorePolicy, startRestoreRun} from "@/fork/restore-run/service";
import type {RestoreRunDeps} from "@/fork/restore-run/deps";
import {defaultManifestFetch} from "@/fork/restore-run/manifest";
import {getRestoreRunView} from "@/fork/restore-run/view";
import {enqueueRestoreTask, type RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {openManifestRepo} from "@/fork/upstream/restic";
import {HEADLINE, FAILURE_GROUPS} from "@/fork/ui/recovery/labels";
import {decryptAgentArchive, encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {freshForkDb, seedAgent, seedBackup, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {req, seedUser} from "@/fork/__tests__/w16-world";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";
import type {testKeypair} from "@/fork/__tests__/w14-fixtures";

/**
 * LIVE W18b Flow C test (FORK_LAB=1, docker-bridge lab ONLY, synthetic TEST-ONLY data, never the owner's hosts).
 * The REAL fork dashboard (production build) runs its OWN `fork-restore-runs` job (FORK_RESTORE_TICK_SECONDS=2, no seams: manifest = restic over rclone on a real MinIO channel,
 * artifact URL = upstream presigned GET) against the REAL fork agent image. F0 sanity · F1 Flow C (plan→overrides→approve→start→ALLOW→succeeded + data oracles) · F2 corrupted object ⇒ honest
 * failed + cleanup · F3 pages under the real server. HOLD (W18B_LAB_HOLD=1, `-t HOLD`) keeps the lab up for the browser run / Session B and executes lines of `$W18B_SCRATCH/w18b-lab.cmd`.
 * Prerequisites: `pnpm build`, FORK_TEST_DATABASE_URL, docker, the agent image (W17_AGENT_IMAGE, default portabase-agent-fork:w17b-lab), restic + rclone on PATH.
 * Cleanup is SCOPED to the `w18bf1-*` names / the `notes` compose project / this lab's run ids: never the global label sweeps of the older labs. Run it alone on the host (fixed local-storage ports 1081/1082).
 */
const LAB = process.env.FORK_LAB === "1";
const HOLD = process.env.W18B_LAB_HOLD === "1";
const SCRATCH = process.env.W18B_SCRATCH ?? "";
const IMAGE = process.env.W17_AGENT_IMAGE ?? "portabase-agent-fork:w17b-lab";
const TTL_MIN = Number(process.env.W18B_AGENT_TASK_TTL_MINUTES ?? 30);
const NET = "w18bf1-lab-net", SUBNET = "172.31.254.0/24", GW = "172.31.254.1", MINIO_IP = "172.31.254.10";
const MINIO = "w18bf1-minio", MINIO_IMAGE = "coollabsio/minio@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9", BUCKET = "w18b-lab";
const CLEAN = "w18bf1-agent-clean", ST_CLEAN = "w18bf1-agent-clean-state", REF_VOL = "w18bf1_ref", REFPG = "w18bf1-refpg", PROJECT = "notes";
const PG_IMG = "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b";
const BUSYBOX = "busybox@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4";
const MEMBER = {email: "member@w18b-lab.test", password: "w18b-member-pw-1!"}, ORGADMIN = {email: "orgadmin@w18b-lab.test", password: "w18b-orgadmin-pw-1!"}; // test-only
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env, input?: Buffer) => execFileSync("docker", args, {encoding: "utf8", env, input, stdio: ["pipe", "pipe", "pipe"]}).trim();
const freePort = (host: string) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const logs = (name: string) => { try { return execFileSync("docker", ["logs", name], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}); } catch (e) { return String(e); } };
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
const FX = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {name: string; file: string; plaintext_sha256: string; plaintext_size: number}[]};
const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
const fxFile = (n: string) => readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures", fx(n).file));
const MASTER = Buffer.from(FX.master_key_b64, "base64");
const CANARY_OV = `W18BOV${randomBytes(9).toString("hex")}$x`; // the override value: must reach the container and nowhere else
const MINIO_USER = `lab${randomBytes(6).toString("hex")}`, MINIO_PASS = randomBytes(18).toString("hex");
const DASH_SECRET = `w18b-lab-${randomBytes(12).toString("hex")}`;

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let priv = ""; let tmp = ""; let ROOT = ""; let base = ""; let org = ""; let adminId = ""; let P = 0;
let forwarder: net.Server | undefined; let mc: Minio.Client;
const RUN: string[] = [];
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const PROJECT_URL = () => `http://forklab-dashboard.localhost:${P}`;
const dashEnvOf = (): NodeJS.ProcessEnv => ({...process.env, NODE_ENV: "production", DATABASE_URL: t.url, PROJECT_URL: PROJECT_URL(), PROJECT_SECRET: DASH_SECRET, PRIVATE_PATH: priv,
    AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password, AUTH_DEFAULT_USER_NAME: "W18b Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true",
    FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off", FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300", TZ: "UTC", FORK_RESTORE_TICK_SECONDS: process.env.W18B_TICK_SECONDS ?? "2", FORK_AGENT_TASK_TTL_MINUTES: String(TTL_MIN)});
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-10).join("\n").slice(-2000)}\n--- clean agent ---\n${stripAnsi(logs(CLEAN)).split("\n").filter((l) => /[Ff]ork|rror|WARN/.test(l)).slice(-10).join(" | ").slice(-2500)}`);
        await sleep(1000);
    }
}
async function startDashboard() {
    const before = out.length;
    child = spawn("pnpm", ["exec", "next", "start", "-p", String(P), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: dashEnvOf(), detached: true}); // own process group: next-server + rclone die with it
    child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
    await waitFor("dashboard ready", async () => out.slice(before).includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
}
const superP = () => ({userId: adminId, systemRole: "superadmin" as const, memberships: [{organizationId: org, role: "admin"}]});
const ENVS = () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: TTL_MIN, FORK_AGENT_LEASE_SECONDS: 60});
/** NO `manifest` / `artifactUrl` seam: the server's own job reads the manifest from the channel and presigns the artifacts (F0 asserts this file never mentions them) */
const rd = (over: Partial<RestoreRunDeps> = {}): RestoreRunDeps => ({db, principal: superP(), keys: fileKeyProvider, serverUrl: PROJECT_URL, configAllowed: async () => true, stepUp: async () => "ok", env: ENVS, ...over});
const chDeps = (): RestoreTaskDeps => ({db, principal: superP(), keys: fileKeyProvider, serverUrl: PROJECT_URL, stepUp: async () => "ok", env: ENVS, configAllowed: async () => true});
const ovDeps = (): OverrideDeps => ({db, principal: superP(), configAllowed: async () => true, now: () => new Date()});
const task = async (id: string) => (await q("select status, result, attempts from fork_agent_task where id=$1", [id]))[0];
const finished = (id: string, ms = 120_000) => waitFor(`task ${id} final`, async () => { const x = await task(id); return x && !["queued", "leased", "running"].includes(x.status) ? x : null; }, ms);
const volume = (name: string) => { try { return JSON.parse(docker(["volume", "inspect", name]))[0] as {Labels: Record<string, string>}; } catch { return null; } };
const listing = (vol: string) => docker(["run", "--rm", "-v", `${vol}:/vol:ro`, BUSYBOX, "sh", "-c", "cd /vol && find . -type f | sort | xargs sha256sum"]);
const rootSh = (script: string) => docker(["run", "--rm", "-v", `${ROOT}:${ROOT}`, BUSYBOX, "sh", "-c", script]); // the agent runs as root: look through busybox
const owned = (id: string) => ({
    containers: docker(["ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${id}`]).trim(),
    volumes: docker(["volume", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${id}`]).trim(),
    networks: docker(["network", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${id}`]).trim(),
});
const runIds: string[] = [];
const runRow = async (id: string) => (await q("select * from fork_restore_run where id=$1", [id]))[0];
const TERMINAL = ["succeeded", "incomplete", "failed", "cancelled"];
/** only OBSERVE the DB while the server's own job drives the run (never a tick from the test) */
async function watchRun(runId: string, states: string[], ms: number) {
    return waitFor(`run ${runId} in ${states.join("|")}`, async () => { const r = await runRow(runId); return r && (states.includes(r.state) || TERMINAL.includes(r.state)) ? r : null; }, ms);
}
const objKey = (rpId: string, name: string) => `w18b/${rpId}/${name}`;
const saved = new Map<string, Buffer>(); // `${rpSeq}/${source_name}` → original object bytes

async function startAgent(name: string, stateVol: string, agentId: string, bundle: string) {
    const edge = Buffer.from(JSON.stringify({serverUrl: PROJECT_URL(), agentId, masterKeyB64: MASTER.toString("base64")})).toString("base64url");
    const f = path.join(tmp, `${name}.bundle`);
    writeFileSync(f, bundle, {mode: 0o600}); chmodSync(f, 0o600);
    docker(["run", "-d", "--name", name, "--network", NET, "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production",
        "-e", "FORK_CHANNEL_ENABLED=true", "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2", "-v", `${f}:/run/fork/bundle:ro`, "-v", `${stateVol}:/config`,
        "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${ROOT}:${ROOT}`, "-e", `FORK_ALLOWED_PATH_ROOTS=${ROOT}`, "-e", `FORK_ARTIFACT_HTTP_HOSTS=${MINIO_IP}`, "-e", "FORK_HOST_ROLE=production", IMAGE], {...process.env, EDGE_KEY: edge});
}

const COMPOSE = (extra = "") => `services:
  db:
    image: ${PG_IMG}
    env_file: stack.env
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: {test: ["CMD-SHELL", "pg_isready -U $\${POSTGRES_USER} -d $\${POSTGRES_DB}"], interval: 3s, timeout: 3s, retries: 20}
    networks: {internal: {aliases: [notes-db]}}
  web:
    image: ${PG_IMG}
    env_file: stack.env
    depends_on: {db: {condition: service_healthy}}
    entrypoint: ["/bin/sh", "/app/serve.sh"]
    volumes: ["./web/serve.sh:/app/serve.sh:ro", "./web/handle.sh:/app/handle.sh:ro", "./uploads:/uploads:ro", "data:/appdata"]
    networks: [internal]
  traefik:
    image: ${BUSYBOX}
    command: ["sleep", "86400"]
    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
    networks: [internal]
${extra}volumes: {pgdata: {}, data: {}}
networks: {internal: {internal: true}}
`;
const MIGRATE = `  migrate:
    image: ${BUSYBOX}
    command: ["true"]
    networks: [internal]
`;

describe.skipIf(!LAB)("W18b live: Flow C through the real server job, MinIO manifest + presign, real agent", () => {
    let w: W17; let cleanBundle = ""; let n1 = ""; let n2 = ""; let channelId = ""; let keyPair: {privateKeyPem: string; publicKeyPem: string; kid: string};
    let f1Plan = {planId: "", planHash: ""}; let f1Run = ""; let f2Run = ""; let f2Plan = {planId: "", planHash: ""};
    let adminCookie = "";

    const makePlan = async (rpId = n1, mappings: Record<string, unknown> = {}) => {
        const c = await createRestorePlan({db, principal: superP(), configAllowed: async () => true},
            req(w, {rpId, mappings: {target_project: null, restore_root: ROOT, volumes: null, select: null, sqlite: null, ...mappings}}));
        if (!c.ok) throw new Error(`plan refused: ${c.code}`);
        return c;
    };
    const planDoc = async (c: {planId: string; planHash: string}) => { const p = await loadPlanRow({db}, c.planId, c.planHash); if (!p.ok) throw new Error(p.code); return p.plan; };
    /** the lab hygiene for a SUCCEEDED run (the run service refuses cleanup of a succeeded run): W17 restore_cleanup task */
    async function hygiene(c: {planId: string; planHash: string}, runId: string) {
        const attempt = async () => {
            const cl = await enqueueRestoreTask(chDeps(), {type: "restore_cleanup", planId: c.planId, planHash: c.planHash, restoreId: runId, cleanup: {workspace: true, volumes: true, networks: true, containers: true}});
            if (!cl.ok) throw new Error(cl.code);
            return finished(cl.taskId);
        };
        let fin = await attempt();
        if (fin.status !== "succeeded") {
            // observed: the agent's cleanup keeps containers that mount the docker socket (the `traefik` fixture) and then fails removing the network (reported as docker_unavailable)
            RUN.push(`hygiene first attempt run=${runId.slice(0, 8)} status=${fin.status} result=${JSON.stringify(fin.result)} leftover containers=${JSON.stringify(docker(["ps", "-a", "--filter", `label=com.portabase.fork.restore_id=${runId}`, "--format", "{{.Names}}:{{.State}}"]).split("\n"))}`);
            for (const id of docker(["ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${runId}`]).split("\n").filter(Boolean)) docker(["rm", "-f", id]); // THIS run's containers only (label-scoped)
            fin = await attempt();
        }
        expect(fin.status, JSON.stringify(fin.result)).toBe("succeeded");
        expect(owned(runId)).toEqual({containers: "", volumes: "", networks: ""});
    }
    /** sign + store the manifest of one RP in the REAL channel (restic over rclone → MinIO), exactly as the dashboard will read it back */
    async function signAndStore(rpId: string) {
        const [rp] = await q("select * from fork_recovery_point where id=$1", [rpId]);
        const arts = await q("select * from fork_recovery_point_artifact where rp_id=$1 order by source_name", [rpId]);
        const facts = arts.map((a) => ({sourceName: a.source_name, engine: a.engine, archiveKind: a.archive_kind, dumpFormat: a.dump_format, archiveFormatVersion: a.archive_format_version, encrypted: a.encrypted, channelId: a.channel_id, channelKind: a.channel_kind,
            pathOrSnapshotId: a.path_or_snapshot_id, generatedId: a.generated_id, sizeBytes: a.size_bytes === null ? null : Number(a.size_bytes), ciphertextSha256: a.ciphertext_sha256, plaintextSha256: a.plaintext_sha256, plaintextSize: a.plaintext_size === null ? null : Number(a.plaintext_size), required: a.required}));
        const m = buildManifest({id: rp.id, stackId: w.stack, stackName: PROJECT, sequence: Number(rp.sequence), createdAt: rp.created_at, finalizedAt: rp.created_at, consistencyLevel: "mixed", inventoryVersion: 1, inventoryHash: rp.inventory_hash,
            requiredArtifactCount: arts.filter((a) => a.required).length}, facts, null, {kid: keyPair.kid, signedAt: new Date(), verifiedAt: new Date()});
        const signed = signManifest(m, keyPair.privateKeyPem);
        await q("update fork_recovery_point set manifest_sha256=$2, manifest_sig_kid=$3 where id=$1", [rp.id, createHash("sha256").update(signed.json).digest("hex"), keyPair.kid]);
        const h = await openManifestRepo(db, channelId, w.stack, MASTER);
        let snapshotId = "";
        try {
            ({snapshotId} = await writeManifestSnapshot(h.run, {json: signed.json, sig: signed.sig, publicKeyPem: keyPair.publicKeyPem}, {rpId: rp.id, sequence: Number(rp.sequence)}));
            await q("update fork_recovery_point set manifest_refs=$2::jsonb where id=$1", [rp.id, JSON.stringify([{channel_id: channelId, snapshot_id: snapshotId}])]);
        } finally { await h.cleanup(); }
        const back = await defaultManifestFetch(db)({id: rp.id, stackId: w.stack, manifestRefs: [{channel_id: channelId, snapshot_id: snapshotId}]});
        expect(back?.json).toBe(signed.json); // the server will read exactly these bytes
        RUN.push(`manifest rp_seq=${rp.sequence} snapshot=${snapshotId.slice(0, 12)} roundtrip=ok`);
    }
    async function putObjects(rpId: string, plain: Record<string, Buffer>, seq: number) {
        for (const [name, body] of Object.entries(plain)) {
            const key = objKey(rpId, name);
            await mc.putObject(BUCKET, key, body); saved.set(`${seq}/${name}`, body);
            await q("update backup_storage set path=$2, status='success' where id=(select backup_storage_id from fork_recovery_point_artifact where rp_id=$1 and source_name=$3)", [rpId, key, name]);
            await q("update fork_recovery_point_artifact set size_bytes=$3 where rp_id=$1 and source_name=$2", [rpId, name, body.length]);
        }
    }
    const tarOf = (name: string, yml: string) => {
        const src = path.join(tmp, name); mkdirSync(src, {recursive: true});
        const demo = path.join(process.cwd(), "dev/fork-lab/demo-stack");
        for (const f of ["stack.env", "web", "uploads"]) execFileSync("cp", ["-r", path.join(demo, f), src]);
        writeFileSync(path.join(src, "compose.yml"), yml);
        mkdirSync(path.join(src, "uploads"), {recursive: true}); writeFileSync(path.join(src, "uploads/hello.txt"), "hello from the backup\n");
        const tgz = path.join(tmp, `${name}.tar.gz`); execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
        return readFileSync(tgz);
    };
    const userWithPw = async (u: {email: string; password: string}, role: "member" | "admin") => {
        const id = await seedUser(t.pool, "user");
        await q(`update "user" set email=$2 where id=$1`, [id, u.email]);
        const {hashPassword} = await import("better-auth/crypto");
        await q(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), id, id, await hashPassword(u.password)]);
        await q(`insert into member (id, organization_id, user_id, role, created_at) values ($1,$2,$3,$4,now())`, [randomUUID(), org, id, role]);
        return id;
    };

    beforeAll(async () => {
        process.env.PROJECT_SECRET ??= `w18b-test-${randomBytes(12).toString("hex")}`;
        tmp = mkdtempSync(path.join(os.tmpdir(), "w18bf1-lab-")); priv = path.join(tmp, "private");
        ROOT = path.join(tmp, "w18bf1-root"); mkdirSync(ROOT, {recursive: true});
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), MASTER, {mode: 0o600});
        for (const n of [CLEAN, MINIO, REFPG]) { try { docker(["rm", "-f", n]); } catch { /* none */ } }
        for (const v of [ST_CLEAN, REF_VOL]) { try { docker(["volume", "rm", "-f", v]); } catch { /* none */ } }
        try { docker(["network", "create", "--subnet", SUBNET, NET]); } catch { const s = docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", NET]); if (s !== SUBNET) throw new Error(`network ${NET} exists with subnet ${s}`); }
        // MinIO on a fixed bridge IP, no published port: the host (dashboard, restic/rclone, test) and the agent container reach the same address
        docker(["run", "-d", "--name", MINIO, "--network", NET, "--ip", MINIO_IP, "-e", "MINIO_ROOT_USER", "-e", "MINIO_ROOT_PASSWORD", "-e", "MINIO_ROOT_USER_FILE=", "-e", "MINIO_ROOT_PASSWORD_FILE=", "-e", "MINIO_ACCESS_KEY_FILE=", "-e", "MINIO_SECRET_KEY_FILE=", MINIO_IMAGE, "server", "/data"],
            {...process.env, MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASS});
        await waitFor("minio live", async () => fetch(`http://${MINIO_IP}:9000/minio/health/live`).then((r) => r.status === 200).catch(() => false), 60_000);
        mc = new Minio.Client({endPoint: MINIO_IP, port: 9000, useSSL: false, accessKey: MINIO_USER, secretKey: MINIO_PASS});
        await mc.makeBucket(BUCKET);

        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        // one origin for the browser and the agents: dashboard on the gateway, a 127.0.0.1 forwarder on the same port (Chrome resolves *.localhost to 127.0.0.1)
        for (let i = 0; i < 20 && !forwarder; i++) {
            P = await freePort(GW);
            const s = net.createServer((c) => { const u = net.connect(P, GW); c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); });
            await new Promise<void>((res) => { s.once("error", () => res()); s.listen(P, "127.0.0.1", () => { forwarder = s; res(); }); });
        }
        if (!forwarder) throw new Error("no free port for the forwarder");
        base = `http://${GW}:${P}`;
        process.env.PROJECT_URL = PROJECT_URL();
        await startDashboard();
        process.env.PRIVATE_PATH = priv;
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;
        const have = await q(`select 1 from member where user_id=$1 and organization_id=$2`, [adminId, org]);
        if (have.length) await q(`update member set role='owner' where user_id=$1 and organization_id=$2`, [adminId, org]); else await q(`insert into member (id, organization_id, user_id, role, created_at) values ($1,$2,$3,'owner',now())`, [randomUUID(), org, adminId]);
        const sysRole = (await q(`select role from "user" where id=$1`, [adminId]))[0].role;
        expect(["admin", "superadmin"]).toContain(sysRole);
        RUN.push(`roles admin_system_role=${sysRole} admin_org_role=owner`);
        await userWithPw(MEMBER, "member"); await userWithPw(ORGADMIN, "admin");

        // data: two compose archives (N-1 happy, N-2 with a one-shot service that finishes with problems) + the two stock-agent fixtures (TEST-ONLY key)
        const tgz1 = tarOf("notes-src", COMPOSE()); const tgz2 = tarOf("notes-src-n2", COMPOSE(MIGRATE));
        const sk = await fileKeyProvider.signing(); keyPair = {privateKeyPem: sk.privateKeyPem, publicKeyPem: sk.publicKeyPem, kid: kidOfPublicKey(sk.publicKeyPem)};
        const web = {name: "web", state: "running", image: {ref: "postgres:17@sha256:" + "c".repeat(64), pinned: true, built_locally: false}, ports: [], networks: ["notes_internal"], mounts: ["m:0000000000000001", "m:0000000000000002"], env_keys: ["SMTP_PASSWORD"]};
        const base0 = cleanInventory().services[0];
        const inventory = cleanInventory({
            stack: {compose_project: PROJECT, display_name: PROJECT, compose_read: "arcane_compose", working_dir_hint: "/srv/app", config_files_hint: ["/srv/app/compose.yml"]},
            services: [{...base0, ...web}, {...base0, name: "db", mounts: [], env_keys: [], networks: ["notes_internal"]}, {...base0, name: "traefik", mounts: ["m:0000000000000003"], env_keys: [], networks: ["notes_internal"], image: {ref: "busybox@sha256:" + "d".repeat(64), pinned: true, built_locally: false}}],
            mounts: [
                {id: "m:0000000000000001", kind: "named_volume", volume_name: "notes_data", destination: "/appdata", rw: true, consumers: ["web"], ownership: "stack_owned"},
                {id: "m:0000000000000002", kind: "bind", destination: "/uploads", host_path_hint: "/srv/app/uploads", rw: false, consumers: ["web"], ownership: "unknown"},
                {id: "m:0000000000000003", kind: "bind", destination: "/var/run/docker.sock", host_path_hint: "/var/run/docker.sock", rw: false, consumers: ["traefik"], ownership: "unknown"},
            ],
            volumes: [{name: "notes_data", driver: "local", in_use_by: ["web"], ownership: "stack_owned"}],
            networks: [{name: "notes_internal", driver: "bridge", internal: true, external: false, members: ["web", "db", "traefik"], classification: "stack_owned"}],
            env_files: [{path_hint: "/srv/app/stack.env", key_names: ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"], referenced_by: ["db", "web"]}, {path_hint: "/srv/mail/mail.env", key_names: ["SMTP_PASSWORD"], referenced_by: ["web"]}],
        } as never);
        w = await seedW17World(t, "", {privateKey: keyPair.privateKeyPem, publicKey: keyPair.publicKeyPem, kid: keyPair.kid} as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "production", roots: [ROOT], caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"], inventory,
            plain: {compose_app: {sha: sha256(tgz1), size: tgz1.length}, volume_app_data: {sha: fx("lab-volume").plaintext_sha256, size: fx("lab-volume").plaintext_size}, db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"}},
            enrolDeps: {serverUrl: PROJECT_URL, stepUp: async () => "ok", keys: fileKeyProvider, env: ENVS, principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
        cleanBundle = w.agentBundle; n1 = w.rp;
        // reshape: the clean host has NO environment; the source environment belongs to vps-1; `spare` is a third machine
        await q("update fork_stack_source set resource_key='volume:notes_data' where id=$1", [w.sources.volume]);
        await q("update fork_stack_source set covers_keys = covers_keys || ARRAY['env:/srv/app/stack.env'] where id=$1", [w.sources.compose]); // stack.env travels in the compose archive ⇒ only SMTP_PASSWORD (outside it) is a missing value
        await q("delete from fork_arcane_environment where id=$1", [w.tgtEnv]);
        await q("update agents set name='clean-host' where id=$1", [w.agent]);
        const vps = await seedAgent(t.pool, org, "vps-1");
        const r = await enrolAgent({...chDeps(), principal: {userId: adminId, systemRole: "superadmin", memberships: []}}, {agentId: vps, password: PASSWORD});
        if (!r.ok) throw new Error(`enrol vps-1: ${r.code}`);
        await q("update fork_agent_enrollment set capabilities=$2 where agent_id=$1", [vps, ["channel.v1", "restore.target.v1", "compose.render.v1"]]);
        await q("update agents set last_contact = now() - interval '2 days' where id=$1", [vps]);
        await q("update fork_arcane_environment set agent_id=$2, agent_name='vps-1' where id=$1", [w.srcEnv, vps]);
        const spare = await seedAgent(t.pool, org, "spare"); await q("update agents set last_contact = now() where id=$1", [spare]);
        const shop = await seedStack(t.pool, org, w.srcEnv, "shop"); await seedRp(t.pool, shop, {status: "pending_verification", seq: 1, required: 1});
        // RP N-1 (seq 2, yesterday), RP N-2 (seq 1, 2 days ago, with `migrate`), RP N (seq 3, pending, 1 hour ago)
        await q("update fork_recovery_point set sequence=2, created_at=now()-interval '1 day', verified_at=now()-interval '1 day'+interval '10 minutes' where id=$1", [n1]);
        channelId = (await q("select channel_id from fork_recovery_point_artifact where rp_id=$1 limit 1", [n1]))[0].channel_id;
        await q("update storage_channel set config=$2::jsonb, name='office-s3' where id=$1", [channelId, JSON.stringify({endPointUrl: MINIO_IP, port: 9000, ssl: false, region: "us-east-1", accessKey: MINIO_USER, secretKey: MINIO_PASS, bucketName: BUCKET})]);
        n2 = (await q(`insert into fork_recovery_point (stack_id, stack_name, sequence, status, required_artifact_count, verified_at, created_at, inventory_version, inventory_hash, consistency_level, manifest_sha256, manifest_sig_kid)
            select stack_id, stack_name, 1, status, required_artifact_count, now()-interval '2 days'+interval '10 minutes', now()-interval '2 days', inventory_version, inventory_hash, consistency_level, manifest_sha256, manifest_sig_kid from fork_recovery_point where id=$1 returning id`, [n1]))[0].id;
        for (const a of await q("select * from fork_recovery_point_artifact where rp_id=$1", [n1])) {
            const bs = (await seedBackup(t.pool, w.agent, channelId)).backupStorageId;
            await q(`insert into fork_recovery_point_artifact (rp_id, stack_source_id, source_name, engine, archive_kind, encrypted, channel_id, channel_kind, plaintext_sha256, plaintext_size, dump_format, archive_format_version, required, presence, path_or_snapshot_id, generated_id, backup_storage_id)
                values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16)`, [n2, a.stack_source_id, a.source_name, a.engine, a.archive_kind, a.encrypted, a.channel_id, a.channel_kind, a.source_name === "compose_app" ? sha256(tgz2) : a.plaintext_sha256, a.source_name === "compose_app" ? tgz2.length : a.plaintext_size, a.dump_format, a.archive_format_version, a.required, a.presence, `lab/${a.source_name}-n2`, bs]);
        }
        await seedRp(t.pool, w.stack, {status: "pending_verification", seq: 3, required: 3}); await q("update fork_recovery_point set created_at=now()-interval '1 hour' where stack_id=$1 and sequence=3", [w.stack]);
        const vol = fxFile("lab-volume"), pg = fxFile("lab-postgres");
        await putObjects(n1, {compose_app: encryptAgentArchive(MASTER, tgz1), volume_app_data: vol, db_db: pg}, 2);
        await putObjects(n2, {compose_app: encryptAgentArchive(MASTER, tgz2), volume_app_data: vol, db_db: pg}, 1);
        await signAndStore(n1); await signAndStore(n2);
        await startAgent(CLEAN, ST_CLEAN, w.agent, cleanBundle);
        await waitFor("clean agent reported compose.render.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [w.agent]))[0]?.capabilities.includes("compose.render.v1"), 120_000);
        if (!process.env.W18B_TICK_SECONDS) expect(out).not.toMatch(/FORK_RESTORE_TICK_SECONDS=0/);
        await makePlan(n1, {}); // "folder last used" prefill for the browser run
        docker(["volume", "create", REF_VOL]);
        docker(["run", "--rm", "-i", "-v", `${REF_VOL}:/r`, BUSYBOX, "tar", "-xzf", "-", "-C", "/r", "--strip-components=1"], process.env, decryptAgentArchive(MASTER, vol));
        const sw = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: PROJECT_URL()}, body: JSON.stringify({email: ADMIN.email, password: ADMIN.password})});
        adminCookie = sw.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    }, 900_000);

    afterAll(async () => {
        const evidence = process.env.W18B_EVIDENCE_DIR;
        const all = stripAnsi(logs(CLEAN)) + out;
        const bundle = (() => { try { return decodeBundle(cleanBundle); } catch { return {task_key_b64: "~~", credential: "~~"}; } })();
        const canaries = [CANARY_OV, MINIO_PASS, MASTER.toString("base64"), bundle.task_key_b64 ?? "~~", bundle.credential ?? "~~", "X-Amz-Signature"];
        const clean = !canaries.some((s) => s && s !== "~~" && all.includes(s));
        if (evidence && clean) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(path.join(evidence, "w18b-agent-clean.log"), stripAnsi(logs(CLEAN)));
            writeFileSync(path.join(evidence, "dashboard-fork-w18b.log"), out.split("\n").filter((l) => /[Ff]ork|agent-channel/.test(l) && !/Received POST/.test(l)).join("\n"));
            writeFileSync(path.join(evidence, "lab-run-w18b.txt"), RUN.join("\n") + "\n");
        } else if (evidence) writeFileSync(path.join(tmp, "NOT-WRITTEN"), "canary found a secret in a log: evidence withheld");
        // SCOPED cleanup (DD-F1-7): this lab's names, the `notes` compose project, this lab's run ids. Never a global label sweep.
        for (const n of [CLEAN, MINIO, REFPG]) { try { docker(["rm", "-f", n]); } catch { /* gone */ } }
        for (const id of docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${PROJECT}`]).split("\n").filter(Boolean)) { try { docker(["rm", "-f", id]); } catch { /* gone */ } }
        for (const id of runIds) {
            for (const c of docker(["ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${id}`]).split("\n").filter(Boolean)) { try { docker(["rm", "-f", c]); } catch { /* gone */ } }
            for (const v of docker(["volume", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${id}`]).split("\n").filter(Boolean)) { try { docker(["volume", "rm", "-f", v]); } catch { /* gone */ } }
        }
        for (const v of docker(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`]).split("\n").filter(Boolean)) { try { docker(["volume", "rm", "-f", v]); } catch { /* gone */ } }
        for (const id of [...runIds.map((r) => `com.portabase.fork.restore_id=${r}`), `com.docker.compose.project=${PROJECT}`]) for (const n of docker(["network", "ls", "-q", "--filter", `label=${id}`]).split("\n").filter(Boolean)) { try { docker(["network", "rm", n]); } catch { /* gone */ } }
        for (const v of [ST_CLEAN, REF_VOL, "notes_data"]) { try { docker(["volume", "rm", "-f", v]); } catch { /* gone */ } }
        try { docker(["network", "rm", NET]); } catch { /* gone */ }
        forwarder?.close();
        const killGroup = (sig: NodeJS.Signals) => { try { if (child?.pid) process.kill(-child.pid, sig); } catch { /* gone */ } };
        killGroup("SIGTERM"); await sleep(1500); killGroup("SIGKILL");
        await t?.drop();
        try { rootSh("rm -rf " + ROOT + "/*"); } catch { /* none */ }
        rmSync(tmp, {recursive: true, force: true});
    });

    /** every restore run of this lab is remembered for the scoped cleanup */
    const startRun = async (c: {planId: string; planHash: string}, accept: boolean) => {
        const r = await startRestoreRun(rd(), {planId: c.planId, planHash: c.planHash, confirm: `RESTORE ${PROJECT}`, acceptMissingInputs: accept});
        if (!r.ok) throw new Error(`start refused: ${r.code}`);
        runIds.push(r.runId); return r.runId;
    };
    const approveProd = async (c: {planId: string; planHash: string}) => {
        const a = await approveRestorePlan({db, principal: superP(), configAllowed: async () => true}, {planId: c.planId, planHash: c.planHash, kind: "production_target"});
        if (!a.ok) throw new Error(`approve: ${a.code}`);
    };

    it("F0 lab sanity: forwarder, no seams in this file, objects in MinIO, the plan for N-1 → clean-host is ready with the kit's items", async () => {
        const health = await fetch(`http://127.0.0.1:${P}/api/health`); expect(health.status).toBe(200);
        const src = readFileSync(__filename, "utf8");
        expect(src.includes("tickRestore" + "Run(")).toBe(false); expect(src.includes("artifact" + "Url:")).toBe(false);
        const keys: string[] = []; await new Promise<void>((res, rej) => { const s = mc.listObjectsV2(BUCKET, "", true); s.on("data", (o) => { if (o.name) keys.push(o.name); }); s.on("end", () => res()); s.on("error", rej); });
        expect(keys.filter((k) => k.startsWith("w18b/")).length).toBe(6);
        expect(keys.filter((k) => k.startsWith(`backups/fork-manifest/${w.stack}/`)).length).toBeGreaterThan(0);
        const c = await makePlan(); const doc = await planDoc(c) as any;
        if (doc.outcome !== "ready") RUN.push(`F0 PLAN NOT READY ${JSON.stringify({outcome: doc.outcome, blockers: doc.blockers, actions: doc.actions?.map((a: any) => `${a.kind}:${a.reason ?? ""}`), secrets: doc.secrets, decisions: doc.decisions})}`);
        expect(doc.outcome).toBe("ready");
        expect(doc.target.host_role_source).toBe("default");
        RUN.push(`F0 plan outcome=${doc.outcome} role_source=${doc.target.host_role_source} findings=${JSON.stringify((doc.compose_findings ?? []).map((f: any) => f.kind ?? f.rule ?? f))} secrets=${JSON.stringify(doc.secrets)} volume=${doc.actions.find((a: any) => a.kind === "restore_volume")?.destination?.name}`);
        expect(doc.actions.find((a: any) => a.kind === "restore_volume").destination.name).toBe("notes_data");
        expect(JSON.stringify(doc.secrets)).toContain("SMTP_PASSWORD");
    }, 120_000);

    it("F1 Flow C through the server job: plan → value → approve → start → ALLOW traefik → succeeded; data == independent references; override reaches only the container; presign never persisted", async () => {
        const c = await makePlan(); f1Plan = c;
        const set = await setRestoreOverrides(ovDeps(), {planId: c.planId, planHash: c.planHash, set: [{service: "web", key: "SMTP_PASSWORD", value: CANARY_OV}]});
        if (!set.ok) throw new Error(`overrides refused: ${set.code}`);
        await approveProd(c);
        f1Run = await startRun(c, false);
        const aw = await watchRun(f1Run, ["awaiting_approval"], 300_000);
        RUN.push(`F1 awaiting state=${aw.state} (reached by the server job, no tick from the test)`);
        expect(aw.state).toBe("awaiting_approval");
        const view = await getRestoreRunView(rd(), {runId: f1Run}); if (!view.ok) throw new Error(view.code);
        const tr = view.view.awaiting?.services.find((x) => x.service === "traefik");
        expect(tr?.phrase).toBeTruthy();
        const wrong = await approveRestorePolicy(rd(), {runId: f1Run, confirmations: {traefik: "ALLOW nothing"}});
        expect(wrong).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await approveRestorePolicy(rd(), {runId: f1Run, confirmations: {traefik: tr!.phrase}})).toMatchObject({ok: true});
        const r = await watchRun(f1Run, [], 480_000);
        RUN.push(`F1 run state=${r.state} verification=${r.verification} reason=${r.reason} phrase="${tr!.phrase}" wrong_phrase=confirmation_mismatch steps=${(r.steps as {name: string; status: string}[]).map((s) => `${s.name}:${s.status}`).join(",")}`);
        expect(r).toMatchObject({state: "succeeded", verification: "started"});
        const j = await q("select step, task_id from fork_restore_run_task where run_id=$1 order by created_at", [f1Run]);
        expect(j.map((x) => x.step)).toEqual(["probe", "stage", "apply", "render", "restore_db", "compose_up"]);
        const ps = docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${PROJECT}`, "--format", "{{.Names}}|{{.State}}|{{.Label \"com.portabase.fork.restore_id\"}}"]).trim().split("\n");
        expect(ps.sort().join(";")).toBe([`notes-db-1|running|${f1Run}`, `notes-traefik-1|running|${f1Run}`, `notes-web-1|running|${f1Run}`].join(";"));
        const v0 = volume("notes_data"); expect(v0?.Labels["com.portabase.fork.restore_id"]).toBe(f1Run);
        RUN.push(`F1 volume labels=${JSON.stringify(Object.keys(v0!.Labels).sort())}`);
        expect(listing("notes_data")).toBe(listing(REF_VOL));
        const STACK_ENV = Object.fromEntries(readFileSync(path.join(process.cwd(), "dev/fork-lab/demo-stack/stack.env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
        const psql = (container: string, sql: string) => docker(["exec", container, "sh", "-c", `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${sql}"`]);
        const items = psql("notes-db-1", "select string_agg(id||chr(58)||payload, chr(44) order by id) from items");
        const dump = execFileSync("sh", ["-c", "tar -xzOf - --wildcards '*.dump'"], {input: decryptAgentArchive(MASTER, fxFile("lab-postgres")), maxBuffer: 1 << 28});
        docker(["run", "-d", "--name", REFPG, "-e", `POSTGRES_USER=${STACK_ENV.POSTGRES_USER}`, "-e", `POSTGRES_PASSWORD=${STACK_ENV.POSTGRES_PASSWORD}`, "-e", `POSTGRES_DB=${STACK_ENV.POSTGRES_DB}`, PG_IMG]);
        await waitFor("reference pg ready", async () => { try { docker(["exec", REFPG, "sh", "-c", 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"']); return true; } catch { return false; } }, 60_000);
        await sleep(3000);
        docker(["exec", "-i", REFPG, "sh", "-c", 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner'], process.env, dump);
        const ref = psql(REFPG, "select string_agg(id||chr(58)||payload, chr(44) order by id) from items");
        try { docker(["rm", "-f", REFPG]); } catch { /* gone */ }
        expect(createHash("sha256").update(items).digest("hex")).toBe(createHash("sha256").update(ref).digest("hex"));
        RUN.push(`F1 data: volume listing == reference; items sha256(restored)=${createHash("sha256").update(items).digest("hex").slice(0, 16)} == reference; containers=${ps.join(",")}`);
        expect(docker(["exec", "notes-web-1", "printenv", "SMTP_PASSWORD"])).toBe(CANARY_OV);
        RUN.push("F1 override: printenv SMTP_PASSWORD inside notes-web-1 == the value set in the plan (value not logged)");
        const tables = (await q("select table_name from information_schema.tables where table_schema='public' and table_name like 'fork\\_%'")).map((x) => x.table_name as string);
        let hits = 0; for (const tb of tables) hits += Number((await q(`select count(*)::int n from "${tb}" t where t::text like '%X-Amz-Signature%' or t::text like '%' || $1 || '%'`, [MINIO_PASS]))[0].n);
        expect(hits).toBe(0);
        RUN.push(`F1 presign/credential scan: ${tables.length} fork_* tables, rows containing X-Amz-Signature or the MinIO secret = ${hits}`);
        const dl = stripAnsi(logs(CLEAN)).includes(MINIO_IP); RUN.push(`F1 agent log mentions the MinIO host: ${dl}`);
        await hygiene(c, f1Run);
        RUN.push("F1 hygiene: restore_cleanup succeeded, owned leftovers 0");
    }, 1_200_000);

    it("F2 real-storage negative: a corrupted object ⇒ honest failed at stage (damaged), explicit cleanup removes the workspace", async () => {
        const orig = saved.get("2/volume_app_data")!; const bad = Buffer.from(orig); bad[Math.floor(bad.length / 2)] ^= 0xff;
        await mc.putObject(BUCKET, objKey(n1, "volume_app_data"), bad);
        try {
            const c = await makePlan(); f2Plan = c; await approveProd(c);
            f2Run = await startRun(c, true);
            const r = await watchRun(f2Run, [], 480_000);
            RUN.push(`F2 state=${r.state} failed_step=${r.failed_step} reason=${r.reason}`);
            expect(r).toMatchObject({state: "failed", failed_step: "stage"});
            const grouped = JSON.stringify(FAILURE_GROUPS).includes(String(r.reason));
            RUN.push(`F2 reason covered by an explicit FAILURE_GROUPS entry: ${grouped}`);
            expect(grouped).toBe(true);
            const cl = await cleanupRestoreRun(rd(), {runId: f2Run}); if (!cl.ok) throw new Error(`cleanup refused: ${cl.code}`);
            expect((await finished(cl.taskId)).status).toBe("succeeded");
            expect(owned(f2Run)).toEqual({containers: "", volumes: "", networks: ""});
            RUN.push("F2 cleanup: succeeded, owned leftovers 0");
        } finally { await mc.putObject(BUCKET, objKey(n1, "volume_app_data"), orig); }
    }, 900_000);

    it("F3 pages under the real server: no canary in HTML / RSC, run headline per state", async () => {
        const canaries = [CANARY_OV, MINIO_PASS, MASTER.toString("base64"), decodeBundle(cleanBundle).task_key_b64, decodeBundle(cleanBundle).credential, "X-Amz-Signature", "/srv/app", `${ROOT}/notes/compose`];
        const paths = ["/dashboard/recovery", `/dashboard/recovery/plans/${f1Plan.planId}`, `/dashboard/recovery/runs/${f1Run}`, `/dashboard/recovery/runs/${f2Run}`];
        const bodies: Record<string, string> = {};
        for (const p of paths) {
            for (const [label, url, h] of [["html", p, {}], ["rsc", p, {RSC: "1"}], ["rsc-q", `${p}?_rsc=1`, {RSC: "1"}]] as const) {
                const res = await fetch(`${base}${url}`, {headers: {cookie: adminCookie, origin: PROJECT_URL(), ...h}, redirect: label === "html" ? "manual" : "follow"});
                const body = await res.text(); expect(res.status, `${label} ${p}`).toBe(200);
                for (const cn of canaries) expect(body.includes(cn), `${label} ${p} leaks ${cn.slice(0, 6)}…`).toBe(false);
                if (label === "html") bodies[p] = body;
            }
        }
        const headline = (html: string) => (html.match(/data-testid="run-headline"[^>]*>([\s\S]*?)<\/(?:h\d|p|div)>/)?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
        const h1 = headline(bodies[paths[2]]), h2 = headline(bodies[paths[3]]);
        RUN.push(`F3 headline F1="${h1}" F2="${h2}"`);
        expect(h1).toBe(HEADLINE.started.text);
        expect(h2.startsWith("Restore failed at 'Download the backup'")).toBe(true);
        RUN.push(`F3 canaries checked in html + rsc + ?_rsc=1 for ${paths.length} pages: none present`);
    }, 180_000);

    /** HOLD (browser / Session B): keeps everything up, executes lab commands (DD-F1-5) until $SCRATCH/w18b-lab.stop exists */
    it.skipIf(!HOLD)("HOLD", async () => {
        expect(SCRATCH).not.toBe("");
        mkdirSync(SCRATCH, {recursive: true});
        const cmdF = path.join(SCRATCH, "w18b-lab.cmd"), logF = path.join(SCRATCH, "w18b-lab.log"), stopF = path.join(SCRATCH, "w18b-lab.stop");
        for (const f of [cmdF, stopF]) { try { unlinkSync(f); } catch { /* none */ } }
        writeFileSync(path.join(SCRATCH, "w18b-lab.json"), JSON.stringify({base: PROJECT_URL(), admin: ADMIN.email, adminPassword: ADMIN.password, member: MEMBER, orgAdmin: ORGADMIN, root: ROOT, cmd: cmdF, stop: stopF, notesStack: w.stack, n1, n2}, null, 1), {mode: 0o600});
        const say = (cmd: string, ok: boolean, d = "") => writeFileSync(logF, `${new Date().toISOString()} ${cmd} ${ok ? "ok" : "error"} ${d}\n`, {flag: "a"});
        const find = async (seq: string, name: string) => { const rp = seq === "1" ? n2 : seq === "2" ? n1 : null; if (!rp || !name) throw new Error("usage: <rpSeq 1|2> <source_name>"); return {key: objKey(rp, name), orig: saved.get(`${seq}/${name}`)!}; };
        const exec = async (line: string) => {
            const [cmd, a, b] = line.trim().split(/\s+/);
            if (cmd === "env-on") {
                const envId = (await q(`insert into fork_arcane_environment (connection_id, external_id, name, agent_id, agent_name, host_role, allowed_path_roots, last_sync_status, last_sync_at) values ($1,'clean-env','clean-env',$2,'clean-host','production',$3,'ok',now()) returning id`, [w.conn, w.agent, [ROOT]]))[0].id;
                await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name) values ($1,$2,'clean-env','notes','notes (on clean-host)')", [org, envId]);
            } else if (cmd === "env-off") {
                await q("delete from fork_stack where environment_id in (select id from fork_arcane_environment where external_id='clean-env')"); await q("delete from fork_arcane_environment where external_id='clean-env'");
            } else if (cmd === "corrupt-object") { const o = await find(a, b); const bad = Buffer.from(o.orig); bad[Math.floor(bad.length / 2)] ^= 0xff; await mc.putObject(BUCKET, o.key, bad);
            } else if (cmd === "put-object") { const o = await find(a, b); await mc.putObject(BUCKET, o.key, o.orig);
            } else if (cmd === "drop-object") { const o = await find(a, b); await mc.removeObject(BUCKET, o.key);
            } else if (cmd === "pause-agent") docker(["pause", CLEAN]);
            else if (cmd === "resume-agent") docker(["unpause", CLEAN]);
            else if (cmd === "expire-plans") await q("update fork_restore_plan set expires_at = now() - interval '1 minute' where id not in (select plan_id from fork_restore_run)");
            else if (cmd === "hygiene") {
                for (const r of await q("select r.id, p.id plan_id, p.plan_hash from fork_restore_run r join fork_restore_plan p on p.id=r.plan_id where r.state in ('succeeded','incomplete')")) { await hygiene({planId: r.plan_id, planHash: r.plan_hash}, r.id); runIds.push(r.id); }
            } else throw new Error("unknown");
        };
        let lastSpare = 0;
        while (!existsSync(stopF)) {
            if (Date.now() - lastSpare > 30_000) { await q("update agents set last_contact=now() where name='spare'"); lastSpare = Date.now(); }
            if (existsSync(cmdF)) {
                const lines = readFileSync(cmdF, "utf8").split("\n").filter((l) => l.trim()); unlinkSync(cmdF);
                for (const l of lines) { try { await exec(l); say(l.trim(), true); } catch (e) { say(l.trim(), false, String((e as Error).message).slice(0, 200)); } }
            }
            await sleep(2000);
        }
        try { docker(["unpause", CLEAN]); } catch { /* not paused */ }
    }, 4 * 3_600_000);
});
