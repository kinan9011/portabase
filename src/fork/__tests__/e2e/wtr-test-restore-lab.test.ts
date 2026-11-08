import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {createPrivateKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from "node:fs";
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
import {SIGN_DOMAIN} from "@/fork/agent-channel/vocab";
import {canonicalJson} from "@/fork/canonical";
import type {ForkDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {createRestorePlan, setStackPrivacy} from "@/fork/restore/service";
import {buildManifest} from "@/fork/manifest/build";
import {signManifest} from "@/fork/manifest/sign";
import {createHash} from "node:crypto";
import {loadProtectionByStackId} from "@/fork/stacks/protection-load";
import {evaluateAlerts} from "@/fork/notifications/evaluate";
import {renderNotification} from "@/fork/notifications/render";
import {testRestoreSchedulerTick} from "@/fork/test-restore/scheduler";
import {advanceTestRestoreWipes} from "@/fork/test-restore/wipe";
import {runTestRestoreNow, setTestRestoreSchedule} from "@/fork/test-restore/service";
import {getTestRestoreView} from "@/fork/test-restore/view";
import {DEFAULT_TR_SCHEDULE} from "@/fork/test-restore/vocab";
import type {TestRestoreDeps} from "@/fork/test-restore/deps";
import type {RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {tickRestoreRun} from "@/fork/restore-run/tick";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import {decryptAgentArchive, encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import type {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {req, seedUser, type ExtraSource} from "@/fork/__tests__/w16-world";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

/**
 * LIVE W-TR test (FORK_LAB=1, docker-bridge lab ONLY, synthetic TEST-ONLY data, never the owner's hosts): the REAL fork dashboard (production build, its own
 * restore-runs job switched off with FORK_RESTORE_TICK_SECONDS=0) + the REAL fork agent image (`W17_AGENT_IMAGE`) on a dedicated docker network. The TEST process drives
 * the orchestrator (`tickRestoreRun`) with the same DB and seams for the manifest bytes and the artifact URLs (an in-test http server on the bridge gateway).
 *   L1 full orchestrated restore + VPS isolation + concurrency · L2 forged manifest · L3 rollback manifest · L4 agent offline at start · L8 agent killed during restore_db · L5 stage object swapped → cleanup.
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, the agent image.
 */
const LAB = process.env.FORK_LAB === "1";
const IMAGE = process.env.W17_AGENT_IMAGE ?? "portabase-agent-fork:wtr-lab";
const NET = "wtr-lab-net", SUBNET = "172.31.246.0/24", GW = "172.31.246.1";
const CLEAN = "wtr-agent-test", VPS = "wtr-agent-prod", ST_CLEAN = "wtr-agent-test-state", ST_VPS = "wtr-agent-prod-state", REF_VOL = "wtrlab_ref";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env, input?: Buffer) => execFileSync("docker", args, {encoding: "utf8", env, input, stdio: ["pipe", "pipe", "pipe"]}).trim();
const freePort = (host = GW) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const logs = (name: string) => { try { return execFileSync("docker", ["logs", name], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}); } catch (e) { return String(e); } };
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
const FX = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {name: string; file: string; plaintext_sha256: string; plaintext_size: number}[]};
const fxFile = (n: string) => readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures", FX.fixtures.find((f) => f.name === n)!.file));
const MASTER = Buffer.from(FX.master_key_b64, "base64");
/** W16b: the per-key override value of the lab (random; contains a literal `$` to prove escaping): must reach the container and nowhere else */
const CANARY3 = `W16B${randomBytes(9).toString("hex")}$x`;
const SECRET_QS = `X-Amz-Signature=${randomBytes(12).toString("hex")}SECRETSIG`;
/** W-TR-f: HOLD keeps the lab up for the browser run and executes lines of `$WTR_SCRATCH/wtr-lab.cmd` (closed command set); the sqlite world has the pilot shape (uptime-kuma: sqlite in a named volume + a sqlite artifact) */
const HOLD = process.env.WTR_LAB_HOLD === "1";
const SCRATCH = process.env.WTR_SCRATCH ?? "";
const MEMBER = {email: "member@wtr-lab.test", password: "wtr-member-pw-1!"}, ORGADMIN = {email: "orgadmin@wtr-lab.test", password: "wtr-orgadmin-pw-1!"}; // test-only
const KUMA_EXTRA: ExtraSource[] = [
    {role: "volume", key: "volume:app_kumadata", dbms: "docker-volume", member: "volume_app_kumadata", engine: "docker-volume"},
    {role: "db", key: "db:kuma", dbms: "sqlite", member: "db_kuma", engine: "sqlite"},
];
/** SLOW sqlite fixture (D-F8): 4 KiB pages, a table + an index over 200 000 repetitive rows ⇒ `PRAGMA integrity_check` has to verify every index entry (≈ a second) while the archive stays small.
 *  `bad` = the same db with the root pages of the table and the index overwritten (page 1 + header stay intact, so the agent finds the file and the RIGHT check fails). */
const KUMA_ROWS = Number(process.env.WTR_KUMA_ROWS ?? 200_000);
const KUMA_SCRIPT = String.raw`set -eu
exec 3>&1 1>&2
W=/tmp/w; mkdir -p $W/good $W/bad $W/vol/vol $W/out && cd $W
sqlite3 good/kuma.db "PRAGMA page_size=4096; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${KUMA_ROWS}) INSERT INTO t(v) SELECT printf('%0200d', x) FROM c; CREATE INDEX t_v ON t(v);"
sqlite3 good/kuma.db "VACUUM INTO '$W/out/consistent.db'"
mv $W/out/consistent.db good/kuma.db
cp good/kuma.db vol/vol/kuma.db; cp good/kuma.db bad/kuma.db
PS=$(sqlite3 good/kuma.db "PRAGMA page_size")
R1=$(sqlite3 good/kuma.db "select rootpage from sqlite_master where name='t'"); R2=$(sqlite3 good/kuma.db "select rootpage from sqlite_master where name='t_v'")
for r in $R1 $R2; do head -c 64 /dev/zero | tr '\000' '\377' | dd of=bad/kuma.db bs=1 seek=$(( (r-1)*PS + 8 )) conv=notrunc 2>/dev/null; done
printf '{"rows":%s,"bytes":%s,"page_size":%s,"roots":[%s,%s]}' ${KUMA_ROWS} "$(stat -c %s good/kuma.db)" "$PS" "$R1" "$R2" > out/meta.json
tar --numeric-owner --owner=1000 --group=1000 -czf out/vol.tar.gz -C vol vol
tar --numeric-owner --owner=1000 --group=1000 -czf out/sqlite.tar.gz -C good kuma.db
tar --numeric-owner --owner=1000 --group=1000 -czf out/bad.tar.gz -C bad kuma.db
tar -cf - -C out vol.tar.gz sqlite.tar.gz bad.tar.gz meta.json >&3
`;
type KumaFx = {vol: Buffer; good: Buffer; bad: Buffer; meta: {rows: number; bytes: number; page_size: number; roots: number[]}};

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let priv = ""; let tmp = ""; let ROOT = ""; let base = ""; let org = ""; let adminId = "";
let server: http.Server; let serverPort = 0; let dashPort = 0;
let forwarder: net.Server | undefined; let kuma: KumaFx; let memberId = "";
const helperIds = new Set<string>();
const dashEnvOf = (): NodeJS.ProcessEnv => ({...process.env, NODE_ENV: "production", DATABASE_URL: t.url,
    PROJECT_URL: URL_FOR_AGENTS(), PROJECT_SECRET: DASH_SECRET, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
    AUTH_DEFAULT_USER_NAME: "W17 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
    FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300", FORK_RESTORE_TICK_SECONDS: "0", FORK_TEST_RESTORE_TICK_SECONDS: "0"});
const DASH_SECRET = `wtr-lab-${randomBytes(12).toString("hex")}`;
/** W17-live (L10): the dashboard start / stop are functions so a case can restart it on the same port, DB and keys */
async function startDashboard() {
    const before = out.length;
    child = spawn("pnpm", ["exec", "next", "start", "-p", String(dashPort), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: dashEnvOf()});
    child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
    await waitFor("dashboard ready", async () => out.slice(before).includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
}
async function stopDashboard() {
    const c = child; if (!c || c.exitCode !== null) return;
    const gone = new Promise<void>((res) => c.once("exit", () => res()));
    c.kill("SIGTERM");
    const killer = setTimeout(() => c.kill("SIGKILL"), 10_000);
    await gone; clearTimeout(killer);
}
const objects = new Map<string, {body: Buffer; slow?: boolean; hits: number; holdMs?: number}>();
const RUN: string[] = [];
let madeProxy = false;
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const URL_FOR_AGENTS = () => `http://forklab-dashboard.localhost:${new URL(base).port}`;
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-10).join("\n").slice(-2000)}\n--- clean agent ---\n${stripAnsi(logs(CLEAN)).split("\n").filter((l) => /[Ff]ork|rror|WARN/.test(l)).slice(-10).join(" | ").slice(-2500)}`);
        await sleep(1000);
    }
}
const chDeps = (): RestoreTaskDeps => ({db, principal: {userId: adminId, systemRole: "superadmin", memberships: [{organizationId: org, role: "admin"}]}, keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok",
    env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}), configAllowed: async () => true,
    artifactUrl: async (sid) => { const [a] = await q("select rp_id, source_name from fork_recovery_point_artifact where backup_storage_id=$1", [sid]); return `http://${GW}:${serverPort}/${a.rp_id}/${a.source_name}?${SECRET_QS}`; }});
const task = async (id: string) => (await q("select status, result, attempts from fork_agent_task where id=$1", [id]))[0];
const finished = (id: string, ms = 120_000) => waitFor(`task ${id} final`, async () => { const x = await task(id); return x && !["queued", "leased", "running"].includes(x.status) ? x : null; }, ms);
const volume = (name: string) => { try { return JSON.parse(docker(["volume", "inspect", name]))[0] as {Labels: Record<string, string>}; } catch { return null; } };
const listing = (vol: string) => docker(["run", "--rm", "-v", `${vol}:/vol:ro`, "busybox", "sh", "-c", "cd /vol && find . -type f | sort | xargs sha256sum"]);
// the agent runs as root: what it writes under ROOT is root-owned, so the host-side test looks through busybox
const rootSh = (script: string) => docker(["run", "--rm", "-v", `${ROOT}:${ROOT}`, "busybox", "sh", "-c", script]);
const rexists = (p: string) => { try { rootSh(`test -e '${p}'`); return true; } catch { return false; } };
const rread = (p: string) => rootSh(`cat '${p}'`);
const rmode = (p: string) => rootSh(`stat -c %a '${p}'`);
const stateFile = (vol: string, file: string) => { try { return docker(["run", "--rm", "-v", `${vol}:/s:ro`, "busybox", "cat", `/s/${file}`]); } catch { return ""; } };

const userWithPw = async (u: {email: string; password: string}, role: "member" | "admin") => {
    const id = await seedUser(t.pool, "user");
    await q(`update "user" set email=$2 where id=$1`, [id, u.email]);
    const {hashPassword} = await import("better-auth/crypto");
    await q(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), id, id, await hashPassword(u.password)]);
    await q(`insert into member (id, organization_id, user_id, role, created_at) values ($1,$2,$3,$4,now())`, [randomUUID(), org, id, role]);
    return id;
};

async function startAgent(name: string, stateVol: string, agentId: string, bundle: string, clean: boolean) {
    const edge = Buffer.from(JSON.stringify({serverUrl: URL_FOR_AGENTS(), agentId, masterKeyB64: MASTER.toString("base64")})).toString("base64url");
    const f = path.join(tmp, `${name}.bundle`);
    writeFileSync(f, bundle, {mode: 0o600}); chmodSync(f, 0o600);
    const args = ["run", "-d", "--name", name, "--network", NET, "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production",
        "-e", "FORK_CHANNEL_ENABLED=true", "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2", "-v", `${f}:/run/fork/bundle:ro`, "-v", `${stateVol}:/config`];
    if (clean) args.push("-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${ROOT}:${ROOT}`, "-e", `FORK_ALLOWED_PATH_ROOTS=${ROOT}`, "-e", `FORK_ARTIFACT_HTTP_HOSTS=${GW}`, "-e", "FORK_HOST_ROLE=test");
    docker([...args, IMAGE], {...process.env, EDGE_KEY: edge});
}

/** plant a signed task (the dashboard code signs; it is handed out like any queued task, the AGENT decides) — only used for forged / mis-targeted cases */
async function plant(agentId: string, bundleStr: string, type: string, payload: unknown, o: {target?: string | null; signWith?: {privateKey: string; kid: string}} = {}) {
    const [e] = await q("select enroll_id from fork_agent_enrollment where agent_id=$1", [agentId]);
    const [{seq}] = await q("update fork_agent_enrollment set next_seq=next_seq+1 where agent_id=$1 returning next_seq-1 as seq", [agentId]);
    const sk = o.signWith ?? {privateKey: (await fileKeyProvider.signing()).privateKeyPem, kid: kidOfPublicKey((await fileKeyProvider.signing()).publicKeyPem)};
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

describe.skipIf(!LAB)("W-TR live: scheduled data-only test restore on the fork agent image", () => {
    let world: W17; const planId = ""; const planHash = ""; let cleanBundle = ""; let vpsAgent = ""; let vpsBundle = ""; const volName = ""; const composeDest = "";
    const restoreId = randomUUID();
    let filesPlain = Buffer.alloc(0);

    const put = (rp: string, name: string, body: Buffer, slow = false, holdMs = 0) => { objects.set(`/${rp}/${name}`, {body, slow, hits: 0, holdMs}); };
    const manifestOf = () => ({json: world.manifestJson, sigB64: world.manifestSig});
    async function makePlan(w: W17, mapping: Record<string, unknown>) {
        const sel = ["dir:/srv/app", "volume:app_data", "db:db"];
        const c = await createRestorePlan({db, principal: {userId: adminId, systemRole: "superadmin", memberships: [{organizationId: org, role: "admin"}]}, configAllowed: async () => true},
            req(w, {mode: "new_stack", mappings: {target_project: null, restore_root: `${ROOT}/restore`, volumes: null, select: sel, sqlite: null, ...mapping}}));
        if (!c.ok) throw new Error(`plan refused: ${c.code}`);
        return c;
    }

    beforeAll(async () => {
        process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w17-test-${randomBytes(12).toString("hex")}`;
        tmp = mkdtempSync(path.join(os.tmpdir(), "wtr-lab-")); priv = path.join(tmp, "private");
        ROOT = path.join(tmp, "wtr-root"); mkdirSync(ROOT, {recursive: true});
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), MASTER, {mode: 0o600});
        for (const n of [CLEAN, VPS]) { try { docker(["rm", "-f", n]); } catch { /* none */ } }
        for (const v of [ST_CLEAN, ST_VPS, REF_VOL]) { try { docker(["volume", "rm", "-f", v]); } catch { /* none */ } }
        try { docker(["network", "create", "--subnet", SUBNET, NET]); } catch { /* exists */ }
        try { docker(["network", "create", "lab_proxy"]); madeProxy = true; } catch { /* exists: not ours */ }
        // artifact server on the bridge gateway
        serverPort = await freePort();
        server = http.createServer((rq, rs) => {
            const o = objects.get(new URL(rq.url!, "http://x").pathname);
            if (!o) { rs.writeHead(404).end(); return; }
            o.hits++;
            const send = () => {
                rs.writeHead(200, {"content-length": o.body.length});
                if (!o.slow) { rs.end(o.body); return; }
                let off = 0; const tick = () => { if (off >= o.body.length) { rs.end(); return; } rs.write(o.body.subarray(off, off + 65536)); off += 65536; setTimeout(tick, 40); }; tick();
            };
            if (o.holdMs) setTimeout(send, o.holdMs); else send(); // W17-live: hold the response (L10/L11 need a stage that is visibly in flight)
        }).listen(serverPort, GW);
        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        dashPort = await freePort(); base = `http://${GW}:${dashPort}`;
        if (HOLD) {
            // one origin for the browser and the agent: dashboard on the gateway, a 127.0.0.1 forwarder on the same port (Chrome resolves *.localhost to 127.0.0.1)
            for (let i = 0; i < 20 && !forwarder; i++) {
                const pt = await freePort(GW);
                const fw = net.createServer((c) => { const u = net.connect(pt, GW); c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); });
                await new Promise<void>((res) => { fw.once("error", () => res()); fw.listen(pt, "127.0.0.1", () => { forwarder = fw; dashPort = pt; res(); }); });
            }
            if (!forwarder) throw new Error("no free port for the forwarder");
            base = `http://${GW}:${dashPort}`;
        }
        await startDashboard();
        process.env.PRIVATE_PATH = priv;
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;

        // data: a small files archive (compose dir) + the two stock-agent fixtures (TEST-ONLY key); the dashboard's manifest is signed with its REAL key
        const src = path.join(tmp, "src"); mkdirSync(src, {recursive: true});
        const demo = path.join(process.cwd(), "dev/fork-lab/demo-stack");
        for (const f of ["compose.yml", "stack.env", "web", "uploads"]) execFileSync("cp", ["-r", path.join(demo, f), src]);
        writeFileSync(path.join(src, "compose.yml"), readFileSync(path.join(src, "compose.yml"), "utf8").replace('    ports: ["127.0.0.1:18080:8080"]\n', "").replaceAll("appdata", "data")); // the seeded plan restores the volume as `app_data` ⇒ the compose volume key is `data`
        mkdirSync(path.join(src, "uploads"), {recursive: true}); writeFileSync(path.join(src, "uploads/hello.txt"), "hello from the backup\n");
        const tgz = path.join(tmp, "files.tar.gz"); execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
        filesPlain = readFileSync(tgz);
        // sqlite fixtures (ONE no-network container of the agent image, which ships sqlite3): consistent good db, volume tar (pilot shape), page-damaged copy
        const fxOut = execFileSync("docker", ["run", "--rm", "-i", "--network", "none", "--entrypoint", "sh", IMAGE, "-s"], {input: KUMA_SCRIPT, maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"]});
        const fxDir = mkdtempSync(path.join(tmp, "kuma-")); execFileSync("tar", ["-xf", "-", "-C", fxDir], {input: fxOut});
        kuma = {vol: readFileSync(path.join(fxDir, "vol.tar.gz")), good: readFileSync(path.join(fxDir, "sqlite.tar.gz")), bad: readFileSync(path.join(fxDir, "bad.tar.gz")), meta: JSON.parse(readFileSync(path.join(fxDir, "meta.json"), "utf8"))};
        const badDir = mkdtempSync(path.join(tmp, "bad-")); execFileSync("tar", ["-xzf", "-", "-C", badDir], {input: kuma.bad});
        const magic = readFileSync(path.join(badDir, "kuma.db")).subarray(0, 16).toString("latin1");
        RUN.push(`RUN T4-fixture ${magic === "SQLite format 3\0" ? "PASS" : "FAIL"} magic intact; ${JSON.stringify(kuma.meta)} tgz good=${kuma.good.length} bad=${kuma.bad.length} vol=${kuma.vol.length}`);
        expect(magic).toBe("SQLite format 3\0");
        const key = {privateKey: "", publicKey: "", kid: ""};
        const sk = await fileKeyProvider.signing(); key.privateKey = sk.privateKeyPem; key.publicKey = sk.publicKeyPem; key.kid = kidOfPublicKey(sk.publicKeyPem);
        const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
        const w = await seedW17World(t, "", key as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "test", roots: [ROOT], caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1", "test-restore.v1"],
            plain: {compose_app: {sha: sha256(filesPlain), size: filesPlain.length}, volume_app_data: {sha: fx("lab-volume").plaintext_sha256, size: fx("lab-volume").plaintext_size}, db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"},
                volume_app_kumadata: {sha: sha256(kuma.vol), size: kuma.vol.length}, db_kuma: {sha: sha256(kuma.good), size: kuma.good.length}}, extra: KUMA_EXTRA,
            enrolDeps: {serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok", keys: fileKeyProvider, env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}),
                principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
        world = w; cleanBundle = w.agentBundle;
        put(w.rp, "compose_app", encryptAgentArchive(MASTER, filesPlain)); put(w.rp, "volume_app_data", fxFile("lab-volume")); put(w.rp, "db_db", fxFile("lab-postgres"));
        put(w.rp, "volume_app_kumadata", encryptAgentArchive(MASTER, kuma.vol)); put(w.rp, "db_kuma", encryptAgentArchive(MASTER, kuma.good));
        memberId = await userWithPw(MEMBER, "member"); await userWithPw(ORGADMIN, "admin");
        if (HOLD) await q(`update member set role='owner' where user_id=$1 and organization_id=$2`, [adminId, org]);
        await startAgent(CLEAN, ST_CLEAN, w.agent, cleanBundle, true);
        vpsAgent = await seedAgent(t.pool, org, "wtr-prod");
        const r = await enrolAgent({...chDeps(), principal: {userId: adminId, systemRole: "superadmin", memberships: []}}, {agentId: vpsAgent, password: PASSWORD});
        if (!r.ok) throw new Error(`enrol vps: ${r.code}`);
        vpsBundle = r.bundle; await startAgent(VPS, ST_VPS, vpsAgent, vpsBundle, false);
        await waitFor("test agent reported test-restore.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [w.agent]))[0]?.capabilities.includes("test-restore.v1"), 120_000);
        await waitFor("vps agent reported channel.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [vpsAgent]))[0]?.capabilities.includes("channel.v1"), 120_000);
    }, 600_000);

    afterAll(async () => {
        const evidence = process.env.WTR_EVIDENCE_DIR;
        const all = stripAnsi(logs(CLEAN)) + stripAnsi(logs(VPS)) + out;
        const clean = ![CANARY3, SECRET_QS.split("=")[1], MASTER.toString("base64"), decodeBundle(cleanBundle || "e30").task_key_b64 ?? "~~", decodeBundle(cleanBundle || "e30").credential ?? "~~"].some((s) => s && s !== "~~" && all.includes(s));
        if (evidence && clean) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(path.join(evidence, "wtr-agent-test.log"), stripAnsi(logs(CLEAN))); writeFileSync(path.join(evidence, "wtr-agent-prod.log"), stripAnsi(logs(VPS)));
            writeFileSync(path.join(evidence, "dashboard-fork-wtr.log"), out.split("\n").filter((l) => /[Ff]ork|agent-channel/.test(l) && !/Received POST/.test(l)).join("\n"));
            writeFileSync(path.join(evidence, "run.out"), RUN.join("\n") + "\n");
        } else if (evidence) writeFileSync(path.join(tmp, "NOT-WRITTEN"), "canary found a secret in a log: evidence withheld");
        for (const n of [CLEAN, VPS]) { try { docker(["rm", "-f", n]); } catch { /* gone */ } }
        // SCOPED (W18b-f1 DD-F1-7): only helper containers this lab saw (sampler ids) or whose command path is under this lab's ROOT; only volumes labelled with THIS lab's agents
        const mine = new Set(helperIds);
        try {
            for (const id of docker(["ps", "-aq", "--filter", "label=com.portabase.fork.helper=true"]).split("\n").filter(Boolean)) {
                try { if (ROOT && JSON.stringify(JSON.parse(docker(["inspect", id]))[0].Config.Cmd ?? []).includes(ROOT)) mine.add(id); } catch { /* gone */ }
            }
        } catch { /* none */ }
        for (const id of mine) { try { docker(["rm", "-f", id]); } catch { /* gone */ } }
        for (const a of [world?.agent, vpsAgent].filter(Boolean)) {
            try { for (const v of docker(["volume", "ls", "-q", "--filter", `label=com.portabase.fork.agent_id=${a}`]).split("\n").filter(Boolean)) docker(["volume", "rm", "-f", v]); } catch { /* none */ }
        }
        for (const v of [ST_CLEAN, ST_VPS, REF_VOL, "w17lab_foreign", "w17lab_otherrun"]) { try { docker(["volume", "rm", "-f", v]); } catch { /* gone */ } }
        try { docker(["network", "rm", NET]); } catch { /* gone */ }
        if (madeProxy) { try { docker(["network", "rm", "lab_proxy"]); } catch { /* gone */ } }
        forwarder?.close(); server?.close(); child?.kill("SIGTERM"); await sleep(500); if (child?.exitCode === null) child?.kill("SIGKILL");
        await t?.drop();
        try { rootSh("rm -rf " + ROOT + "/*"); } catch { /* none */ }
        rmSync(tmp, {recursive: true, force: true});
    });

    // ---- W-TR helpers -----------------------------------------------------------------------------------------------------------------------
    const superP = () => ({userId: adminId, systemRole: "superadmin" as const, memberships: [{organizationId: org, role: "admin"}]});
    let curManifest = {json: "", sigB64: ""};
    const td = (over: Partial<TestRestoreDeps> = {}): TestRestoreDeps => ({
        db, principal: superP(), keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, configAllowed: async () => true, stepUp: async () => "ok",
        env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}),
        artifactUrl: chDeps().artifactUrl, manifest: async () => curManifest, ...over,
    });
    const taskCount = async () => Number((await q("select count(*)::int n from fork_agent_task"))[0].n);
    const log = (id: string, ok: boolean, what: string) => { RUN.push(`RUN ${id} ${ok ? "PASS" : "FAIL"} ${what}`); };
    const check = (id: string, cond: boolean, what: string) => { log(id, cond, what); expect(cond, `${id}: ${what}`).toBe(true); };
    const workspace = () => `${ROOT}/restore/${(world as unknown as {project?: string}).project ?? "app"}-test-restore`;
    const helpers = () => docker(["ps", "-aq", "--filter", "label=com.portabase.fork.helper=true"]).trim();
    /** re-sign the manifest over the CURRENT artifact rows (the stored objects are what the test put on the server) */
    async function resign(): Promise<void> {
        const rp = (await q("select * from fork_recovery_point where id=$1", [world.rp]))[0];
        const arts = await q("select * from fork_recovery_point_artifact where rp_id=$1 order by source_name", [world.rp]);
        const facts = arts.map((a) => ({sourceName: a.source_name, engine: a.engine, archiveKind: a.archive_kind, dumpFormat: a.dump_format, archiveFormatVersion: a.archive_format_version, encrypted: a.encrypted, channelId: a.channel_id, channelKind: a.channel_kind,
            pathOrSnapshotId: a.path_or_snapshot_id, generatedId: a.generated_id, sizeBytes: a.size_bytes === null ? null : Number(a.size_bytes), ciphertextSha256: a.ciphertext_sha256, plaintextSha256: a.plaintext_sha256, plaintextSize: a.plaintext_size === null ? null : Number(a.plaintext_size), required: a.required}));
        const sk = await fileKeyProvider.signing();
        const m = buildManifest({id: world.rp, stackId: world.stack, stackName: "app", sequence: Number(rp.sequence), createdAt: rp.created_at, finalizedAt: rp.created_at, consistencyLevel: "mixed", inventoryVersion: 1, inventoryHash: rp.inventory_hash, requiredArtifactCount: arts.filter((a) => a.required).length}, facts, null,
            {kid: kidOfPublicKey(sk.publicKeyPem), signedAt: new Date(), verifiedAt: new Date()});
        const s = signManifest(m, sk.privateKeyPem);
        curManifest = {json: s.json, sigB64: s.sig.toString("base64")};
        await q("update fork_recovery_point set manifest_sha256=$2 where id=$1", [world.rp, createHash("sha256").update(s.json).digest("hex")]);
    }
    /** serve `pg` (plaintext tar.gz of the pg artifact) and tell the DB its signed hash/size */
    async function servePgPlain(plain: Buffer, ciphertext?: Buffer) {
        put(world.rp, "db_db", ciphertext ?? encryptAgentArchive(MASTER, plain));
        await q("update fork_recovery_point_artifact set plaintext_sha256=$3, plaintext_size=$4 where rp_id=$1 and source_name=$2", [world.rp, "db_db", sha256(plain), plain.length]);
        await resign();
    }
    /** same as servePgPlain for the sqlite artifact (`db_kuma`, manifest role Sqlite: engine sqlite, no dump_format) */
    async function serveSqlitePlain(plain: Buffer) {
        put(world.rp, "db_kuma", encryptAgentArchive(MASTER, plain));
        await q("update fork_recovery_point_artifact set plaintext_sha256=$3, plaintext_size=$4 where rp_id=$1 and source_name=$2", [world.rp, "db_kuma", sha256(plain), plain.length]);
        await resign();
    }
    const pgFixturePlain = () => decryptAgentArchive(MASTER, fxFile("lab-postgres"));
    /** a `-Fc` dump cut in half, re-tarred: valid checksums (the manifest is re-signed over it), invalid engine data */
    function truncatedPg(): Buffer {
        const dir = mkdtempSync(path.join(tmp, "pg-"));
        execFileSync("tar", ["-xzf", "-", "-C", dir], {input: pgFixturePlain()});
        const file = execFileSync("sh", ["-c", `find ${dir} -type f | head -1`], {encoding: "utf8"}).trim();
        execFileSync("truncate", ["-s", String(Math.floor(readFileSync(file).length / 2)), file]);
        const tgz = path.join(dir, "..", `trunc-${randomUUID()}.tar.gz`);
        execFileSync("tar", ["-czf", tgz, "-C", dir, "."]);
        return readFileSync(tgz);
    }
    const goodAll = async () => { await servePgPlain(pgFixturePlain()); await serveSqlitePlain(kuma.good); };
    /** T2: docker EVENT stream (not polling): every helper container is inspected the moment it is created, and `docker wait` measures how long it lived */
    type Sample = {id: string; kind: "sqlite" | "pg"; net: string; disabled: unknown; capDrop: string[]; secOpt: string[]; ro: unknown; mounts: string[]; lifetimeMs: number | null};
    function startHelperSampler() {
        const samples: Sample[] = [];
        const ev = spawn("docker", ["events", "--filter", "type=container", "--filter", "event=create", "--filter", "label=com.portabase.fork.helper=true", "--format", "{{.Actor.ID}}"], {stdio: ["ignore", "pipe", "ignore"]});
        let buf = "";
        ev.stdout!.on("data", (d) => {
            buf += d;
            for (;;) {
                const nl = buf.indexOf("\n"); if (nl < 0) break;
                const id = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
                if (!id) continue;
                helperIds.add(id);
                try {
                    const i = JSON.parse(docker(["inspect", id]))[0];
                    const argv = [...(i.Config.Entrypoint ?? []), ...(i.Config.Cmd ?? [])] as string[];
                    const kind = argv[0] === "/usr/bin/sqlite3" ? "sqlite" : /\/pg_restore$/.test(argv[0] ?? "") ? "pg" : null;
                    if (!kind) continue;
                    const smp: Sample = {id, kind, net: i.HostConfig.NetworkMode, disabled: i.Config.NetworkDisabled, capDrop: i.HostConfig.CapDrop ?? [], secOpt: i.HostConfig.SecurityOpt ?? [], ro: i.HostConfig.ReadonlyRootfs,
                        mounts: (i.Mounts ?? []).map((m: {Destination: string}) => m.Destination), lifetimeMs: null};
                    samples.push(smp);
                    const t0 = Date.now();
                    const w = spawn("docker", ["wait", id], {stdio: "ignore"}); w.once("exit", () => { smp.lifetimeMs = Date.now() - t0; });
                } catch { /* a container that vanished before the inspect is not a sample */ }
            }
        });
        return {samples, stop: () => { ev.kill("SIGTERM"); }};
    }
    async function driveTest(runId: string, o: {ms?: number; each?: () => Promise<void>} = {}) {
        const end = Date.now() + (o.ms ?? 420_000);
        for (;;) {
            const r = await q("select * from fork_restore_run where id=$1", [runId]);
            if (["running", "awaiting_approval"].includes(r[0].state)) await tickRestoreRun(td(), runId); else await advanceTestRestoreWipes(td());
            const x = (await q("select * from fork_restore_run where id=$1", [runId]))[0];
            if (o.each) await o.each();
            if (!["running", "awaiting_approval"].includes(x.state) && ["verified", "not_needed", "failed"].includes(x.wipe_state)) return x;
            if (Date.now() > end) throw new Error(`test run ${runId} not settled: ${x.state}/${x.wipe_state} ${JSON.stringify(x.steps)}\n${stripAnsi(logs(CLEAN)).split("\n").filter((l) => /[Ff]ork|rror|WARN/.test(l)).slice(-12).join("\n")}`);
            await sleep(500);
        }
    }
    const manual = async () => { const r = await runTestRestoreNow(td(), {stackId: world.stack}); if (!r.ok) throw new Error(`run-now refused: ${r.code}`); return r.runId; };
    const facetDays = async () => (await loadProtectionByStackId(db, world.stack, {configLocked: false}))?.facets.testRestore;

    it("T0 preflight: the agent image has the checkers, the test host reports test-restore.v1, the production agent does not get a schedule", async () => {
        const caps = (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [world.agent]))[0].capabilities as string[];
        check("T0", caps.includes("test-restore.v1") && caps.includes("restore.target.v1"), `caps ${caps.join(",")}`);
        const tools = docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c", "test -x /usr/bin/sqlite3 && ls /usr/lib/postgresql/*/bin/pg_restore | sort -V | tr '\\n' ' '"]);
        check("T0", /pg_restore/.test(tools), `bundled pg_restore: ${tools.trim()}`);
        await q("update fork_stack set contains_personal_data=false where id=$1", [world.stack]);
    });

    it("T1+T2 scheduled demo test restore: scheduler starts it (trigger=schedule), data_verified, integrity checked, helper had NO network, wipe verified on the host, facet 0 d, duration shown", async () => {
        const now = new Date();
        const sched = {preset: "hourly", timezone: "UTC", minute: (now.getUTCMinutes() + 59) % 60, hour: 0, weekday: 0, monthday: 1};
        const set = await setTestRestoreSchedule(td(), {stackId: world.stack, enabled: true, schedule: sched, targetAgentId: world.agent, restoreRoot: `${ROOT}/restore`, staleAfterDays: 14});
        check("T1", set.ok, "schedule configured (target is a host_role=test host)");
        await q("update fork_test_restore_schedule set enabled_at=$2 where stack_id=$1", [world.stack, new Date(now.getTime() - 2 * 3_600_000)]);
        await goodAll();
        const sampler = startHelperSampler(); await sleep(1500); // the event stream must be subscribed BEFORE the run starts
        const tick = await testRestoreSchedulerTick(td());
        check("T1", tick.started === 1, `scheduler tick started=${tick.started}`);
        const [row] = await q("select id, trigger, scheduled_for from fork_restore_run where stack_id=$1", [world.stack]);
        check("T1", row.trigger === "schedule" && row.scheduled_for !== null, `trigger=${row.trigger} scheduled_for set`);
        const r = await driveTest(row.id);
        await sleep(1500); sampler.stop();
        check("T1", r.state === "succeeded" && r.verification === "data_verified", `state=${r.state} verification=${r.verification}`);
        check("T1", r.integrity?.checked === 2 && r.integrity?.failed === 0 && r.integrity?.not_supported === 0, `integrity=${JSON.stringify(r.integrity)} (pg + sqlite)`);
        const vt = (await q("select status, result from fork_agent_task where type='restore_verify' and agent_id=$1 order by created_at desc limit 1", [world.agent]))[0];
        const checks = (vt?.result?.checks ?? []) as {engine: string; status: string; files?: number}[];
        check("T1", vt?.status === "succeeded" && checks.some((c) => c.engine === "postgresql" && c.status === "ok") && checks.some((c) => c.engine === "sqlite" && c.status === "ok" && c.files === 1), `restore_verify result ${JSON.stringify(vt?.result)}`);
        check("T1", r.wipe_state === "verified", `wipe_state=${r.wipe_state}`);
        check("T1", !rexists(workspace()), `scratch workspace gone on the host (${path.basename(workspace())})`);
        check("T1", helpers() === "", "no helper container left behind");
        const f = await facetDays();
        check("T1", f?.daysAgo === 0 && f.stale === false, `facet ${JSON.stringify(f)}`);
        const v = await getTestRestoreView(td(), {stackId: world.stack});
        check("T1", v.ok && (v.view.last?.durationSeconds ?? 0) > 0, `durationSeconds=${v.ok ? v.view.last?.durationSeconds : "-"}`);
        // T2: NO skip branch — zero samples is a failure of the sampler, never a pass
        const smp = sampler.samples;
        const sqliteN = smp.filter((x) => x.kind === "sqlite").length, pgN = smp.filter((x) => x.kind === "pg").length;
        check("T2", sqliteN >= 1 && pgN >= 1, `sampled ${smp.length} verify helper(s) from the docker event stream: sqlite=${sqliteN} pg=${pgN}`);
        const hardened = (x: Sample) => x.net === "none" && x.disabled === true && x.capDrop.includes("ALL") && x.secOpt.some((o) => /^no-new-privileges(:true)?$/.test(o)) && x.ro === true && x.mounts.length === 1 && x.mounts[0] === "/v";
        check("T2", smp.every(hardened), smp.map((x) => `${x.kind} ${x.net}|${x.disabled}|${x.capDrop.join(",")}|ro=${x.ro}|mounts=${x.mounts.length}(${x.mounts.join(",")})|sec=${x.secOpt.join(",")}`).join(" ;; "));
        log("T2", true, `helper lifetimes (create→exit): ${smp.map((x) => `${x.kind}=${x.lifetimeMs === null ? "unmeasured" : `${x.lifetimeMs}ms`}`).join(" ")}`);
    }, 900_000);

    it("T3 engine corruption with VALID checksums: a truncated pg dump passes stage but fails integrity; facet keeps T1's value; wipe verified; one failed notification", async () => {
        await servePgPlain(truncatedPg());
        const before = await facetDays();
        const id = await manual();
        const r = await driveTest(id);
        check("T3", r.state === "failed" && r.reason === "integrity_failed" && r.failed_step === "integrity", `state=${r.state} reason=${r.reason} step=${r.failed_step}`);
        check("T3", r.wipe_state === "verified" && !rexists(workspace()), `wipe_state=${r.wipe_state}, scratch gone`);
        check("T3", JSON.stringify(await facetDays()) === JSON.stringify(before), `facet unchanged ${JSON.stringify(before)}`);
        check("T3", (await q("select 1 from fork_notification_outbox where kind='test_restore.failed' and dedupe_key=$1", [`test_restore:${id}:failed`])).length === 1, "test_restore.failed notification row");
    }, 900_000);

    it("T4 sqlite page corruption with VALID signed checksums: the artifact stages fine, the sqlite integrity check fails with detail `sqlite` (NOT no_sqlite_file); wipe verified; facet unchanged; one failed notification", async () => {
        await servePgPlain(pgFixturePlain());
        await serveSqlitePlain(kuma.bad);
        const before = await facetDays();
        const id = await manual();
        const r = await driveTest(id);
        check("T4", r.state === "failed" && r.reason === "integrity_failed" && r.failed_step === "integrity", `state=${r.state} reason=${r.reason} step=${r.failed_step}`);
        const vt = (await q("select status, result from fork_agent_task where type='restore_verify' and agent_id=$1 order by created_at desc limit 1", [world.agent]))[0];
        const res = JSON.stringify(vt?.result ?? null);
        const idx = (JSON.parse(curManifest.json).artifacts as {source_name: string}[]).findIndex((a) => a.source_name === "db_kuma");
        check("T4", vt?.status === "failed" && res.includes("integrity_failed") && res.includes('"detail":"sqlite"') && res.includes(`"artifact":${idx}`) && !res.includes("no_sqlite_file"), `restore_verify task result ${res} (db_kuma manifest index ${idx})`);
        check("T4", r.wipe_state === "verified" && !rexists(workspace()), `wipe_state=${r.wipe_state}, scratch gone`);
        check("T4", JSON.stringify(await facetDays()) === JSON.stringify(before), `facet unchanged ${JSON.stringify(before)}`);
        check("T4", (await q("select 1 from fork_notification_outbox where kind='test_restore.failed' and dedupe_key=$1", [`test_restore:${id}:failed`])).length === 1, "test_restore.failed notification row");
        await serveSqlitePlain(kuma.good);
    }, 900_000);

    it("T5 tampered ciphertext (one byte flipped, manifest unchanged) and T5b truncated .enc ⇒ failed at stage, wipe verified", async () => {
        const good = encryptAgentArchive(MASTER, pgFixturePlain());
        await servePgPlain(pgFixturePlain());
        const flipped = Buffer.from(good); flipped[Math.floor(flipped.length / 2)] ^= 0xff;
        put(world.rp, "db_db", flipped);
        const a = await driveTest(await manual());
        check("T5", a.state === "failed" && a.failed_step === "stage" && ["checksum_mismatch", "archive_invalid"].includes(a.reason), `state=${a.state} step=${a.failed_step} reason=${a.reason}`);
        check("T5", a.wipe_state === "verified" && !rexists(workspace()), `wipe_state=${a.wipe_state}, scratch gone`);
        put(world.rp, "db_db", good.subarray(0, Math.floor(good.length / 2)));
        const b = await driveTest(await manual());
        check("T5b", b.state === "failed" && b.failed_step === "stage", `state=${b.state} step=${b.failed_step} reason=${b.reason}`);
        check("T5b", b.wipe_state === "verified" && !rexists(workspace()), `wipe_state=${b.wipe_state}, scratch gone`);
        put(world.rp, "db_db", good);
    }, 900_000);

    it("T6 personal data: undeclared (NULL) ⇒ skipped with 0 plans and 0 tasks; after the explicit opt-in a run succeeds", async () => {
        await servePgPlain(pgFixturePlain());
        await q("update fork_stack set contains_personal_data=NULL, test_restore_opt_in_at=NULL, test_restore_opt_in_by=NULL where id=$1", [world.stack]);
        const plans = Number((await q("select count(*)::int n from fork_restore_plan where stack_id=$1", [world.stack]))[0].n);
        const tasks = await taskCount();
        await q("update fork_test_restore_schedule set last_scheduled_at=$2 where stack_id=$1", [world.stack, new Date(Date.now() - 3 * 3_600_000)]);
        const tick = await testRestoreSchedulerTick(td());
        check("T6", tick.skipped === 1 && tick.started === 0, `tick ${JSON.stringify(tick)}`);
        check("T6", Number((await q("select count(*)::int n from fork_restore_plan where stack_id=$1", [world.stack]))[0].n) === plans && (await taskCount()) === tasks, "0 plans, 0 tasks created");
        check("T6", (await q("select last_reason from fork_test_restore_schedule where stack_id=$1", [world.stack]))[0].last_reason === "personal_data_no_opt_in", "reason personal_data_no_opt_in");
        const s = await setStackPrivacy({db, principal: superP(), configAllowed: async () => true}, {stackId: world.stack, containsPersonalData: true, testRestoreOptIn: true});
        check("T6", s.ok, "explicit opt-in recorded by a system admin");
        const r = await driveTest(await manual());
        check("T6", r.state === "succeeded" && r.wipe_state === "verified", `after opt-in: state=${r.state} wipe=${r.wipe_state}`);
    }, 900_000);

    it("T7 production host refused: configure ⇒ target_not_test; an environment flipped to production after enabling ⇒ the next slot is skipped test_restore_target_not_test", async () => {
        const refused = await setTestRestoreSchedule(td(), {stackId: world.stack, enabled: true, schedule: DEFAULT_TR_SCHEDULE, targetAgentId: vpsAgent, restoreRoot: `${ROOT}/restore`, staleAfterDays: 14});
        check("T7", !refused.ok && refused.code === "target_not_test", `configure on the production agent ⇒ ${refused.ok ? "ok" : refused.code}`);
        await q("update fork_arcane_environment set host_role='production' where agent_id=$1", [world.agent]);
        await q("update fork_test_restore_schedule set last_scheduled_at=$2, paused_at=NULL where stack_id=$1", [world.stack, new Date(Date.now() - 3 * 3_600_000)]);
        const runs = Number((await q("select count(*)::int n from fork_restore_run where stack_id=$1", [world.stack]))[0].n);
        await testRestoreSchedulerTick(td());
        check("T7", (await q("select last_reason from fork_test_restore_schedule where stack_id=$1", [world.stack]))[0].last_reason === "test_restore_target_not_test", "planner refused at fire time");
        check("T7", Number((await q("select count(*)::int n from fork_restore_run where stack_id=$1", [world.stack]))[0].n) === runs, "no run started");
        await q("update fork_arcane_environment set host_role='test' where agent_id=$1", [world.agent]);
    }, 300_000);

    it("T8 decay: the verified run is aged to 15 days ⇒ facet stale and exactly one stack.test_restore_stale notification", async () => {
        await q("update fork_restore_run set finished_at = now() - interval '15 days', created_at = now() - interval '15 days' where stack_id=$1 and purpose='test_restore' and state='succeeded'", [world.stack]);
        const f = await facetDays();
        check("T8", f?.stale === true && (f.daysAgo ?? 0) >= 15, `facet ${JSON.stringify(f)}`);
        await q("insert into fork_stack_policy (stack_id, activated_at, activated_by, selection, updated_at) values ($1, now() - interval '30 days', $2, '{}'::jsonb, now()) on conflict (stack_id) do update set activated_at = excluded.activated_at, deactivated_at = null", [world.stack, adminId]).catch(() => undefined);
        const d = {db, configLocked: false, minHours: 0};
        await evaluateAlerts(d); await evaluateAlerts(d);
        const rows = await q("select dedupe_key from fork_notification_outbox where kind='stack.test_restore_stale' and dedupe_key like $1", [`%${world.stack}%`]);
        check("T8", rows.length === 1, `stack.test_restore_stale rows=${rows.length}`);
    }, 300_000);

    it("T9 canary: no secret, no restore folder and no scratch path in the dashboard log, notifications (+ rendered bodies), audit, run rows, task results or the member view; the admin view carries the restore folder exactly once", async () => {
        const cb = decodeBundle(cleanBundle);
        const dbPw = new URL(t.url).password;
        const named: [string, string][] = [["ROOT", ROOT], ["workspace", workspace()], ["presigned-signature", SECRET_QS.split("=")[1]], ["master-key-b64", MASTER.toString("base64")], ["dashboard-secret", DASH_SECRET],
            ["db-password", dbPw], ["task-key", cb.task_key_b64 ?? ""], ["agent-credential", cb.credential ?? ""]];
        const needles = named.filter(([, v]) => v.length >= 8);
        log("T9", true, `needles: ${needles.map(([n]) => n).join(",")} (dropped as too short/empty: ${named.filter(([, v]) => v.length < 8).map(([n]) => n).join(",") || "none"})`);
        const outbox = await q("select kind, payload from fork_notification_outbox");
        const rendered = outbox.map((o) => JSON.stringify(renderNotification({kind: o.kind, payload: o.payload, stackName: "app", baseUrl: URL_FOR_AGENTS()})));
        const mv = await getTestRestoreView(td({principal: {userId: memberId, systemRole: null, memberships: [{organizationId: org, role: "member"}]}}), {stackId: world.stack});
        const av = await getTestRestoreView(td(), {stackId: world.stack});
        if (!mv.ok || !av.ok) throw new Error("view refused");
        const adminJson = JSON.stringify(av.view);
        const adminNoRoot = JSON.stringify({...av.view, admin: av.view.admin ? {...av.view.admin, restoreRoot: null} : null});
        const hay: [string, string][] = [
            ["dashboard log", out],
            ["outbox payloads", JSON.stringify(outbox.map((o) => o.payload))], ["outbox rendered bodies", rendered.join("\n")],
            ["audit events", JSON.stringify(await q("select action, redacted_details from fork_audit_event"))],
            ["restore runs", JSON.stringify(await q("select reason, steps, integrity, wipe_reason from fork_restore_run"))],
            ["agent task results", JSON.stringify(await q("select result from fork_agent_task where type in ('restore_verify','restore_cleanup','restore_probe')"))],
            ["member view", JSON.stringify(mv.view)], ["admin view without admin.restoreRoot", adminNoRoot],
        ];
        for (const [h, text] of hay) {
            const hit = needles.findIndex(([, v]) => text.includes(v));
            check("T9", hit < 0, hit < 0 ? `${h}: 0 hits (${text.length} bytes, ${needles.length} needles)` : `${h}: HIT needle ${needles[hit][0]}`);
        }
        const roots = adminJson.split(`${ROOT}/restore`).length - 1;
        check("T9", roots === 1 && !adminJson.includes(workspace()), `admin view carries the restore folder exactly ${roots}× (admin.restoreRoot, OD-WTRF-2) and never the scratch path`);
        check("T9", mv.view.admin === null && !JSON.stringify(mv.view).includes(world.agent), "member view: admin projection null, no agent id");
    }, 300_000);

    it("T10 cleanup: no wtr containers other than the two agents, no helper containers, no owner-labelled leftovers", async () => {
        check("T10", helpers() === "", "no helper containers");
        check("T10", docker(["ps", "-aq", "--filter", "label=com.portabase.fork.restore_id"]).trim() === "", "no restore-labelled containers");
        check("T10", docker(["volume", "ls", "-q", "--filter", "label=com.portabase.fork.restore_id"]).trim() === "", "no restore-labelled volumes");
    });

    /** HOLD (browser run, W-TR-f S9): keeps everything up. A run started from the browser goes through the REAL server action → service → startRestoreRun; only its step execution uses the lab seams (manifest bytes, artifact URLs), driven here every 2 s. Never runs the scheduler tick (deterministic). */
    it.skipIf(!HOLD)("HOLD", async () => {
        expect(SCRATCH).not.toBe("");
        mkdirSync(SCRATCH, {recursive: true});
        const cmdF = path.join(SCRATCH, "wtr-lab.cmd"), logF = path.join(SCRATCH, "wtr-lab.log"), stopF = path.join(SCRATCH, "wtr-lab.stop");
        for (const f of [cmdF, stopF]) { try { unlinkSync(f); } catch { /* none */ } }
        await goodAll();
        writeFileSync(path.join(SCRATCH, "wtr-lab.json"), JSON.stringify({base: URL_FOR_AGENTS(), admin: ADMIN.email, adminPassword: ADMIN.password, member: MEMBER, orgAdmin: ORGADMIN, stackId: world.stack, root: ROOT, agentName: world.agentName,
            cmd: cmdF, log: logF, stop: stopF, commands: ["serve-good", "serve-bad-sqlite", "serve-bad-pg", "pause-agent", "resume-agent", "fail-wipe", "privacy-null", "privacy-no", "age <days>"]}, null, 1), {mode: 0o600});
        const say = (cmd: string, ok: boolean, d = "") => writeFileSync(logF, `${new Date().toISOString()} ${cmd} ${ok ? "ok" : "error"} ${d}\n`, {flag: "a"});
        const exec = async (line: string) => {
            const [cmd, a] = line.trim().split(/\s+/);
            if (cmd === "serve-good") await goodAll();
            else if (cmd === "serve-bad-sqlite") { await servePgPlain(pgFixturePlain()); await serveSqlitePlain(kuma.bad); }
            else if (cmd === "serve-bad-pg") { await servePgPlain(truncatedPg()); await serveSqlitePlain(kuma.good); }
            else if (cmd === "pause-agent") docker(["pause", CLEAN]);
            else if (cmd === "resume-agent") docker(["unpause", CLEAN]);
            else if (cmd === "fail-wipe") { // lab-only: pretends the latest wipe failed so the browser can show the failed-wipe state and the real "Wipe now" action
                const n = (await q("update fork_restore_run set wipe_state='failed', wipe_reason='wipe_unverified' where id=(select id from fork_restore_run where purpose='test_restore' and wipe_state='verified' order by created_at desc limit 1) returning id")).length;
                if (n !== 1) throw new Error("no verified test run to fail");
            } else if (cmd === "privacy-null") await q("update fork_stack set contains_personal_data=NULL, test_restore_opt_in_at=NULL, test_restore_opt_in_by=NULL where id=$1", [world.stack]);
            else if (cmd === "privacy-no") await q("update fork_stack set contains_personal_data=false where id=$1", [world.stack]);
            else if (cmd === "age") { const n = Number(a); if (!Number.isInteger(n) || n < 0 || n > 365) throw new Error("usage: age <0..365>"); await q("update fork_restore_run set created_at = created_at - make_interval(days => $1), finished_at = finished_at - make_interval(days => $1) where purpose='test_restore' and state='succeeded'", [n]); }
            else throw new Error("unknown command");
        };
        try {
            while (!existsSync(stopF)) {
                for (const r of await q("select id from fork_restore_run where purpose='test_restore' and state in ('running','awaiting_approval')")) { try { await tickRestoreRun(td(), r.id); } catch (e) { say(`tick ${r.id}`, false, String((e as Error).message).slice(0, 200)); } }
                try { await advanceTestRestoreWipes(td()); } catch (e) { say("wipes", false, String((e as Error).message).slice(0, 200)); }
                if (existsSync(cmdF)) {
                    const lines = readFileSync(cmdF, "utf8").split("\n").filter((l) => l.trim()); unlinkSync(cmdF);
                    for (const l of lines) { try { await exec(l); say(l.trim(), true); } catch (e) { say(l.trim(), false, String((e as Error).message).slice(0, 200)); } }
                }
                await sleep(2000);
            }
        } finally { try { docker(["unpause", CLEAN]); } catch { /* not paused */ } }
    }, 4 * 3_600_000);
});
