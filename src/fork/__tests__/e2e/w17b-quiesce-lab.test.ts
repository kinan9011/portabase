import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {createCipheriv, randomBytes, randomUUID} from "node:crypto";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {Client as Minio} from "minio";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {enrolAgent} from "@/fork/agent-channel/admin";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import type {ForkDb} from "@/fork/db/handle";
import {contentHash} from "@/fork/inventory/schema";
import {fileKeyProvider} from "@/fork/keys";
import {evaluateAlerts} from "@/fork/notifications/evaluate";
import {enqueueQuiesceTask} from "@/fork/quiesce/enqueue";
import {planQuiesce} from "@/fork/quiesce/plan";
import {reconcileQuiesce} from "@/fork/quiesce/reconcile";
import {enableQuiesce, previewQuiesce, startNow, type QuiesceAdminDeps} from "@/fork/quiesce/service";
import {hashUrl} from "@/fork/recovery-point/hash";
import type {RunDeps} from "@/fork/runs/deps";
import {tickAllRuns} from "@/fork/runs/service";
import {startRun} from "@/fork/runs/start";
import {freshForkDb, seedAgent, seedConnection, seedEnvironment, seedProject, type W04Db} from "@/fork/__tests__/w04-helpers";
import {decryptAgentArchive} from "@/fork/__tests__/agent-archive";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";

/**
 * LIVE W17b test (FORK_LAB=1, docker-bridge lab ONLY, synthetic data, never the owner's pilot hosts): the REAL fork dashboard build + ONE REAL fork agent image
 * (`W17B_AGENT_IMAGE`, built locally, never pushed) + a real compose project (`forklab-quiesce`: postgres + a live WAL sqlite writer + an optional flaky container)
 * + a project that contains a Portabase image (`forklab-quiesce-mgr`) + MinIO, all on a dedicated bridge.
 *   Q1 quiesced backup   Q2 agent killed mid-quiesce (boot replay)   Q3 dashboard unreachable (agent-local deadline)
 *   Q4 container fails to restart (honest failure, Start now)   Q5 refusals by id (manager project, foreign id, own id)   Q6 canary: no secret in any log / row.
 * The test process drives the run engine (injected hash seam over the host-published MinIO port); the dashboard process serves the agent routes; its own run job still ticks every 300 s (benign), its drift job ticks once at boot (+20 s, before Q1) and is then parked (3600 s).
 */
const LAB = process.env.FORK_LAB === "1";
const IMAGE = process.env.W17B_AGENT_IMAGE ?? "portabase-agent-fork:w17b-lab";
const NET = "w17b-lab-net", SUBNET = "172.31.252.0/24", GW = "172.31.252.1";
const AGENT_C = "w17b-agent", MINIO_C = "w17b-minio", VOL = "w17b-agent-state";
const P = "forklab-quiesce", PM = "forklab-quiesce-mgr";
const MINIO_IMAGE = "coollabsio/minio@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9";
const BUCKET = "w17b-primary";
const COMPOSE = path.join(process.cwd(), "dev/fork-lab/quiesce/compose.yml");
const COMPOSE_MGR = path.join(process.cwd(), "dev/fork-lab/quiesce/compose.mgr.yml");
const DB_PASSWORD = "lab-synthetic-not-a-secret";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync("docker", args, {encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"]}).trim();
const dockerTry = (args: string[]) => { try { return docker(args); } catch (e) { return `ERR ${String(e).slice(0, 200)}`; } };
const freePort = (host = GW) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const logs = (name: string) => { try { return execFileSync("docker", ["logs", name], {encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]}); } catch (e) { return String(e); } };
const rnd = (n = 18) => randomBytes(n).toString("base64url");

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let priv = ""; let tmp = ""; let base = ""; let org = ""; let adminId = ""; let minio: Minio; let minioPort = 0;
let agentId = ""; let stackId = ""; let envId = ""; let channelId = ""; let projectId = ""; let pgDbId = ""; let volDbId = ""; let bundleOf = "";
const EVID: string[] = [];
const note = (s: string) => { EVID.push(`${new Date().toISOString()} ${s}`); };
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const URL_FOR_AGENTS = () => `http://forklab-dashboard.localhost:${new URL(base).port}`;
const ENVC = () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 45});
const chDeps = (): ChannelDeps => ({db, principal: {userId: adminId, systemRole: "superadmin", memberships: []}, keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, stepUp: async () => "ok", env: ENVC, configAllowed: async () => true});
const runDeps = (): RunDeps => ({db, mode: async () => "on", flag: () => true, owner: "w17b-lab-test", refresh: async () => "ok", channel: {keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, env: ENVC},
    cfg: {tickMs: 2000, waitTimeoutMs: 120_000, stallTimeoutMs: 300_000, maxRunMs: 1_800_000, captureWindowMs: 3_600_000, maxPerAgent: 1, maxPerOrg: 3, hashMaxBytes: 1 << 30, hashTimeoutMs: 120_000},
    hash: async (r) => { const [s] = await q("select path from backup_storage where id=$1", [r.backupStorageId]); return hashUrl(await minio.presignedGetObject(BUCKET, s.path as string, 600), r); }});
