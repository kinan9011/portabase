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
import {cancelMirrorRevision, createMirror, getMirrorView} from "@/fork/mirror/service";
import {tickAllMirrors} from "@/fork/mirror/tick";
import {designateRunner, requestRunnerProbe, runnerIsolation, setRunnerTargets, type RunnerDeps} from "@/fork/runner/service";
import {encryptAgentArchive, sha256} from "@/fork/__tests__/agent-archive";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import type {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";

/**
 * LIVE W22a-f1 lab, "Flow D" (FORK_LAB=1, docker lab ONLY, synthetic TEST-ONLY data, never a real host): the REAL fork dashboard (production build, its mirror job off:
 * the test drives `tickAllMirrors`) creates a test mirror of the demo stack THROUGH THE SERVICE the server action calls, on the REAL fork agent image running as a MIRROR RUNNER inside the
 * W21 docker-in-docker "runner box" (nftables egress policy in the box's own netns, production sinks on a separate lab network). Real-VM proof stays PENDING-HUMAN (#125).
 *   L1 create → READY · L2 isolation from inside the mirror · L3 loopback-only access · L4 secrets · L9 limits · L8 role gating · L6 blocked · L7 cancel · L5 negative control (firewall off).
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, W22A_AGENT_IMAGE (local fork image, never pushed). `dev/fork-lab/runner/w22a.sh` builds the box.
 */
const LAB = process.env.FORK_LAB === "1";
const AGENT_IMAGE = process.env.W22A_AGENT_IMAGE ?? "portabase-agent-fork:w22a-lab";
const GW = "172.31.247.1";
const W22A_SH = path.join(process.cwd(), "dev/fork-lab/runner/w22a.sh");
const BOX = "w22a-runner", PROD_AGENT = "w22a-agent-prod";
const MIRROR_ROOT = "/srv/portabase-mirrors";
const PROD_PW = "demo-synthetic-not-a-secret"; // the production POSTGRES_PASSWORD inside the demo stack's stack.env
const SECRET_QS = `X-Amz-Signature=${randomBytes(12).toString("hex")}SECRETSIG`;
const NONCE = randomBytes(6).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[], o: {env?: NodeJS.ProcessEnv; input?: string} = {}) => execFileSync(cmd, args, {encoding: "utf8", env: o.env ?? process.env, input: o.input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024}).trim();
const docker = (args: string[]) => sh("docker", args);
const inbox = (args: string[]) => docker(["exec", BOX, ...args]);
const lab = (args: string[], env: Record<string, string> = {}, input?: string) => sh("bash", [W22A_SH, ...args], {env: {...process.env, W22A_AGENT_IMAGE: AGENT_IMAGE, ...env}, input});
const logs = (name: string) => { const r = spawnSync("docker", ["logs", name], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024}); return `${r.stdout ?? ""}${r.stderr ?? ""}`; };
const freePort = (host: string) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
const FX = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {name: string; file: string; plaintext_sha256: string; plaintext_size: number}[]};
const fxFile = (n: string) => readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures", FX.fixtures.find((f) => f.name === n)!.file));
const fx = (n: string) => FX.fixtures.find((f) => f.name === n)!;
const MASTER = Buffer.from(FX.master_key_b64, "base64");

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let tmp = ""; let priv = ""; let base = ""; let org = ""; let adminId = ""; let dashPort = 0; let artPort = 0; let server: http.Server;
let runnerAgent = ""; let prodAgent = ""; let runnerBundle = ""; let prodBundle = ""; let world: W17;
const objects = new Map<string, {body: Buffer; hits: number; holdMs?: number}>();
const RUN: string[] = [];
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const urlForAgents = () => `http://forklab-dashboard.localhost:${dashPort}`;
const ENV = {FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60};
const superP = () => ({userId: adminId, systemRole: "superadmin" as const, memberships: [{organizationId: org, role: "admin"}]});
const rdeps = (): RunnerDeps => ({db, principal: superP(), keys: fileKeyProvider, serverUrl: urlForAgents, stepUp: async () => "ok", env: () => ENV, configAllowed: async () => true, mirrorsEnabled: () => true, rate: (() => ({ok: true})) as never});
const mdeps = (over: Partial<MirrorDeps> = {}): MirrorDeps => ({...rdeps(), artifactUrl: async (sid) => { const [a] = await q("select rp_id, source_name from fork_recovery_point_artifact where backup_storage_id=$1", [sid]); return `http://${GW}:${artPort}/${a.rp_id}/${a.source_name}?${SECRET_QS}`; },
    manifest: async () => ({json: world.manifestJson, sigB64: world.manifestSig}), principalOf: async (id) => (id === adminId ? {kind: "ok", principal: superP()} : {kind: "missing"}), ...over});
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-8).join("\n").slice(-1500)}\n--- runner agent ---\n${stripAnsi(sh("docker", ["exec", BOX, "docker", "logs", "runner-agent"])).split("\n").slice(-14).join(" | ").slice(-2500)}`);
        await sleep(1000);
    }
}
async function startDashboard() {
    const env: NodeJS.ProcessEnv = {...process.env, NODE_ENV: "production", DATABASE_URL: t.url, PROJECT_URL: urlForAgents(), PROJECT_SECRET: `w22a-lab-${randomBytes(12).toString("hex")}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
        AUTH_DEFAULT_USER_NAME: "W22a Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_MIRRORS_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
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
    if (poison) yml = yml.replace("      - data:/data\n", "      - data:/data\n      - /var/run/docker.sock:/var/run/docker.sock\n");
    writeFileSync(path.join(src, "compose.yml"), yml);
    writeFileSync(path.join(src, "uploads/hello.txt"), "hello from the backup\n");
    const tgz = path.join(tmp, `files-${poison ? "poison" : "demo"}.tar.gz`); execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
    const filesPlain = readFileSync(tgz);
    const sk = await fileKeyProvider.signing(); const key = {privateKey: sk.privateKeyPem, publicKey: sk.publicKeyPem, kid: kidOfPublicKey(sk.publicKeyPem)};
    const w = await seedW17World(t, "", key as ReturnType<typeof testKeypair>, adminId, {org, hostRole: "production", roots: ["/srv/none"], caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"],
        plain: {compose_app: {sha: sha256(filesPlain), size: filesPlain.length}, volume_app_data: {sha: fx("lab-volume").plaintext_sha256, size: fx("lab-volume").plaintext_size}, db_db: {sha: fx("lab-postgres").plaintext_sha256, size: fx("lab-postgres").plaintext_size, dump: "pg_custom"}},
        enrolDeps: {serverUrl: urlForAgents, stepUp: async () => "ok", keys: fileKeyProvider, env: () => ENV, principal: {userId: adminId, systemRole: "superadmin", memberships: []}}});
    objects.set(`/${w.rp}/compose_app`, {body: encryptAgentArchive(MASTER, filesPlain), hits: 0}); objects.set(`/${w.rp}/volume_app_data`, {body: fxFile("lab-volume"), hits: 0}); objects.set(`/${w.rp}/db_db`, {body: fxFile("lab-postgres"), hits: 0});
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
        const active = ["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting", "healthchecking"].includes(r.state);
        if (!active && (r.state === "ready" || WIPE_FINAL.includes(r.wipe_state))) return r;
        if (Date.now() > end) throw new Error(`drive timeout: state=${r.state} reason=${r.reason} steps=${JSON.stringify(r.steps).slice(0, 600)}`);
        await sleep(1000);
    }
}
const ctrs = (rev: string) => inbox(["docker", "ps", "-aq", "--filter", `label=com.portabase.fork.restore_id=${rev}`]).split("\n").filter(Boolean);
const ctrOf = (rev: string, service: string) => inbox(["docker", "ps", "-q", "--filter", `label=com.portabase.fork.restore_id=${rev}`, "--filter", `label=com.docker.compose.service=${service}`]).split("\n")[0]!;
const envOf = (ctr: string) => Object.fromEntries((JSON.parse(inbox(["docker", "inspect", ctr, "-f", "{{json .Config.Env}}"])) as string[]).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
const wsOf = (project: string) => `${MIRROR_ROOT}/${project}`;
let m1: {mirrorId: string; revisionId: string; hostPort: number; project: string};

describe.skipIf(!LAB)("W22a-f1 mirror lab (Flow D): a test mirror is created from a verified recovery point on an emulated runner VM (real-VM proof PENDING-HUMAN #125)", () => {
    beforeAll(async () => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "w22a-lab-")); priv = path.join(tmp, "private");
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), MASTER, {mode: 0o600});
        process.env.PRIVATE_PATH = priv; process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w22a-test-${randomBytes(12).toString("hex")}`;
        lab(["down"]); lab(["nets"]); lab(["sinks"]);
        dashPort = await freePort(GW); artPort = await freePort(GW); base = `http://${GW}:${dashPort}`;
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
        runnerAgent = await seedAgent(t.pool, org, "w22a-runner-agent"); prodAgent = await seedAgent(t.pool, org, "w22a-prod-agent");
        const enrol = async (agentId: string) => { const r = await enrolAgent({...rdeps()} as never, {agentId, password: PASSWORD}); if (!r.ok) throw new Error(`enrol ${r.code}`); return r.bundle; };
        runnerBundle = await enrol(runnerAgent); prodBundle = await enrol(prodAgent);
        lab(["box"], {DASH_PORT: String(dashPort), ARTIFACT_PORT: String(artPort)});
        lab(["agent"], {DASH_PORT: String(dashPort), EDGE_KEY: edgeKeyOf(runnerAgent)}, runnerBundle);
        const bf = path.join(tmp, "prod.bundle"); writeFileSync(bf, prodBundle, {mode: 0o600}); chmodSync(bf, 0o600);
        sh("docker", ["run", "-d", "--name", PROD_AGENT, "--network", "w22a-lab-net", "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production", "-e", "FORK_CHANNEL_ENABLED=true",
            "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2", "-v", `${bf}:/run/fork/bundle:ro`, AGENT_IMAGE], {env: {...process.env, EDGE_KEY: edgeKeyOf(prodAgent)}});
        const nets = Object.keys(JSON.parse(docker(["inspect", BOX, "-f", "{{json .NetworkSettings.Networks}}"]))).sort();
        expect(nets).toEqual(["w22a-lab-net", "w22a-prod-net"]);
        const TARGETS = [
            {kind: "tcp", host: "172.31.248.25", port: 25, class: "smtp", label: "Prod SMTP"}, {kind: "tcp", host: "172.31.248.80", port: 8080, class: "webhook", label: "Prod webhook"},
            {kind: "tcp", host: "172.31.248.54", port: 5432, class: "database", label: "Prod DB"}, {kind: "dns_tcp", host: "172.31.248.53", port: 53, class: "dns", label: "Prod resolver TCP"},
            {kind: "tcp", host: GW, port: dashPort, class: "custom", label: "Dashboard lab"}, {kind: "tcp", host: "172.31.247.10", port: 2376, class: "custom", label: "Runner host dockerd - input chain"},
            {kind: "dns_name", host: `leak${NONCE}.w22a.lab`, class: "dns", label: "Leak canary name"},
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
        server?.close();
        try { lab(["down"]); } catch { /* best effort */ }
        await t?.drop();
        rmSync(tmp, {recursive: true, force: true});
    });

    it("L1 create → READY: a mirror of the demo stack is created through the service (as createMirrorAction does), runs five gates and ends READY; the start-tested fact is set; the read model carries no value", async () => {
        const r = await create(world, "lab1");
        const project = `pbm-lab1-r1`;
        m1 = {...r, project};
        const seen = new Set<string>();
        const row = await drive(r.revisionId, {each: (x) => { seen.add(x.state); }});
        RUN.push(`L1 states seen: ${[...seen].join(" > ")}`);
        expect(row.state, `reason=${row.reason} step=${row.failed_step} steps=${JSON.stringify(row.steps).slice(0, 800)}`).toBe("ready");
        for (const g of ["expected_data", "db_health", "app_smoke", "isolation", "side_effects"]) expect(row.gates[g]?.ok, g).toBe(true);
        const fact = await startTestedFact(db, world.stack);
        expect(fact?.revisionId).toBe(r.revisionId);
        const v = await getMirrorView(mdeps(), {mirrorId: r.mirrorId});
        expect(v.ok).toBe(true);
        keep("l1-view.json", JSON.stringify(v, null, 2));
        expect(JSON.stringify(v)).not.toContain(PROD_PW);
        expect(row.wipe_state).toBeNull();
        RUN.push(`L1 PASS revision ${r.revisionId} READY on host port ${r.hostPort}; gates all ok; facet readiedAt=${fact?.readiedAt.toISOString()} duration=${fact?.durationSeconds}s; start-tested set`);
    }, 900_000);

    it("L2 isolation from inside the mirror: the app container (on the loopback-published access network) cannot reach the SMTP / webhook / DB sinks or resolve a nonce name; the sinks and the wire saw nothing; the internal DB path works (control)", async () => {
        const web = ctrOf(m1.revisionId, "web"), dbc = ctrOf(m1.revisionId, "db");
        expect(web && dbc).toBeTruthy();
        lab(["capture", "start"]);
        const attempt = (c: string, cmd: string) => { const r = spawnSync("docker", ["exec", BOX, "docker", "exec", c, "sh", "-c", cmd], {encoding: "utf8"}); return `${r.stdout}${r.stderr}`.trim(); };
        const results = {
            smtp: attempt(web, "nc -w 3 172.31.248.25 25 </dev/null; echo rc=$?"), hook: attempt(web, "nc -w 3 172.31.248.80 8080 </dev/null; echo rc=$?"), db: attempt(web, "nc -w 3 172.31.248.54 5432 </dev/null; echo rc=$?"),
            dnsTcp: attempt(web, "nc -w 3 172.31.248.53 53 </dev/null; echo rc=$?"), name: attempt(web, `nslookup leak${NONCE}.w22a.lab 2>&1 | tail -2; echo rc=$?`),
            dbFromDb: attempt(dbc, "nc -w 3 172.31.248.25 25 </dev/null; echo rc=$?"), control: attempt(web, "nc -w 3 demo-db 5432 </dev/null; echo rc=$?"),
        };
        lab(["capture", "stop"]);
        for (const k of ["smtp", "hook", "db", "dnsTcp", "dbFromDb"] as const) expect(results[k], k).not.toMatch(/rc=0/);
        expect(results.control, "the db is reachable on the mirror's own network").toMatch(/rc=0/);
        const logsOf2 = (n: string) => stripAnsi(logs(n));
        for (const s of ["w22a-sink-smtp", "w22a-sink-hook", "w22a-sink-dns"]) expect(logsOf2(s), s).not.toContain("CONN");
        expect(logsOf2("w22a-sink-db")).not.toMatch(/connection received: host=\d/);
        expect(lab(["capture", "show"])).not.toContain(NONCE);
        keep("l2-attempts.json", JSON.stringify(results, null, 2));
        RUN.push(`L2 PASS sinks quiet, wire capture clean, attempts=${JSON.stringify(results)}`);
    }, 300_000);

    it("L3 inbound is loopback-only: the demo page is served on 127.0.0.1:<host_port> inside the box (greeting + restored rows + a successful DB login with the ROTATED password); from the lab network the same port is refused", async () => {
        const page = inbox(["sh", "-c", `wget -qO- -T 8 http://127.0.0.1:${m1.hostPort}/ 2>&1`]);
        RUN.push(`L3 page: ${page.replace(/\n/g, " | ")}`);
        expect(page).toContain("greeting=hello-from-the-forklab-demo-stack");
        expect(page).toMatch(/rows=\d+/);
        expect(page).not.toMatch(/FATAL|password authentication|could not/i);
        const rows = Number(/rows=(\d+)/.exec(page)![1]);
        expect(rows).toBeGreaterThan(0);
        const fromLab = spawnSync("curl", ["-sS", "-m", "5", `http://172.31.247.10:${m1.hostPort}/`], {encoding: "utf8"});
        expect(fromLab.status, `${fromLab.stdout}${fromLab.stderr}`).not.toBe(0);
        const ports = inbox(["docker", "ps", "--filter", `label=com.portabase.fork.restore_id=${m1.revisionId}`, "--format", "{{.Names}} {{.Ports}}"]);
        expect(ports).not.toMatch(/0\.0\.0\.0|\[::\]/);
        RUN.push(`L3 PASS rows=${rows}, lab-network access refused (curl rc=${fromLab.status}), ports: ${ports.replace(/\n/g, "; ")}`);
    }, 120_000);

    it("L4 secrets: db and app carry the SAME rotated POSTGRES_PASSWORD (≠ the production value); neither value nor the seed exists anywhere in the dashboard (DB, log, audit, read model); the seed file is 0600 and stays in the box", async () => {
        const web = envOf(ctrOf(m1.revisionId, "web")), dbe = envOf(ctrOf(m1.revisionId, "db"));
        expect(dbe.POSTGRES_PASSWORD).toBe(web.POSTGRES_PASSWORD);
        expect(dbe.POSTGRES_PASSWORD).not.toBe(PROD_PW);
        expect(dbe.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{32}$/);
        const seedFile = `${wsOf(m1.project)}/.portabase/mirror/seed`;
        expect(inbox(["stat", "-c", "%a", seedFile])).toBe("600");
        expect(inbox(["stat", "-c", "%a", `${wsOf(m1.project)}/.portabase/mirror/out.json`])).toBe("600");
        const seedHex = inbox(["sh", "-c", `od -An -tx1 -v ${seedFile} | tr -d ' \\n'`]);
        expect(seedHex).toHaveLength(64);
        const tables = (await q("select table_name from information_schema.tables where table_name like 'fork\\_%' and table_schema='public'")).map((r) => r.table_name as string);
        let all = "";
        for (const tn of tables) all += (await q(`select coalesce(string_agg(row_to_json(x)::text, E'\\n'), '') as s from "${tn}" x`))[0].s;
        const view = JSON.stringify(await getMirrorView(mdeps(), {mirrorId: m1.mirrorId}));
        const serverLog = out + stripAnsi(sh("docker", ["exec", BOX, "docker", "logs", "runner-agent"]));
        for (const [what, secret] of [["production password", PROD_PW], ["rotated password", dbe.POSTGRES_PASSWORD!], ["seed", seedHex]] as const) {
            expect(all.includes(secret), `${what} in a fork table`).toBe(false);
            expect(view.includes(secret), `${what} in the read model`).toBe(false);
            expect(serverLog.includes(secret), `${what} in a log`).toBe(false);
        }
        expect(all).not.toContain(SECRET_QS.split("=")[1]); // the presigned artifact URL signature is not stored either
        // the production value does not exist on the runner inside any container env (rotated everywhere)
        for (const c of ctrs(m1.revisionId)) expect(JSON.stringify(envOf(c))).not.toContain(PROD_PW);
        RUN.push("L4 PASS rotated value shared by db+web, production value absent from the mirror and the dashboard, seed 0600 and never left the box");
    }, 120_000);

    it("L9 limits: every mirror container carries the policy limits (1 GiB, 512 pids, 1.0 CPU) and the owner labels", async () => {
        const rows = ctrs(m1.revisionId).map((c) => JSON.parse(inbox(["docker", "inspect", c, "-f", "{{json .HostConfig}}"])) as {Memory: number; PidsLimit: number; NanoCpus: number});
        expect(rows.length).toBe(2);
        for (const h of rows) expect([h.Memory, h.PidsLimit, h.NanoCpus]).toEqual([1073741824, 512, 1_000_000_000]);
        keep("l9-limits.json", JSON.stringify(rows, null, 2));
        RUN.push(`L9 PASS ${rows.length} containers: ${JSON.stringify(rows.map((h) => [h.Memory, h.PidsLimit, h.NanoCpus]))}`);
    }, 60_000);

    it("L8 role gating with forged signed tasks: a production agent refuses a mirror_stage (role_forbidden), the mirror runner refuses a restore_stage (role_forbidden)", async () => {
        const stage = {v: 1, restore_id: randomUUID(), plan_id: randomUUID(), plan_hash: "a".repeat(64), stack_id: randomUUID(), rp_id: randomUUID(), purpose: "mirror", mode: "new_stack", host_role: "runner", approvals: [], workspace: `${MIRROR_ROOT}/pbm-x-r1`, project: "pbm-x-r1",
            manifest: {json_b64: "e30=", sig_b64: "AA==", sha256: "b".repeat(64)}, artifacts: [], paths: []};
        const t1 = await plant(prodAgent, prodBundle, "mirror_stage", stage, ["runner.v1", "mirror.v1"], prodAgent);
        const t2 = await plant(runnerAgent, runnerBundle, "restore_stage", {...stage, purpose: "restore", host_role: "production", approvals: ["production_target"]}, ["restore.target.v1"], runnerAgent);
        const [a, b] = await Promise.all([finished(t1), finished(t2)]);
        expect(a).toMatchObject({status: "rejected", result: {reason: "role_forbidden"}});
        expect(b).toMatchObject({status: "rejected", result: {reason: "role_forbidden"}});
        RUN.push("L8 PASS production agent refused mirror_stage (role_forbidden); mirror runner refused restore_stage (role_forbidden)");
    }, 180_000);

    it("L6 blocked: a poison variant (docker.sock bind) is refused before anything starts: no container is ever created, the staged copy is wiped and the wipe is verified", async () => {
        const w = await labWorld(true);
        const r = await create(w, "lab6");
        const row = await drive(r.revisionId);
        expect(["blocked"], `state=${row.state} reason=${row.reason}`).toContain(row.state);
        expect(["compile_refused", "policy_refused"]).toContain(row.reason);
        expect(row.wipe_state).toBe("verified");
        expect(ctrs(r.revisionId)).toEqual([]);
        expect(inbox(["sh", "-c", `ls ${MIRROR_ROOT}/pbm-lab6-r1 2>&1 | head -1`])).toMatch(/No such file/);
        RUN.push(`L6 PASS blocked reason=${row.reason}; no container ever existed; wipe verified; workspace gone`);
    }, 600_000);

    it("L7 cancel during stage: the in-flight stage is awaited, the revision ends cancelled and the wipe is verified", async () => {
        const w = await labWorld(false);
        objects.get(`/${w.rp}/volume_app_data`)!.holdMs = 25_000; // the stage download is visibly in flight
        const r = await create(w, "lab7");
        let cancelled = false;
        const row = await drive(r.revisionId, {each: async (x) => {
            if (cancelled) return;
            const [s] = await q("select t.status from fork_mirror_task j join fork_agent_task t on t.id=j.task_id where j.revision_id=$1 and j.step='stage' order by j.created_at desc limit 1", [x.id]);
            if (s && ["leased", "running"].includes(s.status)) { const c = await cancelMirrorRevision(mdeps(), {revisionId: x.id}); expect(c.ok).toBe(true); cancelled = true; }
        }});
        expect(cancelled).toBe(true);
        expect(row.state).toBe("cancelled");
        expect(row.wipe_state).toBe("verified");
        expect(ctrs(r.revisionId)).toEqual([]);
        RUN.push("L7 PASS cancelled during stage; wipe verified; no container");
    }, 600_000);

    it("L5 negative control: with the firewall table removed right before the isolation step the revision FAILS runner_not_isolated, never READY; the wipe is verified; after fw-on the runner reads isolated again", async () => {
        const r = await create(await labWorld(false), "lab5");
        let off = false;
        try {
            const row = await drive(r.revisionId, {each: async (x) => {
                const steps = x.steps as {name: string; status: string}[];
                if (!off && steps.some((s) => s.name === "check" && s.status === "done")) { lab(["fw-off"]); off = true; }
            }});
            expect(off).toBe(true);
            expect(row.state).toBe("failed");
            expect(row.reason).toBe("runner_not_isolated");
            expect(row.wipe_state).toBe("verified");
            expect(ctrs(r.revisionId)).toEqual([]);
            expect(await startTestedFact(db, (await q("select stack_id from fork_mirror where id=$1", [r.mirrorId]))[0]!.stack_id)).toBeNull();
        } finally { lab(["fw-on"]); }
        await probe();
        expect(await iso()).toMatchObject({state: "isolated"});
        RUN.push("L5 PASS fw-off before the isolation step ⇒ failed runner_not_isolated, never ready, wipe verified; fw-on ⇒ isolated again");
    }, 900_000);
});
