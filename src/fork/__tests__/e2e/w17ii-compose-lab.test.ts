import {execFileSync, spawn, type ChildProcess} from "node:child_process";
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
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import {decryptAgentArchive, encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {req} from "@/fork/__tests__/w16-world";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

/**
* LIVE W17-ii test (FORK_LAB=1, docker-bridge lab ONLY, synthetic TEST-ONLY data, never the owner's hosts): the REAL fork dashboard (production build) +
 * the REAL fork agent image (`W17_AGENT_IMAGE`) on a dedicated docker network. Artifacts are served by an in-test http server on the bridge gateway
 * (it can swap an object and trickle a large one; MinIO is not needed to prove the agent). Restores land in `W17_ROOT` (a temp dir bind-mounted at the SAME path).
 *   L1 probe + capabilities · L2 stage · L3 apply · L4 isolation · L5 forged inputs · L6 kill + restart · L7 cleanup · L8 canary.
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, the agent image.
 */
const LAB = process.env.FORK_LAB === "1";
const IMAGE = process.env.W17_AGENT_IMAGE ?? "portabase-agent-fork:w17ii-lab";
const NET = "w17ii-lab-net", SUBNET = "172.31.251.0/24", GW = "172.31.251.1";
const CLEAN = "w17ii-agent-clean", VPS = "w17ii-agent-vps", ST_CLEAN = "w17ii-agent-clean-state", ST_VPS = "w17ii-agent-vps-state", REF_VOL = "w17iilab_ref";
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

describe.skipIf(!LAB)("W17-ii live: compose render, policy re-check, restore_db, compose up, cleanup on the fork image", () => {
    let world: W17; let planId = ""; let planHash = ""; let cleanBundle = ""; let vpsAgent = ""; let vpsBundle = ""; let volName = ""; let composeDest = "";
    const restoreId = randomUUID();
    let filesPlain = Buffer.alloc(0);

    const put = (rp: string, name: string, body: Buffer, slow = false) => { objects.set(`/${rp}/${name}`, {body, slow, hits: 0}); };
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
        tmp = mkdtempSync(path.join(os.tmpdir(), "w17ii-lab-")); priv = path.join(tmp, "private");
        ROOT = path.join(tmp, "w17ii-root"); mkdirSync(ROOT, {recursive: true});
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
            rs.writeHead(200, {"content-length": o.body.length});
            if (!o.slow) { rs.end(o.body); return; }
            let off = 0; const tick = () => { if (off >= o.body.length) { rs.end(); return; } rs.write(o.body.subarray(off, off + 65536)); off += 65536; setTimeout(tick, 40); }; tick();
        }).listen(serverPort, GW);
        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        const port = await freePort(); base = `http://${GW}:${port}`;
        child = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {...process.env, NODE_ENV: "production", DATABASE_URL: t.url,
            PROJECT_URL: URL_FOR_AGENTS(), PROJECT_SECRET: `w17ii-lab-${randomBytes(12).toString("hex")}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
            AUTH_DEFAULT_USER_NAME: "W17 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
            FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300"}});
        child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
        await waitFor("dashboard ready", async () => out.includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
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
        const w = await seedW17World(t, "", key as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "test", roots: [ROOT], caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"],
            plain: {compose_app: {sha: sha256(filesPlain), size: filesPlain.length}, volume_app_data: {sha: fx("lab-volume").plaintext_sha256, size: fx("lab-volume").plaintext_size}, db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"}},
            enrolDeps: {serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok", keys: fileKeyProvider, env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60}),
                principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
        world = w; cleanBundle = w.agentBundle;
        put(w.rp, "compose_app", encryptAgentArchive(MASTER, filesPlain)); put(w.rp, "volume_app_data", fxFile("lab-volume")); put(w.rp, "db_db", fxFile("lab-postgres"));
        await startAgent(CLEAN, ST_CLEAN, w.agent, cleanBundle, true);
        vpsAgent = await seedAgent(t.pool, org, "w17ii-vps");
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
        const evidence = process.env.W17_EVIDENCE_DIR;
        const all = stripAnsi(logs(CLEAN)) + stripAnsi(logs(VPS)) + out;
        const clean = ![SECRET_QS.split("=")[1], MASTER.toString("base64"), decodeBundle(cleanBundle || "e30").task_key_b64 ?? "~~", decodeBundle(cleanBundle || "e30").credential ?? "~~"].some((s) => s && s !== "~~" && all.includes(s));
        if (evidence && clean) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(path.join(evidence, "w17ii-agent-clean.log"), stripAnsi(logs(CLEAN))); writeFileSync(path.join(evidence, "w17ii-agent-vps.log"), stripAnsi(logs(VPS)));
            writeFileSync(path.join(evidence, "dashboard-fork-w17ii.log"), out.split("\n").filter((l) => /[Ff]ork|agent-channel/.test(l) && !/Received POST/.test(l)).join("\n"));
            writeFileSync(path.join(evidence, "lab-run-w17ii.txt"), RUN.join("\n") + "\n");
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

    // ---- helpers of the W17-ii cases -----------------------------------------------------------------------------------------------------------
    const wsDir = () => `${ROOT}/restore/app`;
    const DEMO = path.join(process.cwd(), "dev/fork-lab/demo-stack");
    const STACK_ENV = Object.fromEntries(readFileSync(path.join(DEMO, "stack.env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
    const enq = async (type: string, extra: Record<string, unknown> = {}) => {
        const r = await enqueueRestoreTask(chDeps(), {type, planId, planHash, restoreId, ...(type === "restore_cleanup" ? {} : {manifest: manifestOf()}), ...extra} as never);
        return r;
    };
    const run = async (type: string, extra: Record<string, unknown> = {}) => {
        const r = await enq(type, extra);
        if (!r.ok) return {refused: r.code} as {refused: string};
        const x = await finished(r.taskId);
        return {id: r.taskId, status: x.status as string, result: x.result as Record<string, any>};
    };
    const rows = async () => (await q("select task_id, rendered_sha256, policy_view from fork_compose_render where restore_id=$1 order by created_at", [restoreId]));
    const dc = (n: string, ...args: string[]) => { try { return docker([n, ...args]); } catch (e) { return String((e as {stderr?: string}).stderr ?? e); } };
    const psql = (sql: string) => docker(["exec", "app-db-1", "sh", "-c", `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${sql}"`]);

    it("N1 probe: the clean agent reports compose.render.v1 + Compose 5.4.0 + the TS rules hash; the vps agent reports neither restore nor compose", async () => {
        const caps = (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [world.agent]))[0].capabilities as string[];
        expect(caps).toEqual(expect.arrayContaining(["restore.target.v1", "compose.render.v1"]));
        const vcaps = (await q("select capabilities from fork_agent_enrollment where agent_id=$1", [vpsAgent]))[0].capabilities as string[];
        expect(vcaps.some((c) => c === "compose.render.v1" || c === "restore.target.v1")).toBe(false);
        const p = await enqueueRestoreTask(chDeps(), {type: "restore_probe", agentId: world.agent});
        if (!p.ok) throw new Error(p.code);
        const x = await finished(p.taskId);
        const {RULES_SHA256} = await import("@/fork/policy/rules");
        expect(x.status).toBe("succeeded");
        expect(x.result).toMatchObject({compose_version: "5.4.0", rules_sha256: RULES_SHA256});
        RUN.push(`N1 caps=${caps.join(",")} compose_version=${x.result.compose_version} rules_sha256=${x.result.rules_sha256 === RULES_SHA256 ? "== TS RULES_SHA256" : "DIFFERENT"}`);
    });

    it("N2 stage + apply (W17-i path) with the new_stack plan", async () => {
        const s = await run("restore_stage");
        expect(s).toMatchObject({status: "succeeded"});
        const a = await run("restore_apply");
        expect(a).toMatchObject({status: "succeeded"});
        expect(rexists(`${wsDir()}/compose/compose.yml`)).toBe(true);
        RUN.push(`N2 stage=${(s as {status: string}).status} apply=${(a as {status: string}).status} volume=${volName}`);
    });

    it("N3 render: policy view stored, isPolicyView, hash equal, TS verdict allow; canary (DB password) absent from the row, the dashboard log and the agent log", async () => {
        const r = await run("compose_render");
        expect(r).toMatchObject({status: "succeeded"});
        const row = (await rows()).at(-1)!;
        const {isPolicyView} = await import("@/fork/restore-tasks/view");
        const {renderVerdict} = await import("@/fork/restore-tasks/render");
        expect(isPolicyView(JSON.parse(row.policy_view))).toBe(true);
        expect(row.rendered_sha256).toBe((r as {result: Record<string, any>}).result.rendered_sha256);
        const [full] = await q("select * from fork_compose_render where task_id=$1", [row.task_id]);
        const verdict = renderVerdict({taskId: full.task_id, agentId: full.agent_id, restoreId: full.restore_id, policyView: full.policy_view, renderedSha256: full.rendered_sha256, raw: full.raw, roots: full.roots, files: full.files, composeVersion: full.compose_version, agentRulesSha256: full.agent_rules_sha256, createdAt: full.created_at}, wsDir());
        expect([verdict.verdict, verdict.hard.length]).toEqual(["allow", 0]);
        expect((r as {result: Record<string, any>}).result.verdict).toBe("allow");
        const canary = STACK_ENV.POSTGRES_PASSWORD;
        expect(row.policy_view).not.toContain(canary);
        expect(JSON.stringify(await q("select * from fork_audit_event"))).not.toContain(canary);
        expect(stripAnsi(logs(CLEAN)) + out).not.toContain(canary);
        RUN.push(`N3 render ok sha=${row.rendered_sha256.slice(0, 12)} verdict=${verdict.verdict} findings=${verdict.findings.length} view_bytes=${row.policy_view.length}`);
    });

    it("N4 raw poison: a restored override file with env_file outside the root ⇒ agent failed:raw_refused (kind env_file), no new render row, no helper container", async () => {
        const before = (await rows()).length;
        rootSh(`printf 'services:\\n  web:\\n    env_file: /etc/hostname\\n' > '${wsDir()}/compose/compose.override.yml'`);
        const r = await run("compose_render");
        expect(r).toMatchObject({status: "failed"});
        const x = r as {result: Record<string, any>};
        expect(x.result).toMatchObject({reason: "raw_refused"});
        expect(x.result.raw.violations[0].kind).toBe("env_file");
        expect((await rows()).length).toBe(before);
        expect(docker(["ps", "-aq", "--filter", "label=com.portabase.fork.helper=true"]).trim()).toBe("");
        rootSh(`rm -f '${wsDir()}/compose/compose.override.yml'`);
        RUN.push(`N4 raw_refused kind=${x.result.raw.violations[0].kind} rows_before=${before} rows_after=${(await rows()).length}`);
    });

    it("N5 rendered poison: privileged service ⇒ needs-explicit-override; compose_up without a token is refused by the dashboard AND by a planted task on the agent; nothing is started", async () => {
        rootSh(`printf 'services:\\n  web:\\n    privileged: true\\n' > '${wsDir()}/compose/compose.override.yml'`);
        const r = await run("compose_render");
        expect(r).toMatchObject({status: "succeeded"});
        const res = (r as {result: Record<string, any>}).result;
        expect(res.verdict).toBe("needs-explicit-override");
        expect(res.findings).toEqual(expect.arrayContaining([{service: "web", rule: "privileged"}]));
        expect(await enq("compose_up", {approval: null})).toMatchObject({ok: false, code: "approval_invalid"});
        const plan = await loadPlanRow({db}, planId, planHash); if (!plan.ok) throw new Error(plan.code);
        const header = {v: 1, restore_id: restoreId, plan_id: planId, plan_hash: planHash, stack_id: world.stack, rp_id: world.rp, purpose: plan.plan.purpose, mode: plan.plan.mode, host_role: "test", approvals: [], workspace: wsDir(), project: "app"};
        const planted = await plant(world.agent, cleanBundle, "compose_up", {...header, manifest_sha256: world.manifestSha, compose: {dir: `${wsDir()}/compose`, override_yml: null, env: {}, path_map: []}, compose_sha256: res.rendered_sha256, approval: null, volumes: []}, {target: world.agent});
        const x = await finished(planted);
        expect(x.status).toBe("failed");
        expect(x.result).toMatchObject({reason: "approval_invalid", detail: "none"});
        expect(docker(["ps", "-aq", "--filter", "label=com.docker.compose.project=app"]).trim()).toBe("");
        rootSh(`rm -f '${wsDir()}/compose/compose.override.yml'`);
        RUN.push(`N5 verdict=${res.verdict} findings=${JSON.stringify(res.findings)} dashboard=approval_invalid agent=approval_invalid:none project_containers=0`);
    });

    it("N6 restore_db (-Fc): the demo database is restored inside the stack's own db container and its content hash equals the fixture's expectation", async () => {
        expect(await run("compose_render")).toMatchObject({status: "succeeded"});
        const r = await run("restore_db", {approval: null});
        RUN.push(`N6 restore_db ${JSON.stringify(r)}`);
        expect(r).toMatchObject({status: "succeeded"});
        const out1 = psql("select string_agg(id||chr(58)||payload, chr(44) order by id) from items");
        // independent reference: the same fixture dump restored by the TEST into a throwaway postgres
        const {createHash} = await import("node:crypto");
        const plainTgz = decryptAgentArchive(MASTER, fxFile("lab-postgres"));
        const dump = execFileSync("sh", ["-c", "tar -xzOf - --wildcards '*.dump'"], {input: plainTgz, maxBuffer: 1 << 28});
        try { docker(["rm", "-f", "w17ii-refpg"]); } catch { /* none */ }
        docker(["run", "-d", "--name", "w17ii-refpg", "-e", `POSTGRES_USER=${STACK_ENV.POSTGRES_USER}`, "-e", `POSTGRES_PASSWORD=${STACK_ENV.POSTGRES_PASSWORD}`, "-e", `POSTGRES_DB=${STACK_ENV.POSTGRES_DB}`, "postgres:17-alpine"]);
        await waitFor("reference pg ready", async () => { try { docker(["exec", "w17ii-refpg", "sh", "-c", 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"']); return true; } catch { return false; } }, 60_000);
        await sleep(3000);
        docker(["exec", "-i", "w17ii-refpg", "sh", "-c", 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner'], process.env, dump);
        const ref = docker(["exec", "w17ii-refpg", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"']);
        try { docker(["rm", "-f", "w17ii-refpg"]); } catch { /* gone */ }
        const rows = psql("select count(*) from items").trim();
        RUN.push(`N6 items rows=${rows} sha256(restored)=${createHash("sha256").update(out1).digest("hex").slice(0, 16)} sha256(reference restore)=${createHash("sha256").update(ref).digest("hex").slice(0, 16)}`);
        expect(Number(rows)).toBeGreaterThan(0);
        expect(createHash("sha256").update(out1).digest("hex")).toBe(createHash("sha256").update(ref).digest("hex"));
    });

    it("N7 compose_up: the stack runs, every container / volume / network of the project carries the owner labels, restored volume content is intact, literal $ survived", async () => {
        const r = await run("compose_up", {approval: null});
        RUN.push(`N7 compose_up ${JSON.stringify(r).slice(0, 400)}`);
        expect(r).toMatchObject({status: "succeeded"});
        const ps = docker(["ps", "-a", "--filter", "label=com.docker.compose.project=app", "--format", "{{.Names}}|{{.State}}|{{.Label \"com.portabase.fork.restore_id\"}}"]).trim().split("\n");
        expect(ps.sort().join(";")).toBe([`app-db-1|running|${restoreId}`, `app-web-1|running|${restoreId}`].join(";"));
        for (const v of docker(["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=app"]).trim().split("\n").filter(Boolean)) expect(volume(v)!.Labels["com.portabase.fork.restore_id"]).toBe(restoreId);
        expect(listing(volName)).toBe(listing(REF_VOL).replaceAll("./", "./")); // R-i: the restored volume is intact after `up`
        const hc = JSON.parse(docker(["inspect", "-f", "{{json .Config.Healthcheck.Test}}", "app-db-1"]));
        expect(JSON.stringify(hc)).toContain("${POSTGRES_USER}"); // R-b: the compose file's `$${POSTGRES_USER}` reached the container as the literal `${POSTGRES_USER}` (one `$`, not two)
        expect(JSON.stringify(hc)).not.toContain("$$");
        RUN.push(`N7 containers=${ps.join(",")} healthcheck=${JSON.stringify(hc)}`);
    });

    it("N8 guard: a foreign container with the same container_name ⇒ container_conflict; the foreign container and the agent keep running", async () => {
        docker(["run", "-d", "--name", "w17ii-foreign", "busybox", "sleep", "3600"]);
        rootSh(`printf 'services:\\n  web:\\n    container_name: w17ii-foreign\\n' > '${wsDir()}/compose/compose.override.yml'`);
        expect(await run("compose_render")).toMatchObject({status: "succeeded"});
        const r = await run("compose_up", {approval: null});
        expect(r).toMatchObject({status: "failed", result: {reason: "container_conflict"}});
        expect(docker(["inspect", "-f", "{{.State.Running}}", "w17ii-foreign"]).trim()).toBe("true");
        expect(docker(["inspect", "-f", "{{.State.Running}}", CLEAN]).trim()).toBe("true");
        rootSh(`printf 'services:\\n  web:\\n    container_name: ${CLEAN}\\n' > '${wsDir()}/compose/compose.override.yml'`);
        expect(await run("compose_render")).toMatchObject({status: "succeeded"});
        expect(await run("compose_up", {approval: null})).toMatchObject({status: "failed", result: {reason: "protected_container"}});
        expect(docker(["inspect", "-f", "{{.State.Running}}", CLEAN]).trim()).toBe("true");
        rootSh(`rm -f '${wsDir()}/compose/compose.override.yml'`);
        RUN.push("N8 container_conflict + protected_container; foreign and agent still running");
    });

    it("N9 isolation: a compose_up signed for the vps agent but targeted at the clean one, and one without a target, are rejected target_mismatch", async () => {
        const header = {v: 1, restore_id: restoreId, plan_id: planId, plan_hash: planHash, stack_id: world.stack, rp_id: world.rp, purpose: "restore", mode: "new_stack", host_role: "test", approvals: [], workspace: wsDir(), project: "app"};
        const body = {...header, manifest_sha256: world.manifestSha, compose: {dir: `${wsDir()}/compose`, override_yml: null, env: {}, path_map: []}, compose_sha256: "0".repeat(64), approval: null, volumes: []};
        const a = await plant(vpsAgent, vpsBundle, "compose_up", body, {target: world.agent});
        const b = await plant(world.agent, cleanBundle, "compose_up", body);
        const [ra, rb] = [await finished(a), await finished(b)];
        RUN.push(`N9 vps_signed=${JSON.stringify(ra.result)} no_target=${JSON.stringify(rb.result)}`);
        expect([ra.status, rb.status]).toEqual(["rejected", "rejected"]);
        expect([ra.result?.reason, rb.result?.reason]).toEqual(["target_mismatch", "target_mismatch"]);
    });

    it("N10 cleanup (containers, volumes, networks, workspace): owned resources are gone, the foreign container survives, the agent keeps running", async () => {
        const r = await run("restore_cleanup", {cleanup: {workspace: true, volumes: true, networks: true, containers: true}});
        RUN.push(`N10 cleanup ${JSON.stringify(r)}`);
        expect(r).toMatchObject({status: "succeeded"});
        expect(docker(["ps", "-aq", "--filter", "label=com.docker.compose.project=app"]).trim()).toBe("");
        expect(docker(["volume", "ls", "-q", "--filter", "label=com.portabase.fork.agent_id"]).trim()).toBe("");
        expect(rexists(wsDir())).toBe(false);
        expect(docker(["inspect", "-f", "{{.State.Running}}", "w17ii-foreign"]).trim()).toBe("true");
        expect(docker(["inspect", "-f", "{{.State.Running}}", CLEAN]).trim()).toBe("true");
        docker(["rm", "-f", "w17ii-foreign"]);
    });

    it("N11 canary: no DB password, presigned query, master key, task key or credential in the agent or dashboard logs; secret/ never kept", async () => {
        const all = stripAnsi(logs(CLEAN)) + stripAnsi(logs(VPS)) + out;
        for (const s of [STACK_ENV.POSTGRES_PASSWORD, SECRET_QS.split("=")[1], MASTER.toString("base64"), decodeBundle(cleanBundle).task_key_b64, decodeBundle(cleanBundle).credential]) expect(all.includes(s as string), `canary leaked`).toBe(false);
        RUN.push("N11 canaries absent from agent + dashboard logs");
    });
});
