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
import {MIRROR_REASONS} from "@/fork/mirror/vocab";
import {createMirror, deleteMirror, previewMirrorRefresh, refreshMirror, rollbackMirror, stopMirror} from "@/fork/mirror/service";
import {tickAllMirrors} from "@/fork/mirror/tick";
import {designateRunner, requestRunnerProbe, runnerIsolation, setRunnerTargets, type RunnerDeps} from "@/fork/runner/service";
import {encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import type {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {capacityWarning, } from "@/fork/ui/mirrors/refresh/model";
import {nextRp} from "@/fork/__tests__/w24-world";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

// ponytail: copy of the W24 lab world (names w24-*, subnets 172.31.241/242, dev/fork-lab/runner/w24.sh reused unchanged); follow-up task: extract a shared `mirror-lab world` (w22a..w25).
/**
 * LIVE W25 failure-injection drills (FORK_LAB=1, docker lab ONLY, synthetic TEST-ONLY data, never a real host): the REAL fork dashboard (production build) + the REAL fork agent image as a MIRROR RUNNER inside the
 * docker-in-docker runner box (nftables egress policy in the box's netns). The orchestrator tick runs in THIS process with the W22a storage seams. W25_DRILL selects the scenario:
 *   bad-dump D1a/D1b · concurrent D2a-d · disk D3 · isolation D4a-c · all (every drill, one mirror) · hold (Flow E browser pass: keeps everything up, file-driven commands).
 * L0 (always) creates a mirror from RP A and refreshes it ONCE to RP B (route established, A kept as the rollback target). After EVERY injected failure `assertUndisturbed` proves the active revision is
 * unchanged and still serving through the stable route port. Exit code = verdict (dev/fork-lab/drills/refresh-*.sh). Real-VM proof stays PENDING-HUMAN (#125).
 */
const LAB = process.env.FORK_LAB === "1";
const DRILLS = ["bad-dump", "concurrent", "disk", "isolation", "all", "hold"] as const;
const DRILL = process.env.W25_DRILL ?? "all";
const HOLD = DRILL === "hold"; const SCRATCH = process.env.W25_SCRATCH ?? "";
const on = (d: string) => LAB && (DRILL === d || (DRILL === "all" && d !== "hold"));
const AGENT_IMAGE = process.env.W25_AGENT_IMAGE ?? "portabase-agent-fork:w24-lab";
const GW = "172.31.241.1";
const W24_SH = path.join(process.cwd(), "dev/fork-lab/runner/w24.sh");
const BOX = "w24-runner", PROD_AGENT = "w24-agent-prod";
const MIRROR_ROOT = "/srv/portabase-mirrors";
const PROD_PW = "demo-synthetic-not-a-secret"; // the production POSTGRES_PASSWORD inside the demo stack's stack.env
const SECRET_QS = `X-Amz-Signature=${randomBytes(12).toString("hex")}SECRETSIG`;
const NONCE = randomBytes(6).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[], o: {env?: NodeJS.ProcessEnv; input?: string} = {}) => execFileSync(cmd, args, {encoding: "utf8", env: o.env ?? process.env, input: o.input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024}).trim();
const docker = (args: string[]) => sh("docker", args);
const inbox = (args: string[]) => docker(["exec", BOX, ...args]);
const lab = (args: string[], env: Record<string, string> = {}, input?: string) => sh("bash", [W24_SH, ...args], {env: {...process.env, W24_AGENT_IMAGE: AGENT_IMAGE, ...env}, input});
const logs = (name: string) => { const r = spawnSync("docker", ["logs", name], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024}); return `${r.stdout ?? ""}${r.stderr ?? ""}`; };
const freePort = (host: string) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
const FX = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {name: string; file: string; plaintext_sha256: string; plaintext_size: number}[]};
const fxFile = (n: string) => readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures", FX.fixtures.find((f) => f.name === n)!.file));
const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
const MASTER = Buffer.from(FX.master_key_b64, "base64");

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let tmp = ""; let priv = ""; let base = ""; let org = ""; let adminId = ""; let dashPort = 0; let artPort = 0; let server: http.Server;
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
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-8).join("\n").slice(-1500)}\n--- runner agent ---\n${stripAnsi(sh("docker", ["exec", BOX, "docker", "logs", "runner-agent"])).split("\n").slice(-14).join(" | ").slice(-2500)}`);
        await sleep(1000);
    }
}
async function startDashboard() {
    const env: NodeJS.ProcessEnv = {...process.env, NODE_ENV: "production", DATABASE_URL: t.url, PROJECT_URL: urlForAgents(), PROJECT_SECRET: `w25-lab-${randomBytes(12).toString("hex")}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
        AUTH_DEFAULT_USER_NAME: "W25 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_MIRRORS_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
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
    yml = yml.replace(/( {2}web:[\s\S]*?image: )postgres:17-alpine/, "$1w24-demo-web:lab"); // own image name for the web tier (see w24.sh)
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
        if (process.env.W25_FREEZE_AT_DB && (r.steps as {name: string; status: string}[]).some((x) => x.name === "restore_db" && x.status !== "pending")) { await sleep(20_000); throw new Error("frozen for debugging (W25_FREEZE_AT_DB)"); }
        const active = ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting", "healthchecking"].includes(r.state);
        if (!active && (r.state === "ready" || WIPE_FINAL.includes(r.wipe_state))) return r;
        if (!active && r.state !== "ready" && !process.env.W25_QUIET) RUN.push(`terminal ${r.state}/${r.reason}; last tasks: ${JSON.stringify((await q("select type, status, result from fork_agent_task where agent_id=$1 order by seq desc limit 3", [runnerAgent])).map((x) => [x.type, x.status, x.result]))}`);
        if (Date.now() > end) throw new Error(`drive timeout: state=${r.state} reason=${r.reason} steps=${JSON.stringify(r.steps).slice(0, 600)}`);
        await sleep(1000);
    }
}
const ctrs = (rev: string) => inbox(["docker", "ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${rev}`]).split("\n").filter(Boolean);
const ctrOf = (rev: string, service: string) => inbox(["docker", "ps", "-q", "--filter", `label=com.portabase.fork.restore_id=${rev}`, "--filter", `label=com.docker.compose.service=${service}`]).split("\n")[0]!;
const envOf = (ctr: string) => Object.fromEntries((JSON.parse(inbox(["docker", "inspect", ctr, "-f", "{{json .Config.Env}}"])) as string[]).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
const wsOf = (project: string) => `${MIRROR_ROOT}/${project}`;

describe.skipIf(!LAB)(`W25 refresh failure-injection drills [${DRILL}] on an emulated runner VM (real-VM proof PENDING-HUMAN #125)`, () => {
    beforeAll(async () => {
        if (!(DRILLS as readonly string[]).includes(DRILL)) throw new Error(`unknown W25_DRILL ${DRILL}`);
        tmp = mkdtempSync(path.join(os.tmpdir(), "w25-lab-")); priv = path.join(tmp, "private");
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), MASTER, {mode: 0o600});
        process.env.PRIVATE_PATH = priv; process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w25-test-${randomBytes(12).toString("hex")}`;
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
        world = await labWorld(false);
        runnerAgent = await seedAgent(t.pool, org, "w24-runner-agent"); prodAgent = await seedAgent(t.pool, org, "w24-prod-agent");
        const enrol = async (agentId: string) => { const r = await enrolAgent({...rdeps()} as never, {agentId, password: PASSWORD}); if (!r.ok) throw new Error(`enrol ${r.code}`); return r.bundle; };
        runnerBundle = await enrol(runnerAgent); prodBundle = await enrol(prodAgent);
        lab(["box"], {DASH_PORT: String(dashPort), ARTIFACT_PORT: String(artPort)});
        lab(["agent"], {DASH_PORT: String(dashPort), EDGE_KEY: edgeKeyOf(runnerAgent)}, runnerBundle);
        const bf = path.join(tmp, "prod.bundle"); writeFileSync(bf, prodBundle, {mode: 0o600}); chmodSync(bf, 0o600);
        sh("docker", ["run", "-d", "--name", PROD_AGENT, "--network", "w24-lab-net", "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production", "-e", "FORK_CHANNEL_ENABLED=true",
            "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2", "-v", `${bf}:/run/fork/bundle:ro`, AGENT_IMAGE], {env: {...process.env, EDGE_KEY: edgeKeyOf(prodAgent)}});
        const nets = Object.keys(JSON.parse(docker(["inspect", BOX, "-f", "{{json .NetworkSettings.Networks}}"]))).sort();
        expect(nets).toEqual(["w24-lab-net", "w24-prod-net"]);
        const TARGETS = [
            {kind: "tcp", host: "172.31.242.25", port: 25, class: "smtp", label: "Prod SMTP"}, {kind: "tcp", host: "172.31.242.80", port: 8080, class: "webhook", label: "Prod webhook"},
            {kind: "tcp", host: "172.31.242.54", port: 5432, class: "database", label: "Prod DB"}, {kind: "dns_tcp", host: "172.31.242.53", port: 53, class: "dns", label: "Prod resolver TCP"},
            {kind: "tcp", host: GW, port: dashPort, class: "custom", label: "Dashboard lab"}, {kind: "tcp", host: "172.31.241.10", port: 2376, class: "custom", label: "Runner host dockerd - input chain"},
            {kind: "dns_name", host: `leak${NONCE}.w24.lab`, class: "dns", label: "Leak canary name"},
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
        if (!process.env.W25_KEEP_LAB) { try { lab(["down"]); } catch { /* best effort */ } } // W25_KEEP_LAB=1: debugging only, the caller runs `w24.sh down`
        await t?.drop();
        rmSync(tmp, {recursive: true, force: true});
    });



    // ---- recovery points of the SAME stack (A = labWorld, the refresh sources are built here) -----------------------------------------------------------------------------------
    const key = async () => { const sk = await fileKeyProvider.signing(); return {privateKey: sk.privateKeyPem, publicKey: sk.publicKeyPem, kid: kidOfPublicKey(sk.publicKeyPem)} as unknown as ReturnType<typeof testKeypair>; };
    /** the files archive of the demo stack with another greeting and one more upload (RP B); same transformations as `labWorld` */
    // ponytail: copy of the labWorld source tree steps; extract if a third variant appears.
    function filesArchive(tag: string, greeting: string, extraUpload: string | null): Buffer {
        const src = path.join(tmp, `src-${tag}`); mkdirSync(src, {recursive: true});
        const demo = path.join(process.cwd(), "dev/fork-lab/demo-stack");
        for (const f of ["compose.yml", "stack.env", "web", "uploads"]) cpSync(path.join(demo, f), path.join(src, f), {recursive: true});
        let yml = readFileSync(path.join(src, "compose.yml"), "utf8").replace('    ports: ["127.0.0.1:18080:8080"]\n', "").replaceAll("appdata", "data");
        yml = yml.replaceAll("postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b", "postgres:17-alpine");
        yml = yml.replace(/( {2}web:[\s\S]*?image: )postgres:17-alpine/, "$1w24-demo-web:lab");
        writeFileSync(path.join(src, "compose.yml"), yml);
        writeFileSync(path.join(src, "stack.env"), readFileSync(path.join(src, "stack.env"), "utf8").replace(/^APP_GREETING=.*$/m, `APP_GREETING=${greeting}`));
        writeFileSync(path.join(src, "uploads/hello.txt"), "hello from the backup\n");
        if (extraUpload) writeFileSync(path.join(src, "uploads", extraUpload), "second upload of recovery point B\n");
        const tgz = path.join(tmp, `files-${tag}.tar.gz`); execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
        return readFileSync(tgz);
    }
    /** a NEWER verified recovery point of the same stack; `files` = its compose archive (null = the base one), `dbDump` = a replacement plaintext for the database archive */
    async function variantRp(base: W17, o: {files?: Buffer; dbDump?: Buffer; plaintextSize?: number}): Promise<W17> {
        const plain: Record<string, {sha: string; size: number; dump?: "pg_custom"}> = {};
        if (o.files) plain.compose_app = {sha: sha256(o.files), size: o.files.length};
        if (o.dbDump) plain.db_db = {sha: sha256(o.dbDump), size: o.dbDump.length, dump: "pg_custom"};
        const w = await nextRp(t, base, await key(), {plain, plaintextSize: o.plaintextSize});
        const same = (n: string) => objects.get(`/${base.rp}/${n}`)!.body;
        objects.set(`/${w.rp}/compose_app`, {body: o.files ? encryptAgentArchive(MASTER, o.files) : same("compose_app"), hits: 0});
        objects.set(`/${w.rp}/volume_app_data`, {body: same("volume_app_data"), hits: 0});
        objects.set(`/${w.rp}/db_db`, {body: o.dbDump ? encryptAgentArchive(MASTER, o.dbDump) : same("db_db"), hits: 0});
        worlds.set(w.rp, w);
        return w;
    }

    // ---- lab helpers ----------------------------------------------------------------------------------------------------------------------------------------------------------------
    const wget = (port: number) => spawnSync("docker", ["exec", BOX, "sh", "-c", `wget -qO- -T 6 http://127.0.0.1:${port} 2>&1`], {encoding: "utf8"});
    /** the demo page; `tries` > 1 retries a transient / truncated answer (the page is produced by `nc -e` per request) until it carries both the greeting and the uploads count */
    const page = (port: number, tries = 1) => { for (let i = 0; i < tries; i++) { const r = wget(port); if (r.status === 0 && (tries === 1 || r.stdout.includes("uploads="))) return r.stdout; if (i < tries - 1) spawnSync("sleep", ["1"]); } return null; };
    const mirrorRow = async (id: string) => (await q("select * from fork_mirror where id=$1", [id]))[0]!;
    const ctrsAll = (rev: string) => inbox(["docker", "ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${rev}`]).split("\n").filter(Boolean);
    const ctrStates = (project: string) => inbox(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}={{.State}}"]).split("\n").filter(Boolean);
    const rpwOf = (rev: string) => { const c = inbox(["docker", "ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${rev}`, "--filter", "label=com.docker.compose.service=db"]).split("\n")[0]; return c ? envOf(c).POSTGRES_PASSWORD : undefined; };
    const seedHex = (project: string) => inbox(["sh", "-c", `od -An -tx1 -v ${wsOf(project)}/.portabase/mirror/seed | tr -d ' \\n'`]);
    const routeName = (mirrorId: string) => `pbm-route-${mirrorId}`;
    const projectOfRev = async (rev: string) => (await q("select project from fork_mirror_revision where id=$1", [rev]))[0]!.project as string;
    async function driveStatus(mirrorId: string, want: string[], ms = 420_000) {
        const end = Date.now() + ms;
        for (;;) {
            await tickAllMirrors(mdeps());
            const m = await mirrorRow(mirrorId);
            if (want.includes(m.status)) return m;
            if (Date.now() > end) throw new Error(`status timeout: status=${m.status} want=${want} events=${JSON.stringify(await q("select kind, from_state, to_state, code from fork_mirror_event where mirror_id=$1 order by at desc limit 5", [mirrorId]))}`);
            await sleep(1000);
        }
    }
    /** tick until `fn` holds (retention, wipes) */
    async function tickUntil(what: string, fn: () => Promise<boolean>, ms = 240_000) {
        const end = Date.now() + ms;
        for (;;) { await tickAllMirrors(mdeps()); if (await fn()) return; if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await sleep(1000); }
    }
    /** the serving probe: every >= 2 s one request to the given port from `each`; the caller asserts zero failures afterwards */
    function serving(port: () => number) {
        const s = {ok: 0, failed: [] as string[], last: 0};
        return {s, each: async () => { if (Date.now() - s.last < 2000) return; s.last = Date.now(); // W25: the demo page is produced by `nc -e` per request and a single answer can be truncated (observed once in D2d, pre-switch): a poll FAILS only when three tries 1 s apart all miss; a real outage fails all three
        let p: string | null = null; for (let i = 0; i < 3 && !p?.includes("greeting="); i++) { if (i > 0) await sleep(1000); p = page(port()); }
        if (p?.includes("greeting=")) s.ok++; else s.failed.push(`${new Date().toISOString()} ${String(p).slice(0, 60)}`); }};
    }
    const greeting = (html: string | null) => /greeting=(\S+)/.exec(html ?? "")?.[1] ?? null;
    const uploads = (html: string | null) => Number(/uploads=(\d+)/.exec(html ?? "")?.[1] ?? NaN);
    /** what the runner and the orchestrator said (failure diagnostics only; the rows are value-free by contract) */
    const diag = async (mirrorId: string) => JSON.stringify({events: await q("select kind, from_state, to_state, code, details from fork_mirror_event where mirror_id=$1 order by at desc limit 8", [mirrorId]),
        routeTasks: await q("select seq, status, result from fork_agent_task where agent_id=$1 and type='mirror_route' order by seq desc limit 4", [runnerAgent])});
    const activeIs = async (mirrorId: string, mir: Record<string, any>, id: string) => { if (mir.active_revision_id !== id) throw new Error(`active revision is ${mir.active_revision_id}, expected ${id}: ${await diag(mirrorId)}`); };
    const refresh = (m: {mirrorId: string; name: string}, w: W17) => refreshMirror(mdeps(), {mirrorId: m.mirrorId, rpId: w.rp, confirmName: m.name, acknowledgePrivacy: false});
    async function driveRefresh(m: {mirrorId: string}, revisionId: string, each?: () => Promise<void>) {
        const row = await drive(revisionId, {ms: 600_000, each: each ? async () => each() : undefined});
        const mir = await driveStatus(m.mirrorId, ["ready", "failed"]);
        return {row, mir};
    }
    const gone = (project: string, rev: string) => {
        expect(ctrsAll(rev)).toEqual([]);
        expect(inbox(["docker", "network", "ls", "-q", "--filter", `name=${project}_`])).toBe("");
        expect(inbox(["docker", "volume", "ls", "-q", "--filter", `label=com.portabase.fork.restore_id=${rev}`])).toBe("");
        expect(inbox(["sh", "-c", `test ! -e ${wsOf(project)} && echo gone`])).toBe("gone");
    };

    /** values read from the runner while the revisions existed (the seed bytes, the rotated database password): L9 proves none of them reached a dashboard row */
    const RUNNER_SECRETS: string[] = [];
    const NAME = `rf-${NONCE.slice(0, 6)}`;
    let M: {mirrorId: string; name: string}; let r1: {revisionId: string; hostPort: number; project: string}; let worldB: W17; let routePort = 0;
    const revs: Record<string, string> = {};

    // ---- W25 helpers --------------------------------------------------------------------------------------------------------------------------------------------------------------
    const PREVIEWS: string[] = []; // every RefreshPreview answer of the run (canary: no secret, no runner path)
    const site = () => urlForAgents();
    let tagN = 0;
    /** a NEWER verified recovery point (other greeting) of the same stack */
    const good = (greet: string) => variantRp(world, {files: filesArchive(`g${++tagN}`, greet, "second.txt")});
    const holdDeps = (): MirrorDeps => { const {principalOf: _p, ...d} = mdeps(); return d; };
    const preview = async (rpId: string | null) => {
        const r = await previewMirrorRefresh(mdeps(), {mirrorId: M.mirrorId, rpId});
        PREVIEWS.push(JSON.stringify(r));
        return r;
    };
    type Snap = {status: string; active: string; routePort: number; routeRev: string; greeting: string | null};
    /** the state that must survive every injected failure */
    async function snapshot(): Promise<Snap> {
        const m = await mirrorRow(M.mirrorId);
        return {status: m.status, active: m.active_revision_id, routePort: m.route_port, routeRev: m.route_revision_id, greeting: greeting(page(m.route_port as number, 6))};
    }
    /** DD-14: after a failure the mirror is `ready` on the SAME active revision, the stable route still answers with the SAME app, the failed revision is wiped (verified) and audited once */
    async function assertUndisturbed(label: string, before: Snap, o: {failed?: string; probe?: ReturnType<typeof serving>; audit?: "refresh" | "rollback"; targetKept?: string} = {}) {
        const m = await mirrorRow(M.mirrorId);
        expect(m.status, `${label}: mirror status; ${await diag(M.mirrorId)}`).toBe("ready");
        expect(m.active_revision_id, `${label}: active revision`).toBe(before.active);
        expect(m.route_port, `${label}: route port`).toBe(before.routePort);
        expect(m.route_revision_id, `${label}: route revision = active`).toBe(before.active);
        expect(before.routeRev).toBe(before.active);
        const g = greeting(page(m.route_port as number, 6));
        expect(g, `${label}: the route still answers with the active greeting`).toBe(before.greeting);
        if (o.probe) { expect(o.probe.s.failed, `${label}: failed polls during the attempt`).toEqual([]); expect(o.probe.s.ok, `${label}: polls ran`).toBeGreaterThan(0); }
        if (o.failed) {
            const r = await revRow(o.failed);
            expect(["verified", "not_needed"], `${label}: wipe_state of the failed revision`).toContain(r.wipe_state);
            gone(await projectOfRev(o.failed), o.failed);
            expect(ctrsAll(o.failed), `${label}: containers of the failed revision`).toEqual([]);
            if (o.audit) expect(Number((await q("select count(*)::int as n from fork_audit_event where action=$1 and redacted_details->>'phase'='requested' and redacted_details->>'revisionId'=$2", [`fork.mirror.${o.audit}`, o.failed]))[0]!.n), `${label}: one requested audit row`).toBe(1);
        }
        if (o.targetKept) {
            const r = await revRow(o.targetKept);
            expect([r.state, r.wipe_state, r.retired_at], `${label}: the rollback target is untouched`).toEqual(["ready", null, null]);
        }
        RUN.push(`${label} assertUndisturbed ok: status=ready active=${before.active.slice(0, 8)} route=${before.routePort}→${before.active.slice(0, 8)} greeting=${g}${o.probe ? ` polls ok=${o.probe.s.ok} failed=0` : ""}${o.failed ? ` failed-rev wipe verified, 1 audit row` : ""}`);
    }
    const rollbackCandidates = async () => (await q("select id from fork_mirror_revision where mirror_id=$1 and id<>$2 and state='ready' and activated_at is not null and retired_at is null and wipe_state is null order by seq desc", [M.mirrorId, (await mirrorRow(M.mirrorId)).active_revision_id])).map((r) => r.id as string);
    /** a good refresh to completion (the mirror ends ready on the new revision, route switched) */
    async function goodRefresh(label: string, greet: string) {
        const w = await good(greet);
        const asked = await refresh(M, w);
        expect(asked.ok, JSON.stringify(asked)).toBe(true);
        const rid = (asked as {revisionId: string}).revisionId;
        const {row, mir} = await driveRefresh(M, rid);
        expect(row.state, `${label}: reason=${row.reason} step=${row.failed_step}`).toBe("ready");
        await activeIs(M.mirrorId, mir, rid);
        expect(mir.route_revision_id).toBe(rid);
        expect(greeting(page(mir.route_port as number, 6)), `${label}: route greeting`).toBe(greet);
        RUN.push(`${label}: good refresh READY, route ${mir.route_port} → greeting ${greet}`);
        return {w, rid, mir};
    }
    const ensureTarget = async () => { if ((await rollbackCandidates()).length === 0) await goodRefresh("ensureTarget", `hello-target-${++tagN}`); return (await rollbackCandidates())[0]!; };
    /** mirror-level ops started since `t0` (mirror-scoped state_changed into refreshing / rolling_back) */
    const opsSince = async (t0: Date) => Number((await q("select count(*)::int as n from fork_mirror_event where mirror_id=$1 and to_state in ('refreshing','rolling_back') and at >= $2", [M.mirrorId, t0]))[0]!.n);
    /** tick until the mirror is ready/failed; the serving probe stops polling once a route task of this mirror exists (the switch itself may drop a connection for ~1 s: R-W24-9) */
    async function settle(pr: ReturnType<typeof serving>, port: number, since: Date, ms = 600_000) {
        const end = Date.now() + ms;
        for (;;) {
            await tickAllMirrors(mdeps());
            const m = await mirrorRow(M.mirrorId);
            if (["ready", "failed"].includes(m.status)) return m;
            const sw = Number((await q("select count(*)::int as n from fork_mirror_task t join fork_mirror_revision r on r.id=t.revision_id where r.mirror_id=$1 and t.step='route' and t.created_at >= $2", [M.mirrorId, since]))[0]!.n);
            if (sw === 0) await pr.each(); // pre-switch: the active revision must answer every poll
            if (Date.now() > end) throw new Error(`settle timeout: ${m.status} ${await diag(M.mirrorId)}`);
            await sleep(1000);
        }
    }
    /** one failed refresh attempt, end to end; returns the failed revision */
    async function failedRefresh(label: string, w: W17, reasons: string[], o: {steps?: string[]} = {}) {
        const before = await snapshot();
        const pv = await preview(w.rp);
        expect(pv.ok, JSON.stringify(pv)).toBe(true);
        const asked = await refresh(M, w);
        expect(asked.ok, JSON.stringify(asked)).toBe(true);
        const rid = (asked as {revisionId: string}).revisionId;
        const pr = serving(() => before.routePort);
        const {row} = await driveRefresh(M, rid, pr.each);
        RUN.push(`${label}: revision ${rid.slice(0, 8)} state=${row.state} reason=${row.reason} failed_step=${row.failed_step} wipe=${row.wipe_state}`);
        keep(`${label.toLowerCase().replace(/\W+/g, "-")}.txt`, `state=${row.state} reason=${row.reason} step=${row.failed_step} wipe=${row.wipe_state} polls ok=${pr.s.ok} failed=${pr.s.failed.length}`);
        expect(row.state, `${label}: reason=${row.reason} step=${row.failed_step}`).toBe("failed");
        expect(reasons.includes(row.reason) || (MIRROR_REASONS as readonly string[]).includes(row.reason), `${label}: observed reason ${row.reason}`).toBe(true);
        if (o.steps) expect(o.steps, `${label}: failed step ${row.failed_step}`).toContain(row.failed_step);
        await assertUndisturbed(label, before, {failed: rid, probe: pr, audit: "refresh"});
        return {rid, row, before, pv};
    }

    // ---- L0: the mirror every drill starts from -----------------------------------------------------------------------------------------------------------------------------
    it.skipIf(!LAB)("L0 create the mirror from RP A (READY) and refresh it once to RP B: route established, A kept as the rollback target", async () => {
        const r = await create(world, NAME);
        const row = await drive(r.revisionId, {ms: 300_000});
        expect(row.state, `reason=${row.reason} step=${row.failed_step}`).toBe("ready");
        M = {mirrorId: r.mirrorId, name: NAME}; r1 = {revisionId: r.revisionId, hostPort: r.hostPort, project: await projectOfRev(r.revisionId)}; revs.r1 = r.revisionId;
        const pA = page(r1.hostPort, 6);
        expect(greeting(pA), String(pA)).toBe("hello-from-the-forklab-demo-stack");
        for (const host of ["192.168.8.32", "192.168.8.31", "192.168.8.141"]) expect(site().includes(host)).toBe(false); // guard: never the owner's pilot hosts
        worldB = await good("hello-from-rp-b");
        const asked = await refresh(M, worldB);
        expect(asked.ok, JSON.stringify(asked)).toBe(true);
        const r2id = (asked as {revisionId: string}).revisionId; revs.r2 = r2id;
        const {row: rowB, mir} = await driveRefresh(M, r2id);
        expect(rowB.state, `reason=${rowB.reason} step=${rowB.failed_step}`).toBe("ready");
        await activeIs(M.mirrorId, mir, r2id);
        routePort = mir.route_port as number;
        expect(greeting(page(routePort, 6))).toBe("hello-from-rp-b");
        expect((await rollbackCandidates())).toEqual([r1.revisionId]);
        const sh1 = seedHex(r1.project); const p1 = rpwOf(r1.revisionId)!;
        expect(sh1).toMatch(/^[0-9a-f]{64}$/);
        RUNNER_SECRETS.push(sh1, Buffer.from(sh1, "hex").toString("base64"), p1);
        RUN.push(`L0 PASS ${NAME}: A READY, refreshed to B, route ${routePort} → greeting B, rollback target = A`);
    }, 1_500_000);

    // ---- D1 bad dump -------------------------------------------------------------------------------------------------------------------------------------------------------------
    describe.skipIf(!on("bad-dump"))("D1 bad dump", () => {
        it("D1a raw non-archive bytes instead of the encrypted database archive: the new revision fails and is wiped; the active revision keeps serving", async () => {
            const w = await variantRp(world, {dbDump: Buffer.from("x")});
            objects.set(`/${w.rp}/db_db`, {body: Buffer.from("this is not an encrypted portabase archive"), hits: 0});
            const {pv} = await failedRefresh("D1a", w, ["checksum_mismatch", "archive_invalid", "db_restore_failed", "execution_error", "stage_failed"]);
            expect(pv.ok && pv.preview.selected?.outcome, "the dialog cannot detect a bad dump: the pipeline does").toBe("ready");
            RUN.push("D1a PASS");
        }, 900_000);
        it("D1b a VALID encrypted archive whose plaintext is a garbage pg_custom dump (verify passes, restore fails): failed, wiped, active unchanged", async () => {
            const garbage = Buffer.concat([Buffer.from("PGDMP"), randomBytes(4096)]);
            const w = await variantRp(world, {dbDump: garbage});
            const {row, pv} = await failedRefresh("D1b", w, ["db_restore_failed", "execution_error", "archive_invalid"]);
            expect(pv.ok && pv.preview.selected?.outcome).toBe("ready");
            RUN.push(`D1b PASS (observed ${row.reason} at ${row.failed_step})`);
        }, 900_000);
    });

    // ---- D2 concurrency ----------------------------------------------------------------------------------------------------------------------------------------------------
    describe.skipIf(!on("concurrent"))("D2 concurrent operations", () => {
        it("D2a five simultaneous refreshes of the same newer RP ⇒ exactly one new revision, one plain ok, the rest already (same id) or mirror_busy; the refresh then completes", async () => {
            const g = `hello-d2a-${++tagN}`; const w = await good(g);
            const before = Number((await q("select count(*)::int as n from fork_mirror_revision where mirror_id=$1", [M.mirrorId]))[0]!.n);
            const res = await Promise.all([1, 2, 3, 4, 5].map(() => refresh(M, w)));
            const ok = res.filter((x) => x.ok) as {ok: true; revisionId: string; already?: true}[];
            const plain = ok.filter((x) => !x.already);
            expect(plain, JSON.stringify(res)).toHaveLength(1);
            for (const x of res) if (!x.ok) expect((x as {code: string}).code, JSON.stringify(res)).toBe("mirror_busy"); else expect(x.revisionId).toBe(plain[0]!.revisionId);
            expect(Number((await q("select count(*)::int as n from fork_mirror_revision where mirror_id=$1", [M.mirrorId]))[0]!.n)).toBe(before + 1);
            const rid = plain[0]!.revisionId;
            const {row, mir} = await driveRefresh(M, rid);
            expect(row.state, `reason=${row.reason}`).toBe("ready");
            await activeIs(M.mirrorId, mir, rid);
            expect(greeting(page(routePort, 6))).toBe(g);
            RUN.push(`D2a PASS: ${res.length} calls → ok-plain 1, already ${ok.length - 1}, busy ${res.length - ok.length}; one new revision row; active = ${rid.slice(0, 8)}`);
        }, 1_200_000);
        it("D2b while a refresh runs: rollback / stop / delete answer mirror_busy, the refresh preview mirror_state_invalid; the refresh then completes", async () => {
            const target = await ensureTarget();
            const w = await good(`hello-d2b-${++tagN}`);
            const asked = await refresh(M, w);
            expect(asked.ok, JSON.stringify(asked)).toBe(true);
            const rid = (asked as {revisionId: string}).revisionId;
            expect((await mirrorRow(M.mirrorId)).status).toBe("refreshing");
            const rb = await rollbackMirror(mdeps(), {mirrorId: M.mirrorId, revisionId: target, confirmName: M.name});
            const st = await stopMirror(mdeps(), {mirrorId: M.mirrorId});
            const dl = await deleteMirror(mdeps(), {mirrorId: M.mirrorId, confirmName: M.name});
            const pv = await preview(null);
            expect([rb, st, dl].map((x) => (x as {code?: string}).code), JSON.stringify([rb, st, dl])).toEqual(["mirror_busy", "mirror_busy", "mirror_busy"]);
            expect(pv).toMatchObject({ok: false, code: "mirror_state_invalid"});
            const {row, mir} = await driveRefresh(M, rid);
            expect(row.state, `reason=${row.reason}`).toBe("ready");
            await activeIs(M.mirrorId, mir, rid);
            RUN.push("D2b PASS: rollback/stop/delete ⇒ mirror_busy, preview ⇒ mirror_state_invalid while refreshing; refresh completed, active = new revision");
        }, 1_200_000);
        it("D2c rollback and refresh at the same instant ⇒ exactly one op wins, the other is refused (mirror_busy); the mirror ends ready on an allowed revision with zero failed polls before the switch", async () => {
            const target = await ensureTarget();
            const before = await snapshot();
            const w = await good(`hello-d2c-${++tagN}`);
            const t0 = new Date(Date.now() - 1000);
            const [rb, rf] = await Promise.all([rollbackMirror(mdeps(), {mirrorId: M.mirrorId, revisionId: target, confirmName: M.name}), refresh(M, w)]);
            const winners = [rb, rf].filter((x) => x.ok && !(x as {already?: true}).already);
            expect(winners, JSON.stringify([rb, rf])).toHaveLength(1);
            const loser = [rb, rf].find((x) => !winners.includes(x))!;
            expect(loser.ok ? "already" : (loser as {code: string}).code, JSON.stringify([rb, rf])).toBe("mirror_busy");
            expect(await opsSince(t0), "exactly one mirror-level op started").toBe(1);
            const pr = serving(() => before.routePort);
            const m = await settle(pr, before.routePort, t0);
            expect(m.status, `${await diag(M.mirrorId)}`).toBe("ready");
            const refreshWon = winners[0] === rf;
            const allowed = refreshWon ? (rf as {revisionId: string}).revisionId : target;
            await activeIs(M.mirrorId, m, allowed);
            expect(pr.s.failed, "no failed poll before the switch").toEqual([]);
            expect(greeting(page(before.routePort, 6))).not.toBeNull();
            RUN.push(`D2c PASS: ${refreshWon ? "refresh" : "rollback"} won, the other answered mirror_busy; one op event; ready on ${allowed.slice(0, 8)}; ${pr.s.ok} pre-switch polls ok / 0 failed`);
        }, 1_500_000);
        it("D2d two simultaneous rollbacks ⇒ exactly one op", async () => {
            const target = await ensureTarget();
            const t0 = new Date(Date.now() - 1000);
            const before = await snapshot();
            const res = await Promise.all([1, 2].map(() => rollbackMirror(mdeps(), {mirrorId: M.mirrorId, revisionId: target, confirmName: M.name})));
            expect(res.filter((x) => x.ok && !(x as {already?: true}).already), JSON.stringify(res)).toHaveLength(1);
            for (const x of res) if (!x.ok) expect((x as {code: string}).code).toBe("mirror_busy");
            expect(await opsSince(t0)).toBe(1);
            const pr = serving(() => before.routePort);
            const m = await settle(pr, before.routePort, t0);
            expect(m.status, `${await diag(M.mirrorId)}`).toBe("ready");
            await activeIs(M.mirrorId, m, target);
            expect(pr.s.failed).toEqual([]);
            RUN.push(`D2d PASS: 2 rollbacks → one op; ready on the target ${target.slice(0, 8)}`);
        }, 1_200_000);
    });

    // ---- D3 insufficient disk ----------------------------------------------------------------------------------------------------------------------------------------------
    describe.skipIf(!on("disk"))("D3 insufficient disk", () => {
        it("D3 a 10^15-byte backup: the preview warns with the runner's last report, the refresh fails at the capacity preflight (probe) before anything is staged, the active revision is untouched", async () => {
            const w = await variantRp(world, {plaintextSize: 10 ** 15});
            const pv = await preview(w.rp);
            expect(pv.ok, JSON.stringify(pv)).toBe(true);
            if (!pv.ok) return;
            expect(pv.preview.selected!.requiredDiskBytes).toBeGreaterThanOrEqual(1.1e15);
            expect(typeof pv.preview.lastCapacity?.freeDiskBytes, "a real probe reported the runner's free disk").toBe("number");
            expect(capacityWarning(pv.preview, new Date()), "the dialog warns").not.toBeNull();
            const {rid, row} = await failedRefresh("D3", w, ["insufficient_disk"], {steps: ["probe"]});
            expect(row.reason).toBe("insufficient_disk");
            expect(row.wipe_state).toBe("not_needed");
            expect(Number((await q("select count(*)::int as n from fork_mirror_task where revision_id=$1 and step='stage'", [rid]))[0]!.n), "nothing was staged").toBe(0);
            RUN.push(`D3 PASS: required ${pv.preview.selected!.requiredDiskBytes} B, runner free ${pv.preview.lastCapacity!.freeDiskBytes} B; failed insufficient_disk at probe, zero stage tasks`);
        }, 900_000);
    });

    // ---- D4 isolation failure -----------------------------------------------------------------------------------------------------------------------------------------------
    describe.skipIf(!on("isolation"))("D4 isolation failure", () => {
        it("D4a firewall off: a refresh never reaches READY; the active revision keeps serving; D4b a rollback under the same condition is refused/fails without damage; D4c firewall on ⇒ recovery refresh works", async () => {
            const target = await ensureTarget();
            const before = await snapshot();
            lab(["fw-off"]);
            try {
                // ---- D4a
                const w = await good(`hello-d4a-${++tagN}`);
                const asked = await refresh(M, w);
                if (!asked.ok) {
                    RUN.push(`D4a: refresh refused at request: ${(asked as {code: string}).code}`);
                    expect(["runner_not_isolated", "runner_busy"], JSON.stringify(asked)).toContain((asked as {code: string}).code);
                } else {
                    const rid = asked.revisionId; const pr = serving(() => before.routePort);
                    const {row} = await driveRefresh(M, rid, pr.each);
                    RUN.push(`D4a: revision ${rid.slice(0, 8)} state=${row.state} reason=${row.reason} failed_step=${row.failed_step} wipe=${row.wipe_state}`);
                    keep("d4a-isolation.txt", `state=${row.state} reason=${row.reason} step=${row.failed_step} wipe=${row.wipe_state} polls ok=${pr.s.ok} failed=${pr.s.failed.length}`);
                    expect(["failed", "blocked"], `reason=${row.reason}`).toContain(row.state);
                    expect(row.state).not.toBe("ready");
                    await assertUndisturbed("D4a", before, {failed: rid, probe: pr, audit: "refresh"});
                }
                // ---- D4b: still fw-off
                const rb = await rollbackMirror(mdeps(), {mirrorId: M.mirrorId, revisionId: target, confirmName: M.name});
                if (!rb.ok) {
                    RUN.push(`D4b: rollback refused at request: ${(rb as {code: string}).code}`);
                    expect(["runner_not_isolated", "runner_busy", "mirror_busy"], JSON.stringify(rb)).toContain((rb as {code: string}).code);
                } else {
                    const m = await driveStatus(M.mirrorId, ["ready", "failed"], 600_000);
                    const ev = await q("select kind, from_state, to_state, code from fork_mirror_event where mirror_id=$1 and details->>'scope'='mirror' order by at desc limit 3", [M.mirrorId]);
                    RUN.push(`D4b: rollback accepted → mirror ${m.status}; last mirror events ${JSON.stringify(ev)}`);
                    expect(m.status, JSON.stringify(ev)).toBe("ready");
                    expect(ev[0]!.code, "the failed rollback has a reason code").not.toBeNull();
                }
                const m2 = await mirrorRow(M.mirrorId);
                expect([m2.status, m2.active_revision_id, m2.route_port]).toEqual([before.status, before.active, before.routePort]);
                expect(greeting(page(before.routePort, 6))).toBe(before.greeting);
                const r = await revRow(target);
                expect([r.state, r.wipe_state, r.retired_at], "the rollback target survives a failed rollback").toEqual(["ready", null, null]);
                RUN.push("D4b PASS: active unchanged, route answers, rollback target untouched");
            } finally {
                lab(["fw-on"]);
            }
            // ---- D4c
            const p = await probe(); expect(p.status).toBe("succeeded");
            expect(await iso()).toMatchObject({state: "isolated"});
            const ok = await goodRefresh("D4c", `hello-d4c-${++tagN}`);
            RUN.push(`D4c PASS: firewall on, probe isolated, recovery refresh READY + switched (${ok.rid.slice(0, 8)})`);
        }, 2_400_000);
    });

    // ---- L9 canary (every non-HOLD run) -----------------------------------------------------------------------------------------------------------------------------------
    it.skipIf(!LAB || HOLD)("L9 canary: no dashboard row and no refresh preview carries the production password, the signed-URL secret, the rotated database password, the seed bytes or the runner root", async () => {
        const secrets = [PROD_PW, SECRET_QS.split("=")[1]!];
        const rows = (await Promise.all(["fork_audit_event", "fork_mirror_event", "fork_mirror_task", "fork_mirror_revision", "fork_mirror"].map((tbl) => q(`select to_jsonb(x)::text as j from ${tbl} x`)))).flat().map((r) => r.j as string);
        rows.push(...(await q("select to_jsonb(x)::text as j from fork_agent_task x where type like 'mirror_%'")).map((r) => r.j as string));
        const hay = rows.join("\n");
        expect(hay.length).toBeGreaterThan(1000);
        for (const s of secrets) expect(hay.includes(s), `a row carries a secret (${s.slice(0, 8)}…)`).toBe(false);
        expect(hay.includes(SECRET_QS)).toBe(false);
        expect(RUNNER_SECRETS.length, "L0 must have captured the runner-side secrets").toBeGreaterThanOrEqual(3);
        for (const x of RUNNER_SECRETS) expect(hay.includes(x), "a row carries a runner-side secret (seed / rotated password)").toBe(false);
        const pj = PREVIEWS.join("\n");
        for (const s of [...secrets, ...RUNNER_SECRETS, MIRROR_ROOT, SECRET_QS, GW]) expect(pj.includes(s), "a refresh preview carries a secret / runner path").toBe(false);
        if (["bad-dump", "disk", "all"].includes(DRILL)) expect(PREVIEWS.length, "these drills preview every refresh").toBeGreaterThan(0);
        keep("l9-canary.txt", `scanned ${rows.length} rows (${hay.length} chars) and ${PREVIEWS.length} previews; secrets absent`);
        RUN.push(`L9 PASS canary: ${rows.length} rows + ${PREVIEWS.length} preview answers scanned, no production password / signed-URL secret / seed / runner root`);
    }, 120_000);

    // ---- HOLD: Flow E browser pass -----------------------------------------------------------------------------------------------------------------------------------------
    /** keeps everything up after L0, ticks the orchestrator every 2 s, executes lab commands until $W25_SCRATCH/w25-lab.stop exists */
    it.skipIf(!LAB || !HOLD)("HOLD", async () => {
        expect(SCRATCH).not.toBe("");
        mkdirSync(SCRATCH, {recursive: true});
        const cmdF = path.join(SCRATCH, "w25-lab.cmd"), logF = path.join(SCRATCH, "w25-lab.log"), stopF = path.join(SCRATCH, "w25-lab.stop");
        for (const f of [cmdF, stopF]) { try { unlinkSync(f); } catch { /* none */ } }
        const rpSeq = async (w: W17) => Number((await q("select sequence from fork_recovery_point where id=$1", [w.rp]))[0].sequence);
        const info = {base: site(), admin: ADMIN.email, adminPassword: ADMIN.password, mirrorId: M.mirrorId, mirrorName: M.name, routePort, rpA: world.rp, rpB: worldB.rp, rpSequenceB: await rpSeq(worldB), cmd: cmdF, stop: stopF};
        writeFileSync(path.join(SCRATCH, "w25-lab.json"), JSON.stringify(info, null, 1), {mode: 0o600});
        const say = (cmd: string, ok: boolean, d = "") => writeFileSync(logF, `${new Date().toISOString()} ${cmd} ${ok ? "ok" : "error"} ${d}\n`, {flag: "a"});
        const exec = async (line: string) => {
            const [cmd, a] = line.trim().split(/\s+/);
            if (cmd === "fw-off") lab(["fw-off"]);
            else if (cmd === "fw-on") lab(["fw-on"]);
            else if (cmd === "probe") { const p = await probe(); say(line.trim(), p.status === "succeeded", `isolation=${JSON.stringify(await iso())}`); return; }
            else if (cmd === "rp-good") { const w = await good(a ?? `hello-hold-${++tagN}`); say(line.trim(), true, `rp=${w.rp} sequence=${await rpSeq(w)} greeting=${a ?? "(generated)"}`); return; }
            else if (cmd === "rp-bad") { const w = await variantRp(world, {dbDump: Buffer.concat([Buffer.from("PGDMP"), randomBytes(4096)])}); say(line.trim(), true, `rp=${w.rp} sequence=${await rpSeq(w)} (garbage dump)`); return; }
            else if (cmd === "rp-huge") { const w = await variantRp(world, {plaintextSize: 10 ** 15}); say(line.trim(), true, `rp=${w.rp} sequence=${await rpSeq(w)} (10^15 bytes)`); return; }
            else if (cmd === "curl") { const o = inbox(["sh", "-c", `wget -qO- -T 8 http://127.0.0.1:${a} 2>&1`]); say(line.trim(), true, o.replace(/\s+/g, " ").slice(0, 300)); return; }
            else if (cmd === "mirrors") { const rows = await q("select m.name, m.status, m.route_port, m.active_revision_id, r.seq, r.state, r.reason, r.wipe_state from fork_mirror m join fork_mirror_revision r on r.mirror_id=m.id order by r.seq"); say(line.trim(), true, JSON.stringify(rows)); return; }
            else if (cmd === "ctr-state") { say(line.trim(), true, inbox(["docker", "ps", "-a", "--format", "{{.Names}}={{.State}}"]).replace(/\n/g, " ").slice(0, 600)); return; }
            else throw new Error("unknown");
            say(line.trim(), true);
        };
        say("hold-ready", true, `mirror=${M.mirrorId} name=${M.name} routePort=${routePort}`);
        let lastTick = 0;
        while (!existsSync(stopF)) {
            if (existsSync(cmdF)) {
                const lines = readFileSync(cmdF, "utf8").split("\n").filter((l) => l.trim()); unlinkSync(cmdF);
                for (const l of lines) { try { await exec(l); } catch (e) { say(l.trim(), false, String((e as Error).message).slice(0, 200)); } }
            }
            if (Date.now() - lastTick > 2000) {
                lastTick = Date.now();
                try { await tickAllMirrors(holdDeps()); } catch (e) { say("tick", false, String((e as Error).message).slice(0, 200)); }
            }
            await sleep(500);
        }
    }, 4 * 3_600_000);
});
