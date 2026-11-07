import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {createPrivateKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {enrolAgent} from "@/fork/agent-channel/admin";
import {decodeBundle} from "@/fork/agent-channel/bundle";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {EnvelopeSchema} from "@/fork/agent-channel/envelope";
import {encryptPayload, payloadSha256} from "@/fork/agent-channel/payload";
import {SIGN_DOMAIN} from "@/fork/agent-channel/vocab";
import {canonicalJson} from "@/fork/canonical";
import type {ForkDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {registerLiveAnchor} from "@/fork/manifest/anchors";
import {buildManifest} from "@/fork/manifest/build";
import {kidOfPublicKey, signManifest} from "@/fork/manifest/sign";
import {approveRestorePlan, createRestorePlan, loadPlanRow} from "@/fork/restore/service";
import {buildStagePayload, type BuildInput} from "@/fork/restore-tasks/build";
import {enqueueRestoreTask, type RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import {decryptAgentArchive, encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {P, req} from "@/fork/__tests__/w16-world";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

/**
 * LIVE W17-i test (FORK_LAB=1, docker-bridge lab ONLY, synthetic TEST-ONLY data, never the owner's hosts): the REAL fork dashboard (production build) +
 * the REAL fork agent image (`W17_AGENT_IMAGE`) on a dedicated docker network. Artifacts are served by an in-test http server on the bridge gateway
 * (it can swap an object and trickle a large one; MinIO is not needed to prove the agent). Restores land in `W17_ROOT` (a temp dir bind-mounted at the SAME path).
 *   L1 probe + capabilities · L2 stage · L3 apply · L4 isolation · L5 forged inputs · L6 kill + restart · L7 cleanup · L8 canary.
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, the agent image.
 */
const LAB = process.env.FORK_LAB === "1";
const IMAGE = process.env.W17_AGENT_IMAGE ?? "portabase-agent-fork:w17-lab";
const NET = "w17-lab-net", SUBNET = "172.31.250.0/24", GW = "172.31.250.1";
const CLEAN = "w17-agent-clean", VPS = "w17-agent-vps", ST_CLEAN = "w17-agent-clean-state", ST_VPS = "w17-agent-vps-state", REF_VOL = "w17lab_ref";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env, input?: Buffer) => execFileSync("docker", args, {encoding: "utf8", env, input, stdio: ["pipe", "pipe", "pipe"]}).trim();
const freePort = (host = GW) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const logs = (name: string) => { try { return execFileSync("docker", ["logs", name], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}); } catch (e) { return String(e); } };
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
const FX = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {name: string; file: string; plaintext_sha256: string; plaintext_size: number}[]};
const fxFile = (n: string) => readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures", FX.fixtures.find((f) => f.name === n)!.file));
const MASTER = Buffer.from(FX.master_key_b64, "base64");
const SECRET_QS = `X-Amz-Signature=${randomBytes(12).toString("hex")}SECRETSIG`;

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let priv = ""; let tmp = ""; let ROOT = ""; let base = ""; let org = ""; let adminId = "";
let server: http.Server; let serverPort = 0;
const objects = new Map<string, {body: Buffer; slow?: boolean; hits: number}>();
const RUN: string[] = [];
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
        payload_sha256: payloadSha256(pt), requires: ["restore.target.v1"], kid: sk.kid, ...(o.target ? {target_agent_id: o.target} : {})});
    const text = canonicalJson({...env, requires: [...env.requires].sort()});
    const signature = rsaSign("sha256", Buffer.from(SIGN_DOMAIN + text), createPrivateKey(sk.privateKey)).toString("base64");
    await q(`insert into fork_agent_task (id, agent_id, agent_name, enroll_id, type, requires, seq, envelope_text, signature, kid, payload_enc, payload_sha256, status, created_by, not_after)
             values ($1,$2,'planted',$3,$4,'{restore.target.v1}',$5,$6,$7,$8,$9,$10,'queued','lab', now() + interval '30 minutes')`,
        [taskId, agentId, e.enroll_id, type, seq, text, signature, sk.kid, encryptPayload(Buffer.from(decodeBundle(bundleStr).task_key_b64, "base64"), {taskId, agentId, type}, pt), env.payload_sha256]);
    return taskId;
}