const adminDeps = (): QuiesceAdminDeps => ({db, principal: {userId: adminId, systemRole: "superadmin", memberships: []}, channel: {keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, env: ENVC}, mode: async () => "on", flag: () => true, assertConfigAllowed: async () => undefined, rate: () => ({ok: true}), leaseSeconds: 45});

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000, every = 1000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard (fork lines) ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l)).slice(-10).join("\n").slice(-1800)}\n--- agent ---\n${logs(AGENT_C).split("\n").slice(-15).join("\n").slice(-2200)}`);
        await sleep(every);
    }
}
const state = (c: string) => { try { const j = JSON.parse(docker(["inspect", c]))[0].State; return {running: j.Running as boolean, health: (j.Health?.Status ?? null) as string | null, status: j.Status as string}; } catch { return {running: false, health: null, status: "absent"}; } };
const cid = (project: string, service: string) => docker(["ps", "-aq", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`]).split("\n")[0];
const up = (c: string) => { const s = state(c); return s.running && (s.health === null || s.health === "healthy"); };
const allUp = (...c: string[]) => c.every(up);
const run = async (id: string) => (await q("select * from fork_stack_run where id=$1", [id]))[0];
const rpOf = async () => (await q("select * from fork_recovery_point where stack_id=$1 order by sequence", [stackId]));

