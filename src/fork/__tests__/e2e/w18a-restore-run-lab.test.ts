import {execFileSync, spawn, spawnSync, type ChildProcess} from "node:child_process";
import {createPrivateKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
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
import {createRestorePlan, loadPlanRow} from "@/fork/restore/service";
import {enqueueRestoreTask, type RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {approveRestorePlan} from "@/fork/restore/service";
import {startRestoreRun, cleanupRestoreRun, approveRestorePolicy, cancelRestoreRun} from "@/fork/restore-run/service";
import {leaseName, tickRestoreRun} from "@/fork/restore-run/tick";
import {getRestoreRunView} from "@/fork/restore-run/view";
import {setRestoreOverrides, type OverrideDeps} from "@/fork/config/service";
import {acquireLease} from "@/fork/locks";
import type {RestoreRunDeps} from "@/fork/restore-run/deps";
import {harness} from "@/fork/__tests__/w18a-world";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import {decryptAgentArchive, encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {req, seedUser} from "@/fork/__tests__/w16-world";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

/**
 * LIVE W18a test (FORK_LAB=1, docker-bridge lab ONLY, synthetic TEST-ONLY data, never the owner's hosts): the REAL fork dashboard (production build, its own
 * restore-runs job switched off with FORK_RESTORE_TICK_SECONDS=0) + the REAL fork agent image (`W17_AGENT_IMAGE`) on a dedicated docker network. The TEST process drives
 * the orchestrator (`tickRestoreRun`) with the same DB and seams for the manifest bytes and the artifact URLs (an in-test http server on the bridge gateway).
 *   L1 full orchestrated restore + VPS isolation + concurrency · L2 forged manifest · L3 rollback manifest · L4 agent offline at start · L8 agent killed during restore_db · L5 stage object swapped → cleanup.
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, the agent image.
 */
const LAB = process.env.FORK_LAB === "1";
const IMAGE = process.env.W17_AGENT_IMAGE ?? "portabase-agent-fork:w17ii-lab";
const NET = "w18a-lab-net", SUBNET = "172.31.252.0/24", GW = "172.31.252.1";
const CLEAN = "w18a-agent-clean", VPS = "w18a-agent-vps", ST_CLEAN = "w18a-agent-clean-state", ST_VPS = "w18a-agent-vps-state", REF_VOL = "w18alab_ref";
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

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let priv = ""; let tmp = ""; let ROOT = ""; let base = ""; let org = ""; let adminId = "";
let server: http.Server; let serverPort = 0; let dashPort = 0;
const dashEnvOf = (): NodeJS.ProcessEnv => ({...process.env, NODE_ENV: "production", DATABASE_URL: t.url,
    PROJECT_URL: URL_FOR_AGENTS(), PROJECT_SECRET: DASH_SECRET, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
    AUTH_DEFAULT_USER_NAME: "W17 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
    FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300", FORK_RESTORE_TICK_SECONDS: "0"});
const DASH_SECRET = `w18a-lab-${randomBytes(12).toString("hex")}`;
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

async function startAgent(name: string, stateVol: string, agentId: string, bundle: string, clean: boolean) {
    const edge = Buffer.from(JSON.stringify({serverUrl: URL_FOR_AGENTS(), agentId, masterKeyB64: MASTER.toString("base64")})).toString("base64url");
    const f = path.join(tmp, `${name}.bundle`);
    writeFileSync(f, bundle, {mode: 0o600}); chmodSync(f, 0o600);
    const args = ["run", "-d", "--name", name, "--network", NET, "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production",
        "-e", "FORK_CHANNEL_ENABLED=true", "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2", "-v", `${f}:/run/fork/bundle:ro`, "-v", `${stateVol}:/config`];
    if (clean) args.push("-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${ROOT}:${ROOT}`, "-e", `FORK_ALLOWED_PATH_ROOTS=${ROOT}`, "-e", `FORK_ARTIFACT_HTTP_HOSTS=${GW}`, "-e", "FORK_HOST_ROLE=production");
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

describe.skipIf(!LAB)("W18a live: orchestrated restore on the fork agent image", () => {
    let world: W17; let planId = ""; let planHash = ""; let cleanBundle = ""; let vpsAgent = ""; let vpsBundle = ""; let volName = ""; let composeDest = "";
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
        tmp = mkdtempSync(path.join(os.tmpdir(), "w18a-lab-")); priv = path.join(tmp, "private");
        ROOT = path.join(tmp, "w18a-root"); mkdirSync(ROOT, {recursive: true});
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
        const key = {privateKey: "", publicKey: "", kid: ""};
        const sk = await fileKeyProvider.signing(); key.privateKey = sk.privateKeyPem; key.publicKey = sk.publicKeyPem; key.kid = kidOfPublicKey(sk.publicKeyPem);
        const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
        const w = await seedW17World(t, "", key as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "production", roots: [ROOT], caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"],
            plain: {compose_app: {sha: sha256(filesPlain), size: filesPlain.length}, volume_app_data: {sha: fx("lab-volume").plaintext_sha256, size: fx("lab-volume").plaintext_size}, db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"}},
            enrolDeps: {serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok", keys: fileKeyProvider, env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}),
                principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
        world = w; cleanBundle = w.agentBundle;
        put(w.rp, "compose_app", encryptAgentArchive(MASTER, filesPlain)); put(w.rp, "volume_app_data", fxFile("lab-volume")); put(w.rp, "db_db", fxFile("lab-postgres"));
        await startAgent(CLEAN, ST_CLEAN, w.agent, cleanBundle, true);
        vpsAgent = await seedAgent(t.pool, org, "w18a-vps");
        const r = await enrolAgent({...chDeps(), principal: {userId: adminId, systemRole: "superadmin", memberships: []}}, {agentId: vpsAgent, password: PASSWORD});
        if (!r.ok) throw new Error(`enrol vps: ${r.code}`);
        vpsBundle = r.bundle; await startAgent(VPS, ST_VPS, vpsAgent, vpsBundle, false);
        await waitFor("clean agent reported compose.render.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [w.agent]))[0]?.capabilities.includes("compose.render.v1"), 120_000);
        await waitFor("vps agent reported channel.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [vpsAgent]))[0]?.capabilities.includes("channel.v1"), 120_000);
        const c = await makePlan(w, {}); planId = c.planId; planHash = c.planHash;
        const plan = (await loadPlanRow({db}, planId, planHash)); if (!plan.ok) throw new Error(plan.code);
        volName = plan.plan.actions.find((a) => a.kind === "restore_volume")!.destination.name!;
        composeDest = plan.plan.actions.find((a) => a.kind === "restore_compose_dir")!.destination.path!;
        RUN.push(`plan outcome=${plan.plan.outcome} volume=${volName} compose_dest=${composeDest}`);
        expect(plan.plan.outcome).toBe("ready");
        // a reference volume for L3: the same fixture plaintext, decrypted in the TEST, extracted by busybox
        docker(["volume", "create", REF_VOL]);
        docker(["run", "--rm", "-i", "-v", `${REF_VOL}:/r`, "busybox", "tar", "-xzf", "-", "-C", "/r", "--strip-components=1"], process.env, decryptAgentArchive(MASTER, fxFile("lab-volume")));
    }, 600_000);

    afterAll(async () => {
        const evidence = process.env.W18A_EVIDENCE_DIR;
        const all = stripAnsi(logs(CLEAN)) + stripAnsi(logs(VPS)) + out;
        const clean = ![CANARY3, SECRET_QS.split("=")[1], MASTER.toString("base64"), decodeBundle(cleanBundle || "e30").task_key_b64 ?? "~~", decodeBundle(cleanBundle || "e30").credential ?? "~~"].some((s) => s && s !== "~~" && all.includes(s));
        if (evidence && clean) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(path.join(evidence, "w18a-agent-clean.log"), stripAnsi(logs(CLEAN))); writeFileSync(path.join(evidence, "w18a-agent-vps.log"), stripAnsi(logs(VPS)));
            writeFileSync(path.join(evidence, "dashboard-fork-w18a.log"), out.split("\n").filter((l) => /[Ff]ork|agent-channel/.test(l) && !/Received POST/.test(l)).join("\n"));
            writeFileSync(path.join(evidence, "lab-run-w18a.txt"), RUN.join("\n") + "\n");
        } else if (evidence) writeFileSync(path.join(tmp, "NOT-WRITTEN"), "canary found a secret in a log: evidence withheld");
        for (const n of [CLEAN, VPS]) { try { docker(["rm", "-f", n]); } catch { /* gone */ } }
        try { for (const id of docker(["ps", "-aq", "--filter", "label=com.portabase.fork.helper=true"]).split("\n").filter(Boolean)) docker(["rm", "-f", id]); } catch { /* none */ }
        try { for (const v of docker(["volume", "ls", "-q", "--filter", "label=com.portabase.fork.agent_id"]).split("\n").filter(Boolean)) docker(["volume", "rm", "-f", v]); } catch { /* none */ }
        for (const v of [ST_CLEAN, ST_VPS, REF_VOL, "w17lab_foreign", "w17lab_otherrun"]) { try { docker(["volume", "rm", "-f", v]); } catch { /* gone */ } }
        try { docker(["network", "rm", NET]); } catch { /* gone */ }
        if (madeProxy) { try { docker(["network", "rm", "lab_proxy"]); } catch { /* gone */ } }
        server?.close(); child?.kill("SIGTERM"); await sleep(500); if (child?.exitCode === null) child?.kill("SIGKILL");
        await t?.drop();
        try { rootSh("rm -rf " + ROOT + "/*"); } catch { /* none */ }
        rmSync(tmp, {recursive: true, force: true});
    });

    // ---- helpers of the W18a cases ---------------------------------------------------------------------------------------------------------------
    const superP = () => ({userId: adminId, systemRole: "superadmin" as const, memberships: [{organizationId: org, role: "admin"}]});
    const rd = (over: Partial<RestoreRunDeps> = {}): RestoreRunDeps => ({
        db, principal: superP(), keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, configAllowed: async () => true, stepUp: async () => "ok",
        env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}),
        artifactUrl: chDeps().artifactUrl, manifest: async () => ({json: world.manifestJson, sigB64: world.manifestSig}), ...over,
    });
    const approvedPlan = async () => {
        const c = await makePlan(world, {});
        for (const kind of ["production_target"] as const) {
            const a = await approveRestorePlan({db, principal: superP(), configAllowed: async () => true}, {planId: c.planId, planHash: c.planHash, kind});
            if (!a.ok) throw new Error(`approve: ${a.code}`);
        }
        const project = (await q("select plan->'target'->>'project' p from fork_restore_plan where id=$1", [c.planId]))[0].p as string;
        return {...c, project};
    };
    const begin = async (c: {planId: string; planHash: string; project: string}, over: Partial<RestoreRunDeps> = {}) => {
        const s = await startRestoreRun(rd(over), {planId: c.planId, planHash: c.planHash, confirm: `RESTORE ${c.project}`, acceptMissingInputs: true});
        if (!s.ok) throw new Error(`start refused: ${s.code}`);
        return s.runId;
    };
    const runRow = async (id: string) => (await q("select * from fork_restore_run where id=$1", [id]))[0];
    const TERMINAL = ["succeeded", "incomplete", "failed", "cancelled"];
    /** tick every 500 ms until terminal; `each` sees every observed row (state sampling) */
    async function driveRun(runId: string, o: {ms?: number; over?: Partial<RestoreRunDeps>; each?: (r: Record<string, any>) => Promise<void> | void} = {}) {
        const end = Date.now() + (o.ms ?? 480_000);
        for (;;) {
            await tickRestoreRun(rd(o.over), runId);
            const r = await runRow(runId);
            if (o.each) await o.each(r);
            if (TERMINAL.includes(r.state)) return r;
            if (Date.now() > end) throw new Error(`run ${runId} not terminal: ${r.state} ${JSON.stringify(r.steps)}\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l)).slice(-8).join("\n")}\n${stripAnsi(logs(CLEAN)).slice(-1500)}`);
            await sleep(500);
        }
    }
    const journalOf = (id: string) => q("select step, attempt, task_type, task_id from fork_restore_run_task where run_id=$1 order by created_at", [id]);
    const taskCount = async () => Number((await q("select count(*)::int n from fork_agent_task"))[0].n);
    const owned = (id: string) => ({
        containers: docker(["ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${id}`]).trim(),
        volumes: docker(["volume", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${id}`]).trim(),
        networks: docker(["network", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${id}`]).trim(),
    });
    const wsDir = () => `${ROOT}/restore/app`;
    const psql = (sql: string) => docker(["exec", "app-db-1", "sh", "-c", `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${sql}"`]);
    /** the explicit cleanup the operator would order (service, as the admin), awaited to its final status */
    async function cleanup(runId: string) {
        const r = await cleanupRestoreRun(rd(), {runId});
        if (!r.ok) throw new Error(`cleanup refused: ${r.code}`);
        return finished(r.taskId);
    }
    const STACK_ENV = Object.fromEntries(readFileSync(path.join(process.cwd(), "dev/fork-lab/demo-stack/stack.env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));


    // ---- helpers of the W17-live L-cases (#151) ---------------------------------------------------------------------------------------------------
    const ovDeps = (): OverrideDeps => ({db, principal: superP(), configAllowed: async () => true, now: () => new Date()});
    const approvedPlanWith = async (o: {overrideYml?: string; set?: {service: string; key: string; value: string}[]}) => {
        const c = await makePlan(world, {});
        if (o.overrideYml !== undefined || o.set) {
            const r = await setRestoreOverrides(ovDeps(), {planId: c.planId, planHash: c.planHash, ...(o.set ? {set: o.set} : {}), ...(o.overrideYml !== undefined ? {overrideYml: o.overrideYml} : {})});
            if (!r.ok) throw new Error(`overrides refused: ${r.code}`);
        }
        const a = await approveRestorePlan({db, principal: superP(), configAllowed: async () => true}, {planId: c.planId, planHash: c.planHash, kind: "production_target"});
        if (!a.ok) throw new Error(`approve: ${a.code}`);
        const project = (await q("select plan->'target'->>'project' p from fork_restore_plan where id=$1", [c.planId]))[0].p as string;
        return {...c, project};
    };
    /** like driveRun, but also stops (returns the row) as soon as the run is in one of `states` */
    async function driveUntil(runId: string, states: string[], o: {ms?: number; over?: Partial<RestoreRunDeps>} = {}) {
        const end = Date.now() + (o.ms ?? 480_000);
        for (;;) {
            await tickRestoreRun(rd(o.over), runId);
            const r = await runRow(runId);
            if (states.includes(r.state) || TERMINAL.includes(r.state)) return r;
            if (Date.now() > end) throw new Error(`run ${runId} not in ${states.join("|")}: ${r.state} ${JSON.stringify(r.steps)}\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l)).slice(-8).join("\n")}`);
            await sleep(500);
        }
    }
    /** lab hygiene for a SUCCEEDED run: remove what it created through the W17 cleanup path (the run service refuses cleanup of a succeeded run) */
    async function hygiene(c: {planId: string; planHash: string}, runId: string) {
        const cl = await enqueueRestoreTask(chDeps(), {type: "restore_cleanup", planId: c.planId, planHash: c.planHash, restoreId: runId, cleanup: {workspace: true, volumes: true, networks: true, containers: true}});
        if (!cl.ok) throw new Error(cl.code);
        expect((await finished(cl.taskId)).status).toBe("succeeded");
        expect(owned(runId)).toEqual({containers: "", volumes: "", networks: ""});
    }
    const logsSince = (name: string, since: Date) => { const r = spawnSync("docker", ["logs", "--since", since.toISOString(), name], {encoding: "utf8"}); return stripAnsi(`${r.stdout}${r.stderr}`); };
    const stageTask = async (runId: string) => (await q("select a.status, a.id from fork_restore_run_task j join fork_agent_task a on a.id=j.task_id where j.run_id=$1 and j.step='stage' order by j.created_at desc limit 1", [runId]))[0];

    it("L2 forged manifest (one flipped byte) ⇒ failed/manifest_mismatch at verify_manifest, ZERO tasks created, the target agent never contacted", async () => {
        const c = await approvedPlan();
        const before = await taskCount();
        const runId = await begin(c, {manifest: async () => ({json: world.manifestJson.replace('"sequence"', '"sequencf"'), sigB64: world.manifestSig})});
        const r = await driveRun(runId, {over: {manifest: async () => ({json: world.manifestJson.replace('"sequence"', '"sequencf"'), sigB64: world.manifestSig})}, ms: 60_000});
        expect(r).toMatchObject({state: "failed", reason: "manifest_mismatch", failed_step: "verify_manifest"});
        expect(await taskCount()).toBe(before);
        expect(await journalOf(runId)).toEqual([]);
        RUN.push(`L2 forged manifest: state=${r.state} reason=${r.reason} step=${r.failed_step} tasks_created=${(await taskCount()) - before}`);
    });

    it("L3 rollback (validly signed manifest of the previous snapshot) ⇒ failed/manifest_mismatch, ZERO tasks", async () => {
        await t.pool.query("update fork_recovery_point set sequence=5 where id=$1", [world.rp]);
        try {
            const c = await approvedPlan();
            const rollback = await harness(t, "", {privateKey: (await fileKeyProvider.signing()).privateKeyPem, publicKey: "", kid: kidOfPublicKey((await fileKeyProvider.signing()).publicKeyPem)} as ReturnType<typeof testKeypair>, org).signedManifestOf(world, 4);
            const before = await taskCount();
            const over = {manifest: async () => rollback};
            const runId = await begin(c, over);
            const r = await driveRun(runId, {over, ms: 60_000});
            expect(r).toMatchObject({state: "failed", reason: "manifest_mismatch", failed_step: "verify_manifest"});
            expect(await taskCount()).toBe(before);
            RUN.push(`L3 rollback manifest (sequence 4 vs plan 5): state=${r.state} reason=${r.reason} tasks_created=${(await taskCount()) - before}`);
        } finally {
            await t.pool.query("update fork_recovery_point set sequence=1 where id=$1", [world.rp]);
        }
    });

    it("L1 + L13 full orchestrated restore of the demo stack on the clean agent: 8 steps, one task per step, labels, data == reference; the VPS agent saw nothing; a second start is already_running", async () => {
        const c = await approvedPlan();
        const runId = await begin(c);
        const c2 = await approvedPlan();
        expect(await startRestoreRun(rd(), {planId: c2.planId, planHash: c2.planHash, confirm: `RESTORE ${c2.project}`, acceptMissingInputs: true})).toMatchObject({ok: false, code: "already_running"}); // L13
        const states: string[] = [];
        const r = await driveRun(runId, {each: (x) => { states.push(x.state); }});
        RUN.push(`L1 run state=${r.state} verification=${r.verification} reason=${r.reason} steps=${(r.steps as {name: string; status: string}[]).map((s) => `${s.name}:${s.status}`).join(",")}`);
        expect(r).toMatchObject({state: "succeeded", verification: "started"});
        expect(states).not.toContain("failed");
        const j = await journalOf(runId);
        expect(j.map((x) => x.step)).toEqual(["probe", "stage", "apply", "render", "restore_db", "compose_up"]);
        expect(new Set(j.map((x) => x.task_id)).size).toBe(6);
        // everything the run created carries the owner labels of THIS restore
        const ps = docker(["ps", "-a", "--filter", "label=com.docker.compose.project=app", "--format", "{{.Names}}|{{.State}}|{{.Label \"com.portabase.fork.restore_id\"}}"]).trim().split("\n");
        expect(ps.sort().join(";")).toBe([`app-db-1|running|${runId}`, `app-web-1|running|${runId}`].join(";"));
        for (const v of docker(["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=app"]).trim().split("\n").filter(Boolean)) expect(volume(v)!.Labels["com.portabase.fork.restore_id"]).toBe(runId);
        expect(listing(volName)).toBe(listing(REF_VOL)); // the restored volume equals the independent reference
        // PostgreSQL rows == an independent reference restore of the same dump (N6 method)
        const {createHash} = await import("node:crypto");
        const out1 = psql("select string_agg(id||chr(58)||payload, chr(44) order by id) from items");
        const plainTgz = decryptAgentArchive(MASTER, fxFile("lab-postgres"));
        const dump = execFileSync("sh", ["-c", "tar -xzOf - --wildcards '*.dump'"], {input: plainTgz, maxBuffer: 1 << 28});
        try { docker(["rm", "-f", "w18a-refpg"]); } catch { /* none */ }
        docker(["run", "-d", "--name", "w18a-refpg", "-e", `POSTGRES_USER=${STACK_ENV.POSTGRES_USER}`, "-e", `POSTGRES_PASSWORD=${STACK_ENV.POSTGRES_PASSWORD}`, "-e", `POSTGRES_DB=${STACK_ENV.POSTGRES_DB}`, "postgres:17-alpine"]);
        await waitFor("reference pg ready", async () => { try { docker(["exec", "w18a-refpg", "sh", "-c", 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"']); return true; } catch { return false; } }, 60_000);
        await sleep(3000);
        docker(["exec", "-i", "w18a-refpg", "sh", "-c", 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner'], process.env, dump);
        const ref = docker(["exec", "w18a-refpg", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"']);
        try { docker(["rm", "-f", "w18a-refpg"]); } catch { /* gone */ }
        expect(createHash("sha256").update(out1).digest("hex")).toBe(createHash("sha256").update(ref).digest("hex"));
        RUN.push(`L1 data: volume listing == reference; items sha256(restored)=${createHash("sha256").update(out1).digest("hex").slice(0, 16)} == sha256(reference)=${createHash("sha256").update(ref).digest("hex").slice(0, 16)}; containers=${ps.join(",")}`);
        // L1 isolation: the VPS agent got no task and its log names none
        expect(Number((await q("select count(*)::int n from fork_agent_task where agent_id=$1", [vpsAgent]))[0].n)).toBe(0);
        const vlog = stripAnsi(logs(VPS));
        for (const x of j) expect(vlog.includes(x.task_id as string)).toBe(false);
        RUN.push(`L1 isolation: vps tasks=0, no task id in the vps agent log; L13 second start while active ⇒ already_running`);
        // a succeeded restore is never cleaned by the run service (it would delete the restored stack)
        expect(await cleanupRestoreRun(rd(), {runId})).toMatchObject({ok: false, code: "not_allowed"});
        // lab hygiene: remove what THIS run created, through the W17 cleanup path
        const cl = await enqueueRestoreTask(chDeps(), {type: "restore_cleanup", planId: c.planId, planHash: c.planHash, restoreId: runId, cleanup: {workspace: true, volumes: true, networks: true, containers: true}});
        if (!cl.ok) throw new Error(cl.code);
        expect((await finished(cl.taskId)).status).toBe("succeeded");
        expect(owned(runId)).toEqual({containers: "", volumes: "", networks: ""});
    }, 900_000);

    it("L4 the clean agent is offline when the run starts: the never-started probe expires, a fresh task is enqueued (attempt 2) when the agent is back, and the run finishes", async () => {
        const short = {env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 1, FORK_AGENT_LEASE_SECONDS: 60})};
        const c = await approvedPlan();
        docker(["stop", CLEAN]);
        try {
            const runId = await begin(c, short);
            await tickRestoreRun(rd(short), runId);
            expect((await journalOf(runId)).map((x) => `${x.step}#${x.attempt}`)).toEqual(["probe#1"]);
            await sleep(65_000); // the 1-minute start deadline passes with nobody polling
            await tickRestoreRun(rd(short), runId); // the orchestrator itself expires the stale task and enqueues attempt 2
            expect((await journalOf(runId)).map((x) => `${x.step}#${x.attempt}`)).toEqual(["probe#1", "probe#2"]);
            expect((await runRow(runId)).state).toBe("running"); // offline is not failed
            docker(["start", CLEAN]);
            const r = await driveRun(runId, {over: short});
            RUN.push(`L4 offline at start: probe attempts=2 (first expired) final=${r.state} verification=${r.verification}`);
            expect(r).toMatchObject({state: "succeeded", verification: "started"});
            const cl = await enqueueRestoreTask(chDeps(), {type: "restore_cleanup", planId: c.planId, planHash: c.planHash, restoreId: runId, cleanup: {workspace: true, volumes: true, networks: true, containers: true}});
            if (!cl.ok) throw new Error(cl.code);
            expect((await finished(cl.taskId)).status).toBe("succeeded");
        } finally {
            try { docker(["start", CLEAN]); } catch { /* already running */ }
        }
    }, 900_000);

    it("L8 the clean agent is killed while restore_db runs: the run ends failed TRUTHFULLY (the interrupted restore is aborted by the agent's startup sweep, never silently re-run, never success) and the explicit cleanup removes the owned leftovers", async () => {
        const c = await approvedPlan();
        const runId = await begin(c);
        const states: string[] = [];
        let killed = false;
        const r = await driveRun(runId, {each: async (x) => {
            states.push(x.state);
            if (killed) return;
            const [t1] = await q("select a.status from fork_restore_run_task j join fork_agent_task a on a.id=j.task_id where j.run_id=$1 and j.step='restore_db'", [runId]);
            if (t1 && ["leased", "running"].includes(t1.status)) { killed = true; docker(["kill", CLEAN]); await sleep(3000); docker(["start", CLEAN]); RUN.push(`L8 killed ${CLEAN} while restore_db was ${t1.status}; restarted`); }
        }});
        const [rdb] = await q("select a.status, a.result, a.attempts from fork_restore_run_task j join fork_agent_task a on a.id=j.task_id where j.run_id=$1 and j.step='restore_db'", [runId]);
        RUN.push(`L8 killed=${killed} run=${r.state} reason=${r.reason} failed_step=${r.failed_step} verification=${r.verification} restore_db_task=${rdb.status}/${JSON.stringify(rdb.result)}/attempts=${rdb.attempts} states_seen=${[...new Set(states)].join(",")}`);
        expect(killed).toBe(true);
        expect(r.state).not.toBe("succeeded"); // an interrupted restore is never recorded as success
        expect(r.verification).toBeNull();
        expect(r.failed_step).toBe("restore_db");
        expect((await journalOf(runId)).filter((x) => x.step === "restore_db").length).toBe(1);
        const cl = await cleanup(runId);
        expect(cl.status).toBe("succeeded");
        expect(owned(runId)).toEqual({containers: "", volumes: "", networks: ""});
        expect(rexists(wsDir())).toBe(false);
        RUN.push(`L8 cleanup status=${cl.status} owned_leftovers=0 workspace_gone=${!rexists(wsDir())}`);
    }, 900_000);

    it("L5 the stored object is swapped after the plan: failed/checksum_mismatch at stage; the explicit cleanup removes the workspace and nothing else was created", async () => {
        const c = await approvedPlan();
        const original = objects.get(`/${world.rp}/compose_app`)!.body;
        put(world.rp, "compose_app", encryptAgentArchive(MASTER, Buffer.from("not the archive the plan was made for")));
        try {
            const runId = await begin(c);
            const r = await driveRun(runId, {ms: 240_000});
            RUN.push(`L5 state=${r.state} reason=${r.reason} step=${r.failed_step}`);
            expect(r).toMatchObject({state: "failed", failed_step: "stage", reason: "checksum_mismatch"});
            expect((await journalOf(runId)).map((x) => x.step)).toEqual(["probe", "stage"]); // nothing after the failure
            const cl = await cleanup(runId);
            expect(cl.status).toBe("succeeded");
            expect(rexists(wsDir())).toBe(false);
            expect(owned(runId)).toEqual({containers: "", volumes: "", networks: ""});
            expect(docker(["ps", "-aq", "--filter", "label=com.docker.compose.project=app"]).trim()).toBe("");
            const v = await q("select reason from fork_restore_run where id=$1", [runId]);
            RUN.push(`L5 cleanup status=${cl.status} workspace_gone=${!rexists(wsDir())} owned_leftovers=0 run_reason=${v[0].reason}`);
        } finally {
            put(world.rp, "compose_app", original);
        }
    }, 600_000);

    it("L6 apply meets a FOREIGN volume `app_data` (no owner labels): failed/volume_exists at apply, journal probe→stage→apply, cleanup removes only owned things, the foreign volume survives untouched", async () => {
        const c = await approvedPlan();
        docker(["volume", "create", "app_data"]);
        try {
            const runId = await begin(c);
            const r = await driveRun(runId, {ms: 240_000});
            RUN.push(`L6 state=${r.state} reason=${r.reason} step=${r.failed_step}`);
            expect(r).toMatchObject({state: "failed", failed_step: "apply", reason: "volume_exists"});
            expect((await journalOf(runId)).map((x) => x.step)).toEqual(["probe", "stage", "apply"]);
            const cl = await cleanup(runId);
            expect(cl.status).toBe("succeeded");
            const v = JSON.parse(docker(["volume", "inspect", "app_data"]))[0] as {Labels: Record<string, string> | null};
            expect(v.Labels ?? {}).toEqual({});
            expect(owned(runId)).toEqual({containers: "", volumes: "", networks: ""});
            expect(rexists(wsDir())).toBe(false);
            RUN.push(`L6 cleanup=${cl.status}; foreign app_data still exists, Labels=${JSON.stringify(v.Labels ?? {})}; owned leftovers 0; workspace gone`);
        } finally {
            try { docker(["volume", "rm", "app_data"]); } catch { /* gone */ }
        }
    }, 600_000);

    it("L7 policy round trip: privileged override ⇒ awaiting_approval; org-admin ⇒ forbidden; wrong phrase ⇒ confirmation_mismatch; right phrase ⇒ run succeeds, override reaches the container; a poisoned raw override ⇒ failed/raw_refused with no render task", async () => {
        const c = await approvedPlanWith({overrideYml: "services:\n  web:\n    privileged: true\n", set: [{service: "web", key: "A", value: CANARY3}]});
        const runId = await begin(c);
        const r1 = await driveUntil(runId, ["awaiting_approval"]);
        expect(r1.state).toBe("awaiting_approval");
        const view = await getRestoreRunView(rd(), {runId});
        if (!view.ok) throw new Error(view.code);
        const web = view.view.awaiting?.services.find((x) => x.service === "web");
        expect(web?.phrase).toBeTruthy();
        const orgAdmin = {userId: await seedUser(t.pool, "user"), systemRole: "user" as const, memberships: [{organizationId: org, role: "admin"}]};
        expect(await approveRestorePolicy(rd({principal: orgAdmin}), {runId, confirmations: {web: web!.phrase}})).toMatchObject({ok: false, code: "forbidden"});
        const wrong = await approveRestorePolicy(rd(), {runId, confirmations: {web: "ALLOW nothing"}});
        expect(wrong).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await approveRestorePolicy(rd(), {runId, confirmations: {web: web!.phrase}})).toMatchObject({ok: true});
        const r2 = await driveRun(runId);
        expect(r2).toMatchObject({state: "succeeded", verification: "started"});
        expect(docker(["inspect", "-f", "{{.HostConfig.Privileged}}", "app-web-1"]).trim()).toBe("true");
        expect(docker(["exec", "app-web-1", "sh", "-c", 'printf %s "$A" | sha256sum']).split(/\s+/)[0]).toBe(sha256(CANARY3));
        RUN.push(`L7 awaiting phrase="${web!.phrase}" org-admin=forbidden wrong-phrase=confirmation_mismatch right phrase ok ⇒ run ${r2.state}/${r2.verification}; app-web-1 Privileged=true; sha256(printenv A)==sha256(override)`);
        await hygiene(c, runId);
        // poisoned raw override: the dashboard refuses to sign a render task for it
        const c2 = await approvedPlanWith({overrideYml: "services:\n  web:\n    env_file: /etc/hostname\n"});
        const t0 = new Date();
        const run2 = await begin(c2);
        const r3 = await driveRun(run2, {ms: 240_000});
        const renders = Number((await q("select count(*)::int n from fork_agent_task where type='compose_render' and created_at >= $1", [t0]))[0].n);
        RUN.push(`L7 poisoned raw override: state=${r3.state} reason=${r3.reason} step=${r3.failed_step} compose_render tasks created=${renders}`);
        expect(r3).toMatchObject({state: "failed", failed_step: "render", reason: "raw_refused"});
        expect(renders).toBe(0);
        const cl = await cleanup(run2);
        expect(cl.status).toBe("succeeded");
        expect(owned(run2)).toEqual({containers: "", volumes: "", networks: ""});
    }, 900_000);

    it("L9 container_name collision with a foreign container at compose_up: failed/container_conflict, the foreign container and the agent keep running, cleanup removes the owned db container only", async () => {
        docker(["run", "-d", "--name", "w18a-foreign", "busybox", "sleep", "3600"]);
        try {
            const c = await approvedPlanWith({overrideYml: "services:\n  web:\n    container_name: w18a-foreign\n"});
            const runId = await begin(c);
            const r = await driveRun(runId, {ms: 360_000});
            RUN.push(`L9 state=${r.state} reason=${r.reason} step=${r.failed_step}`);
            expect(r).toMatchObject({state: "failed", failed_step: "compose_up", reason: "container_conflict"});
            expect(docker(["inspect", "-f", "{{.State.Running}}", "w18a-foreign"]).trim()).toBe("true");
            expect(docker(["inspect", "-f", "{{.State.Running}}", CLEAN]).trim()).toBe("true");
            const before = owned(runId).containers;
            expect(before).not.toBe(""); // restore_db brought app-db-1 up before compose_up refused
            const cl = await cleanup(runId);
            expect(cl.status).toBe("succeeded");
            expect(owned(runId)).toEqual({containers: "", volumes: "", networks: ""});
            expect(docker(["inspect", "-f", "{{.State.Running}}", "w18a-foreign"]).trim()).toBe("true");
            RUN.push(`L9 cleanup=${cl.status}; owned containers before=${before.split("\n").length} after=0; w18a-foreign + ${CLEAN} still running`);
        } finally {
            try { docker(["rm", "-f", "w18a-foreign"]); } catch { /* gone */ }
        }
    }, 900_000);

    /** tick until the run's stage task is in the agent's hands AND the (held) object was requested */
    async function untilStageInFlight(runId: string, key: string, over?: Partial<RestoreRunDeps>) {
        const end = Date.now() + 240_000;
        for (;;) {
            await tickRestoreRun(rd(over), runId);
            const st = await stageTask(runId);
            if (st && ["leased", "running"].includes(st.status) && objects.get(key)!.hits > 0) return st;
            if (TERMINAL.includes((await runRow(runId)).state)) throw new Error("run ended before the stage was in flight");
            if (Date.now() > end) throw new Error(`stage never in flight: ${JSON.stringify(st)}`);
            await sleep(500);
        }
    }

    it("L10 dashboard restart mid-run: the stage is in flight while the dashboard is DOWN for 35 s; the run continues after the restart, never fails, one journal row per step", async () => {
        const key = `/${world.rp}/compose_app`;
        const body = objects.get(key)!.body;
        put(world.rp, "compose_app", body, false, 45_000);
        try {
            const c = await approvedPlan();
            const runId = await begin(c);
            await untilStageInFlight(runId, key);
            const t0 = new Date();
            const states: string[] = [];
            await stopDashboard();
            while (Date.now() - t0.getTime() < 35_000) { await tickRestoreRun(rd(), runId); states.push((await runRow(runId)).state); await sleep(1000); }
            await startDashboard();
            const r = await driveRun(runId, {each: (x) => { states.push(x.state); }});
            const j = await journalOf(runId);
            const l = logsSince(CLEAN, t0);
            const evidence = /heartbeat for task .* failed|could not report|lease failed/.exec(l);
            RUN.push(`L10 dashboard down ≥35 s during stage: final=${r.state}/${r.verification} states_seen=${[...new Set(states)].join(",")} journal=${j.map((x) => `${x.step}#${x.attempt}`).join(",")} outage_evidence_in_agent_log="${evidence?.[0] ?? "NONE"}"`);
            expect(evidence, "the outage was real: the agent logged a failed heartbeat/poll/report").not.toBeNull();
            expect(r).toMatchObject({state: "succeeded", verification: "started"});
            expect(states).not.toContain("failed");
            expect(j.map((x) => x.step)).toEqual(["probe", "stage", "apply", "render", "restore_db", "compose_up"]);
            expect(j.every((x) => x.attempt === 1)).toBe(true);
            expect(new Set(j.map((x) => x.task_id)).size).toBe(6);
            await hygiene(c, runId);
        } finally {
            put(world.rp, "compose_app", body);
        }
    }, 1_200_000);

    it("L10b orchestrator crash: a dead owner's lease blocks a second orchestrator (busy) until it expires (20 s), then the run finishes with one task per step", async () => {
        const c = await approvedPlan();
        const runId = await begin(c, {owner: "orch-A"});
        for (;;) { await tickRestoreRun(rd({owner: "orch-A"}), runId); if ((await journalOf(runId)).some((x) => x.step === "stage")) break; await sleep(500); }
        expect(await acquireLease(db, leaseName(runId), "orch-A-crashed", 20_000, new Date())).toBe(true);
        const first = await tickRestoreRun(rd({owner: "orch-B"}), runId);
        expect(first.state).toBe("busy");
        const states = new Set<string>();
        const t0 = Date.now();
        const r = await driveRun(runId, {over: {owner: "orch-B"}, each: () => { states.add("seen"); }});
        const j = await journalOf(runId);
        RUN.push(`L10b first tick of orch-B=${first.state}; run finished ${Math.round((Date.now() - t0) / 1000)} s later: ${r.state}/${r.verification}; journal tasks=${new Set(j.map((x) => x.task_id)).size}/${j.length} rows`);
        expect(r).toMatchObject({state: "succeeded", verification: "started"});
        expect(new Set(j.map((x) => x.task_id)).size).toBe(j.length);
        expect(j.map((x) => x.step)).toEqual(["probe", "stage", "apply", "render", "restore_db", "compose_up"]);
        await hygiene(c, runId);
    }, 900_000);

    it("L11 cancel while the stage is in flight: cancel is idempotent, the run ends cancelled (never failed/succeeded), nothing after stage was enqueued, cleanup leaves nothing", async () => {
        const key = `/${world.rp}/compose_app`;
        const body = objects.get(key)!.body;
        put(world.rp, "compose_app", body, false, 30_000);
        try {
            const c = await approvedPlan();
            const t0 = new Date();
            const runId = await begin(c);
            await untilStageInFlight(runId, key);
            expect(await cancelRestoreRun(rd(), {runId})).toMatchObject({ok: true});
            expect(await cancelRestoreRun(rd(), {runId})).toMatchObject({ok: true});
            const states: string[] = [];
            const r = await driveRun(runId, {each: (x) => { states.push(x.state); }});
            const j = await journalOf(runId);
            const applies = Number((await q("select count(*)::int n from fork_agent_task where type='restore_apply' and created_at >= $1", [t0]))[0].n);
            RUN.push(`L11 cancel during stage: final=${r.state} states_seen=${[...new Set(states)].join(",")} journal=${j.map((x) => x.step).join(",")} restore_apply tasks=${applies}`);
            expect(r.state).toBe("cancelled");
            expect(states).not.toContain("failed"); expect(states).not.toContain("succeeded");
            expect(j.map((x) => x.step)).toEqual(["probe", "stage"]);
            expect(applies).toBe(0);
            expect(await cancelRestoreRun(rd(), {runId})).toMatchObject({ok: false, code: "not_active"});
            const cl = await cleanup(runId);
            expect(cl.status).toBe("succeeded");
            expect(rexists(wsDir())).toBe(false);
            expect(owned(runId)).toEqual({containers: "", volumes: "", networks: ""});
        } finally {
            put(world.rp, "compose_app", body);
        }
    }, 900_000);

    it("L12 canary sweep (last): the override value, presigned signature, master key, task key and credential are in no fork_% table, audit row, run view, dashboard log (across restarts) or agent log; override rows are purged", async () => {
        const secrets: Record<string, string> = {override: CANARY3, presigned: SECRET_QS.split("=")[1]!, master_b64: MASTER.toString("base64"), task_key: decodeBundle(cleanBundle).task_key_b64, credential: decodeBundle(cleanBundle).credential};
        const tables = (await q("select table_name from information_schema.tables where table_schema='public' and table_name like 'fork\\_%' escape '\\'")).map((r) => r.table_name as string);
        for (const n of tables) for (const [k, v] of Object.entries(secrets)) expect((await q(`select count(*)::int c from "${n}" x where x::text like $1`, [`%${v}%`]))[0].c, `${k} in ${n}`).toBe(0);
        expect(Number((await q("select count(*)::int n from fork_restore_override"))[0].n)).toBe(0);
        const runs = (await q("select id from fork_restore_run")).map((r) => r.id as string);
        for (const id of runs) { const v = JSON.stringify(await getRestoreRunView(rd(), {runId: id})); for (const [k, s] of Object.entries(secrets)) expect(v.includes(s), `${k} in view of ${id}`).toBe(false); }
        const logsAll = out + stripAnsi(logs(CLEAN)) + stripAnsi(logs(VPS));
        for (const [k, v] of Object.entries(secrets)) expect(logsAll.includes(v), `${k} in logs`).toBe(false);
        RUN.push(`L12 5 secrets absent from ${tables.length} fork_% tables (+audit), ${runs.length} run views, dashboard log (all restarts), clean + vps agent logs; fork_restore_override rows=0`);
    });
});
