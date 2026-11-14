import {execFileSync, spawn, spawnSync, type ChildProcess} from "node:child_process";
import {createPrivateKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
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
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {RunnerNotIsolatedError} from "@/fork/runner/evaluate";
import {assertRunnerReady, designateRunner, requestRunnerProbe, runnerIsolation, setRunnerTargets, type RunnerDeps} from "@/fork/runner/service";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";

/**
 * LIVE W21 lab (FORK_LAB=1, docker lab ONLY, never a real host): the REAL fork dashboard (production build) + the REAL fork agent image running in RUNNER mode inside a
 * docker-in-docker "runner box" that loads the runbook's `daemon.json` + `nftables.conf`. Production sinks (SMTP, webhook, Postgres, DNS) sit on a separate lab network the
 * runner CAN route to. The probe (`runner_probe` task over the real signed channel) must read everything `blocked` with the firewall on, and the SAME targets `reachable` with
 * the firewall table removed (the negative control: proves the probe can see leaks). Ground truth is independent of the probe: sink logs, a wire capture on the box uplinks.
 *   L1 attest · L2 firewall on · L3 negative control · L4 recovery · L5 role gating (forged signed tasks) · L6 no prod credentials · L7 cross-network isolation
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, W21_AGENT_IMAGE (local fork image). The runner box image is built by `runner.sh`.
 * Real VM proof stays PENDING-HUMAN (#125): this is an emulation and says so in the evidence.
 */
const LAB = process.env.FORK_LAB === "1";
const AGENT_IMAGE = process.env.W21_AGENT_IMAGE ?? "portabase-agent-fork:w21-lab";
const GW = "172.31.245.1";
const RUNNER_SH = path.join(process.cwd(), "dev/fork-lab/runner/runner.sh");
const BOX = "w21-runner", PROD_AGENT = "w21-agent-prod";
const RUNNER_CAPS = ["channel-maint.v1", "channel.v1", "noop.v1", "runner.v1"];
const PASSWORD = "unused-by-the-stepup-seam";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[], o: {env?: NodeJS.ProcessEnv; input?: string} = {}) => execFileSync(cmd, args, {encoding: "utf8", env: o.env ?? process.env, input: o.input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024}).trim();
const docker = (args: string[]) => sh("docker", args);
const inbox = (args: string[]) => docker(["exec", BOX, ...args]);
const runner = (args: string[], env: Record<string, string> = {}, input?: string) => sh("bash", [RUNNER_SH, ...args], {env: {...process.env, W21_AGENT_IMAGE: AGENT_IMAGE, ...env}, input});
/** stdout AND stderr of a container (Postgres logs to stderr: reading stdout only would make every "no connection logged" assertion vacuous) */
const logs = (name: string) => { const r = spawnSync("docker", ["logs", name], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024}); return `${r.stdout ?? ""}${r.stderr ?? ""}`; };
const freePort = (host: string) => new Promise<number>((res) => { const s = net.createServer().listen(0, host, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const stripAnsi = (s: string) => s.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let tmp = ""; let priv = ""; let base = ""; let org = ""; let adminId = ""; let dashPort = 0;
let runnerAgent = ""; let prodAgent = ""; let runnerBundle = ""; let prodBundle = "";
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const NONCE = randomBytes(6).toString("hex");
const RUN: string[] = [];
const urlForAgents = () => `http://forklab-dashboard.localhost:${dashPort}`;
const ENV = {FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60};
const deps = (): RunnerDeps => ({db, principal: {userId: adminId, systemRole: "superadmin", memberships: [{organizationId: org, role: "admin"}]}, keys: fileKeyProvider, serverUrl: urlForAgents, stepUp: async () => "ok", env: () => ENV,
    configAllowed: async () => true, mirrorsEnabled: () => true, rate: (() => ({ok: true})) as never});
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn(); if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-8).join("\n").slice(-1500)}\n--- runner agent ---\n${stripAnsi(sh("docker", ["exec", BOX, "docker", "logs", "runner-agent"])).split("\n").slice(-12).join(" | ").slice(-2000)}`);
        await sleep(1000);
    }
}
async function startDashboard() {
    const env: NodeJS.ProcessEnv = {...process.env, NODE_ENV: "production", DATABASE_URL: t.url, PROJECT_URL: urlForAgents(), PROJECT_SECRET: `w21-lab-${randomBytes(12).toString("hex")}`, PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
        AUTH_DEFAULT_USER_NAME: "W21 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_MIRRORS_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
        FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440", FORK_RUN_TICK_SECONDS: "300", FORK_RESTORE_TICK_SECONDS: "0", FORK_TEST_RESTORE_TICK_SECONDS: "0"};
    child = spawn("pnpm", ["exec", "next", "start", "-p", String(dashPort), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env});
    child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
    await waitFor("dashboard ready", async () => out.includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
}
const edgeKeyOf = (agentId: string) => Buffer.from(JSON.stringify({serverUrl: urlForAgents(), agentId, masterKeyB64: Buffer.alloc(32, 7).toString("base64")})).toString("base64url");
const task = async (id: string) => (await q("select status, result from fork_agent_task where id=$1", [id]))[0];
const finished = (id: string) => waitFor(`task ${id} final`, async () => { const x = await task(id); return x && !["queued", "leased", "running"].includes(x.status) ? x : null; }, 180_000);
const iso = () => runnerIsolation(db, runnerAgent, {serverUrl: urlForAgents(), now: new Date()});
async function probe() {
    const r = await requestRunnerProbe(deps(), {agentId: runnerAgent});
    if (!r.ok) throw new Error(`probe request refused: ${r.code}`);
    const done = await finished(r.taskId);
    return {r, done};
}
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
const evidenceDir = () => process.env.LAB_EVIDENCE_DIR;
const keep = (name: string, body: string) => { const d = evidenceDir(); if (d) { mkdirSync(d, {recursive: true}); writeFileSync(path.join(d, name), body); } };
let TARGETS: unknown[] = [];

describe.skipIf(!LAB)("W21 runner lab: egress isolation proven by the runner_probe task (emulated runner VM, real-VM proof PENDING-HUMAN #125)", () => {
    beforeAll(async () => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "w21-lab-")); priv = path.join(tmp, "private");
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), Buffer.alloc(32, 7), {mode: 0o600});
        process.env.PRIVATE_PATH = priv; process.env.PROJECT_URL ??= "http://forklab-dashboard.localhost:1"; process.env.PROJECT_SECRET ??= `w21-test-${randomBytes(12).toString("hex")}`;
        runner(["down"]); runner(["nets"]); runner(["sinks"]);
        dashPort = await freePort(GW); base = `http://${GW}:${dashPort}`;
        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        await startDashboard();
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;
        runnerAgent = await seedAgent(t.pool, org, "w21-runner-agent"); prodAgent = await seedAgent(t.pool, org, "w21-prod-agent");
        const enrol = async (agentId: string) => { const r = await enrolAgent(deps() as ChannelDeps, {agentId, password: PASSWORD}); if (!r.ok) throw new Error(`enrol ${r.code}`); return r.bundle; };
        runnerBundle = await enrol(runnerAgent); prodBundle = await enrol(prodAgent);
        // the runner box: real daemon.json + nftables ruleset (lab variants), agent inside in RUNNER mode
        runner(["box"], {DASH_PORT: String(dashPort)});
        runner(["agent"], {DASH_PORT: String(dashPort), EDGE_KEY: edgeKeyOf(runnerAgent)}, runnerBundle);
        // a normal (non-runner) fork agent on the HOST docker for the cross-role refusal
        const bf = path.join(tmp, "prod.bundle"); writeFileSync(bf, prodBundle, {mode: 0o600}); chmodSync(bf, 0o600);
        sh("docker", ["run", "-d", "--name", PROD_AGENT, "--network", "w21-lab-net", "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production", "-e", "FORK_CHANNEL_ENABLED=true",
            "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2", "-v", `${bf}:/run/fork/bundle:ro`, AGENT_IMAGE], {env: {...process.env, EDGE_KEY: edgeKeyOf(prodAgent)}});
        // guards: the box is attached to the two lab networks only
        const nets = Object.keys(JSON.parse(docker(["inspect", BOX, "-f", "{{json .NetworkSettings.Networks}}"]))).sort();
        expect(nets).toEqual(["w21-lab-net", "w21-prod-net"]);
        TARGETS = [
            {kind: "tcp", host: "172.31.244.25", port: 25, class: "smtp", label: "Prod SMTP"},
            {kind: "tcp", host: "172.31.244.80", port: 8080, class: "webhook", label: "Prod webhook"},
            {kind: "tcp", host: "172.31.244.54", port: 5432, class: "database", label: "Prod DB"},
            {kind: "dns_tcp", host: "172.31.244.53", port: 53, class: "dns", label: "Prod resolver TCP"},
            {kind: "tcp", host: GW, port: dashPort, class: "custom", label: "Dashboard lab"},
            {kind: "tcp", host: "172.31.245.10", port: 2376, class: "custom", label: "Runner host dockerd - input chain"},
            {kind: "dns_name", host: `leak${NONCE}.w21.lab`, class: "dns", label: "Leak canary name"},
        ];
        // guard: no target ever points into the owner's pilot LAN
        for (const x of TARGETS as {host: string}[]) expect(x.host.startsWith("192.168.8.")).toBe(false);
        await designateRunner(deps(), {agentId: runnerAgent, password: PASSWORD}).then((r) => expect(r).toEqual({ok: true}));
        expect(await setRunnerTargets(deps(), {agentId: runnerAgent, targets: TARGETS})).toMatchObject({ok: true});
    });
    afterAll(async () => {
        try { keep("run.out", RUN.join("\n") + "\n"); keep("runner-agent.log", stripAnsi(sh("docker", ["exec", BOX, "docker", "logs", "runner-agent"]))); } catch { /* box gone */ }
        try { keep("nft-ruleset.txt", inbox(["nft", "list", "table", "inet", "pbm_runner"])); keep("docker-info.txt", inbox(["sh", "-c", "docker info 2>&1 | grep -iE 'Default Address|Name Servers|Storage Driver|Cgroup|Server Version'; cat /etc/docker/daemon.json"])); } catch { /* box gone */ }
        keep("prod-agent.log", stripAnsi(logs(PROD_AGENT)));
        const c = child; if (c && c.exitCode === null) { const gone = new Promise<void>((res) => c.once("exit", () => res())); c.kill("SIGTERM"); const k = setTimeout(() => c.kill("SIGKILL"), 10_000); await gone; clearTimeout(k); }
        try { runner(["down"]); } catch { /* best effort */ }
        await t?.drop();
        rmSync(tmp, {recursive: true, force: true});
    });

    it("L1 attest: the runner reports exactly the four runner capabilities and never enabled the restore path; the production agent is not a runner", async () => {
        const caps = await waitFor("runner capabilities", async () => { const [e] = await q("select capabilities from fork_agent_enrollment where agent_id=$1", [runnerAgent]); return e?.capabilities?.includes("runner.v1") ? (e.capabilities as string[]) : null; });
        expect([...caps].sort()).toEqual(RUNNER_CAPS);
        const prodCaps = await waitFor("prod capabilities", async () => { const [e] = await q("select capabilities from fork_agent_enrollment where agent_id=$1", [prodAgent]); return e?.capabilities?.length ? (e.capabilities as string[]) : null; });
        expect(prodCaps).not.toContain("runner.v1");
        const log = stripAnsi(sh("docker", ["exec", BOX, "docker", "logs", "runner-agent"]));
        expect(log).toContain("runner.v1 enabled");
        expect(log).not.toContain("restore target enabled");
        expect(log).not.toContain("quiesce.v1 enabled");
        expect(await requestRunnerProbe(deps(), {agentId: prodAgent})).toMatchObject({ok: false, code: "not_a_runner"});
        RUN.push(`L1 PASS runner caps=${JSON.stringify(caps)} prod caps=${JSON.stringify(prodCaps)}`);
    });

    it("L2 firewall on: every target (SMTP, webhook, DB, DNS over TCP, dashboard, runner host, DNS name) is blocked; the verdict is isolated; the sinks and the wire saw nothing; the probe objects are wiped", async () => {
        runner(["capture", "start"]);
        const {r, done} = await probe();
        runner(["capture", "stop"]);
        expect(done.status).toBe("succeeded");
        const res = done.result as {self_dns: string; results: {id: string; outcome: string}[]; wiped: {containers: number; networks: number}};
        expect(res.self_dns).toBe("ok");
        expect(res.results.length).toBe(r.targetCount);
        expect(res.results.every((x) => x.outcome === "blocked")).toBe(true);
        expect(res.wiped).toEqual({containers: 1, networks: 1});
        expect(await iso()).toMatchObject({state: "isolated", targetCount: r.targetCount});
        // ground truth independent of the probe
        for (const s of ["w21-sink-smtp", "w21-sink-hook", "w21-sink-dns"]) expect(logs(s)).not.toContain("CONN");
        expect(logs("w21-sink-db")).not.toMatch(/connection received: host=\d/); // (the init server logs `host=[local]`: not a network connection)
        expect(runner(["capture", "show"])).not.toContain(NONCE);
        // verified wipe: nothing carrying the probe label survives in the box
        expect(inbox(["docker", "ps", "-aq", "--filter", "label=com.portabase.fork.runner_probe"])).toBe("");
        expect(inbox(["docker", "network", "ls", "-q", "--filter", "label=com.portabase.fork.runner_probe"])).toBe("");
        keep("probe-fw-on.json", JSON.stringify({outcomes: res.results, self_dns: res.self_dns, wiped: res.wiped, verdict: await iso()}, null, 2));
        RUN.push(`L2 PASS fw on: ${r.targetCount} targets all blocked, isolated; sinks quiet; wire capture clean; wiped ${JSON.stringify(res.wiped)}`);
    });

    it("L3 negative control: with the firewall table removed the SAME targets read reachable (smtp, webhook, database, dns), the SMTP sink and the wire saw the traffic, and assertRunnerReady throws", async () => {
        runner(["fw-off"]);
        try {
            runner(["capture", "start"]);
            const {done} = await probe();
            runner(["capture", "stop"]);
            expect(done.status).toBe("succeeded");
            const v = await iso();
            expect(v.state).toBe("not_isolated");
            const classes = v.state === "not_isolated" ? v.reachable.map((x) => x.class) : [];
            for (const c of ["smtp", "webhook", "database", "dns"]) expect(classes, c).toContain(c);
            expect(logs("w21-sink-smtp")).toContain("CONN w21-sink-smtp");
            expect(logs("w21-sink-hook")).toContain("CONN w21-sink-hook");
            expect(logs("w21-sink-db")).toMatch(/connection received: host=172\.31\.244\.10/); // NATed by the runner box
            expect(runner(["capture", "show"])).toContain(NONCE); // the DNS name left the VM: R-W21-3, the probe outcome of a name is not the ground truth, the wire is
            await expect(assertRunnerReady(db, runnerAgent, {serverUrl: urlForAgents(), now: new Date()})).rejects.toBeInstanceOf(RunnerNotIsolatedError);
            keep("probe-fw-off.json", JSON.stringify({results: (done.result as {results: unknown}).results, verdict: v}, null, 2));
            RUN.push(`L3 PASS fw off: not_isolated reachable classes=${JSON.stringify(classes)}; smtp/hook/db sinks logged connections; DNS nonce on the wire; assertRunnerReady throws`);
        } finally { runner(["fw-on"]); }
    });

    it("L4 recovery: after the table is re-applied the probe reads isolated again", async () => {
        await probe();
        expect(await iso()).toMatchObject({state: "isolated"});
        await expect(assertRunnerReady(db, runnerAgent, {serverUrl: urlForAgents(), now: new Date()})).resolves.toMatchObject({state: "isolated"});
        RUN.push("L4 PASS re-applied ruleset: isolated again");
    });

    it("L5 role gating with forged signed tasks: a runner refuses a restore task, a production agent refuses a runner task (both role_forbidden)", async () => {
        const t1 = await plant(runnerAgent, runnerBundle, "restore_probe", {v: 1}, ["restore.target.v1"], runnerAgent);
        const probePayload = {v: 1, probe_id: randomUUID(), targets_sha256: "a".repeat(64), timeout_ms: 1000, targets: [{id: "t01", kind: "tcp", host: "10.20.30.40", port: 25}]};
        const t2 = await plant(prodAgent, prodBundle, "runner_probe", probePayload, ["runner.v1"], prodAgent);
        const [a, b] = await Promise.all([finished(t1), finished(t2)]);
        expect(a).toMatchObject({status: "rejected", result: {reason: "role_forbidden"}});
        expect(b).toMatchObject({status: "rejected", result: {reason: "role_forbidden"}});
        RUN.push("L5 PASS runner refused restore_probe (role_forbidden); production agent refused runner_probe (role_forbidden)");
    });

    it("L6 no production credentials on the runner: the agent container env has no DATABASE_URL / AWS_* / S3_* / SMTP_*; EDGE_KEY is present (recorded residual R-W21-1)", async () => {
        const env = JSON.parse(inbox(["docker", "inspect", "runner-agent", "-f", "{{json .Config.Env}}"])) as string[];
        const keys = env.map((e) => e.split("=")[0]).sort();
        for (const k of keys) expect(k, k).not.toMatch(/^(DATABASE_URL|AWS_.*|S3_.*|SMTP_.*|.*PASSWORD.*|.*SECRET.*)$/);
        expect(keys).toContain("EDGE_KEY");
        keep("runner-agent-env-keys.txt", keys.join("\n") + "\n");
        RUN.push(`L6 PASS env keys=${keys.join(",")} (EDGE_KEY present: residual R-W21-1)`);
    });

    it("L7 cross-network isolation inside the runner: a container on one pool network cannot reach a container on another (delegated to Docker's isolation chains), the same-network control can", async () => {
        const img = AGENT_IMAGE;
        const cleanup = () => { try { inbox(["docker", "rm", "-f", "l7-b", "l7-c"]); } catch { /* none */ } try { inbox(["docker", "network", "rm", "l7-a", "l7-b"]); } catch { /* none */ } };
        cleanup();
        try {
            inbox(["docker", "network", "create", "l7-a"]); inbox(["docker", "network", "create", "l7-b"]);
            inbox(["docker", "run", "-d", "--name", "l7-b", "--network", "l7-b", "--entrypoint", "sleep", img, "300"]);
            inbox(["docker", "run", "-d", "--name", "l7-c", "--network", "l7-a", "--entrypoint", "sleep", img, "300"]);
            const ip = (n: string, net: string) => inbox(["docker", "inspect", n, "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`]);
            const run = (net: string, target: string) => inbox(["docker", "run", "--rm", "--network", net, "--entrypoint", "bash", img, "-c", `timeout -k1 3 bash -c 'exec 3<>/dev/tcp/${target}/9' 2>/dev/null; echo $?`]).trim();
            expect(run("l7-a", ip("l7-c", "l7-a"))).toBe("1"); // same network: connection refused = a path exists (control)
            expect(run("l7-a", ip("l7-b", "l7-b"))).toBe("124"); // other network: dropped
            RUN.push("L7 PASS same-network control refused (path exists), cross-network timed out (dropped)");
        } finally { cleanup(); }
    });
});