/** Inventory from REAL `docker inspect` of the compose project (real container ids, depends_on, mounts) — a new version row. */
async function seedInventory(project = P) {
    const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`]).split("\n").filter(Boolean);
    const ins = JSON.parse(docker(["inspect", ...ids])) as {Id: string; State: {Status: string}; Config: {Labels: Record<string, string>; Image: string}; Mounts: {Type: string; Name?: string; Destination: string; RW: boolean}[]}[];
    const inv = cleanInventory();
    inv.stack = {...inv.stack, compose_project: project, display_name: project, working_dir_hint: undefined, config_files_hint: []};
    const mid = (n: string) => `m:${Buffer.from(n).toString("hex").padStart(16, "0").slice(-16)}`;
    const mounts = new Map<string, (typeof inv.mounts)[number]>();
    inv.services = ins.map((c) => {
        const name = c.Config.Labels["com.docker.compose.service"];
        const deps = (c.Config.Labels["com.docker.compose.depends_on"] ?? "").split(",").map((x) => x.split(":")[0]).filter(Boolean);
        for (const m of c.Mounts.filter((x) => x.Type === "volume" && x.Name)) {
            const cur = mounts.get(m.Name!) ?? {id: mid(m.Name!), kind: "named_volume" as const, volume_name: m.Name!, destination: m.Destination, rw: m.RW, consumers: [], ownership: "stack_owned" as const};
            cur.consumers.push(name); mounts.set(m.Name!, cur);
        }
        return {name, state: c.State.Status === "running" ? "running" as const : "exited" as const, container_id: c.Id.slice(0, 12), image: {ref: c.Config.Image, pinned: false, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: [], ...(deps.length ? {depends_on: deps} : {})};
    });
    inv.mounts = [...mounts.values()];
    inv.volumes = inv.mounts.map((m) => ({name: m.volume_name!, driver: "local", in_use_by: m.consumers, ownership: "stack_owned" as const}));
    inv.networks = []; inv.env_files = [];
    const [{v}] = await q("select coalesce(max(version),0)::int v from fork_stack_inventory where stack_id=$1", [stackId]);
    await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,$2,$3,$4)", [stackId, v + 1, contentHash(inv), JSON.stringify(inv)]);
    return inv;
}
const setQuiesce = (services: string[], maxStop = 600) => q("update fork_stack_policy set quiesce_enabled=true, quiesce_services=$2, quiesce_max_stop_seconds=$3, quiesce_enabled_by=$4, quiesce_enabled_at=now() where stack_id=$1", [stackId, JSON.stringify(services), maxStop, adminId]);

/** drives the run engine from the test process until `cond` */
async function drive(what: string, cond: () => Promise<boolean>, ms = 300_000) {
    await waitFor(what, async () => { await q("update agents set last_contact=last_contact where id=$1", [agentId]); await tickAllRuns(runDeps()); return cond(); }, ms, 1500);
}
const finished = async (id: string, ms = 420_000) => drive(`run ${id} finished`, async () => !["starting", "running", "finalizing"].includes((await run(id)).state), ms);
/** why a run would (not) use quiesce right now: sources, policy columns and the planner's verdict — written to the evidence on every start */
async function diag(label: string) {
    const srcs = (await q("select dbms, status, database_id is not null as linked from fork_stack_source where stack_id=$1 order by dbms", [stackId]));
    const pol = (await q("select quiesce_enabled, quiesce_services, quiesce_max_stop_seconds, paused_at, pause_reason from fork_stack_policy where stack_id=$1", [stackId]))[0];
    const pv = await previewQuiesce(adminDeps(), {stackId});
    note(`DIAG ${label}: sources=${JSON.stringify(srcs)} policy=${JSON.stringify(pol)} availability=${pv.ok ? JSON.stringify(pv.dto.availability) : "?"} plan=${pv.ok ? JSON.stringify(pv.dto.plan) : "?"}`);
}
async function startRunNow() {
    await diag("before run");
    // the lab seeds the member rows by hand (no Arcane): the dashboard's own drift job would flag them as drifted (hash 0…0 ≠ a real plan hash); keep them active for each run
    await q("update fork_stack_source set status='active', drift_reason=null where stack_id=$1", [stackId]);
    const r = await startRun(runDeps(), {stackId, trigger: "manual", userId: adminId});
    if (r.kind !== "started") throw new Error(`run not started: ${JSON.stringify(r)}`);
    return r.runId;
}
const notSkipped = async (id: string) => { const r = await run(id); if (r.quiesce_state === "skipped") throw new Error(`quiesce was SKIPPED: ${r.quiesce_reason}\n${EVID.filter((l) => l.includes("DIAG")).slice(-1)[0]}`); return true; };
/** docker events (nano timestamps) of the two quiesced containers while `fn` runs */
function watchEvents(names: string[]) {
    const lines: {t: number; action: string; name: string}[] = [];
    const p = spawn("docker", ["events", "--since", String(Math.floor(Date.now() / 1000) - 1), "--filter", "type=container", ...names.flatMap((n) => ["--filter", `container=${n}`]), "--filter", "event=die", "--filter", "event=start", "--format", "{{.TimeNano}} {{.Action}} {{.Actor.Attributes.name}}"]);
    p.stdout.on("data", (d) => { for (const l of String(d).split("\n").filter(Boolean)) { const [ts, action, name] = l.split(" "); lines.push({t: Math.floor(Number(ts) / 1e6), action, name}); } });
    return {lines, stop: () => p.kill()};
}
async function startAgent() {
    const master = readFileSync(path.join(priv, "keys", "master_key.bin"));
    const edge = Buffer.from(JSON.stringify({serverUrl: URL_FOR_AGENTS(), agentId, masterKeyB64: master.toString("base64")})).toString("base64url");
    const f = path.join(tmp, "agent.bundle");
    writeFileSync(f, bundleOf, {mode: 0o600}); chmodSync(f, 0o600);
    docker(["run", "-d", "--name", AGENT_C, "--restart", "no", "--network", NET, "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production",
        "-e", "FORK_CHANNEL_ENABLED=true", "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2",
        "-e", "FORK_QUIESCE_ENABLED=true", "-e", "FORK_QUIESCE_MAX_STOP_SECONDS=300", "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${f}:/run/fork/bundle:ro`, "-v", `${VOL}:/config`, IMAGE], {...process.env, EDGE_KEY: edge});
}
const cleanup = () => {
    // the agent is attached to `${P}_default` (network connect in beforeAll): remove it BEFORE `compose down`, or compose cannot remove its own network
    for (const n of [AGENT_C, MINIO_C]) dockerTry(["rm", "-f", n]);
    try { for (const i of docker(["ps", "-aq", "--filter", "label=com.portabase.fork.helper=true"]).split("\n").filter(Boolean)) dockerTry(["rm", "-f", i]); } catch { /* none */ }
    for (const [p, f, extra] of [[P, COMPOSE, ["--profile", "flaky"]], [PM, COMPOSE_MGR, []]] as const) dockerTry(["compose", "-p", p, "-f", f, ...extra, "down", "-v", "--remove-orphans"]);
    dockerTry(["volume", "rm", "-f", VOL]);
    for (const n of [NET, `${P}_default`, `${PM}_default`]) dockerTry(["network", "rm", n]);
};
/** `child` + every descendant. pnpm 12 runs `next start` in its OWN process group, so neither `child.kill` nor a group signal reaches next-server. */
const dashboardPids = (): number[] => {
    if (!child?.pid) return [];
    const rows = execFileSync("ps", ["-eo", "pid=,ppid="], {encoding: "utf8"}).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    const out = [child.pid];
    for (let i = 0; i < out.length; i++) for (const [pid, ppid] of rows) if (ppid === out[i]) out.push(pid);
    return out;
};
const signalDashboard = (sig: NodeJS.Signals, pids = dashboardPids()) => { for (const p of pids) { try { process.kill(p, sig); } catch { /* gone */ } } };

