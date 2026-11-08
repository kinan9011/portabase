import {execFileSync, spawn, spawnSync, type ChildProcess} from "node:child_process";
import {createHash, createPrivateKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {enrolAgent} from "@/fork/agent-channel/admin";
import {decodeBundle} from "@/fork/agent-channel/bundle";
import {EnvelopeSchema} from "@/fork/agent-channel/envelope";
import {encryptPayload, payloadSha256} from "@/fork/agent-channel/payload";
import {cancelQueuedTask} from "@/fork/agent-channel/tasks";
import {SIGN_DOMAIN} from "@/fork/agent-channel/vocab";
import {canonicalJson} from "@/fork/canonical";
import type {ForkDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {setRestoreOverrides, type OverrideDeps} from "@/fork/config/service";
import {createRestorePlan, loadPlanRow} from "@/fork/restore/service";
import {buildDbPayload, buildComposeRef, type BuildInput} from "@/fork/restore-tasks/build";
import {enqueueRestoreTask, type RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import {decryptAgentArchive, encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {req, type ExtraSource} from "@/fork/__tests__/w16-world";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

/**
 * LIVE W17-live test (FORK_LAB=1, docker-bridge lab ONLY, synthetic TEST-ONLY data, never the owner's hosts): the REAL fork dashboard (production build) + the REAL fork agent image
 * on a dedicated docker network, driven at the W17 task level (`enqueueRestoreTask`) with a multi-service world: `db` (pg_dump -Fc), `db2` (pg_dump -Fd, forced stock-agent packaging),
 * `web`, `kuma` (sqlite in a named volume, uid 1000, stale -wal/-shm in the volume artifact).
 *   P0 preflight · N2 stage+apply · O-set · N3 render · N11 kill+resume · N9 data oracles · N10 compose_up + sqlite · N14 process canary · N12 isolation · N13 cleanup · N15a base image · N15b stock agent · N-canary.
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, the agent image(s) (see plan-W17-live §9).
 */
const LAB = process.env.FORK_LAB === "1";
const IMAGE = process.env.W17_AGENT_IMAGE ?? "portabase-agent-fork:w17b-lab";
const BASE_IMAGE = process.env.W17LIVE_BASE_IMAGE ?? "portabase-agent-fork-base:1.25.2-fork-c4d58fdd226c";
const STOCK_IMAGE = "ghcr.io/portabase/agent:1.25.2@sha256:e8f2b52eb4e59ed652d63d853a6bf517c31e9d41e3556115a2534ecbdde9df9f";
const PG_IMAGE = "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b";
const PAD = Number(process.env.W17LIVE_PAD_ROWS ?? 1_500_000);
const NET = "w17live-lab-net", SUBNET = "172.31.253.0/24", GW = "172.31.253.1";
const CLEAN = "w17live-agent-clean", VPS = "w17live-agent-vps", ST_CLEAN = "w17live-agent-clean-state", ST_VPS = "w17live-agent-vps-state", ST_STOCK = "w17live-agent-stock-state";
const REF_VOL = "w17live_ref", REF_KUMA = "w17live_kumaref";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env, input?: Buffer) => execFileSync("docker", args, {encoding: "utf8", env, input, stdio: ["pipe", "pipe", "pipe"]}).trim();
const dockerBuf = (args: string[], env: NodeJS.ProcessEnv = process.env, input?: Buffer) => execFileSync("docker", args, {env, input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"]});
const freePort = (host = GW) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const logsAll = (name: string) => { try { const r = spawnSync("docker", ["logs", name], {encoding: "utf8"}); return `${r.stdout}${r.stderr}`; } catch (e) { return String(e); } };
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
const FX = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {name: string; file: string; plaintext_sha256: string; plaintext_size: number}[]};
const fxFile = (n: string) => readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures", FX.fixtures.find((f) => f.name === n)!.file));
const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
const MASTER = Buffer.from(FX.master_key_b64, "base64");
const hex = (s: string) => createHash("sha256").update(s).digest("hex");
/** random per run (D8): none of them may ever be put in an argv by THIS test */
const CANARY_DB = `PGPW${randomBytes(9).toString("hex")}`;
const CANARY3 = `W16B${randomBytes(9).toString("hex")}$x`;
const SIG = `${randomBytes(12).toString("hex")}SECRETSIG`;
const SECRET_QS = `X-Amz-Signature=${SIG}`;

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let priv = ""; let tmp = ""; let ROOT = ""; let base = ""; let org = ""; let adminId = "";
let server: http.Server; let serverPort = 0;
const objects = new Map<string, {body: Buffer; hits: number}>();
const RUN: string[] = [];
const SNAPS: string[] = []; // agent logs saved before a container is removed (canary scans cover them)
let madeProxy = false;
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const URL_FOR_AGENTS = () => `http://forklab-dashboard.localhost:${new URL(base).port}`;
const snap = (name: string) => { const l = stripAnsi(logsAll(name)); SNAPS.push(l); return l; };
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-10).join("\n").slice(-2000)}\n--- clean agent ---\n${stripAnsi(logsAll(CLEAN)).split("\n").filter((l) => /[Ff]ork|rror|WARN/.test(l)).slice(-10).join(" | ").slice(-2500)}`);
        await sleep(1000);
    }
}
const principal = () => ({userId: adminId, systemRole: "superadmin", memberships: [{organizationId: org, role: "admin"}]});
const chDeps = (): RestoreTaskDeps => ({db, principal: principal(), keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok",
    env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}), configAllowed: async () => true,
    artifactUrl: async (sid) => { const [a] = await q("select rp_id, source_name from fork_recovery_point_artifact where backup_storage_id=$1", [sid]); return `http://${GW}:${serverPort}/${a.rp_id}/${a.source_name}?${SECRET_QS}`; }});
const task = async (id: string) => (await q("select status, result, attempts, lease_id from fork_agent_task where id=$1", [id]))[0];
const finished = (id: string, ms = 120_000) => waitFor(`task ${id} final`, async () => { const x = await task(id); return x && !["queued", "leased", "running"].includes(x.status) ? x : null; }, ms);
const listing = (vol: string) => docker(["run", "--rm", "-v", `${vol}:/vol:ro`, "busybox", "sh", "-c", "cd /vol && find . -type f | sort | xargs sha256sum"]);
// the agent runs as root: what it writes under ROOT is root-owned, so the host-side test looks through busybox
const rootSh = (script: string) => docker(["run", "--rm", "-v", `${ROOT}:${ROOT}`, "busybox", "sh", "-c", script]);
const rexists = (p: string) => { try { rootSh(`test -e '${p}'`); return true; } catch { return false; } };
const stateFile = (vol: string, file: string) => { try { return docker(["run", "--rm", "-v", `${vol}:/s:ro`, "busybox", "cat", `/s/${file}`]); } catch { return ""; } };

async function startAgent(name: string, stateVol: string, agentId: string, bundle: string, clean: boolean, image = IMAGE) {
    const edge = Buffer.from(JSON.stringify({serverUrl: URL_FOR_AGENTS(), agentId, masterKeyB64: MASTER.toString("base64")})).toString("base64url");
    const f = path.join(tmp, `${name}.bundle`);
    writeFileSync(f, bundle, {mode: 0o600}); chmodSync(f, 0o600);
    const args = ["run", "-d", "--name", name, "--network", NET, "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production",
        "-e", "FORK_CHANNEL_ENABLED=true", "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2", "-v", `${f}:/run/fork/bundle:ro`, "-v", `${stateVol}:/config`];
    if (clean) args.push("-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${ROOT}:${ROOT}`, "-e", `FORK_ALLOWED_PATH_ROOTS=${ROOT}`, "-e", `FORK_ARTIFACT_HTTP_HOSTS=${GW}`, "-e", "FORK_HOST_ROLE=test");
    docker([...args, image], {...process.env, EDGE_KEY: edge});
}

/** plant a signed task (the dashboard code signs; it is handed out like any queued task, the AGENT decides) */
async function plant(agentId: string, bundleStr: string, type: string, payload: unknown, o: {target?: string | null} = {}) {
    const [e] = await q("select enroll_id from fork_agent_enrollment where agent_id=$1", [agentId]);
    const [{seq}] = await q("update fork_agent_enrollment set next_seq=next_seq+1 where agent_id=$1 returning next_seq-1 as seq", [agentId]);
    const sk = {privateKey: (await fileKeyProvider.signing()).privateKeyPem, kid: kidOfPublicKey((await fileKeyProvider.signing()).publicKeyPem)};
    const taskId = randomUUID();
    const pt = Buffer.from(JSON.stringify(payload));
    const now = Math.floor(Date.now() / 1000);
    const env = EnvelopeSchema.parse({v: 1, task_id: taskId, agent_id: agentId, enroll_id: e.enroll_id, type, seq, issued_at: now - 5, not_after: now + 1800, nonce: randomBytes(16).toString("base64url"),
        payload_sha256: payloadSha256(pt), requires: type === "restore_probe" || type.startsWith("restore_") && type !== "restore_db" ? ["restore.target.v1"] : ["restore.target.v1", "compose.render.v1"], kid: sk.kid, ...(o.target ? {target_agent_id: o.target} : {})});
    const text = canonicalJson({...env, requires: [...env.requires].sort()});
    const signature = rsaSign("sha256", Buffer.from(SIGN_DOMAIN + text), createPrivateKey(sk.privateKey)).toString("base64");
    await q(`insert into fork_agent_task (id, agent_id, agent_name, enroll_id, type, requires, seq, envelope_text, signature, kid, payload_enc, payload_sha256, status, created_by, not_after)
             values ($1,$2,'planted',$3,$4,$11::text[],$5,$6,$7,$8,$9,$10,'queued','lab', now() + interval '30 minutes')`,
        [taskId, agentId, e.enroll_id, type, seq, text, signature, sk.kid, encryptPayload(Buffer.from(decodeBundle(bundleStr).task_key_b64, "base64"), {taskId, agentId, type}, pt), env.payload_sha256, env.requires]);
    return taskId;
}

// ---- N14: host /proc sampler (D7) ----------------------------------------------------------------------------------------------------------
type Sampler = {samples: number; hits: Record<string, number>; control: Record<string, number>; seen: Set<string>; stop: () => void};
function startSampler(canaries: Record<string, string>): Sampler {
    const s: Sampler = {samples: 0, hits: Object.fromEntries(Object.keys(canaries).map((k) => [k, 0])), control: {"docker-compose": 0, pg_restore: 0}, seen: new Set(), stop: () => clearInterval(timer)};
    const timer = setInterval(() => {
        s.samples++;
        let pids: string[] = [];
        try { pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { return; }
        for (const pid of pids) {
            let c = "";
            try { c = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch { continue; }
            if (!c) continue;
            for (const [k, v] of Object.entries(canaries)) if (c.includes(v)) s.hits[k]!++;
            for (const k of Object.keys(s.control)) if (c.includes(k) && /docker-compose|pg_restore -U/.test(c) && !c.includes("vitest")) { s.control[k]!++; if (s.seen.size < 20) s.seen.add(c.replace(CANARY_DB, "<redacted>").slice(0, 300)); }
        }
    }, 100);
    return s;
}

const COMPOSE = `services:
  db:
    image: ${PG_IMAGE}
    env_file: stack.env
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: {test: ["CMD-SHELL", "pg_isready -U $\${POSTGRES_USER} -d $\${POSTGRES_DB}"], interval: 3s, timeout: 3s, retries: 20}
    networks: {internal: {aliases: [demo-db]}}
  db2:
    image: ${PG_IMAGE}
    env_file: stack.env
    environment: {POSTGRES_DB: app2}
    volumes: [pgdata2:/var/lib/postgresql/data]
    networks: [internal]
  web:
    image: ${PG_IMAGE}
    env_file: stack.env
    depends_on: {db: {condition: service_healthy}}
    entrypoint: ["/bin/sh", "/app/serve.sh"]
    volumes: ["./web/serve.sh:/app/serve.sh:ro", "./web/handle.sh:/app/handle.sh:ro", "data:/appdata"]
    networks: [internal]
  kuma:
    image: ${STOCK_IMAGE}
    user: "1000:1000"
    entrypoint: ["sleep", "infinity"]
    volumes: [kumadata:/data]
    networks: [internal]
volumes: {pgdata: {}, pgdata2: {}, data: {}, kumadata: {}}
networks: {internal: {internal: true}}
`;
const EXTRA: ExtraSource[] = [
    {role: "db", key: "db:db2", dbms: "postgresql", member: "db_db2", engine: "postgresql"},
    {role: "volume", key: "volume:app_kumadata", dbms: "docker-volume", member: "volume_app_kumadata", engine: "docker-volume"},
    {role: "db", key: "db:kuma", dbms: "sqlite", member: "db_kuma", engine: "sqlite"},
];
const KUMA_SCRIPT = String.raw`set -eu
mkdir -p /w/live /w/out/vol /w/neg && cd /w/live
sqlite3 kuma.db "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<42) INSERT INTO t SELECT x,'row'||x FROM c; PRAGMA wal_checkpoint(TRUNCATE);" >&2
sqlite3 kuma.db >&2 <<'SQL'
PRAGMA wal_autocheckpoint=0;
DELETE FROM t WHERE id<=10;
INSERT INTO t VALUES(999,'wal-t1');
.shell cp kuma.db /w/out/vol/kuma.db; cp kuma.db-wal /w/out/vol/kuma.db-wal; cp kuma.db-shm /w/out/vol/kuma.db-shm
WITH RECURSIVE c(x) AS (SELECT 1000 UNION ALL SELECT x+1 FROM c WHERE x<1009) INSERT INTO t SELECT x,'after-t1-'||x FROM c;
.backup /w/out/dump.db
SQL
sqlite3 /w/out/dump.db "select group_concat(id||':'||v, ',') from (select * from t order by id)" > /w/out/expected.txt
sqlite3 /w/out/dump.db "select count(*) from t" > /w/out/expected-count.txt
cp /w/out/dump.db /w/neg/kuma.db; cp /w/out/vol/kuma.db-wal /w/neg/kuma.db-wal; cp /w/out/vol/kuma.db-shm /w/neg/kuma.db-shm
{ sqlite3 /w/neg/kuma.db "select group_concat(id||':'||v, ',') from (select * from t order by id)"; sqlite3 /w/neg/kuma.db "pragma integrity_check"; } > /w/out/neg.txt 2>&1 || true
cd /w/out && tar --numeric-owner --owner=1000 --group=1000 -czf vol.tar.gz vol && mkdir s && cp dump.db s/kuma.db && tar --numeric-owner --owner=1000 --group=1000 -czf sqlite.tar.gz -C s kuma.db
tar -cf - -C /w/out vol.tar.gz sqlite.tar.gz expected.txt expected-count.txt neg.txt dump.db
`;

describe.skipIf(!LAB)("W17-live: live restore proof (-Fc + -Fd, sqlite in WAL volume, kill/resume, process canary, degrade) on the fork image", () => {
    let world: W17; let planId = ""; let planHash = ""; let cleanBundle = ""; let vpsAgent = ""; let vpsBundle = ""; let composeDest = "";
    const restoreId = randomUUID();
    let filesPlain = Buffer.alloc(0);
    let EXP_DB2 = "", EXP_PAD = "", EXP_KUMA = "", EXP_KUMA_COUNT = "", NEG = "", DUMP_SHA = "";
    let KUMA_TEETH = true;
    let sampler: Sampler | null = null; let samplerCanaries: Record<string, string> = {};
    const manifestOf = () => ({json: world.manifestJson, sigB64: world.manifestSig});
    const put = (rp: string, name: string, body: Buffer) => { objects.set(`/${rp}/${name}`, {body, hits: 0}); };
    const wsDir = () => `${ROOT}/restore/app`;
    const DEMO = path.join(process.cwd(), "dev/fork-lab/demo-stack");
    const SEL = ["dir:/srv/app", "volume:app_data", "db:db", "db:db2", "volume:app_kumadata", "db:kuma"];
    const MAPPING = {target_project: null, restore_root: "", volumes: null, select: SEL, sqlite: {kuma: {volume: "app_kumadata", relative_path: "kuma.db"}}};
    const mkPlan = async () => {
        const c = await createRestorePlan({db, principal: principal(), configAllowed: async () => true}, req(world, {mode: "new_stack", mappings: {...MAPPING, restore_root: `${ROOT}/restore`}}));
        if (!c.ok) throw new Error(`plan refused: ${c.code}`);
        return c;
    };

    beforeAll(async () => {
        process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w17-test-${randomBytes(12).toString("hex")}`;
        tmp = mkdtempSync(path.join(os.tmpdir(), "w17live-lab-")); priv = path.join(tmp, "private");
        ROOT = path.join(tmp, "w17live-root"); mkdirSync(ROOT, {recursive: true});
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), MASTER, {mode: 0o600});
        for (const n of [CLEAN, VPS]) { try { docker(["rm", "-f", n]); } catch { /* none */ } }
        for (const v of [ST_CLEAN, ST_VPS, ST_STOCK, REF_VOL, REF_KUMA]) { try { docker(["volume", "rm", "-f", v]); } catch { /* none */ } }
        try { docker(["network", "create", "--subnet", SUBNET, NET]); } catch { /* exists */ }
        try { docker(["network", "create", "lab_proxy"]); madeProxy = true; } catch { /* exists: not ours */ }
        serverPort = await freePort();
        server = http.createServer((rq, rs) => {
            const o = objects.get(new URL(rq.url!, "http://x").pathname);
            if (!o) { rs.writeHead(404).end(); return; }
            o.hits++; rs.writeHead(200, {"content-length": o.body.length}); rs.end(o.body);
        }).listen(serverPort, GW);
        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        const port = await freePort(); base = `http://${GW}:${port}`;
        child = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {...process.env, NODE_ENV: "production", DATABASE_URL: t.url,
            PROJECT_URL: URL_FOR_AGENTS(), PROJECT_SECRET: `w17live-lab-${randomBytes(12).toString("hex")}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
            AUTH_DEFAULT_USER_NAME: "W17 Live Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
            FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300", FORK_RESTORE_TICK_SECONDS: "0"}});
        child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
        await waitFor("dashboard ready", async () => out.includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
        process.env.PRIVATE_PATH = priv;
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;

        // ---- data ------------------------------------------------------------------------------------------------------------------------
        const src = path.join(tmp, "src"); mkdirSync(src, {recursive: true});
        for (const f of ["web", "uploads"]) execFileSync("cp", ["-r", path.join(DEMO, f), src]);
        writeFileSync(path.join(src, "compose.yml"), COMPOSE);
        writeFileSync(path.join(src, "stack.env"), `POSTGRES_DB=demo\nPOSTGRES_USER=demo\nPOSTGRES_PASSWORD=${CANARY_DB}\nAPP_GREETING=w17live\n`);
        mkdirSync(path.join(src, "uploads"), {recursive: true}); writeFileSync(path.join(src, "uploads/hello.txt"), "hello from the backup\n");
        const tgz = path.join(tmp, "files.tar.gz"); execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
        filesPlain = readFileSync(tgz);

        // db2: -Fd with the stock agent's packaging (D3): pg_dump -Fd -j 4, tar of the dump dir (= append_dir_all(".")), outer tgz holding ONE file <gid>.tar.gz
        const gen = "w17live-gen-pg";
        try { docker(["rm", "-f", gen]); } catch { /* none */ }
        try {
            docker(["run", "-d", "--name", gen, "-e", "POSTGRES_PASSWORD", PG_IMAGE], {...process.env, POSTGRES_PASSWORD: randomBytes(9).toString("hex")});
            await waitFor("generator pg ready (tcp)", async () => { try { docker(["exec", gen, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "postgres"]); return true; } catch { return false; } }, 90_000);
            await sleep(2000);
            const psql = (sql: string) => docker(["exec", gen, "psql", "-U", "postgres", "-Atc", sql]);
            psql(`create table items2(id int primary key, payload text not null); insert into items2 select g, md5(g::text) from generate_series(1,1234) g; create table pad(id int primary key, payload text not null); insert into pad select g, md5('p'||g) from generate_series(1,${PAD}) g;`);
            EXP_DB2 = psql("select md5(string_agg(id||':'||payload, ',' order by id)) from items2");
            EXP_PAD = psql("select count(*) from pad");
            const inner = dockerBuf(["exec", gen, "sh", "-c", "rm -rf /tmp/d && pg_dump -U postgres -d postgres -Fd -j 4 -f /tmp/d && tar -C /tmp/d -czf - ."]);
            const gid = randomUUID();
            mkdirSync(path.join(tmp, "fd"), {recursive: true}); writeFileSync(path.join(tmp, "fd", `${gid}.tar.gz`), inner);
            execFileSync("tar", ["-czf", path.join(tmp, "outer.tgz"), "-C", path.join(tmp, "fd"), `${gid}.tar.gz`]);
        } finally { try { docker(["rm", "-f", gen]); } catch { /* gone */ } }
        const outer = readFileSync(path.join(tmp, "outer.tgz"));

        // kuma: volume artifact (stale WAL of T1) + sqlite artifact (consistent dump of T2) from ONE sqlite3 session in the stock image
        const kumaTar = dockerBuf(["run", "--rm", "-i", "--entrypoint", "sh", STOCK_IMAGE, "-s"], process.env, Buffer.from(KUMA_SCRIPT));
        const kd = path.join(tmp, "kuma"); mkdirSync(kd, {recursive: true}); execFileSync("tar", ["-xf", "-", "-C", kd], {input: kumaTar});
        const kf = (n: string) => readFileSync(path.join(kd, n));
        EXP_KUMA = kf("expected.txt").toString().trim(); EXP_KUMA_COUNT = kf("expected-count.txt").toString().trim(); NEG = kf("neg.txt").toString().trim(); DUMP_SHA = sha256(kf("dump.db"));

        const key = {privateKey: "", publicKey: "", kid: ""};
        const sk = await fileKeyProvider.signing(); key.privateKey = sk.privateKeyPem; key.publicKey = sk.publicKeyPem; key.kid = kidOfPublicKey(sk.publicKeyPem);
        const w = await seedW17World(t, "", key as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "test", roots: [ROOT], caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"], extra: EXTRA,
            plain: {compose_app: {sha: sha256(filesPlain), size: filesPlain.length}, volume_app_data: {sha: fx("lab-volume").plaintext_sha256, size: fx("lab-volume").plaintext_size},
                db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"}, db_db2: {sha: sha256(outer), size: outer.length, dump: "pg_directory"},
                volume_app_kumadata: {sha: sha256(kf("vol.tar.gz")), size: kf("vol.tar.gz").length}, db_kuma: {sha: sha256(kf("sqlite.tar.gz")), size: kf("sqlite.tar.gz").length}},
            enrolDeps: {serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok", keys: fileKeyProvider, env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}),
                principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
        world = w; cleanBundle = w.agentBundle;
        put(w.rp, "compose_app", encryptAgentArchive(MASTER, filesPlain)); put(w.rp, "volume_app_data", fxFile("lab-volume")); put(w.rp, "db_db", fxFile("lab-postgres"));
        put(w.rp, "db_db2", encryptAgentArchive(MASTER, outer)); put(w.rp, "volume_app_kumadata", encryptAgentArchive(MASTER, kf("vol.tar.gz"))); put(w.rp, "db_kuma", encryptAgentArchive(MASTER, kf("sqlite.tar.gz")));
        await startAgent(CLEAN, ST_CLEAN, w.agent, cleanBundle, true);
        vpsAgent = await seedAgent(t.pool, org, "w17live-vps");
        const r = await enrolAgent({...chDeps(), principal: {userId: adminId, systemRole: "superadmin", memberships: []}}, {agentId: vpsAgent, password: PASSWORD});
        if (!r.ok) throw new Error(`enrol vps: ${r.code}`);
        vpsBundle = r.bundle; await startAgent(VPS, ST_VPS, vpsAgent, vpsBundle, false);
        await waitFor("clean agent reported compose.render.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [w.agent]))[0]?.capabilities.includes("compose.render.v1"), 120_000);
        await waitFor("vps agent reported channel.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [vpsAgent]))[0]?.capabilities.includes("channel.v1"), 120_000);
        const c = await mkPlan(); planId = c.planId; planHash = c.planHash;
        const plan = await loadPlanRow({db}, planId, planHash); if (!plan.ok) throw new Error(plan.code);
        composeDest = plan.plan.actions.find((a) => a.kind === "restore_compose_dir")!.destination.path!;
        RUN.push(`plan outcome=${plan.plan.outcome} compose_dest=${composeDest} pad_rows=${PAD}`);
        expect(plan.plan.outcome).toBe("ready");
        // references: lab-volume fixture and the kuma volume artifact extracted independently by busybox
        docker(["volume", "create", REF_VOL]); docker(["volume", "create", REF_KUMA]);
        docker(["run", "--rm", "-i", "-v", `${REF_VOL}:/r`, "busybox", "tar", "-xzf", "-", "-C", "/r", "--strip-components=1"], process.env, decryptAgentArchive(MASTER, fxFile("lab-volume")));
        docker(["run", "--rm", "-i", "-v", `${REF_KUMA}:/r`, "busybox", "tar", "-xzf", "-", "-C", "/r", "--strip-components=1"], process.env, kf("vol.tar.gz"));
    }, 900_000);

    const allLogs = () => SNAPS.join("\n") + stripAnsi(logsAll(CLEAN)) + stripAnsi(logsAll(VPS)) + out;
    const bundleOf = () => { try { return decodeBundle(cleanBundle); } catch { return null; } };
    const secrets = () => ({CANARY_DB, CANARY3, presigned: SIG, master_b64: MASTER.toString("base64"), task_key: bundleOf()?.task_key_b64 ?? "~~", credential: bundleOf()?.credential ?? "~~"});

    afterAll(async () => {
        sampler?.stop();
        const evidence = process.env.W17LIVE_EVIDENCE_DIR;
        const all = allLogs();
        const clean = !Object.values(secrets()).some((s) => s && s !== "~~" && all.includes(s));
        if (evidence && clean) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(path.join(evidence, "w17live-agent-clean.log"), SNAPS.join("\n=====\n") + "\n=====\n" + stripAnsi(logsAll(CLEAN))); writeFileSync(path.join(evidence, "w17live-agent-vps.log"), stripAnsi(logsAll(VPS)));
            writeFileSync(path.join(evidence, "dashboard-fork-w17live.log"), out.split("\n").filter((l) => /[Ff]ork|agent-channel/.test(l) && !/Received POST/.test(l)).join("\n"));
            writeFileSync(path.join(evidence, "lab-run-w17live.txt"), RUN.join("\n") + "\n");
        } else if (evidence) writeFileSync(path.join(tmp, "NOT-WRITTEN"), "canary found a secret in a log: evidence withheld");
        for (const n of [CLEAN, VPS, "w17live-refpg", "w17live-gen-pg"]) { try { docker(["rm", "-f", n]); } catch { /* gone */ } }
        try { for (const id of docker(["ps", "-aq", "--filter", "label=com.portabase.fork.helper=true"]).split("\n").filter(Boolean)) docker(["rm", "-f", id]); } catch { /* none */ }
        try { for (const id of docker(["ps", "-aq", "--filter", "label=com.portabase.fork.agent_id"]).split("\n").filter(Boolean)) docker(["rm", "-f", id]); } catch { /* none */ }
        try { for (const v of docker(["volume", "ls", "-q", "--filter", "label=com.portabase.fork.agent_id"]).split("\n").filter(Boolean)) docker(["volume", "rm", "-f", v]); } catch { /* none */ }
        try { for (const n of docker(["network", "ls", "-q", "--filter", "label=com.portabase.fork.agent_id"]).split("\n").filter(Boolean)) docker(["network", "rm", n]); } catch { /* none */ }
        for (const v of [ST_CLEAN, ST_VPS, ST_STOCK, REF_VOL, REF_KUMA]) { try { docker(["volume", "rm", "-f", v]); } catch { /* gone */ } }
        try { docker(["network", "rm", NET]); } catch { /* gone */ }
        if (madeProxy) { try { docker(["network", "rm", "lab_proxy"]); } catch { /* gone */ } }
        server?.close(); child?.kill("SIGTERM"); await sleep(500); if (child?.exitCode === null) child?.kill("SIGKILL");
        await t?.drop();
        try { rootSh("rm -rf " + ROOT + "/*"); } catch { /* none */ }
        rmSync(tmp, {recursive: true, force: true});
    });

    const enq = (type: string, extra: Record<string, unknown> = {}) => enqueueRestoreTask(chDeps(), {type, planId, planHash, restoreId, ...(type === "restore_cleanup" ? {} : {manifest: manifestOf()}), ...extra} as never);
    const run = async (type: string, extra: Record<string, unknown> = {}) => {
        const r = await enq(type, extra);
        if (!r.ok) return {refused: r.code, id: "", status: "refused", result: {} as Record<string, any>};
        const x = await finished(r.taskId);
        return {refused: undefined as string | undefined, id: r.taskId, status: x.status as string, result: x.result as Record<string, any>};
    };
    const ovDeps = (): OverrideDeps => ({db, principal: principal(), configAllowed: async () => true, now: () => new Date()});
    const rows = async () => (await q("select task_id, rendered_sha256, policy_view from fork_compose_render where restore_id=$1 order by created_at", [restoreId]));
    const caps = async () => (await q("select capabilities, capabilities_seen_at from fork_agent_enrollment where agent_id=$1", [world.agent]))[0] as {capabilities: string[]; capabilities_seen_at: Date | null};
    const kumaSh = (cmd: string) => docker(["exec", "app-kuma-1", "sh", "-c", cmd]);
    const kumaSql = (sql: string) => docker(["exec", "app-kuma-1", "sqlite3", "/data/kuma.db", sql]);

    it("P0 preflight: image ids, capabilities, sqlite teeth, plan actions", async () => {
        const id = (i: string) => docker(["image", "inspect", "-f", "{{.Id}}", i]);
        RUN.push(`P0 images fork=${IMAGE} ${id(IMAGE)} base=${BASE_IMAGE} ${id(BASE_IMAGE)} stock=${id(STOCK_IMAGE.split("@")[0]!)}`);
        const c = (await caps()).capabilities;
        expect(c).toEqual(expect.arrayContaining(["restore.target.v1", "compose.render.v1"]));
        const v = (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [vpsAgent]))[0].capabilities as string[];
        expect(v.some((x) => x === "restore.target.v1" || x === "compose.render.v1")).toBe(false);
        const neg = NEG.split("\n"); const teethDiffers = neg[0] !== EXP_KUMA; const integrityBad = neg.slice(1).some((l) => l !== "ok" && l !== "");
        KUMA_TEETH = teethDiffers || integrityBad;
        RUN.push(`P0 kuma_teeth=${KUMA_TEETH} (neg first line ${teethDiffers ? "differs from" : "equals"} expected; integrity_check ${integrityBad ? "NOT ok" : "ok"}); expected_count=${EXP_KUMA_COUNT} exp_db2_md5=${EXP_DB2} exp_pad=${EXP_PAD}`);
        expect(KUMA_TEETH, "sqlite fixture has no teeth").toBe(true);
        expect(EXP_KUMA_COUNT).toBe("43");
        const plan = await loadPlanRow({db}, planId, planHash); if (!plan.ok) throw new Error(plan.code);
        const kinds = plan.plan.actions.filter((a) => a.op !== "skip").map((a) => a.kind);
        expect(kinds.filter((k) => k === "restore_db_dump")).toHaveLength(2);
        expect(kinds.filter((k) => k === "restore_volume")).toHaveLength(2);
        expect(kinds).toContain("restore_sqlite_file");
        RUN.push(`P0 caps clean=${c.join(",")} vps=${v.join(",")} actions=${kinds.join(",")}`);
    });

    it("N2 stage + apply: app_data == reference; app_kumadata holds ONLY kuma.db (no -wal/-shm), root + file 1000:1000, sha == the consistent dump", async () => {
        const s = await run("restore_stage"); expect(s).toMatchObject({status: "succeeded"});
        const a = await run("restore_apply"); expect(a).toMatchObject({status: "succeeded"});
        expect(listing("app_data")).toBe(listing(REF_VOL));
        // the reference volume (the volume artifact on its own) DOES hold the stale siblings: the restore must have removed them
        const refLs = docker(["run", "--rm", "-v", `${REF_KUMA}:/v:ro`, "busybox", "sh", "-c", "cd /v && ls -A | sort"]);
        expect(refLs.split("\n")).toEqual(["kuma.db", "kuma.db-shm", "kuma.db-wal"]);
        const ls = docker(["run", "--rm", "-v", "app_kumadata:/v:ro", "busybox", "sh", "-c", 'cd /v && ls -A | sort; stat -c "%n %u:%g %a" . kuma.db; sha256sum kuma.db']);
        RUN.push(`N2 app_kumadata: ${ls.replaceAll("\n", " | ")} ; expected dump sha ${DUMP_SHA.slice(0, 16)}…`);
        const lines = ls.split("\n");
        expect(lines.slice(0, 1)).toEqual(["kuma.db"]);
        expect(lines[1]).toMatch(/^\. 1000:1000 /);
        expect(lines[2]).toMatch(/^kuma\.db 1000:1000 /);
        expect(lines[3]!.split(/\s+/)[0]).toBe(DUMP_SHA);
        RUN.push(`N2 stage=${s.status} apply=${a.status} app_data listing == reference; kuma.db sha256 == dump (${DUMP_SHA.slice(0, 16)}…), no -wal/-shm, 1000:1000`);
    });

    it("O-set (W16b) override applied + N14 sampler started", async () => {
        const r = await setRestoreOverrides(ovDeps(), {planId, planHash, set: [{service: "web", key: "A", value: CANARY3}], overrideYml: "services:\n  web:\n    environment:\n      OVERRIDE_PROBE: w17live\n"});
        expect(r).toMatchObject({ok: true});
        samplerCanaries = secrets(); // all six
        sampler = startSampler(samplerCanaries);
        RUN.push("O-set override web/A + OVERRIDE_PROBE; N14 sampler started (100 ms, host /proc)");
    });

    it("N3 render: succeeded, verdict allow, policy view, services db/db2/kuma/web", async () => {
        const r = await run("compose_render");
        expect(r).toMatchObject({status: "succeeded"});
        const row = (await rows()).at(-1)!;
        const {isPolicyView} = await import("@/fork/restore-tasks/view");
        expect(isPolicyView(JSON.parse(row.policy_view))).toBe(true);
        expect(r.result.verdict).toBe("allow");
        const pv = JSON.parse(row.policy_view) as {services?: Record<string, unknown> | {name: string}[]};
        const names = Array.isArray(pv.services) ? pv.services.map((s) => s.name) : Object.keys(pv.services ?? {});
        expect(names.sort()).toEqual(["db", "db2", "kuma", "web"]);
        expect(row.policy_view).not.toContain(CANARY_DB);
        RUN.push(`N3 render ok sha=${row.rendered_sha256.slice(0, 12)} verdict=allow services=${names.sort().join(",")}`);
    });

    let t1Id = "", t1Final: Record<string, any> | null = null; let killedMs = -1;
    it("N11 kill + restart during the db2 pg_restore (-Fd): journal abort/restart, secret/ + tmp/ swept, staged dump kept, T1 failed/execution_error", async () => {
        const plan = await loadPlanRow({db}, planId, planHash); if (!plan.ok) throw new Error(plan.code);
        const arts = (await q("select id, source_name from fork_recovery_point_artifact where rp_id=$1 order by source_name", [world.rp])) as {id: string; source_name: string}[];
        const bi: BuildInput = {restoreId, planId, planHash, plan: plan.plan, approvals: [], indexOf: new Map(arts.map((a, i) => [a.id, i]))};
        const dbs = buildDbPayload(bi, world.manifestSha, buildComposeRef(bi, null), "0".repeat(64), null).dbs;
        const idx2 = dbs.find((d) => d.service === "db2")!.index;
        expect(idx2).toBe(arts.findIndex((a) => a.source_name === "db_db2"));
        const stagesBefore = Number((await q("select count(*)::int n from fork_agent_task where type='restore_stage' and agent_id=$1", [world.agent]))[0].n);
        const r1 = await enq("restore_db", {approval: null});
        if (!r1.ok) throw new Error(r1.code);
        t1Id = r1.taskId;
        const t0 = Date.now(); let killed = false;
        while (Date.now() - t0 < 150_000) {
            let top = "";
            try { top = docker(["top", "app-db2-1", "-eo", "pid,args"]); } catch { top = ""; }
            if (/pg_restore/.test(top)) { docker(["kill", CLEAN]); killed = true; killedMs = Date.now() - t0; break; }
            const x = await task(t1Id); if (x && !["queued", "leased", "running"].includes(x.status)) break;
            await sleep(100);
        }
        RUN.push(`N11 killed=${killed} after ${killedMs} ms (pad_rows=${PAD})`);
        expect(killed, "the agent was killed while pg_restore of db2 was running (raise W17LIVE_PAD_ROWS if the restore is too fast)").toBe(true);
        await sleep(3000); snap(CLEAN); docker(["start", CLEAN]);
        await waitFor("journal abort reason=restart", async () => { const j = stateFile(ST_CLEAN, `fork-restore/${restoreId}.jsonl`); return j.includes('"ev":"abort"') && j.includes('"reason":"restart"') ? j : null; }, 120_000);
        expect(rexists(`${wsDir()}/.portabase/secret`)).toBe(false);
        expect(rexists(`${wsDir()}/.portabase/tmp`)).toBe(false);
        expect(rexists(`${wsDir()}/.portabase/stage/a${idx2}.tar.gz`)).toBe(true);
        const journal = stateFile(ST_CLEAN, `fork-restore/${restoreId}.jsonl`);
        for (const [k, v] of Object.entries(secrets())) expect(journal.includes(v), `journal holds ${k}`).toBe(false);
        t1Final = await finished(t1Id, 240_000);
        expect(t1Final.status).toBe("failed");
        expect(t1Final.result).toMatchObject({reason: "execution_error"});
        const stagesAfter = Number((await q("select count(*)::int n from fork_agent_task where type='restore_stage' and agent_id=$1", [world.agent]))[0].n);
        expect(stagesAfter).toBe(stagesBefore);
        RUN.push(`N11 journal abort restart ok; secret/ + tmp/ gone; stage a${idx2}.tar.gz kept; T1 ${t1Final.status} ${JSON.stringify(t1Final.result)}; stage tasks before/after ${stagesBefore}/${stagesAfter}`);
    });

    it("N11/N9 resume: second restore_db with the same restore_id ⇒ db reused, db2 restored; data oracles", async () => {
        // the orphan pg_restore of T1 (if any) may still run in app-db2-1: record it (plan D-1)
        let orphan = "";
        try { orphan = docker(["top", "app-db2-1", "-eo", "pid,args"]).split("\n").filter((l) => /pg_restore/.test(l)).join(" | "); } catch { orphan = "(no container)"; }
        RUN.push(`N11 orphan pg_restore in app-db2-1 before T2: ${orphan || "none"}`);
        const r = await run("restore_db", {approval: null});
        RUN.push(`N11 T2 restore_db ${JSON.stringify(r).slice(0, 500)}`);
        expect(r).toMatchObject({status: "succeeded"});
        const res = r.result;
        expect(res.dbs).toEqual([{service: "db", format: "pg_custom", status: "reused"}, {service: "db2", format: "pg_directory", status: "restored"}]);
        // N9 oracles
        const psql = (c: string, sql: string) => docker(["exec", c, "sh", "-c", `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${sql}"`]);
        const got = psql("app-db-1", "select string_agg(id||chr(58)||payload, chr(44) order by id) from items");
        const plainTgz = decryptAgentArchive(MASTER, fxFile("lab-postgres"));
        const dump = execFileSync("sh", ["-c", "tar -xzOf - --wildcards '*.dump'"], {input: plainTgz, maxBuffer: 1 << 28});
        try { docker(["rm", "-f", "w17live-refpg"]); } catch { /* none */ }
        docker(["run", "-d", "--name", "w17live-refpg", "-e", "POSTGRES_USER=demo", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=demo", PG_IMAGE], {...process.env, POSTGRES_PASSWORD: randomBytes(9).toString("hex")});
        await waitFor("reference pg ready", async () => { try { docker(["exec", "w17live-refpg", "pg_isready", "-q", "-h", "127.0.0.1", "-U", "demo", "-d", "demo"]); return true; } catch { return false; } }, 60_000);
        await sleep(2000);
        docker(["exec", "-i", "w17live-refpg", "sh", "-c", 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner'], process.env, dump);
        const ref = docker(["exec", "w17live-refpg", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"']);
        try { docker(["rm", "-f", "w17live-refpg"]); } catch { /* gone */ }
        const nItems = psql("app-db-1", "select count(*) from items");
        RUN.push(`N9 db(-Fc) items=${nItems} sha256(restored)=${hex(got).slice(0, 16)} sha256(reference restore)=${hex(ref).slice(0, 16)}`);
        expect(Number(nItems)).toBeGreaterThan(0);
        expect(hex(got)).toBe(hex(ref));
        const md5 = psql("app-db2-1", "select md5(string_agg(id||chr(58)||payload, chr(44) order by id)) from items2");
        const n2 = psql("app-db2-1", "select count(*) from items2"); const np = psql("app-db2-1", "select count(*) from pad");
        RUN.push(`N9 db2(-Fd) items2 md5=${md5} (expected ${EXP_DB2}) count=${n2} pad=${np} (expected ${EXP_PAD})`);
        expect(md5).toBe(EXP_DB2); expect(n2).toBe("1234"); expect(np).toBe(EXP_PAD);
        expect(md5).not.toBe(""); // the expected value was computed on the SOURCE database before dumping (independent of the restore path)
    });

    it("N10 compose_up: four containers owned, kuma uid 1000 reads + WRITES the restored sqlite, no stale WAL, content == expected, override reached web", async () => {
        const r = await run("compose_up", {approval: null});
        RUN.push(`N10 compose_up ${JSON.stringify(r).slice(0, 300)}`);
        expect(r).toMatchObject({status: "succeeded"});
        const ps = docker(["ps", "-a", "--filter", "label=com.docker.compose.project=app", "--format", "{{.Names}}|{{.State}}|{{.Label \"com.portabase.fork.restore_id\"}}"]).trim().split("\n");
        expect(ps.sort().join(";")).toBe(["app-db-1", "app-db2-1", "app-kuma-1", "app-web-1"].map((n) => `${n}|running|${restoreId}`).join(";"));
        expect(kumaSh("id -u").trim()).toBe("1000");
        expect(kumaSh("ls -A /data")).toBe("kuma.db");
        expect(kumaSql("pragma integrity_check")).toBe("ok");
        expect(kumaSql("select group_concat(id||':'||v, ',') from (select * from t order by id)")).toBe(EXP_KUMA);
        expect(kumaSql("select count(*) from t")).toBe("43");
        const wr = docker(["exec", "app-kuma-1", "sqlite3", "/data/kuma.db", "insert into t values(5000,'w'); select count(*) from t"]);
        expect(wr.trim()).toBe("44");
        expect(docker(["exec", "app-web-1", "sh", "-c", 'printf %s "$A" | sha256sum']).split(/\s+/)[0]).toBe(hex(CANARY3));
        expect(listing("app_data")).toBe(listing(REF_VOL));
        RUN.push(`N10 containers=${ps.join(",")} uid=1000 ls=kuma.db integrity=ok content==expected count=43 write(uid 1000)->${wr.trim()} sha256(printenv A)==sha256(override)`);
    });

    it("N14 process canary: no secret in any host cmdline during render / restore_db (incl. kill+restart) / up; positive controls seen; nothing on disk", async () => {
        sampler!.stop();
        const s = sampler!;
        writeFileSync(path.join(tmp, "proc-sampler.txt"), [`samples=${s.samples}`, ...Object.entries(s.hits).map(([k, v]) => `canary ${k} hits=${v}`), ...Object.entries(s.control).map(([k, v]) => `positive-control ${k} hits=${v}`), "--- lab cmdlines matched by the positive controls (password redacted) ---", ...s.seen].join("\n") + "\n");
        RUN.push(`N14 samples=${s.samples} hits=${JSON.stringify(s.hits)} control=${JSON.stringify(s.control)}`);
        expect(s.samples).toBeGreaterThanOrEqual(100);
        expect(s.control["docker-compose"]).toBeGreaterThanOrEqual(1);
        expect(s.control.pg_restore).toBeGreaterThanOrEqual(1);
        for (const [k, v] of Object.entries(s.hits)) expect(v, `canary ${k} seen in a cmdline`).toBe(0);
        const disk = docker(["run", "--rm", "-e", "PAT", "-v", `${ROOT}:${ROOT}`, "busybox", "sh", "-c", `grep -rlF -- "$PAT" ${ROOT} || true`], {...process.env, PAT: CANARY3});
        expect(disk).toBe("");
        const disk2 = docker(["run", "--rm", "-e", "PAT", "-v", `${ROOT}:${ROOT}`, "busybox", "sh", "-c", `grep -rlF -- "$PAT" ${ROOT} || true`], {...process.env, PAT: CANARY_DB});
        RUN.push(`N14 disk grep of ${ROOT} for override value: empty; for db password: ${disk2 ? "FILES:" + disk2.split("\n").length : "empty"} (stack.env legitimately holds it: restored compose dir)`);
    });

    it("N12 isolation: the vps agent has no task and the clean task ids never reached its log", async () => {
        expect(Number((await q("select count(*)::int n from fork_agent_task where agent_id=$1", [vpsAgent]))[0].n)).toBe(0);
        const vlog = stripAnsi(logsAll(VPS));
        const ids = (await q("select id from fork_agent_task where agent_id=$1", [world.agent])).map((r) => r.id as string);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(vlog.includes(id)).toBe(false);
        RUN.push(`N12 vps tasks=0; ${ids.length} clean task ids absent from the vps log`);
    });

    it("N13 cleanup: owned resources gone, workspace gone, agent running", async () => {
        const r = await run("restore_cleanup", {cleanup: {workspace: true, volumes: true, networks: true, containers: true}});
        RUN.push(`N13 cleanup ${JSON.stringify(r)}`);
        if (r.status !== "succeeded") RUN.push(`N13 DIAG left: containers=[${docker(["ps", "-a", "--filter", "label=com.docker.compose.project=app", "--format", "{{.Names}}:{{.State}}"]).replaceAll("\n", ",")}] volumes=[${docker(["volume", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${restoreId}`]).replaceAll("\n", ",")}] networks=[${docker(["network", "ls", "--format", "{{.Name}}", "--filter", `label=com.portabase.fork.restore_id=${restoreId}`]).replaceAll("\n", ",")}]`);
        expect(r).toMatchObject({status: "succeeded"});
        expect(docker(["ps", "-aq", "--filter", "label=com.docker.compose.project=app"]).trim()).toBe("");
        expect(docker(["volume", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${restoreId}`]).trim()).toBe("");
        expect(docker(["network", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${restoreId}`]).trim()).toBe("");
        expect(rexists(wsDir())).toBe(false);
        expect(docker(["inspect", "-f", "{{.State.Running}}", CLEAN]).trim()).toBe("true");
    });

    it("N15a base image (no Compose overlay): restore.target.v1 without compose.render.v1; dashboard capability_missing; planner target_capability_missing; agent rejects a planted compose_render", async () => {
        snap(CLEAN); docker(["rm", "-f", CLEAN]);
        const tRestart = new Date();
        await startAgent(CLEAN, ST_CLEAN, world.agent, cleanBundle, true, BASE_IMAGE);
        const c = await waitFor("base-image caps reported", async () => { const x = await caps(); return x.capabilities_seen_at && x.capabilities_seen_at > tRestart && x.capabilities.includes("restore.target.v1") && !x.capabilities.includes("compose.render.v1") ? x : null; }, 120_000);
        const l = stripAnsi(logsAll(CLEAN));
        expect(l).toContain("compose.render.v1 NOT enabled");
        const why = l.split("\n").find((x) => x.includes("compose.render.v1 NOT enabled"))!.replace(/^.*Fork channel: /, "");
        expect(await enq("compose_render")).toMatchObject({ok: false, code: "capability_missing"});
        const p = await createRestorePlan({db, principal: principal(), configAllowed: async () => true}, req(world, {mode: "new_stack", mappings: {...MAPPING, restore_root: `${ROOT}/restore`}}));
        const blockers = p.ok ? ((await loadPlanRow({db}, p.planId, p.planHash)) as {ok: true; plan: {blockers: string[]}}).plan.blockers : [`refused:${p.code}`];
        expect(blockers).toContain("target_capability_missing");
        const header = {v: 1, restore_id: randomUUID(), plan_id: planId, plan_hash: planHash, stack_id: world.stack, rp_id: world.rp, purpose: "restore", mode: "new_stack", host_role: "test", approvals: [], workspace: `${ROOT}/restore/app`, project: "app"};
        const planted = await plant(world.agent, cleanBundle, "compose_render", {...header, manifest_sha256: world.manifestSha, compose: {dir: `${ROOT}/restore/app/compose`, override_yml: null, env: {}, path_map: []}}, {target: world.agent});
        const x = await finished(planted);
        expect(x.status).toBe("rejected"); expect(x.result).toMatchObject({reason: "capability_missing"});
        expect(docker(["ps", "-aq", "--filter", "label=com.portabase.fork.helper=true"]).trim()).toBe("");
        RUN.push(`N15a caps=${c.capabilities.join(",")} log="${why.slice(0, 160)}" enqueue=capability_missing planner_blockers=${blockers.join(",")} planted compose_render => ${x.status}/${x.result.reason}; no helper container`);
    });

    it("N15b stock agent 1.25.2: never leases; an enqueued restore_probe stays queued (attempts 0, no lease) and is cancellable", async () => {
        snap(CLEAN); docker(["rm", "-f", CLEAN]);
        const edge = Buffer.from(JSON.stringify({serverUrl: URL_FOR_AGENTS(), agentId: world.agent, masterKeyB64: MASTER.toString("base64")})).toString("base64url");
        docker(["run", "-d", "--name", CLEAN, "--network", NET, "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production", "-v", `${ST_STOCK}:/config`, STOCK_IMAGE], {...process.env, EDGE_KEY: edge});
        const p = await enqueueRestoreTask(chDeps(), {type: "restore_probe", agentId: world.agent});
        if (!p.ok) throw new Error(`probe enqueue: ${p.code} (stale capabilities are expected to allow it, OD-W17L-3)`);
        await sleep(90_000);
        const x = await task(p.taskId);
        const l = stripAnsi(logsAll(CLEAN));
        RUN.push(`N15b T3 status=${x.status} attempts=${x.attempts} lease_id=${x.lease_id}; stock log lines=${l.split("\n").length}; contains task id=${l.includes(p.taskId)}; contains "Fork channel"=${l.includes("Fork channel")}`);
        expect(x).toMatchObject({status: "queued", attempts: 0, lease_id: null});
        expect(l.includes(p.taskId)).toBe(false); expect(l.includes("Fork channel")).toBe(false);
        expect(await cancelQueuedTask(db, {taskId: p.taskId, agentId: world.agent, now: new Date()})).toBeTruthy();
        const stockLog = snap(CLEAN);
        const evidence = process.env.W17LIVE_EVIDENCE_DIR;
        const leaked = Object.values(secrets()).some((s) => s && s !== "~~" && stockLog.includes(s));
        if (evidence && !leaked) { mkdirSync(evidence, {recursive: true}); writeFileSync(path.join(evidence, "w17live-agent-stock.log"), stockLog); }
        expect(leaked).toBe(false);
        docker(["rm", "-f", CLEAN]);
        await startAgent(CLEAN, ST_CLEAN, world.agent, cleanBundle, true);
        const tR = new Date();
        await waitFor("fork caps back", async () => { const c = await caps(); return c.capabilities_seen_at && c.capabilities_seen_at > tR && c.capabilities.includes("compose.render.v1"); }, 120_000);
        RUN.push("N15b orchestrator outcome for a non-polling agent = W18a L4 agent_offline (referenced, not re-run); T3 cancelled; fork agent restored (compose.render.v1 again)");
    });

    it("N-canary: no secret in any agent log, the dashboard log, any fork_% table or the audit", async () => {
        const all = allLogs();
        for (const [k, v] of Object.entries(secrets())) expect(all.includes(v), `canary ${k} leaked in a log`).toBe(false);
        const tables = (await q("select table_name from information_schema.tables where table_schema='public' and table_name like 'fork\\_%' escape '\\'")).map((r) => r.table_name as string);
        for (const n of tables) for (const [k, v] of Object.entries(secrets())) expect((await q(`select count(*)::int c from "${n}" x where x::text like $1`, [`%${v}%`]))[0].c, `canary ${k} in ${n}`).toBe(0);
        RUN.push(`N-canary 6 secrets absent from ${SNAPS.length + 2} agent logs, dashboard log, ${tables.length} fork_% tables`);
    });
});