describe.skipIf(!LAB)("W17-i live: agent restore engine (probe, stage, apply, cleanup) on the fork image", () => {
    let world: W17; let planId = ""; let planHash = ""; let cleanBundle = ""; let vpsAgent = ""; let vpsBundle = ""; let volName = ""; let composeDest = "";
    const restoreId = randomUUID();
    let filesPlain = Buffer.alloc(0);

    const put = (rp: string, name: string, body: Buffer, slow = false) => { objects.set(`/${rp}/${name}`, {body, slow, hits: 0}); };
    const manifestOf = () => ({json: world.manifestJson, sigB64: world.manifestSig});
    async function makePlan(w: W17, mapping: Record<string, unknown>) {
        const sel = ["dir:/srv/app", "volume:app_data", "db:db"];
        const c = await createRestorePlan({db, principal: {userId: adminId, systemRole: "superadmin", memberships: [{organizationId: org, role: "admin"}]}, configAllowed: async () => true},
            req(w, {mode: "selective", mappings: {target_project: null, restore_root: `${ROOT}/restore`, volumes: null, select: sel, sqlite: null, ...mapping}}));
        if (!c.ok) throw new Error(`plan refused: ${c.code}`);
        return c;
    }

    beforeAll(async () => {
        process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w17-test-${randomBytes(12).toString("hex")}`;
        tmp = mkdtempSync(path.join(os.tmpdir(), "w17-lab-")); priv = path.join(tmp, "private");
        ROOT = path.join(tmp, "w17-root"); mkdirSync(ROOT, {recursive: true});
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), MASTER, {mode: 0o600});
        for (const n of [CLEAN, VPS]) { try { docker(["rm", "-f", n]); } catch { /* none */ } }
        for (const v of [ST_CLEAN, ST_VPS, REF_VOL]) { try { docker(["volume", "rm", "-f", v]); } catch { /* none */ } }
        try { docker(["network", "create", "--subnet", SUBNET, NET]); } catch { /* exists */ }
        // artifact server on the bridge gateway
        serverPort = await freePort();
        server = http.createServer((rq, rs) => {
            const o = objects.get(new URL(rq.url!, "http://x").pathname);
            if (!o) { rs.writeHead(404).end(); return; }
            o.hits++;
            rs.writeHead(200, {"content-length": o.body.length});
            if (!o.slow) { rs.end(o.body); return; }
            let off = 0; const tick = () => { if (off >= o.body.length) { rs.end(); return; } rs.write(o.body.subarray(off, off + 65536)); off += 65536; setTimeout(tick, 40); }; tick();
        }).listen(serverPort, GW);
        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        const port = await freePort(); base = `http://${GW}:${port}`;
        child = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {...process.env, NODE_ENV: "production", DATABASE_URL: t.url,
            PROJECT_URL: URL_FOR_AGENTS(), PROJECT_SECRET: `w17-lab-${randomBytes(12).toString("hex")}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
            AUTH_DEFAULT_USER_NAME: "W17 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
            FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300"}});
        child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
        await waitFor("dashboard ready", async () => out.includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
        process.env.PRIVATE_PATH = priv;
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;

        // data: a small files archive (compose dir) + the two stock-agent fixtures (TEST-ONLY key); the dashboard's manifest is signed with its REAL key
        const src = path.join(tmp, "src"); mkdirSync(path.join(src, "data"), {recursive: true});
        writeFileSync(path.join(src, "compose.yml"), "services:\n  web:\n    image: busybox\n"); writeFileSync(path.join(src, "data/hello.txt"), "hello from the backup\n");
        const tgz = path.join(tmp, "files.tar.gz"); execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
        filesPlain = readFileSync(tgz);
        const key = {privateKey: "", publicKey: "", kid: ""};
        const sk = await fileKeyProvider.signing(); key.privateKey = sk.privateKeyPem; key.publicKey = sk.publicKeyPem; key.kid = kidOfPublicKey(sk.publicKeyPem);
        const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
        const w = await seedW17World(t, "", key as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "test", roots: [ROOT], caps: ["channel.v1", "noop.v1"],
            plain: {compose_app: {sha: sha256(filesPlain), size: filesPlain.length}, volume_app_data: {sha: fx("lab-volume").plaintext_sha256, size: fx("lab-volume").plaintext_size}, db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"}},
            enrolDeps: {serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok", keys: fileKeyProvider, env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}),
                principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
        world = w; cleanBundle = w.agentBundle;
        put(w.rp, "compose_app", encryptAgentArchive(MASTER, filesPlain)); put(w.rp, "volume_app_data", fxFile("lab-volume")); put(w.rp, "db_db", fxFile("lab-postgres"));
        await startAgent(CLEAN, ST_CLEAN, w.agent, cleanBundle, true);
        vpsAgent = await seedAgent(t.pool, org, "w17-vps");
        const r = await enrolAgent({...chDeps(), principal: {userId: adminId, systemRole: "superadmin", memberships: []}}, {agentId: vpsAgent, password: PASSWORD});
        if (!r.ok) throw new Error(`enrol vps: ${r.code}`);
        vpsBundle = r.bundle; await startAgent(VPS, ST_VPS, vpsAgent, vpsBundle, false);
        await waitFor("clean agent reported restore.target.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [w.agent]))[0]?.capabilities.includes("restore.target.v1"), 120_000);
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
        const evidence = process.env.W17_EVIDENCE_DIR;
        const all = stripAnsi(logs(CLEAN)) + stripAnsi(logs(VPS)) + out;
        const clean = ![SECRET_QS.split("=")[1], MASTER.toString("base64"), decodeBundle(cleanBundle || "e30").task_key_b64 ?? "~~", decodeBundle(cleanBundle || "e30").credential ?? "~~"].some((s) => s && s !== "~~" && all.includes(s));
        if (evidence && clean) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(path.join(evidence, "w17-agent-clean.log"), stripAnsi(logs(CLEAN))); writeFileSync(path.join(evidence, "w17-agent-vps.log"), stripAnsi(logs(VPS)));
            writeFileSync(path.join(evidence, "dashboard-fork.log"), out.split("\n").filter((l) => /[Ff]ork|agent-channel/.test(l) && !/Received POST/.test(l)).join("\n"));
            writeFileSync(path.join(evidence, "lab-run.txt"), RUN.join("\n") + "\n");
        } else if (evidence) writeFileSync(path.join(tmp, "NOT-WRITTEN"), "canary found a secret in a log: evidence withheld");
        for (const n of [CLEAN, VPS]) { try { docker(["rm", "-f", n]); } catch { /* gone */ } }
        try { for (const id of docker(["ps", "-aq", "--filter", "label=com.portabase.fork.helper=true"]).split("\n").filter(Boolean)) docker(["rm", "-f", id]); } catch { /* none */ }
        try { for (const v of docker(["volume", "ls", "-q", "--filter", "label=com.portabase.fork.agent_id"]).split("\n").filter(Boolean)) docker(["volume", "rm", "-f", v]); } catch { /* none */ }
        for (const v of [ST_CLEAN, ST_VPS, REF_VOL, "w17lab_foreign", "w17lab_otherrun"]) { try { docker(["volume", "rm", "-f", v]); } catch { /* gone */ } }
        try { docker(["network", "rm", NET]); } catch { /* gone */ }
        server?.close(); child?.kill("SIGTERM"); await sleep(500); if (child?.exitCode === null) child?.kill("SIGKILL");
        await t?.drop();
        try { rootSh("rm -rf " + ROOT + "/*"); } catch { /* none */ }
        rmSync(tmp, {recursive: true, force: true});
    });

    it("L1 probe on the clean agent (restore.target.v1, root shared); the vps agent reports neither restore nor compose", async () => {
        const [clean] = await q("select capabilities from fork_agent_enrollment where agent_id=$1", [world.agent]);
        const [vps] = await q("select capabilities from fork_agent_enrollment where agent_id=$1", [vpsAgent]);
        expect(clean.capabilities).toContain("restore.target.v1");
        expect(vps.capabilities).not.toContain("restore.target.v1"); expect(vps.capabilities).not.toContain("compose.render.v1");
        const r = await enqueueRestoreTask(chDeps(), {type: "restore_probe", agentId: world.agent});
        if (!r.ok) throw new Error(r.code);
        const done = await finished(r.taskId);
        RUN.push(`L1 probe: ${JSON.stringify(done.result)}; clean caps=${clean.capabilities}; vps caps=${vps.capabilities}`);
        expect(done.status).toBe("succeeded");
        expect(done.result.roots[0]).toMatchObject({path: ROOT, shared: true});
        expect(await enqueueRestoreTask(chDeps(), {type: "restore_probe", agentId: vpsAgent})).toMatchObject({ok: false, code: "capability_missing"});
    }, 180_000);

    it("L2 stage: succeeded, checksums equal the fixtures, files extracted under the workspace, .portabase is 0700", async () => {
        const r = await enqueueRestoreTask(chDeps(), {type: "restore_stage", planId, planHash, restoreId, manifest: manifestOf()});
        if (!r.ok) throw new Error(r.code);
        const done = await finished(r.taskId);
        RUN.push(`L2 stage: ${JSON.stringify(done.result)}`);
        expect(done, JSON.stringify(done.result)).toMatchObject({status: "succeeded"});
        const shas = Object.fromEntries((done.result.staged as {role: string; plaintext_sha256: string}[]).map((s) => [s.role, s.plaintext_sha256]));
        expect(shas.volume).toBe(FX.fixtures.find((f) => f.name === "lab-volume")!.plaintext_sha256);
        expect(shas.pg_dump).toBe(FX.fixtures.find((f) => f.name === "lab-postgres")!.plaintext_sha256);
        expect(rread(path.join(composeDest, "data/hello.txt"))).toBe("hello from the backup");
        const ws = path.join(ROOT, "restore/app");
        expect(rmode(path.join(ws, ".portabase"))).toBe("700");
        expect(rexists(path.join(ws, ".portabase/stage/a0.tar.gz"))).toBe(true);
    }, 240_000);

    it("L3 apply: the volume exists with ownership + compose labels and its listing equals an independently extracted reference volume", async () => {
        const r = await enqueueRestoreTask(chDeps(), {type: "restore_apply", planId, planHash, restoreId, manifest: manifestOf()});
        if (!r.ok) throw new Error(r.code);
        const done = await finished(r.taskId);
        RUN.push(`L3 apply: ${JSON.stringify(done.result)}`);
        expect(done, JSON.stringify(done.result)).toMatchObject({status: "succeeded"});
        const v = volume(volName)!;
        expect(v.Labels).toMatchObject({"com.portabase.fork.restore_id": restoreId, "com.portabase.fork.agent_id": world.agent, "com.docker.compose.project": "app"});
        const got = listing(volName), want = listing(REF_VOL);
        RUN.push(`L3 listing (restored):\n${got}`);
        expect(got).toBe(want);
        expect(got.split("\n").length).toBe(10);
    }, 240_000);

    it("L4 isolation: a stage task signed for the vps agent but targeted at the clean one, and a stage task for the clean agent without a target, are both rejected target_mismatch; the vps log never sees the clean task", async () => {
        const payload = {v: 1, restore_id: randomUUID(), plan_id: planId, plan_hash: planHash, stack_id: world.stack, rp_id: world.rp, purpose: "restore", mode: "selective", host_role: "test", approvals: [], workspace: `${ROOT}/restore/iso`, project: "iso",
            manifest: {json_b64: Buffer.from(world.manifestJson).toString("base64"), sig_b64: world.manifestSig, sha256: world.manifestSha}, artifacts: [], paths: []};
        const a = await plant(vpsAgent, vpsBundle, "restore_stage", payload, {target: world.agent});
        const b = await plant(world.agent, cleanBundle, "restore_stage", payload, {target: null});
        const [da, db2] = [await finished(a), await finished(b)];
        RUN.push(`L4 vps-planted-for-clean: ${da.status}/${JSON.stringify(da.result)}; clean-without-target: ${db2.status}/${JSON.stringify(db2.result)}`);
        expect(da).toMatchObject({status: "rejected", result: {reason: "target_mismatch"}});
        expect(db2).toMatchObject({status: "rejected", result: {reason: "target_mismatch"}});
        expect(rexists(path.join(ROOT, "restore/iso"))).toBe(false);
        expect(stripAnsi(logs(VPS))).not.toContain(b);
    }, 240_000);

    it("L5 forged inputs: unpinned key, tampered byte, older RP manifest, swapped object — each refused with its code, nothing extracted", async () => {
        const plan = await loadPlanRow({db}, planId, planHash); if (!plan.ok) throw new Error(plan.code);
        const rows = await q("select id, source_name from fork_recovery_point_artifact where rp_id=$1 order by source_name", [world.rp]);
        const indexOf = new Map(rows.map((r, i) => [r.id as string, i]));
        const bi = (rid: string): BuildInput => ({restoreId: rid, planId, planHash, plan: plan.plan, approvals: [], indexOf});
        const urls = new Map(rows.map((r, i) => [i, `http://${GW}:${serverPort}/${world.rp}/${r.source_name}?${SECRET_QS}`]));
        const m = JSON.parse(world.manifestJson);
        let n = 0;
        const stage = async (rid: string, json: string, sig: string, sha: string) => {
            const p = buildStagePayload(bi(rid), {manifest: {jsonB64: Buffer.from(json).toString("base64"), sigB64: sig, sha256: sha}, urls});
            const proj = `forge${++n}`; // one workspace per case: a workspace belongs to ONE restore_id
            const dest = {...p, workspace: `${ROOT}/restore/${proj}`, project: proj, paths: [], artifacts: p.artifacts.slice(0, 1)};
            return finished(await plant(world.agent, cleanBundle, "restore_stage", dest, {target: world.agent}));
        };
        const other = testKeypair();
        const forged = signManifest({...m, kid: other.kid}, other.privateKey);
        const r1 = await stage(randomUUID(), forged.json, forged.sig.toString("base64"), sha256(forged.json));
        const tampered = world.manifestJson.replace('"app"', '"apq"');
        const r2 = await stage(randomUUID(), tampered, world.manifestSig, sha256(tampered));
        const sk = await fileKeyProvider.signing();
        const olderRp = signManifest({...m, rp: {...m.rp, id: randomUUID()}}, sk.privateKeyPem);
        const r3 = await stage(randomUUID(), olderRp.json, olderRp.sig.toString("base64"), sha256(olderRp.json));
        RUN.push(`L5 forged: ${[r1, r2, r3].map((r) => `${r.status}:${r.result.reason}`).join(", ")}`);
        expect([r1.result.reason, r2.result.reason, r3.result.reason]).toEqual(["manifest_unknown_kid", "manifest_signature", "manifest_mismatch"]);
        // object swapped on the storage side: the agent's checksum comparison stops it before extraction
        const key = `/${world.rp}/compose_app`;
        const good = objects.get(key)!;
        objects.set(key, {body: fxFile("lab-postgres"), hits: 0});
        const swapped = await stage(randomUUID(), world.manifestJson, world.manifestSig, world.manifestSha);
        objects.set(key, good);
        RUN.push(`L5 swapped object: ${swapped.status}:${swapped.result.reason} artifact=${swapped.result.artifact}`);
        expect(swapped).toMatchObject({status: "failed", result: {reason: "checksum_mismatch", artifact: 0}});
        expect(rexists(path.join(ROOT, "restore/forge4/.portabase/stage/a0.tar.gz"))).toBe(false); // the swapped object was never staged
        expect(rexists(path.join(ROOT, "restore/forge1/.portabase/stage/a0.tar.gz")) || rexists(path.join(ROOT, "restore/forge2/.portabase/stage/a0.tar.gz")) || rexists(path.join(ROOT, "restore/forge3/.portabase/stage/a0.tar.gz"))).toBe(false);
    }, 360_000);

    it("L7 cleanup: foreign volumes survive; the owned volume and the workspace are removed", async () => {
        docker(["volume", "create", "w17lab_foreign"]);
        docker(["volume", "create", "--label", `com.portabase.fork.restore_id=${randomUUID()}`, "--label", `com.portabase.fork.agent_id=${world.agent}`, "w17lab_otherrun"]);
        const r = await enqueueRestoreTask(chDeps(), {type: "restore_cleanup", planId, planHash, restoreId, cleanup: {workspace: true, volumes: true, networks: true, containers: false}});
        if (!r.ok) throw new Error(r.code);
        const done = await finished(r.taskId);
        RUN.push(`L7 cleanup: ${JSON.stringify(done.result)}`);
        expect(done, JSON.stringify(done.result)).toMatchObject({status: "succeeded"});
        expect(volume(volName)).toBeNull();
        expect(volume("w17lab_foreign")).not.toBeNull(); expect(volume("w17lab_otherrun")).not.toBeNull();
        expect(rexists(path.join(ROOT, "restore/app"))).toBe(false);
    }, 240_000);

    it("L6 kill + restart: tmp/ and secret/ are swept, the journal shows abort, and a new stage with the same restore_id skips the finished artifact", async () => {
        // a second world whose LAST artifact is large and trickled; the first (small) artifact finishes and is journaled
        const sk = await fileKeyProvider.signing(); const key = {privateKey: sk.privateKeyPem, publicKey: sk.publicKeyPem, kid: kidOfPublicKey(sk.publicKeyPem)};
        const pad = randomBytes(40 * 1024 * 1024); const padTgz = path.join(tmp, "pad.tar.gz"); const padDir = path.join(tmp, "pad"); mkdirSync(path.join(padDir, "vol"), {recursive: true}); writeFileSync(path.join(padDir, "vol/blob.bin"), pad);
        execFileSync("tar", ["-czf", padTgz, "-C", padDir, "vol"]); const padPlain = readFileSync(padTgz);
        const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
        const w2 = await seedW17World(t, "", key as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "test", roots: [ROOT], caps: ["channel.v1", "noop.v1"],
            plain: {compose_app: {sha: sha256(filesPlain), size: filesPlain.length}, db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"}, volume_app_data: {sha: sha256(padPlain), size: padPlain.length}},
            enrolDeps: {serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok", keys: fileKeyProvider, env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}), principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
        // the second world's target agent is a NEW dashboard agent row; reuse the running clean agent container by re-pointing is not possible, so run this world's stage on a second clean container
        const C2 = "w17-agent-clean2", ST2 = "w17-agent-clean2-state";
        try { docker(["rm", "-f", C2]); } catch { /* none */ } try { docker(["volume", "rm", "-f", ST2]); } catch { /* none */ }
        put(w2.rp, "compose_app", encryptAgentArchive(MASTER, filesPlain)); put(w2.rp, "db_db", fxFile("lab-postgres")); put(w2.rp, "volume_app_data", encryptAgentArchive(MASTER, padPlain), true);
        await startAgent(C2, ST2, w2.agent, w2.agentBundle, true);
        try {
            await waitFor("second clean agent restore.target.v1", async () => (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [w2.agent]))[0]?.capabilities.includes("restore.target.v1"), 120_000);
            const prev = world; world = w2;
            const c = await makePlan(w2, {restore_root: `${ROOT}/restore2`}); const rid = randomUUID();
            const r = await enqueueRestoreTask(chDeps(), {type: "restore_stage", planId: c.planId, planHash: c.planHash, restoreId: rid, manifest: {json: w2.manifestJson, sigB64: w2.manifestSig}});
            if (!r.ok) throw new Error(r.code);
            await waitFor("padding download started", async () => (objects.get(`/${w2.rp}/volume_app_data`)?.hits ?? 0) > 0 && stateFile(ST2, `fork-restore/${rid}.jsonl`).includes('"artifact:'), 120_000);
            docker(["kill", C2]);
            const hitsBefore = { small: objects.get(`/${w2.rp}/compose_app`)!.hits };
            docker(["start", C2]);
            await waitFor("journal abort after restart", async () => stateFile(ST2, `fork-restore/${rid}.jsonl`).includes('"ev":"abort"'), 120_000);
            const journal = stateFile(ST2, `fork-restore/${rid}.jsonl`);
            RUN.push(`L6 journal after kill+restart:\n${journal}`);
            const ws2 = path.join(ROOT, "restore2/app");
            expect(rexists(path.join(ws2, ".portabase/secret"))).toBe(false); expect(rexists(path.join(ws2, ".portabase/tmp"))).toBe(false);
            expect(journal).toContain('"reason":"restart"');
            // the interrupted task's lease lapses and the dashboard re-offers it: the agent re-reports its stored outcome / or a fresh stage with the same restore_id completes
            objects.get(`/${w2.rp}/volume_app_data`)!.slow = false;
            const again = await enqueueRestoreTask(chDeps(), {type: "restore_stage", planId: c.planId, planHash: c.planHash, restoreId: rid, manifest: {json: w2.manifestJson, sigB64: w2.manifestSig}});
            if (!again.ok) throw new Error(again.code);
            const done = await finished(again.taskId, 240_000);
            RUN.push(`L6 second stage (same restore_id): ${done.status} ${JSON.stringify(done.result)}; small artifact downloads before=${hitsBefore.small} after=${objects.get(`/${w2.rp}/compose_app`)!.hits}`);
            expect(done, JSON.stringify(done.result)).toMatchObject({status: "succeeded"});
            expect(objects.get(`/${w2.rp}/compose_app`)!.hits).toBe(hitsBefore.small); // the finished artifact was NOT downloaded again
            world = prev;
        } finally { try { docker(["rm", "-f", C2]); } catch { /* gone */ } try { docker(["volume", "rm", "-f", ST2]); } catch { /* gone */ } }
    }, 900_000);

    it("L8 canary: no presigned query, master key, task key or credential appears in the agent or dashboard logs", async () => {
        const all = stripAnsi(logs(CLEAN)) + stripAnsi(logs(VPS)) + out;
        const secrets = {presigned: SECRET_QS.split("=")[1], master: MASTER.toString("base64"), taskKey: decodeBundle(cleanBundle).task_key_b64, credential: decodeBundle(cleanBundle).credential};
        for (const [name, s] of Object.entries(secrets)) expect(all.includes(s), `${name} in logs`).toBe(false);
        RUN.push("L8 canary: presigned query, master key, task key and credential absent from agent + dashboard logs");
    });
});