describe.skipIf(!LAB)("W17b live: composite quiesce task against a real agent image and a real compose project", () => {
    beforeAll(async () => {
        process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w17b-test-side-${rnd(24)}`;
        tmp = mkdtempSync(path.join(os.tmpdir(), "w17b-lab-")); priv = path.join(tmp, "private");
        cleanup();
        docker(["tag", "ghcr.io/portabase/agent:1.25.2", "forklab/sqlite-writer:w17b"]);
        docker(["network", "create", "--subnet", SUBNET, NET]);
        const minioUser = `u${rnd(8)}`, minioSecret = rnd(24);
        minioPort = await freePort("127.0.0.1");
        docker(["run", "-d", "--name", MINIO_C, "--network", NET, "-p", `127.0.0.1:${minioPort}:9000`, "-e", `MINIO_ROOT_USER=${minioUser}`, "-e", `MINIO_ROOT_PASSWORD=${minioSecret}`,
            "-e", "MINIO_ROOT_USER_FILE=", "-e", "MINIO_ROOT_PASSWORD_FILE=", "-e", "MINIO_ACCESS_KEY_FILE=", "-e", "MINIO_SECRET_KEY_FILE=", MINIO_IMAGE, "server", "/data"]);
        minio = new Minio({endPoint: "127.0.0.1", port: minioPort, useSSL: false, accessKey: minioUser, secretKey: minioSecret});
        await waitFor("minio up", async () => { try { await minio.listBuckets(); return true; } catch { return false; } }, 60_000);
        await minio.makeBucket(BUCKET);
        docker(["compose", "-p", P, "-f", COMPOSE, "up", "-d", "--wait"]);
        docker(["compose", "-p", PM, "-f", COMPOSE_MGR, "up", "-d"]);
        await waitFor("lab stack healthy", async () => allUp(`${P}-db-1`, `${P}-app-1`), 120_000);

        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        const port = await freePort(); base = `http://${GW}:${port}`;
        child = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {...process.env, NODE_ENV: "production", DATABASE_URL: t.url,
            PROJECT_URL: URL_FOR_AGENTS(), PROJECT_SECRET: `w17b-lab-${rnd(24)}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
            AUTH_DEFAULT_USER_NAME: "W17b Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
            FORK_QUIESCE_ENABLED: "true", FORK_AGENT_LEASE_SECONDS: "45", FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300", FORK_MATERIALIZE_TICK_SECONDS: "3600"}});
        child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
        await waitFor("dashboard ready", async () => out.includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
        const initAt = Date.now();
        process.env.PRIVATE_PATH = priv;
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;

        agentId = await seedAgent(t.pool, org, "w17b-edge");
        const r = await enrolAgent(chDeps(), {agentId, password: "lab-step-up-not-checked"});
        if (!r.ok) throw new Error(`enrol: ${r.code}`);
        bundleOf = r.bundle;
        await startAgent();
        dockerTry(["network", "connect", `${P}_default`, AGENT_C]); // the stock agent dumps `db` over this network
        projectId = await seedProject(t.pool, org, "w17b-demo");
        channelId = (await q("insert into storage_channel (provider, name, config, enabled) values ('s3','w17b-minio',$1::jsonb,true) returning id",
            [JSON.stringify({ssl: false, port: 9000, region: "us-east-1", accessKey: minioUser, secretKey: minioSecret, bucketName: BUCKET, endPointUrl: MINIO_C})]))[0].id;
        await q("insert into storage_policy (storage_channel_id, project_id) values ($1,$2)", [channelId, projectId]);
        const mk = readFileSync(path.join(priv, "keys", "master_key.bin"));
        const iv = randomBytes(12); const ci = createCipheriv("aes-256-gcm", mk, iv);
        const ct = Buffer.concat([ci.update(DB_PASSWORD, "utf8"), ci.final()]);
        const envelope = {__encrypted: true, version: 1, kid: "credentials-v1", iv: iv.toString("base64"), ciphertext: ct.toString("base64"), tag: ci.getAuthTag().toString("base64")};
        const mkDb = async (name: string, dbms: string, config: unknown) => (await q(`insert into databases (id, agent_database_id, name, dbms, agent_id, project_id, config, backup_engine) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, 'archive') returning id`,
            [randomUUID(), name, dbms, agentId, projectId, JSON.stringify(config)]))[0].id as string;
        pgDbId = await mkDb("w17b-pg", "postgresql", {host: "db", port: 5432, database: "demo", username: "demo", password: envelope});
        volDbId = await mkDb("w17b-appdata", "docker-volume", {volume_name: `${P}_appdata`});
        await q("update settings set encryption=true");
        await waitFor("agent reported quiesce.v1", async () => ((await q("select capabilities from fork_agent_enrollment where agent_id=$1", [agentId]))[0]?.capabilities ?? []).includes("quiesce.v1"), 120_000);

        // the stack + policy + sources, exactly the rows the W10/W11 services write (the lab has no Arcane here)
        const conn = await seedConnection(t.pool, org, "w17b-conn");
        envId = await seedEnvironment(t.pool, conn, agentId, "w17b-edge", "w17b");
        await q("update fork_arcane_environment set enabled=true, host_role='test' where id=$1", [envId]);
        stackId = (await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name, project_id, project_name, protection_state) values ($1,$2,'env',$3,$3,$4,'p','active') returning id", [org, envId, P, projectId]))[0].id;
        await seedInventory();
        await q(`insert into fork_stack_policy (stack_id, activated_at, activated_by, schedule, policy, storage_channel_ids, materialize_state, activation) values ($1, now() - interval '2 days', $2, $3, $4, $5, 'ready', $6)`,
            [stackId, adminId, JSON.stringify({preset: "daily", timezone: "UTC", minute: 0, hour: 2, weekday: 0, monthday: 1}), JSON.stringify({keep_last: 5, daily: 7, weekly: 4, monthly: 6, yearly: 0}), [channelId],
                JSON.stringify({userId: adminId, capability: "stacks.backup.manage", aclAgentId: agentId, organizationId: org, encryption: true, channelIds: [channelId], at: new Date().toISOString()})]);
        for (const [role, key, dbId, dbms, name] of [["db", "db:db", pgDbId, "postgresql", "w17b-pg"], ["volume", `volume:${P}_appdata`, volDbId, "docker-volume", "w17b-appdata"]] as const) {
            await q(`insert into fork_stack_source (stack_id, role, resource_key, status, database_id, dbms, engine, member_name, covers_keys, desired_hash, last_probe, last_probe_at)
                values ($1,$2,$3,'active',$4,$5,'archive',$6,$7,$8,'readable',now())`, [stackId, role, key, dbId, dbms, name, [key], "0".repeat(64)]);
        }
        // enable through the REAL admin service (planner + audit), not a raw update
        const en = await enableQuiesce(adminDeps(), {stackId, services: ["app", "db"], maxStopSeconds: 600});
        if (!en.ok) throw new Error(`enable: ${JSON.stringify(en)}`);
        // the dashboard's own boot ticks (runs job +15 s, drift job +20 s after init) must be over before Q1: the drift tick flips the hand-seeded sources mid-run
        await sleep(Math.max(0, initAt + 25_000 - Date.now()));
        note(`setup done: dashboard ${base}, agent ${IMAGE}, project ${P}`);
    }, 600_000);

    afterAll(async () => {
        const evidence = process.env.W17B_EVIDENCE_DIR;
        if (evidence) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(path.join(evidence, "lab-run.txt"), `${EVID.join("\n")}\n`);
            writeFileSync(path.join(evidence, "agent.log"), logs(AGENT_C));
            writeFileSync(path.join(evidence, "dashboard.log"), out.split("\n").filter((l) => /[Ff]ork|rror|quiesce/.test(l)).slice(-400).join("\n"));
        }
        const pids = dashboardPids(); // snapshot first: orphans re-parent to init once pnpm exits
        signalDashboard("SIGCONT", pids); signalDashboard("SIGTERM", pids); await sleep(1500); signalDashboard("SIGKILL", pids);
        cleanup();
        try { await t?.drop(); } catch { /* ignore */ }
        dockerTry(["run", "--rm", "-v", `${tmp}:/x`, "busybox", "sh", "-c", "rm -rf /x/oracle"]); // the oracle files were extracted by a root-owned container
        rmSync(tmp, {recursive: true, force: true});
    }, 180_000);

    it("Q1 quiesced backup: app stops before db, db starts before app, the volume copy runs inside the pause, RP `stopped`, WAL oracle ok", async () => {
        const ev = watchEvents([`${P}-app-1`, `${P}-db-1`]);
        const id = await startRunNow();
        await finished(id);
        await sleep(1500); ev.stop();
        const r = await run(id);
        note(`Q1 run ${id}: ${JSON.stringify({state: r.state, quiesce_state: r.quiesce_state, released: r.quiesce_release_reason, result: r.quiesce_result})}`);
        expect(r).toMatchObject({quiesce_state: "restarted"});
        const stops = ev.lines.filter((l) => l.action === "die"); const starts = ev.lines.filter((l) => l.action === "start");
        note(`Q1 docker events: ${JSON.stringify(ev.lines)}`);
        expect(stops.map((l) => l.name)).toEqual([`${P}-app-1`, `${P}-db-1`]);
        expect(starts.map((l) => l.name)).toEqual([`${P}-db-1`, `${P}-app-1`]);
        expect(allUp(`${P}-db-1`, `${P}-app-1`)).toBe(true);
        const items = await q("select dbms, queued_at, started_at, finished_at, state from fork_stack_run_item where run_id=$1 order by dbms", [id]);
        const vol = items.find((i) => i.dbms === "docker-volume")!;
        expect(items.every((i) => i.state === "succeeded")).toBe(true);
        expect(new Date(vol.queued_at).getTime()).toBeGreaterThanOrEqual(new Date(r.quiesce_stopped_at).getTime() - 2000); // the window member is queued only after the agent reported `stopped`
        expect(new Date(vol.finished_at).getTime()).toBeLessThanOrEqual(new Date(r.quiesce_release_at).getTime() + 60_000);
        expect(stops[0].t).toBeLessThanOrEqual(new Date(vol.queued_at).getTime() + 2000); // already stopped when the copy was queued
        // the app was stopped while the volume was copied: the stop event precedes the copy start, the db start follows the release
        const [point] = await rpOf();
        note(`Q1 RP: ${JSON.stringify({status: point.status, reason: point.downgrade_reason, consistency: point.consistency_level})}`);
        expect(point.consistency_level).toBe("stopped");
        expect([null, "validator_blocked"]).toContain(point.downgrade_reason); // the lab seeds no full completeness coverage: the only acceptable downgrade is the validator, never a quiesce one
        expect(point.status).not.toBe("verified");
        expect(Number((r.quiesce_result as {downtime_ms: number}).downtime_ms)).toBeGreaterThan(0);
        // independent oracle: fetch + decrypt the volume artifact from MinIO, run integrity_check / count = max(id) / even count on it
        const [s] = await q("select s.path from backup_storage s join fork_stack_run_item i on i.backup_id = s.backup_id where i.run_id=$1 and i.dbms='docker-volume'", [id]);
        const enc = Buffer.concat(await (async () => { const cs: Buffer[] = []; for await (const c of await minio.getObject(BUCKET, s.path as string)) cs.push(c as Buffer); return cs; })());
        const plain = decryptAgentArchive(readFileSync(path.join(priv, "keys", "master_key.bin")), enc);
        const dir = path.join(tmp, "oracle"); mkdirSync(dir, {recursive: true}); writeFileSync(path.join(dir, "vol.tgz"), plain);
        docker(["run", "--rm", "-v", `${dir}:/x`, "busybox", "sh", "-c", "cd /x && tar -xzf vol.tgz && ls -R . | head -20"]);
        const oracle = docker(["run", "--rm", "-v", `${dir}:/x`, "--entrypoint", "sh", "forklab/sqlite-writer:w17b", "-c", "f=$(find /x -name app.db | head -1); sqlite3 \"$f\" \"PRAGMA integrity_check; select count(*), max(id), count(*)%2 from ledger;\""]);
        note(`Q1 WAL oracle on the quiesced copy: ${oracle.replace(/\n/g, " | ")}`);
        const [ic, row] = oracle.split("\n");
        expect(ic).toBe("ok");
        const [cnt, mx, odd] = row.split("|").map(Number);
        expect(cnt).toBe(mx); expect(odd).toBe(0);
    }, 600_000);

    it("Q2 agent killed mid-quiesce: containers stay stopped, alert raised, on restart the journal is replayed and the honest outcome reported", async () => {
        const id = await startRunNow();
        // drive only until the quiesce task is enqueued, then stop ticking: a tick after `stopped` would queue the window volume copy, and a kill racing the
        // stock agent's copy leaves its upstream row `ongoing` (stall, later runs skip the member as `busy`)
        await drive("quiesce requested", async () => (await notSkipped(id)) && ["requested", "stopped"].includes((await run(id)).quiesce_state), 240_000);
        await waitFor("quiesce stopped (no engine tick)", async () => (await run(id)).quiesce_state === "stopped", 240_000, 500);
        await sleep(1500);
        expect((await q("select count(*)::int c from fork_stack_run_item where run_id=$1 and dbms='docker-volume'", [id]))[0].c).toBe(0); // no window copy in flight at the kill
        docker(["kill", AGENT_C]);
        note("Q2 agent killed");
        await sleep(6000);
        expect(up(`${P}-app-1`) || up(`${P}-db-1`)).toBe(false); // nothing restarted them: only the agent's boot replay can
        await evaluateAlerts({db, now: () => new Date(Date.now() + 20 * 60_000), configLocked: false, minHours: 24});
        expect((await q("select active from fork_alert_state where stack_id=$1 and kind='stack.quiesce_stopped'", [stackId]))[0]?.active).toBe(true);
        expect((await q("select count(*)::int c from fork_notification_outbox where kind='stack.quiesce_stopped'"))[0].c).toBeGreaterThanOrEqual(1);
        const journal = dockerTry(["run", "--rm", "-v", `${VOL}:/c:ro`, "busybox", "ls", "/c/fork-quiesce"]);
        note(`Q2 journal while dead: ${journal.replace(/\n/g, " ")}`);
        expect(journal).toMatch(/\.json/);
        docker(["start", AGENT_C]);
        const t0 = Date.now();
        await waitFor("containers back after agent restart", async () => allUp(`${P}-db-1`, `${P}-app-1`), 120_000, 500);
        note(`Q2 containers healthy ${Date.now() - t0} ms after the agent was started`);
        await waitFor("agent logged the replay", async () => /quiesce replay — task .* 2\/2 verified/.test(logs(AGENT_C)), 60_000); // logged after the settle check, a few seconds after the containers are up
        await waitFor("journal removed", async () => !/\.json/.test(dockerTry(["run", "--rm", "-v", `${VOL}:/c:ro`, "busybox", "ls", "/c/fork-quiesce"])), 60_000);
        await finished(id);
        await reconcileQuiesce(db, id, new Date());
        const r = await run(id);
        note(`Q2 final: ${JSON.stringify({state: r.state, q: r.quiesce_state, reason: r.quiesce_reason, result: r.quiesce_result})}`);
        expect(r.quiesce_state).toBe("restarted");
        expect(r.quiesce_reason).toBe("quiesce_interrupted");
        expect((r.quiesce_result as {released_by: string}).released_by).toBe("replay");
        await evaluateAlerts({db, now: () => new Date(Date.now() + 21 * 60_000), configLocked: false, minHours: 24});
        expect((await q("select active from fork_alert_state where stack_id=$1 and kind='stack.quiesce_stopped'", [stackId]))[0].active).toBe(false);
        expect((await rpOf()).at(-1)?.consistency_level).not.toBe("stopped"); // window broken by the crash: never claimed as stopped
    }, 600_000);

    it("Q3 dashboard unreachable: the agent-local deadline restarts the containers; the result says deadline, window_intact=false", async () => {
        await q("update fork_stack_policy set quiesce_max_stop_seconds=60 where stack_id=$1", [stackId]);
        const id = await startRunNow();
        await drive("quiesce stopped", async () => (await notSkipped(id)) && (await run(id)).quiesce_state === "stopped", 240_000);
        const stoppedAt = Date.now();
        // the dashboard process TREE is FROZEN: SIGSTOP on every descendant, because pnpm runs next-server in its own process group. It accepts connections and answers nothing —
        // the agent cannot reach a working dashboard. (A docker network disconnect is not enough: the host-side address stays reachable through the other bridge; in an earlier
        // run the lapsed lease made the route answer 409 ⇒ `lost_dashboard`, the other fail-safe.)
        signalDashboard("SIGSTOP");
        note("Q3 dashboard process tree frozen (SIGSTOP)");
        let took = -1;
        try {
            await waitFor("containers restarted by the agent-local deadline", async () => allUp(`${P}-db-1`, `${P}-app-1`), 150_000, 1000);
            took = Date.now() - stoppedAt;
            note(`Q3 containers back ${took} ms after the stop report (limit 60 s + start time)`);
        } finally {
            signalDashboard("SIGCONT"); // never leave the dashboard frozen: a failed Q3 must not cascade into Q4
            note("Q3 dashboard process tree resumed");
            await finished(id).catch(() => undefined);
        }
        await reconcileQuiesce(db, id, new Date());
        const r = await run(id);
        note(`Q3 final: ${JSON.stringify({state: r.state, q: r.quiesce_state, result: r.quiesce_result})}`);
        expect((r.quiesce_result as {released_by: string; window_intact: boolean})).toMatchObject({released_by: "deadline", window_intact: false}); // names WHO ended the window before any timing check
        expect(took).toBeLessThan(60_000 + 60_000);
        expect(took).toBeGreaterThanOrEqual(35_000); // window = 60 s from the FIRST stop; stop phase + observation lag ≈ 10–15 s
        expect((await rpOf()).at(-1)?.consistency_level).not.toBe("stopped");
        expect((await q("select count(*)::int c from fork_notification_outbox where dedupe_key=$1", [`quiesce.failed:${id}:deadline`]))[0].c).toBe(1);
        await q("update fork_stack_policy set quiesce_max_stop_seconds=600 where stack_id=$1", [stackId]);
    }, 600_000);

    it("Q4 a container that does not come back: honest restart_failed, the others verified, alert, Start now twice (fail, then fixed)", async () => {
        docker(["compose", "-p", P, "-f", COMPOSE, "--profile", "flaky", "up", "-d", "flaky"]);
        await waitFor("flaky running", async () => up(`${P}-flaky-1`), 60_000);
        await seedInventory(); await setQuiesce(["flaky", "app", "db"]);
        const id = await startRunNow();
        await finished(id, 900_000);
        await reconcileQuiesce(db, id, new Date());
        const r = await run(id);
        note(`Q4 run: ${JSON.stringify({state: r.state, q: r.quiesce_state, reason: r.quiesce_reason, result: r.quiesce_result})}`);
        expect(r).toMatchObject({quiesce_state: "restart_failed", quiesce_reason: "restart_unverified"});
        const res = r.quiesce_result as {containers: {service: string; outcome: string}[]};
        expect(res.containers.find((c) => c.service === "flaky")?.outcome).toBe("not_running");
        expect(res.containers.filter((c) => c.service !== "flaky").every((c) => c.outcome === "verified")).toBe(true);
        expect(allUp(`${P}-db-1`, `${P}-app-1`)).toBe(true);
        expect(up(`${P}-flaky-1`)).toBe(false);
        expect((await rpOf()).at(-1)).toMatchObject({consistency_level: "stopped"});
        expect((await q("select count(*)::int c from fork_notification_outbox where dedupe_key=$1", [`quiesce.failed:${id}:restart_failed`]))[0].c).toBe(1);
        await evaluateAlerts({db, now: () => new Date(), configLocked: false, minHours: 24});
        expect((await q("select active from fork_alert_state where stack_id=$1 and kind='stack.quiesce_stopped'", [stackId]))[0].active).toBe(true);
        // Start now #1: the agent replays its journal; flaky still exits ⇒ honest failure
        expect(await startNow(adminDeps(), {stackId})).toEqual({ok: true, mode: "start_task"});
        await waitFor("start task #1 final", async () => (await q("select status, result from fork_agent_task where id=$1", [(await run(id)).quiesce_start_task_id]))[0]?.status === "failed", 300_000, 2000);
        await reconcileQuiesce(db, id, new Date());
        expect((await run(id)).quiesce_state).toBe("restart_failed");
        // fix the cause, Start now #2
        docker(["run", "--rm", "-v", `${P}_flakystate:/s`, "busybox", "rm", "/s/started"]);
        await sleep(46_000); // the agent's lease window of the finished start task (45 s floor, W27a F-03)
        expect(await startNow(adminDeps(), {stackId})).toEqual({ok: true, mode: "start_task"});
        await waitFor("start task #2 final", async () => (await q("select status from fork_agent_task where id=$1", [(await run(id)).quiesce_start_task_id]))[0]?.status === "succeeded", 300_000, 2000);
        await reconcileQuiesce(db, id, new Date());
        expect((await run(id)).quiesce_state).toBe("restarted");
        expect(up(`${P}-flaky-1`)).toBe(true);
        await evaluateAlerts({db, now: () => new Date(), configLocked: false, minHours: 24});
        expect((await q("select active from fork_alert_state where stack_id=$1 and kind='stack.quiesce_stopped'", [stackId]))[0].active).toBe(false);
        await q("update fork_stack_policy set quiesce_services=$2 where stack_id=$1", [stackId, JSON.stringify(["app", "db"])]);
    }, 1_200_000);

    it("Q5 refusals by id: manager project, foreign container, the agent's own container — nothing is stopped", async () => {
        const mgrInv = await seedInventory(PM);
        const blocked = planQuiesce(mgrInv, ["app2"], [{name: "v", dbms: "docker-volume", mountIds: [], active: true}]);
        note(`Q5a planner on ${PM}: ${JSON.stringify(blocked)}`);
        expect(blocked).toMatchObject({ok: false, blockers: expect.arrayContaining([{code: "manager_in_stack", service: "mgr"}])});
        await seedInventory(P); // restore the stack's own inventory as the newest version
        const snap = () => [`${P}-db-1`, `${P}-app-1`, `${PM}-mgr-1`, `${PM}-app2-1`, AGENT_C].map((c) => `${c}=${state(c).status}`).join(",");
        const before = snap();
        const id12 = (project: string, service: string) => cid(project, service).slice(0, 12);
        const attempt = async (label: string, project: string, service: string, containerId: string, want: string) => {
            const r = await enqueueQuiesceTask({db, keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS, env: ENVC}, {runId: null, stackId, orgId: org, agentId, actorUserId: adminId, project, maxStopSeconds: 60,
                plan: {ok: true, stopOrder: [{service, container_id: containerId}], startOrder: [service], windowMembers: [], preMembers: [], notRunning: []}});
            if (!r.ok) throw new Error(`${label}: enqueue ${r.code}`);
            const fin = await waitFor(`${label} final`, async () => { const x = (await q("select status, result from fork_agent_task where id=$1", [r.taskId]))[0]; return x && !["queued", "leased", "running"].includes(x.status) ? x : null; }, 90_000);
            note(`Q5 ${label}: ${fin.status} ${JSON.stringify(fin.result)}`);
            expect(fin.status).toBe("failed"); expect((fin.result as {reason: string}).reason).toBe(want);
            expect(snap()).toBe(before);
        };
        await attempt("b manager project", PM, "app2", id12(PM, "app2"), "protected_in_project");
        await attempt("c foreign container id", P, "app", id12(PM, "app2"), "not_in_project");
        await attempt("d agent's own container", P, "app", docker(["inspect", "-f", "{{.Id}}", AGENT_C]).slice(0, 12), "protected_container");
    }, 300_000);

    it("Q6 canary: no credential, key or secret in any log, audit row, outbox row or task result", async () => {
        const secrets = [DB_PASSWORD, "lab-step-up-not-checked", bundleOf, (readFileSync(path.join(priv, "keys", "master_key.bin")).toString("base64")), (readFileSync(path.join(priv, "keys", "master_key.bin")).toString("hex"))];
        const rows = JSON.stringify([await q("select redacted_details from fork_audit_event"), await q("select payload from fork_notification_outbox"), await q("select result from fork_agent_task"), await q("select quiesce_result from fork_stack_run")]);
        const logsAll = `${logs(AGENT_C)}\n${out}`;
        for (const s of secrets) { expect(rows).not.toContain(s); expect(logsAll).not.toContain(s); }
        expect(logsAll).not.toMatch(/fork\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/); // an agent bearer credential
        note("Q6 canary: clean");
    }, 60_000);
});
