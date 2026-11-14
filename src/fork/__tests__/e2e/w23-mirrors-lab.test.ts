import {execFileSync, spawn, spawnSync, type ChildProcess} from "node:child_process";
import {createPrivateKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from "node:fs";
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
import type {MirrorDeps} from "@/fork/mirror/deps";
import {createMirror, deleteMirror} from "@/fork/mirror/service";
import {tickAllMirrors} from "@/fork/mirror/tick";
import {designateRunner, requestRunnerProbe, runnerIsolation, setRunnerTargets, type RunnerDeps} from "@/fork/runner/service";
import {encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import type {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {seedUser} from "@/fork/__tests__/w16-world";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

// ponytail: copy of the W22b lab setup (unique names/subnets 172.31.251/252); extract shared helpers if a fourth mirror lab appears.
/**
 * LIVE W23 lab (FORK_LAB=1, docker lab ONLY, synthetic TEST-ONLY data, never a real host): the REAL fork dashboard (production build) + the REAL fork agent image as a MIRROR RUNNER inside the
 * docker-in-docker runner box (nftables egress policy in the box's netns). The orchestrator tick (incl. the W23 delete tick) runs in THIS process with the W22a storage seams (synthetic RP).
 * Real-VM proof stays PENDING-HUMAN (#125).
 *   L-A1 list + four detail tabs for a real READY mirror (+ canary) · L-A2 delete = verified wipe of the runner copy, a DECOY of another owner survives, name + port reusable ·
 *   L-A3 delete while configuration is locked · HOLD (browser pass, W23_LAB_HOLD=1).
 */
const LAB = process.env.FORK_LAB === "1";
const AGENT_IMAGE = process.env.W23_AGENT_IMAGE ?? "portabase-agent-fork:w22a-lab";
const GW = "172.31.251.1";
const W23_SH = path.join(process.cwd(), "dev/fork-lab/runner/w23.sh");
const BOX = "w23-runner", PROD_AGENT = "w23-agent-prod";
const MIRROR_ROOT = "/srv/portabase-mirrors";
const PROD_PW = "demo-synthetic-not-a-secret"; // the production POSTGRES_PASSWORD inside the demo stack's stack.env
const SECRET_QS = `X-Amz-Signature=${randomBytes(12).toString("hex")}SECRETSIG`;
const NONCE = randomBytes(6).toString("hex");
const HOLD = process.env.W23_LAB_HOLD === "1"; const SCRATCH = process.env.W23_SCRATCH ?? "";
const MEMBER = {email: "member@w23-lab.test", password: "w23-member-pw-1!"}, ORGADMIN = {email: "orgadmin@w23-lab.test", password: "w23-orgadmin-pw-1!"}; // test-only
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[], o: {env?: NodeJS.ProcessEnv; input?: string} = {}) => execFileSync(cmd, args, {encoding: "utf8", env: o.env ?? process.env, input: o.input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024}).trim();
const docker = (args: string[]) => sh("docker", args);
const inbox = (args: string[]) => docker(["exec", BOX, ...args]);
const lab = (args: string[], env: Record<string, string> = {}, input?: string) => sh("bash", [W23_SH, ...args], {env: {...process.env, W23_AGENT_IMAGE: AGENT_IMAGE, ...env}, input});
const logs = (name: string) => { const r = spawnSync("docker", ["logs", name], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024}); return `${r.stdout ?? ""}${r.stderr ?? ""}`; };
const freePort = (host: string) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
const FX = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {name: string; file: string; plaintext_sha256: string; plaintext_size: number}[]};
const fxFile = (n: string) => readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures", FX.fixtures.find((f) => f.name === n)!.file));
const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
const MASTER = Buffer.from(FX.master_key_b64, "base64");

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let tmp = ""; let priv = ""; let base = ""; let org = ""; let adminId = ""; let dashPort = 0; let artPort = 0; let server: http.Server;
let poisonWorld: W17 | undefined; let orgAdminId = ""; const orgAdminP = () => ({userId: orgAdminId, systemRole: "user" as const, memberships: [{organizationId: org, role: "admin"}]});
let forwarder: net.Server | undefined; let runnerAgent = ""; let prodAgent = ""; let runnerBundle = ""; let prodBundle = ""; let world: W17;
const worlds = new Map<string, W17>();
const objects = new Map<string, {body: Buffer; hits: number; holdMs?: number}>();
const RUN: string[] = [];
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const urlForAgents = () => `http://forklab-dashboard.localhost:${dashPort}`;
const ENV = {FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60};
const superP = () => ({userId: adminId, systemRole: "superadmin" as const, memberships: [{organizationId: org, role: "admin"}]});
const rdeps = (): RunnerDeps => ({db, principal: superP(), keys: fileKeyProvider, serverUrl: urlForAgents, stepUp: async () => "ok", env: () => ENV, configAllowed: async () => true, mirrorsEnabled: () => true, rate: (() => ({ok: true})) as never});
const mdeps = (over: Partial<MirrorDeps> = {}): MirrorDeps => ({...rdeps(), artifactUrl: async (sid) => { const [a] = await q("select rp_id, source_name from fork_recovery_point_artifact where backup_storage_id=$1", [sid]); return `http://${GW}:${artPort}/${a.rp_id}/${a.source_name}?${SECRET_QS}`; },
    manifest: async (rp) => { const w = worlds.get(rp.id) ?? world; return {json: w.manifestJson, sigB64: w.manifestSig}; }, principalOf: async (id) => (id === adminId ? {kind: "ok", principal: superP()} : {kind: "missing"}), ...over});
