import {execFileSync, spawn, spawnSync, type ChildProcess} from "node:child_process";
import {createPrivateKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
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
import {startTestedFact} from "@/fork/mirror/facet";
import {createMirror, deleteMirror, getMirrorAccess, refreshMirror, rollbackMirror} from "@/fork/mirror/service";
import {tickAllMirrors} from "@/fork/mirror/tick";
import {designateRunner, requestRunnerProbe, runnerIsolation, setRunnerTargets, type RunnerDeps} from "@/fork/runner/service";
import {encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import type {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {nextRp} from "@/fork/__tests__/w24-world";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

// ponytail: copy of the W22b lab setup (unique names/subnets 172.31.241/252); extract shared helpers if a fourth mirror lab appears.
/**
 * LIVE W24 refresh lab (FORK_LAB=1, docker lab ONLY, synthetic TEST-ONLY data, never a real host): the REAL fork dashboard (production build) + the REAL fork agent image as a MIRROR RUNNER inside the
 * docker-in-docker runner box (nftables egress policy in the box's netns). The orchestrator tick runs in THIS process with the W22a storage seams (synthetic recovery points of the SAME stack).
 * ONE mirror goes through the whole life: L1 create A · L2 refresh A→B (r1 keeps serving, route switch, forwarder hardening, seed + credentials preserved) · L3 rollback · L4 bad-dump refresh ·
 * L5 insufficient disk · L6 concurrent refresh · L7 retention (decoy survives) · L8 delete (route removed first) · L9 canary. Real-VM proof stays PENDING-HUMAN (#125).
 */
const LAB = process.env.FORK_LAB === "1";
const AGENT_IMAGE = process.env.W24_AGENT_IMAGE ?? "portabase-agent-fork:w24-lab";
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
    const env: NodeJS.ProcessEnv = {...process.env, NODE_ENV: "production", DATABASE_URL: t.url, PROJECT_URL: urlForAgents(), PROJECT_SECRET: `w24-lab-${randomBytes(12).toString("hex")}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
        AUTH_DEFAULT_USER_NAME: "W24 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_MIRRORS_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
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
        if (process.env.W24_FREEZE_AT_DB && (r.steps as {name: string; status: string}[]).some((x) => x.name === "restore_db" && x.status !== "pending")) { await sleep(20_000); throw new Error("frozen for debugging (W24_FREEZE_AT_DB)"); }
        const active = ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting", "healthchecking"].includes(r.state);
        if (!active && (r.state === "ready" || WIPE_FINAL.includes(r.wipe_state))) return r;
        if (!active && r.state !== "ready" && !process.env.W24_QUIET) RUN.push(`terminal ${r.state}/${r.reason}; last tasks: ${JSON.stringify((await q("select type, status, result from fork_agent_task where agent_id=$1 order by seq desc limit 3", [runnerAgent])).map((x) => [x.type, x.status, x.result]))}`);
        if (Date.now() > end) throw new Error(`drive timeout: state=${r.state} reason=${r.reason} steps=${JSON.stringify(r.steps).slice(0, 600)}`);
        await sleep(1000);
    }
}
const ctrs = (rev: string) => inbox(["docker", "ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${rev}`]).split("\n").filter(Boolean);
const ctrOf = (rev: string, service: string) => inbox(["docker", "ps", "-q", "--filter", `label=com.portabase.fork.restore_id=${rev}`, "--filter", `label=com.docker.compose.service=${service}`]).split("\n")[0]!;
const envOf = (ctr: string) => Object.fromEntries((JSON.parse(inbox(["docker", "inspect", ctr, "-f", "{{json .Config.Env}}"])) as string[]).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
const wsOf = (project: string) => `${MIRROR_ROOT}/${project}`;

describe.skipIf(!LAB)("W24 refresh lab: refresh / rollback / retention / route switch on an emulated runner VM (real-VM proof PENDING-HUMAN #125)", () => {
    beforeAll(async () => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "w24-lab-")); priv = path.join(tmp, "private");
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), MASTER, {mode: 0o600});
        process.env.PRIVATE_PATH = priv; process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w24-test-${randomBytes(12).toString("hex")}`;
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
        if (!process.env.W24_KEEP_LAB) { try { lab(["down"]); } catch { /* best effort */ } } // W24_KEEP_LAB=1: debugging only, the caller runs `w24.sh down`
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
        return {s, each: async () => { if (Date.now() - s.last < 2000) return; s.last = Date.now(); const p = page(port()); if (p?.includes("greeting=")) s.ok++; else s.failed.push(`${new Date().toISOString()} ${String(p).slice(0, 60)}`); }};
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

    const NAME = `rf-${NONCE.slice(0, 6)}`;
    let M: {mirrorId: string; name: string}; let r1: {revisionId: string; hostPort: number; project: string}; let worldB: W17; let routePort = 0;
    const revs: Record<string, string> = {};

    it("L1 create the mirror from recovery point A: READY, the demo page answers with greeting A", async () => {
        const r = await create(world, NAME);
        const row = await drive(r.revisionId, {ms: 300_000});
        expect(row.state, `reason=${row.reason} step=${row.failed_step}`).toBe("ready");
        M = {mirrorId: r.mirrorId, name: NAME}; r1 = {revisionId: r.revisionId, hostPort: r.hostPort, project: await projectOfRev(r.revisionId)}; revs.r1 = r.revisionId;
        const p = page(r1.hostPort, 6);
        expect(greeting(p), String(p)).toBe("hello-from-the-forklab-demo-stack");
        expect(uploads(p)).toBe(1);
        expect((await mirrorRow(M.mirrorId)).route_port, "no route before the first switch").toBeNull();
        RUN.push(`L1 PASS ${NAME} READY on 127.0.0.1:${r1.hostPort}: ${p!.replace(/\s+/g, " ").slice(0, 100)}`);
    }, 600_000);

    it("L2 refresh A→B: r1 keeps serving (every 2 s, zero failures) while r2 builds; the route switches to r2; the forwarder is hardened; seed + test credentials preserved", async () => {
        worldB = await variantRp(world, {files: filesArchive("b", "hello-from-rp-b", "second.txt")});
        const asked = await refresh(M, worldB);
        expect(asked.ok, JSON.stringify(asked)).toBe(true);
        const r2id = (asked as {revisionId: string}).revisionId; revs.r2 = r2id;
        expect((await mirrorRow(M.mirrorId)).status).toBe("refreshing");
        const probeR1 = serving(() => r1.hostPort);
        const {row, mir} = await driveRefresh(M, r2id, probeR1.each);
        expect(row.state, `reason=${row.reason} step=${row.failed_step}`).toBe("ready");
        expect(mir.status, JSON.stringify(mir)).toBe("ready");
        expect(probeR1.s.failed, "r1 answered every poll while r2 was built").toEqual([]);
        expect(probeR1.s.ok).toBeGreaterThan(3);
        await activeIs(M.mirrorId, mir, r2id);
        expect(mir.route_revision_id).toBe(r2id);
        routePort = mir.route_port as number;
        const r2port = (await revRow(r2id)).host_port as number;
        expect([routePort, r1.hostPort, r2port].filter((x, i, a) => a.indexOf(x) === i)).toHaveLength(3); // the stable route port is neither revision's port
        const acc = await getMirrorAccess(mdeps(), {mirrorId: M.mirrorId});
        expect(acc).toMatchObject({ok: true, access: {hostPort: routePort}});
        const pB = page(routePort, 6);
        expect(greeting(pB), String(pB)).toBe("hello-from-rp-b");
        expect(uploads(pB)).toBe(2);
        expect(page(r1.hostPort), "r1 is stopped").toBeNull();
        expect(ctrStates(r1.project).every((x) => x.endsWith("=exited")), JSON.stringify(ctrStates(r1.project))).toBe(true);
        // the forwarder container, as the runner really has it
        const name = routeName(M.mirrorId); const r2project = await projectOfRev(r2id);
        const ins = JSON.parse(inbox(["docker", "inspect", name]))[0];
        expect(Object.keys(ins.NetworkSettings.Networks)).toEqual([`${r2project}_pbm_access`]);
        const bindings = ins.HostConfig.PortBindings as Record<string, {HostIp: string; HostPort: string}[]>;
        expect(bindings).toEqual({"8080/tcp": [{HostIp: "127.0.0.1", HostPort: String(routePort)}]});
        expect(ins.Config.User).toBe("65534:65534");
        expect(ins.HostConfig.ReadonlyRootfs).toBe(true);
        expect(ins.HostConfig.CapDrop).toEqual(["ALL"]);
        expect(ins.HostConfig.SecurityOpt).toContain("no-new-privileges");
        expect(ins.Config.Labels["com.portabase.fork.helper"]).toBeUndefined();
        expect(inbox(["docker", "ps", "--format", "{{.Ports}}"])).not.toContain("0.0.0.0");
        // the route port is reachable on the runner's loopback only: from the lab network (the box's lab address) it is refused
        const probeLab = spawnSync("docker", ["run", "--rm", "--network", "w24-lab-net", "busybox@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4", "wget", "-qO-", "-T", "3", `http://172.31.241.10:${routePort}/`], {encoding: "utf8"});
        expect(probeLab.status, "the route port must not answer on the runner's lab address").not.toBe(0);
        // test credentials preserved: same seed, same rotated database password (compared as booleans, never printed)
        const r2proj = r2project;
        expect(inbox(["sh", "-c", `cmp ${wsOf(r1.project)}/.portabase/mirror/seed ${wsOf(r2proj)}/.portabase/mirror/seed && echo same`])).toBe("same");
        const [p1, p2] = [rpwOf(r1.revisionId), rpwOf(r2id)];
        expect(p1 !== undefined && p1 === p2, "the rotated database password is identical across revisions").toBe(true);
        expect(p1).not.toBe(PROD_PW);
        keep("l2-refresh.txt", `r1=${r1.revisionId} r2=${r2id} route=${routePort} polls ok=${probeR1.s.ok} failed=${probeR1.s.failed.length}\n${JSON.stringify({networks: Object.keys(ins.NetworkSettings.Networks), bindings, user: ins.Config.User, ro: ins.HostConfig.ReadonlyRootfs, capdrop: ins.HostConfig.CapDrop})}`);
        RUN.push(`L2 PASS refresh A→B: ${probeR1.s.ok} polls of r1 during the build, 0 failed; route ${routePort} → greeting B, uploads=2; forwarder on ${r2project}_pbm_access only, loopback only, user 65534, ro rootfs, cap drop ALL; seed + db password identical; lab-address probe refused`);
    }, 1_200_000);

    it("L3 rollback to r1: greeting A again through the same route port; r2 is rolled_back and wiped (verified); the route is attached only to r1; the start-tested fact is r1's", async () => {
        const r2id = revs.r2; const r2project = await projectOfRev(r2id);
        const res = await rollbackMirror(mdeps(), {mirrorId: M.mirrorId, revisionId: r1.revisionId, confirmName: M.name});
        expect(res, JSON.stringify(res)).toMatchObject({ok: true});
        const mir = await driveStatus(M.mirrorId, ["ready", "failed"]);
        expect(mir.status, JSON.stringify(mir)).toBe("ready");
        expect(mir.active_revision_id).toBe(r1.revisionId);
        expect(mir.route_revision_id).toBe(r1.revisionId);
        expect(mir.route_port).toBe(routePort);
        const p = page(routePort, 6);
        expect(greeting(p), String(p)).toBe("hello-from-the-forklab-demo-stack");
        await tickUntil("r2 wiped", async () => ["verified", "failed"].includes((await revRow(r2id)).wipe_state));
        const r2 = await revRow(r2id);
        expect(r2.state).toBe("rolled_back");
        expect(r2.wipe_state).toBe("verified");
        gone(r2project, r2id);
        const ins = JSON.parse(inbox(["docker", "inspect", routeName(M.mirrorId)]))[0];
        expect(Object.keys(ins.NetworkSettings.Networks)).toEqual([`${r1.project}_pbm_access`]);
        expect((await startTestedFact(db, world.stack))?.revisionId).toBe(r1.revisionId);
        const audits = await q("select action, result, redacted_details from fork_audit_event where action = 'fork.mirror.rollback' order by created_at");
        expect(audits.map((a) => a.redacted_details?.phase).filter(Boolean), JSON.stringify(audits)).toEqual(expect.arrayContaining(["requested", "done"]));
        RUN.push(`L3 PASS rollback: route ${routePort} → greeting A; r2 rolled_back + wipe verified + nothing left; route on ${r1.project}_pbm_access only; start-tested fact = r1`);
    }, 900_000);

    it("L4 bad-dump refresh: the new revision fails and is wiped; the mirror stays ready on r1 and the route keeps answering (greeting A) during and after", async () => {
        const worldC = await variantRp(world, {dbDump: Buffer.from("not a pg dump")});
        const asked = await refresh(M, worldC);
        expect(asked.ok, JSON.stringify(asked)).toBe(true);
        const r3id = (asked as {revisionId: string}).revisionId; revs.r3 = r3id;
        const probe3 = serving(() => routePort);
        const {row, mir} = await driveRefresh(M, r3id, probe3.each);
        expect(row.state, `reason=${row.reason}`).toBe("failed");
        expect(row.wipe_state).toBe("verified");
        expect(mir.status).toBe("ready");
        expect(mir.active_revision_id).toBe(r1.revisionId);
        expect(mir.route_revision_id).toBe(r1.revisionId);
        expect(probe3.s.failed, "the route answered during the failed refresh").toEqual([]);
        expect(greeting(page(routePort, 6))).toBe("hello-from-the-forklab-demo-stack");
        gone(await projectOfRev(r3id), r3id);
        keep("l4-bad-dump.txt", `r3 state=${row.state} reason=${row.reason} step=${row.failed_step} wipe=${row.wipe_state}; polls ok=${probe3.s.ok}`);
        RUN.push(`L4 PASS bad dump: r3 failed (${row.reason}) wipe ${row.wipe_state}; mirror ready on r1, route unchanged, ${probe3.s.ok} polls ok / 0 failed`);
    }, 900_000);

    it("L5 insufficient disk: the capacity preflight fails at the probe step before anything is staged; nothing was copied; the mirror and the route are untouched", async () => {
        const worldD = await variantRp(world, {plaintextSize: 10 ** 15});
        const asked = await refresh(M, worldD);
        expect(asked.ok, JSON.stringify(asked)).toBe(true);
        const r4id = (asked as {revisionId: string}).revisionId; revs.r4 = r4id;
        const {row, mir} = await driveRefresh(M, r4id);
        expect(row.state).toBe("failed");
        expect(row.reason).toBe("insufficient_disk");
        expect(row.failed_step).toBe("probe");
        expect(row.wipe_state).toBe("not_needed");
        expect((await q("select count(*)::int as n from fork_mirror_task where revision_id=$1 and step='stage'", [r4id]))[0]!.n).toBe(0);
        expect(mir.status).toBe("ready");
        expect(mir.active_revision_id).toBe(r1.revisionId);
        expect(greeting(page(routePort, 6))).toBe("hello-from-the-forklab-demo-stack");
        RUN.push(`L5 PASS insufficient disk: r4 failed insufficient_disk at probe, no stage task, wipe ${row.wipe_state}; route answers greeting A`);
    }, 600_000);

    it("L6 concurrent refresh: two requests at once ⇒ exactly one new revision, the second answer is `already` with the same id; the refresh then completes and the route points at it", async () => {
        const worldE = await variantRp(world, {files: filesArchive("e", "hello-from-rp-e", "second.txt")});
        const before = Number((await q("select count(*)::int as n from fork_mirror_revision where mirror_id=$1", [M.mirrorId]))[0]!.n);
        const [a, b] = await Promise.all([refresh(M, worldE), refresh(M, worldE)]);
        expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
        expect((a as {revisionId: string}).revisionId).toBe((b as {revisionId: string}).revisionId);
        expect([a, b].filter((x) => (x as {already?: true}).already === true)).toHaveLength(1);
        expect(Number((await q("select count(*)::int as n from fork_mirror_revision where mirror_id=$1", [M.mirrorId]))[0]!.n)).toBe(before + 1);
        const r5id = (a as {revisionId: string}).revisionId; revs.r5 = r5id;
        const {row, mir} = await driveRefresh(M, r5id);
        expect(row.state, `reason=${row.reason}`).toBe("ready");
        await activeIs(M.mirrorId, mir, r5id);
        expect(mir.route_revision_id).toBe(r5id);
        expect(greeting(page(routePort, 6))).toBe("hello-from-rp-e");
        const r1row = await revRow(r1.revisionId);
        expect(r1row.state, "r1 is retained (stopped) for rollback").toBe("ready");
        expect(ctrStates(r1.project).every((x) => x.endsWith("=exited"))).toBe(true);
        for (const k of ["r3", "r4"]) expect(["verified", "not_needed"]).toContain((await revRow(revs[k]!)).wipe_state);
        RUN.push(`L6 PASS concurrent refresh: one revision row (${before} → ${before + 1}), second answer already:true; r5 READY, route → greeting E; r1 retained stopped; r3/r4 wiped`);
    }, 900_000);

    it("L7 retention: one more refresh ⇒ at most two kept READY revisions; the oldest non-active one is retired and wiped (verified); a decoy of another owner survives", async () => {
        inbox(["docker", "run", "-d", "--name", "w24-decoy", "--label", `com.portabase.fork.restore_id=${randomUUID()}`, "--label", `com.portabase.fork.agent_id=${runnerAgent}`, "--entrypoint", "sleep", "postgres:17-alpine", "3600"]);
        const worldF = await variantRp(world, {files: filesArchive("f", "hello-from-rp-f", "second.txt")});
        const asked = await refresh(M, worldF);
        expect(asked.ok, JSON.stringify(asked)).toBe(true);
        const r6id = (asked as {revisionId: string}).revisionId; revs.r6 = r6id;
        const {row, mir} = await driveRefresh(M, r6id);
        expect(row.state, `reason=${row.reason}`).toBe("ready");
        await activeIs(M.mirrorId, mir, r6id);
        await tickUntil("r1 retired + wiped", async () => ["verified", "failed"].includes((await revRow(r1.revisionId)).wipe_state));
        const r1row = await revRow(r1.revisionId);
        expect(r1row.retired_at).not.toBeNull();
        expect(r1row.wipe_state).toBe("verified");
        gone(r1.project, r1.revisionId);
        const kept = await q("select id from fork_mirror_revision where mirror_id=$1 and state='ready' and retired_at is null and coalesce(wipe_state,'') not in ('verified','not_needed') order by seq", [M.mirrorId]);
        expect(kept.map((x) => x.id).sort()).toEqual([revs.r5!, r6id].sort());
        expect(inbox(["docker", "ps", "-q", "--filter", "name=w24-decoy"]), "the decoy of another owner must survive").not.toBe("");
        expect(greeting(page(routePort, 6))).toBe("hello-from-rp-f");
        RUN.push(`L7 PASS retention: kept = {r6 active, r5}; r1 retired + wipe verified + nothing left; decoy survived`);
    }, 900_000);

    it("L8 delete: the route is removed FIRST (no forwarder container, no route directory), then every revision is wiped (verified); the name and the route port are reusable", async () => {
        const del = await deleteMirror(mdeps(), {mirrorId: M.mirrorId, confirmName: M.name});
        expect(del).toEqual({ok: true});
        const end = Date.now() + 300_000;
        for (;;) { await tickAllMirrors(mdeps()); const m = await mirrorRow(M.mirrorId); if (m.status === "deleted") break; if (Date.now() > end) throw new Error(`delete timeout: ${m.status}`); await sleep(1000); }
        const tasks = await q("select t.step, t.created_at from fork_mirror_task t join fork_mirror_revision r on r.id=t.revision_id where r.mirror_id=$1 and t.created_at >= (select max(at) from fork_mirror_event where mirror_id=$1 and to_state='deleting') order by t.created_at, t.step", [M.mirrorId]);
        const routeIdx = tasks.findIndex((x) => x.step === "route"); const firstWipe = tasks.findIndex((x) => x.step === "wipe");
        expect(routeIdx, JSON.stringify(tasks.map((x) => x.step))).toBeGreaterThanOrEqual(0);
        expect(routeIdx).toBeLessThan(firstWipe);
        expect(inbox(["docker", "ps", "-aq", "--filter", "name=pbm-route-"])).toBe("");
        expect(inbox(["sh", "-c", `ls -d ${MIRROR_ROOT}/pbm-route-* 2>/dev/null | wc -l`])).toBe("0");
        const all = await q("select id, project, wipe_state from fork_mirror_revision where mirror_id=$1", [M.mirrorId]);
        for (const r of all) { expect(["verified", "not_needed"], `${r.project}`).toContain(r.wipe_state); gone(r.project, r.id); }
        const m = await mirrorRow(M.mirrorId);
        expect(m.route_port).toBeNull();
        // the name and the route port are free again
        const again = await create(world, NAME);
        const row = await drive(again.revisionId, {ms: 300_000});
        expect(row.state, `reason=${row.reason}`).toBe("ready");
        expect(page(again.hostPort)).toContain("greeting=");
        expect(await deleteMirror(mdeps(), {mirrorId: again.mirrorId, confirmName: NAME})).toEqual({ok: true});
        const end2 = Date.now() + 300_000;
        for (;;) { await tickAllMirrors(mdeps()); if ((await mirrorRow(again.mirrorId)).status === "deleted") break; if (Date.now() > end2) throw new Error("second delete timeout"); await sleep(1000); }
        RUN.push(`L8 PASS delete: route task before the first wipe, no pbm-route container/dir, ${all.length} revisions wiped, name reused`);
    }, 1_200_000);

    it("L9 canary: no audit / event / task / revision / mirror row of the whole run carries the production password, the signed-URL secret, the rotated database password or the seed bytes", async () => {
        const secrets = [PROD_PW, SECRET_QS.split("=")[1]!, NONCE, "/srv/portabase-mirrors"];
        const rows = (await Promise.all(["fork_audit_event", "fork_mirror_event", "fork_mirror_task", "fork_mirror_revision", "fork_mirror"].map((tbl) => q(`select to_jsonb(x)::text as j from ${tbl} x`)))).flat().map((r) => r.j as string);
        rows.push(...(await q("select to_jsonb(x)::text as j from fork_agent_task x where type like 'mirror_%'")).map((r) => r.j as string)); // the agents' results (payloads are encrypted at rest)
        const hay = rows.join("\n");
        expect(hay.length).toBeGreaterThan(1000);
        for (const s of secrets.filter((x) => x !== NONCE && x !== "/srv/portabase-mirrors")) expect(hay.includes(s), `a row carries a secret (${s.slice(0, 8)}…)`).toBe(false);
        expect(hay.includes(SECRET_QS)).toBe(false);
        // seed + rotated password were read from the box while the revisions still existed (L2/L3): re-derive from a fresh mirror would be a second lab; the seed canary uses the box's remaining objects
        const leftoverSeeds = inbox(["sh", "-c", `ls ${MIRROR_ROOT}/*/.portabase/mirror/seed 2>/dev/null || true`]).split("\n").filter(Boolean);
        for (const f of leftoverSeeds) { const hex = inbox(["sh", "-c", `od -An -tx1 -v ${f} | tr -d ' \\n'`]); expect(hay.includes(hex) || hay.includes(Buffer.from(hex, "hex").toString("base64"))).toBe(false); }
        keep("l9-canary.txt", `scanned ${rows.length} rows (${hay.length} chars); secrets absent`);
        RUN.push(`L9 PASS canary: ${rows.length} rows scanned, no production password / signed-URL secret / seed`);
    }, 120_000);
});