/** the HOLD orchestrator deps: NO principalOf override (the real readPrincipal re-authorises the browser user) */
const holdDeps = (): MirrorDeps => { const {principalOf: _p, ...d} = mdeps(); return d; };
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-8).join("\n").slice(-1500)}\n--- runner agent ---\n${stripAnsi(sh("docker", ["exec", BOX, "docker", "logs", "runner-agent"])).split("\n").slice(-14).join(" | ").slice(-2500)}`);
        await sleep(1000);
    }
}
async function startDashboard() {
    const env: NodeJS.ProcessEnv = {...process.env, NODE_ENV: "production", DATABASE_URL: t.url, PROJECT_URL: urlForAgents(), PROJECT_SECRET: `w23-lab-${randomBytes(12).toString("hex")}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
        AUTH_DEFAULT_USER_NAME: "W23 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_MIRRORS_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
        FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300", FORK_RESTORE_TICK_SECONDS: "0", FORK_TEST_RESTORE_TICK_SECONDS: "0", FORK_MIRROR_TICK_SECONDS: "0"};
    child = spawn("pnpm", ["exec", "next", "start", "-p", String(dashPort), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env});
    child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
    await waitFor("dashboard ready", async () => out.includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
}
async function stopDashboard() {
    const c = child; if (!c || c.exitCode !== null) return;
    const gone = new Promise<void>((res) => c.once("exit", () => res())); c.kill("SIGTERM");
    const k = setTimeout(() => c.kill("SIGKILL"), 10_000); await gone; clearTimeout(k);
}
const edgeKeyOf = (agentId: string) => Buffer.from(JSON.stringify({serverUrl: urlForAgents(), agentId, masterKeyB64: MASTER.toString("base64")})).toString("base64url");
/** a SIGNED task planted straight into the queue (the dashboard code signs it; the AGENT decides): only for the role-gating cases */
async function plant(agentId: string, bundleStr: string, type: string, payload: unknown, requires: string[], target: string) {
    const [e] = await q("select enroll_id from fork_agent_enrollment where agent_id=$1", [agentId]);
    const [{seq}] = await q("update fork_agent_enrollment set next_seq=next_seq+1 where agent_id=$1 returning next_seq-1 as seq", [agentId]);
    const sk = await fileKeyProvider.signing(); const kid = kidOfPublicKey(sk.publicKeyPem);
    const taskId = randomUUID(); const pt = Buffer.from(JSON.stringify(payload)); const now = Math.floor(Date.now() / 1000);
    const env = EnvelopeSchema.parse({v: 1, task_id: taskId, agent_id: agentId, enroll_id: e.enroll_id, type, seq, issued_at: now - 5, not_after: now + 1800, nonce: randomBytes(16).toString("base64url"), payload_sha256: payloadSha256(pt), requires, kid, target_agent_id: target});
    const text = canonicalJson({...env, requires: [...env.requires].sort()});
    const signature = rsaSign("sha256", Buffer.from(SIGN_DOMAIN + text), createPrivateKey(sk.privateKeyPem)).toString("base64");
    await q(`insert into fork_agent_task (id, agent_id, agent_name, enroll_id, type, requires, seq, envelope_text, signature, kid, payload_enc, payload_sha256, status, created_by, not_after)
             values ($1,$2,'planted',$3,$4,$11::text[],$5,$6,$7,$8,$9,$10,'queued','lab', now() + interval '30 minutes')`,
        [taskId, agentId, e.enroll_id, type, seq, text, signature, kid, encryptPayload(Buffer.from(decodeBundle(bundleStr).task_key_b64, "base64"), {taskId, agentId, type}, pt), env.payload_sha256, requires]);
    return taskId;
}
const task = async (id: string) => (await q("select status, result from fork_agent_task where id=$1", [id]))[0];
const finished = (id: string) => waitFor(`task ${id} final`, async () => { const x = await task(id); return x && !["queued", "leased", "running"].includes(x.status) ? x : null; }, 180_000);
const evidenceDir = () => process.env.LAB_EVIDENCE_DIR;
const keep = (name: string, body: string) => { const d = evidenceDir(); if (d) { mkdirSync(d, {recursive: true}); writeFileSync(path.join(d, name), body); } };
const iso = () => runnerIsolation(db, runnerAgent, {serverUrl: urlForAgents(), now: new Date()});
async function probe() {
    const r = await requestRunnerProbe(rdeps(), {agentId: runnerAgent});
    if (!r.ok) throw new Error(`probe request refused: ${r.code}`);
    return finished(r.taskId);
}

/** The demo stack as a backup: compose dir (files archive) + the two stock-agent fixtures (TEST-ONLY key). `poison` adds a docker.sock bind to the web service. */
async function labWorld(poison: boolean): Promise<W17> {
    const src = path.join(tmp, `src-${poison ? "poison" : "demo"}`); mkdirSync(src, {recursive: true});
    const demo = path.join(process.cwd(), "dev/fork-lab/demo-stack");
    for (const f of ["compose.yml", "stack.env", "web", "uploads"]) cpSync(path.join(demo, f), path.join(src, f), {recursive: true});
    let yml = readFileSync(path.join(src, "compose.yml"), "utf8").replace('    ports: ["127.0.0.1:18080:8080"]\n', "").replaceAll("appdata", "data").replace("image: postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b", "image: postgres:17-alpine");
    yml = yml.replaceAll("postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b", "postgres:17-alpine"); // the box has the tag only (no registry)
    yml = yml.replace(/( {2}web:[\s\S]*?image: )postgres:17-alpine/, "$1w23-demo-web:lab"); // own image name for the web tier (see w23.sh)
    if (poison) yml = yml.replace("      - data:/data\n", "      - data:/data\n      - /var/run/docker.sock:/var/run/docker.sock\n");
    writeFileSync(path.join(src, "compose.yml"), yml);
    writeFileSync(path.join(src, "uploads/hello.txt"), "hello from the backup\n");
    const tgz = path.join(tmp, `files-${poison ? "poison" : "demo"}.tar.gz`); execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
    const filesPlain = readFileSync(tgz);
    const sk = await fileKeyProvider.signing(); const key = {privateKey: sk.privateKeyPem, publicKey: sk.publicKeyPem, kid: kidOfPublicKey(sk.publicKeyPem)};
    // the pinned inventory the wizard reads: a web service with its TCP port and a database service (env KEY NAMES only)
    const base0 = cleanInventory().services[0]!;
    const inventory = cleanInventory({services: [{...base0, ports: [{target: 8080, published: 18080, protocol: "tcp"}], env_keys: ["A", "APP_TITLE"]},
        {...base0, name: "db", image: {ref: `postgres:17@sha256:${"b".repeat(64)}`, pinned: true, built_locally: false}, ports: [], mounts: [], env_keys: ["POSTGRES_PASSWORD"], database_hint: {engine: "postgresql", basis: "image"}}]});
    const w = await seedW17World(t, "", key as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "production", roots: ["/srv/none"], inventory, caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"],
        plain: {compose_app: {sha: sha256(filesPlain), size: filesPlain.length}, volume_app_data: {sha: fx("lab-volume").plaintext_sha256, size: fx("lab-volume").plaintext_size}, db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"}},
        enrolDeps: {serverUrl: urlForAgents, stepUp: async () => "ok", keys: fileKeyProvider, env: () => ENV, principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
    objects.set(`/${w.rp}/compose_app`, {body: encryptAgentArchive(MASTER, filesPlain), hits: 0}); objects.set(`/${w.rp}/volume_app_data`, {body: fxFile("lab-volume"), hits: 0}); objects.set(`/${w.rp}/db_db`, {body: fxFile("lab-postgres"), hits: 0});
    worlds.set(w.rp, w);
    await q("update fork_stack set contains_personal_data=false where id=$1", [w.stack]); // synthetic data: no personal data (ADR-009 §4 would otherwise need the opt-in)
    return w;
}
const POLICY = {v: 1, access: {service: "web", target: 8080}, http_path: "/", env: {}} as const;
async function create(w: W17, name: string) {
    world = w;
    const r = await createMirror(mdeps(), {stackId: w.stack, rpId: w.rp, runnerAgentId: runnerAgent, name, policy: POLICY, keepConfirmations: {}, acknowledgePrivacy: false});
    if (!r.ok) throw new Error(`createMirror refused: ${r.code} ${JSON.stringify((r as {blockers?: string[]}).blockers ?? [])}`);
    return r;
}
const revRow = async (id: string) => (await q("select * from fork_mirror_revision where id=$1", [id]))[0]!;
const WIPE_FINAL = ["verified", "not_needed", "failed"];
/** tick (orchestrator + wipe phase) every second until READY, or terminal with a finished wipe; `each` sees every observed row */
async function drive(revisionId: string, o: {ms?: number; each?: (r: Record<string, any>) => Promise<void> | void} = {}) {
    const end = Date.now() + (o.ms ?? 600_000);
    for (;;) {
        await tickAllMirrors(mdeps());
        const r = await revRow(revisionId);
        await o.each?.(r);
        if (process.env.W23_FREEZE_AT_DB && (r.steps as {name: string; status: string}[]).some((x) => x.name === "restore_db" && x.status !== "pending")) { await sleep(20_000); throw new Error("frozen for debugging (W23_FREEZE_AT_DB)"); }
        const active = ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting", "healthchecking"].includes(r.state);
        if (!active && (r.state === "ready" || WIPE_FINAL.includes(r.wipe_state))) return r;
        if (!active && r.state !== "ready" && !process.env.W23_QUIET) RUN.push(`terminal ${r.state}/${r.reason}; last tasks: ${JSON.stringify((await q("select type, status, result from fork_agent_task where agent_id=$1 order by seq desc limit 3", [runnerAgent])).map((x) => [x.type, x.status, x.result]))}`);
        if (Date.now() > end) throw new Error(`drive timeout: state=${r.state} reason=${r.reason} steps=${JSON.stringify(r.steps).slice(0, 600)}`);
        await sleep(1000);
    }
}
const ctrs = (rev: string) => inbox(["docker", "ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${rev}`]).split("\n").filter(Boolean);
const ctrOf = (rev: string, service: string) => inbox(["docker", "ps", "-q", "--filter", `label=com.portabase.fork.restore_id=${rev}`, "--filter", `label=com.docker.compose.service=${service}`]).split("\n")[0]!;
const envOf = (ctr: string) => Object.fromEntries((JSON.parse(inbox(["docker", "inspect", ctr, "-f", "{{json .Config.Env}}"])) as string[]).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
const wsOf = (project: string) => `${MIRROR_ROOT}/${project}`;

describe.skipIf(!LAB)("W23 wizard lab (Flow D through the UI): a test mirror is created from a verified recovery point on an emulated runner VM (real-VM proof PENDING-HUMAN #125)", () => {
    beforeAll(async () => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "w23-lab-")); priv = path.join(tmp, "private");
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), MASTER, {mode: 0o600});
        process.env.PRIVATE_PATH = priv; process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w23-test-${randomBytes(12).toString("hex")}`;
        lab(["down"]); lab(["nets"]); lab(["sinks"]);
        // one origin for the browser and the agents: dashboard on the gateway, a 127.0.0.1 forwarder on the SAME port (Chrome resolves *.localhost to 127.0.0.1)
        for (let i = 0; i < 20 && !forwarder; i++) {
            dashPort = await freePort(GW);
            const s = net.createServer((c) => { const u = net.connect(dashPort, GW); c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); });
            await new Promise<void>((res) => { s.once("error", () => res()); s.listen(dashPort, "127.0.0.1", () => { forwarder = s; res(); }); });
        }
        if (!forwarder) throw new Error("no free port for the forwarder");
        artPort = await freePort(GW); base = `http://${GW}:${dashPort}`;
        server = http.createServer((rq, rs) => {
            const o = objects.get(new URL(rq.url!, "http://x").pathname);
            if (!o) { rs.writeHead(404).end(); return; }
            o.hits++;
            const send = () => { rs.writeHead(200, {"content-length": o.body.length}); rs.end(o.body); };
            if (o.holdMs) setTimeout(send, o.holdMs); else send();
        }).listen(artPort, GW);
        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        await startDashboard();
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;
        const userWithPw = async (u: {email: string; password: string}, role: "member" | "admin") => {
            const id = await seedUser(t.pool, "user");
            await q(`update "user" set email=$2 where id=$1`, [id, u.email]);
            const {hashPassword} = await import("better-auth/crypto");
            await q(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), id, id, await hashPassword(u.password)]);
            await q(`insert into member (id, organization_id, user_id, role, created_at) values ($1,$2,$3,$4,now())`, [randomUUID(), org, id, role]);
            return id;
        };
        await userWithPw(MEMBER, "member"); orgAdminId = await userWithPw(ORGADMIN, "admin");
        world = await labWorld(false);
        runnerAgent = await seedAgent(t.pool, org, "w23-runner-agent"); prodAgent = await seedAgent(t.pool, org, "w23-prod-agent");
        const enrol = async (agentId: string) => { const r = await enrolAgent({...rdeps()} as never, {agentId, password: PASSWORD}); if (!r.ok) throw new Error(`enrol ${r.code}`); return r.bundle; };
        runnerBundle = await enrol(runnerAgent); prodBundle = await enrol(prodAgent);
        lab(["box"], {DASH_PORT: String(dashPort), ARTIFACT_PORT: String(artPort)});
        lab(["agent"], {DASH_PORT: String(dashPort), EDGE_KEY: edgeKeyOf(runnerAgent)}, runnerBundle);
        const bf = path.join(tmp, "prod.bundle"); writeFileSync(bf, prodBundle, {mode: 0o600}); chmodSync(bf, 0o600);
        sh("docker", ["run", "-d", "--name", PROD_AGENT, "--network", "w23-lab-net", "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production", "-e", "FORK_CHANNEL_ENABLED=true",
            "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2", "-v", `${bf}:/run/fork/bundle:ro`, AGENT_IMAGE], {env: {...process.env, EDGE_KEY: edgeKeyOf(prodAgent)}});
        const nets = Object.keys(JSON.parse(docker(["inspect", BOX, "-f", "{{json .NetworkSettings.Networks}}"]))).sort();
        expect(nets).toEqual(["w23-lab-net", "w23-prod-net"]);
        const TARGETS = [
            {kind: "tcp", host: "172.31.252.25", port: 25, class: "smtp", label: "Prod SMTP"}, {kind: "tcp", host: "172.31.252.80", port: 8080, class: "webhook", label: "Prod webhook"},
            {kind: "tcp", host: "172.31.252.54", port: 5432, class: "database", label: "Prod DB"}, {kind: "dns_tcp", host: "172.31.252.53", port: 53, class: "dns", label: "Prod resolver TCP"},
            {kind: "tcp", host: GW, port: dashPort, class: "custom", label: "Dashboard lab"}, {kind: "tcp", host: "172.31.251.10", port: 2376, class: "custom", label: "Runner host dockerd - input chain"},
            {kind: "dns_name", host: `leak${NONCE}.w23.lab`, class: "dns", label: "Leak canary name"},
        ];
        for (const x of TARGETS) expect(x.host.startsWith("192.168.8.")).toBe(false); // guard: never the owner's pilot LAN
        await designateRunner(rdeps(), {agentId: runnerAgent, password: PASSWORD}).then((r) => expect(r).toEqual({ok: true}));
        expect(await setRunnerTargets(rdeps(), {agentId: runnerAgent, targets: TARGETS})).toMatchObject({ok: true});
        await waitFor("runner reported mirror.v1", async () => { const [e] = await q("select capabilities from fork_agent_enrollment where agent_id=$1", [runnerAgent]); return e?.capabilities?.includes("mirror.v1") ? (e.capabilities as string[]) : null; });
        const p = await probe(); expect(p.status).toBe("succeeded");
        expect(await iso()).toMatchObject({state: "isolated"});
    }, 900_000);

    afterAll(async () => {
        try { keep("runner-agent.log", stripAnsi(sh("docker", ["exec", BOX, "docker", "logs", "runner-agent"]))); keep("run.out", RUN.join("\n") + "\n"); keep("nft-ruleset.txt", inbox(["nft", "list", "table", "inet", "pbm_runner"])); } catch { /* box gone */ }
        keep("prod-agent.log", stripAnsi(logs(PROD_AGENT)));
        try { lab(["fw-on"]); } catch { /* box gone */ }
        await stopDashboard();
        forwarder?.close();
        server?.close();
        if (!process.env.W23_KEEP_LAB) { try { lab(["down"]); } catch { /* best effort */ } } // W23_KEEP_LAB=1: debugging only, the caller runs `w23.sh down`
        await t?.drop();
        rmSync(tmp, {recursive: true, force: true});
    });


    // ---- browser-facing helpers (the same origin the browser uses: the 127.0.0.1 forwarder resolves *.localhost) -------------------------------------------------------------------
    const site = () => urlForAgents();
    const login = async (u: {email: string; password: string}) => {
        const r = await fetch(`${site()}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: site()}, body: JSON.stringify({email: u.email, password: u.password})});
        expect(r.status, await r.clone().text()).toBe(200);
        return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    };
    const page = (p: string, cookie: string, rsc = false) => fetch(`${site()}${p}`, {headers: rsc ? {cookie, RSC: "1"} : {cookie}}).then((r) => r.text());
    const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const rpSeq = async (w: W17) => Number((await q("select sequence from fork_recovery_point where id=$1", [w.rp]))[0].sequence);

    let m1: {mirrorId: string; revisionId: string; hostPort: number; name: string; project: string};
    let m3: {mirrorId: string; revisionId: string; hostPort: number; name: string; project: string};
    const projectOf = async (revisionId: string) => (await q("select project from fork_mirror_revision where id=$1", [revisionId]))[0]!.project as string;
    const mirrorStatus = async (id: string) => (await q("select status, deleted_at from fork_mirror where id=$1", [id]))[0]!;
    const canaries = async (rev: string) => {
        const ctr = ctrOf(rev, "db");
        const rotated = ctr ? envOf(ctr).POSTGRES_PASSWORD : undefined;
        return [PROD_PW, NONCE, SECRET_QS.split("=")[1]!, "/srv/portabase-mirrors", priv, ...(rotated ? [rotated] : [])];
    };
    /** tick every second until the mirror is `deleted`; `deps` lets a case tick as the locked dashboard */
    async function driveDelete(mirrorId: string, deps: () => MirrorDeps = mdeps, ms = 180_000) {
        const end = Date.now() + ms;
        for (;;) {
            await tickAllMirrors(deps());
            const m = await mirrorStatus(mirrorId);
            if (m.status === "deleted") return m;
            if (Date.now() > end) throw new Error(`delete timeout: status=${m.status} revisions=${JSON.stringify(await q("select state, wipe_state, wipe_reason from fork_mirror_revision where mirror_id=$1", [mirrorId]))}`);
            await sleep(1000);
        }
    }

    it("L-A1 a real READY mirror shows in the list (name, Healthy, loopback only, no tunnel command) and in all four detail tabs; neither HTML nor RSC carries a secret, the rotated password, a nonce, the signature or a host path", async () => {
        const name = `la1-${NONCE.slice(0, 6)}`;
        const r = await create(world, name);
        const row = await drive(r.revisionId, {ms: 240_000});
        expect(row.state, `reason=${row.reason} step=${row.failed_step}`).toBe("ready");
        m1 = {...r, name, project: await projectOf(r.revisionId)};
        const admin = await login(ADMIN);
        const list = await page("/dashboard/mirrors", admin);
        const text = visible(list);
        expect(text).toContain(name);
        expect(text).toContain("Healthy");
        expect(text).toContain("Loopback only");
        expect(list).not.toMatch(/ssh -L/);
        expect(list).toContain('href="/dashboard/mirrors"'); // sidebar entry
        const secrets = await canaries(r.revisionId);
        expect(secrets.length).toBeGreaterThan(5); // incl. the rotated password read from the box
        const pages = ["/dashboard/mirrors", ...["overview", "configuration", "history", "logs"].map((t) => `/dashboard/mirrors/${r.mirrorId}?tab=${t}`)];
        for (const p of pages) {
            const html = await page(p, admin);
            expect(visible(html), p).toContain(name);
            for (const body of [html, await page(p, admin, true), await page(`${p}${p.includes("?") ? "&" : "?"}_rsc=1`, admin, true)]) for (const s of secrets) expect(body.includes(s), `${p} leaks ${s.slice(0, 10)}`).toBe(false);
        }
        const cfg = visible(await page(`/dashboard/mirrors/${r.mirrorId}?tab=configuration`, admin));
        expect(cfg).toContain("Isolation evidence");
        expect(cfg).toContain("Isolated (checked");
        keep("la1-list.txt", text);
        RUN.push(`L-A1 PASS list + 4 tabs for READY ${name} on 127.0.0.1:${r.hostPort}; ${pages.length} pages x 3 bodies free of ${secrets.length} canaries`);
    }, 600_000);

    it("L-A2 Delete = verified wipe: the runner copy is gone (containers, workspace), a DECOY of another owner survives, the name and the port are reusable", async () => {
        const name = `la2-${NONCE.slice(0, 6)}`;
        const r = await create(world, name);
        const row = await drive(r.revisionId, {ms: 240_000});
        expect(row.state, `reason=${row.reason} step=${row.failed_step}`).toBe("ready");
        const project = await projectOf(r.revisionId);
        expect(ctrs(r.revisionId).length).toBeGreaterThan(0);
        expect(inbox(["sh", "-c", `test -d ${wsOf(project)} && echo present`])).toBe("present");
        // the decoy: a container carrying the owner labels of ANOTHER revision of this runner agent: the wipe must never touch it
        const otherRev = randomUUID();
        inbox(["docker", "run", "-d", "--name", "w23-decoy", "--label", `com.portabase.fork.restore_id=${otherRev}`, "--label", `com.portabase.fork.agent_id=${runnerAgent}`, "--entrypoint", "sleep", "postgres:17-alpine", "3600"]);
        expect(inbox(["docker", "ps", "-q", "--filter", "name=w23-decoy"])).not.toBe("");
        const del = await deleteMirror(mdeps(), {mirrorId: r.mirrorId, confirmName: name});
        expect(del).toEqual({ok: true});
        const m = await driveDelete(r.mirrorId);
        expect(m.deleted_at).not.toBeNull();
        expect(ctrs(r.revisionId)).toEqual([]);
        expect(inbox(["sh", "-c", `test ! -e ${wsOf(project)} && echo gone`])).toBe("gone");
        expect(inbox(["docker", "ps", "-q", "--filter", "name=w23-decoy"]), "the decoy of another owner must survive").not.toBe("");
        expect((await revRow(r.revisionId)).wipe_state).toBe("verified");
        // the name and the loopback port are free again on the same runner
        const r3 = await create(world, name);
        expect(r3.hostPort).toBe(r.hostPort);
        const row3 = await drive(r3.revisionId, {ms: 240_000});
        expect(row3.state, `reason=${row3.reason} step=${row3.failed_step}`).toBe("ready");
        m3 = {...r3, name, project: await projectOf(r3.revisionId)};
        keep("la2-delete.txt", `deleted ${name} (${r.mirrorId}); revision ${r.revisionId} wipe verified; decoy survived; re-created same name on port ${r3.hostPort}`);
        RUN.push(`L-A2 PASS delete verified (containers + workspace gone), decoy survived, name+port reused (${r3.hostPort})`);
    }, 900_000);

    it("L-A3 Delete works while configuration is locked (the dashboard still deletes and the wipe still verifies)", async () => {
        const locked = () => mdeps({configAllowed: async () => false});
        const del = await deleteMirror(locked(), {mirrorId: m3.mirrorId, confirmName: m3.name});
        expect(del).toEqual({ok: true});
        const m = await driveDelete(m3.mirrorId, locked);
        expect(m.deleted_at).not.toBeNull();
        expect(ctrs(m3.revisionId)).toEqual([]);
        expect(inbox(["sh", "-c", `test ! -e ${wsOf(m3.project)} && echo gone`])).toBe("gone");
        expect((await revRow(m3.revisionId)).wipe_state).toBe("verified");
        // the first mirror (L-A1) is untouched by the other deletions
        expect((await mirrorStatus(m1.mirrorId)).status).toBe("ready");
        expect(ctrs(m1.revisionId).length).toBeGreaterThan(0);
        RUN.push("L-A3 PASS delete while locked; the L-A1 mirror untouched");
    }, 600_000);

    /** HOLD (browser pass): keeps everything up, ticks the orchestrator every 2 s, executes lab commands until $W23_SCRATCH/w23-lab.stop exists */
    it.skipIf(!HOLD)("HOLD", async () => {
        expect(SCRATCH).not.toBe("");
        mkdirSync(SCRATCH, {recursive: true});
        const cmdF = path.join(SCRATCH, "w23-lab.cmd"), logF = path.join(SCRATCH, "w23-lab.log"), stopF = path.join(SCRATCH, "w23-lab.stop");
        for (const f of [cmdF, stopF]) { try { unlinkSync(f); } catch { /* none */ } }
        const info = {base: site(), admin: ADMIN.email, adminPassword: ADMIN.password, member: MEMBER, orgAdmin: ORGADMIN, stack: world.stack, rpSequence: await rpSeq(world), runnerName: (await q("select name from agents where id=$1", [runnerAgent]))[0].name, cmd: cmdF, stop: stopF, poisonStack: null as string | null, mirrors: [] as string[]};
        const writeInfo = () => writeFileSync(path.join(SCRATCH, "w23-lab.json"), JSON.stringify(info, null, 1), {mode: 0o600});
        writeInfo();
        const say = (cmd: string, ok: boolean, d = "") => writeFileSync(logF, `${new Date().toISOString()} ${cmd} ${ok ? "ok" : "error"} ${d}\n`, {flag: "a"});
        let frozen = false;
        const exec = async (line: string) => {
            const [cmd, a] = line.trim().split(/\s+/);
            if (cmd === "fw-off") lab(["fw-off"]);
            else if (cmd === "fw-on") lab(["fw-on"]);
            else if (cmd === "probe") { const p = await probe(); say(line.trim(), p.status === "succeeded", `isolation=${JSON.stringify(await iso())}`); return; }
            else if (cmd === "pd-null") await q("update fork_stack set contains_personal_data=null, mirror_opt_in_at=null, mirror_opt_in_by=null where id=$1", [a]);
            else if (cmd === "pd-false") await q("update fork_stack set contains_personal_data=false where id=$1", [a]);
            else if (cmd === "freeze-db") frozen = a === "on";
            else if (cmd === "curl") { const o = inbox(["sh", "-c", `wget -qO- -T 8 http://127.0.0.1:${a} 2>&1`]); say(line.trim(), true, o.replace(/\s+/g, " ").slice(0, 300)); return; }
            else if (cmd === "poison") { const pw = await labWorld(true); poisonWorld = pw; info.poisonStack = pw.stack; writeInfo(); say(line.trim(), true, `poisonStack=${pw.stack} rpSequence=${await rpSeq(pw)}`); return; }
            else if (cmd === "create") { const nm = a ?? `demo-${Date.now().toString(36)}`; const cw = line.includes("poison") && poisonWorld ? poisonWorld : world; const r = await createMirror({...holdDeps(), principal: orgAdminP()}, {stackId: cw.stack, rpId: cw.rp, runnerAgentId: runnerAgent, name: nm, policy: POLICY, keepConfirmations: {}, acknowledgePrivacy: false}); say(line.trim(), r.ok, r.ok ? `mirror=${r.mirrorId} port=${r.hostPort}` : r.code); return; }
            else if (cmd === "decoy") { inbox(["docker", "run", "-d", "--name", "w23-decoy", "--label", `com.portabase.fork.restore_id=${randomUUID()}`, "--label", `com.portabase.fork.agent_id=${runnerAgent}`, "--entrypoint", "sleep", "postgres:17-alpine", "3600"]); say(line.trim(), true); return; }
            else if (cmd === "decoy-check") { say(line.trim(), true, `decoy=${inbox(["docker", "ps", "-q", "--filter", "name=w23-decoy"]) ? "present" : "GONE"}`); return; }
            else if (cmd === "ctr-state") { say(line.trim(), true, inbox(["docker", "ps", "-a", "--format", "{{.Names}}={{.State}}"]).replace(/\n/g, " ").slice(0, 400)); return; }
            else if (cmd === "mirrors") { const rows = await q("select m.id, m.name, m.status, r.state, r.reason, r.wipe_state from fork_mirror m join fork_mirror_revision r on r.mirror_id=m.id order by m.created_at"); say(line.trim(), true, JSON.stringify(rows)); return; }
            else throw new Error("unknown");
            say(line.trim(), true);
        };
        let lastTick = 0;
        while (!existsSync(stopF)) {
            if (existsSync(cmdF)) {
                const lines = readFileSync(cmdF, "utf8").split("\n").filter((l) => l.trim()); unlinkSync(cmdF);
                for (const l of lines) { try { await exec(l); } catch (e) { say(l.trim(), false, String((e as Error).message).slice(0, 200)); } }
            }
            if (Date.now() - lastTick > 2000) {
                lastTick = Date.now();
                const atDb = frozen && (await q("select 1 from fork_mirror_revision where state='restoring_db' or (state in ('restoring_files','transforming','starting') and steps @> '[{\"name\":\"restore_db\",\"status\":\"running\"}]')")).length > 0;
                if (!atDb) { try { await tickAllMirrors(holdDeps()); } catch (e) { say("tick", false, String((e as Error).message).slice(0, 200)); } }
            }
            await sleep(500);
        }
    }, 4 * 3_600_000);
});
