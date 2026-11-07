import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {createPrivateKey, createPublicKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
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
import {enqueueTask} from "@/fork/agent-channel/tasks";
import {SIGN_DOMAIN} from "@/fork/agent-channel/vocab";
import {canonicalJson} from "@/fork/canonical";
import type {ForkDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import {ADMIN} from "@/fork/__tests__/e2e/helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

/**
 * LIVE W15 test (FORK_LAB=1, docker-bridge lab ONLY, synthetic data): the REAL fork dashboard (production build, real upstream boot + fork init + real routes)
 * and TWO REAL fork agents (the stock agent image built with `--features fork-stacks`, image `W15_LAB_AGENT_IMAGE`) over plain http on a lab-only docker network
 * (the single loopback-lab exemption: host `forklab-dashboard.localhost`, FORK_ALLOW_INSECURE_LOOPBACK on both sides).
 *   - signed no-op round trip (agent B "clean-host"), capability negotiation, lease isolation (agent A "vps" can never lease or touch B's task),
 *   - negative fixtures against the REAL agent: tampered signature, wrong key claiming the pinned kid, expired, replayed, rolled-back seq — each refused, never run,
 *   - disabled channel + revoked credential ⇒ the real agent stops getting tasks.
 * Prerequisites: `pnpm build`, Postgres at FORK_TEST_DATABASE_URL, docker, and the image (docker build -f docker/Dockerfile --target prod --build-arg CARGO_FEATURES=fork-stacks).
 * Never run against the owner's pilot hosts.
 */
const LAB = process.env.FORK_LAB === "1";
const IMAGE = process.env.W15_LAB_AGENT_IMAGE ?? "portabase-agent-fork:w15-lab";
const NET = "w15-lab-net", SUBNET = "172.31.250.0/24", GW = "172.31.250.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync("docker", args, {encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"]}).trim();
const freePort = () => new Promise<number>((res) => { const s = net.createServer().listen(0, GW, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

let t: W04Db; let db: ForkDb; let child: ChildProcess; let out = ""; let priv = ""; let tmp = ""; let base = ""; let org = ""; let adminId = "";
const containers: string[] = [];
const q = async (s: string, a: unknown[] = []) => (await t.pool.query(s, a)).rows as Record<string, any>[];
const URL_FOR_AGENTS = () => `http://forklab-dashboard.localhost:${new URL(base).port}`;

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout waiting for ${what}\n--- dashboard (fork lines) ---\n${out.split("\n").filter((l) => /[Ff]ork|rror/.test(l) && !/Received POST/.test(l)).slice(-12).join("\n").slice(-2500)}\n--- agents ---\n${containers.map((c) => `${c}: ${logs(c).split("\n").filter((l) => /[Ff]ork|rror|WARN/.test(l)).slice(-6).join(" | ")}`).join("\n").slice(-2000)}`); await sleep(1000); }
}

const deps = (): ChannelDeps => ({db, principal: {userId: adminId, systemRole: "superadmin", memberships: []}, keys: fileKeyProvider, serverUrl: URL_FOR_AGENTS,
    env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 60}), configAllowed: async () => true});

async function startAgent(name: string, agentId: string, bundle: string) {
    const master = readFileSync(path.join(priv, "keys", "master_key.bin"));
    const edge = Buffer.from(JSON.stringify({serverUrl: URL_FOR_AGENTS(), agentId, masterKeyB64: master.toString("base64")})).toString("base64url");
    const f = path.join(tmp, `${name}.bundle`);
    writeFileSync(f, bundle, {mode: 0o600}); chmodSync(f, 0o600);
    containers.push(name);
    docker(["run", "-d", "--name", name, "--network", NET, "--add-host", `forklab-dashboard.localhost:${GW}`, "-e", "EDGE_KEY", "-e", "TZ=UTC", "-e", "LOG=debug", "-e", "APP_ENV=production",
        "-e", "FORK_CHANNEL_ENABLED=true", "-e", "FORK_CHANNEL_BUNDLE_FILE=/run/fork/bundle", "-e", "FORK_ALLOW_INSECURE_LOOPBACK=true", "-e", "FORK_CHANNEL_POLL_SECONDS=2",
        "-v", `${f}:/run/fork/bundle:ro`, IMAGE], {...process.env, EDGE_KEY: edge});
}
const logs = (name: string) => { try { return execFileSync("docker", ["logs", name], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}); } catch (e) { return String(e); } };
const task = async (id: string) => (await q("select status, result, attempts, agent_id from fork_agent_task where id=$1", [id]))[0];

/** Inserts a queued row for `agentId` carrying whatever envelope/signature we want (the dashboard hands it out as-is; the AGENT must refuse it). */
async function plant(agentId: string, o: {text: string; signature: string; payloadEnc: string; seq: number; enrollId: string; type?: string}) {
    const id = randomUUID();
    await q(`insert into fork_agent_task (id, agent_id, agent_name, enroll_id, type, requires, seq, envelope_text, signature, kid, payload_enc, payload_sha256, status, created_by, not_after)
             values ($1,$2,'planted',$3,$4,'{}',$5,$6,$7,$8,$9,$10,'queued','lab', now() + interval '10 minutes')`,
        [id, agentId, o.enrollId, o.type ?? "noop", o.seq, o.text, o.signature, JSON.parse(o.text).kid, o.payloadEnc, JSON.parse(o.text).payload_sha256]);
    return id;
}

describe.skipIf(!LAB)("W15 live: real fork dashboard + two real fork agents (signed task channel)", () => {
    let A = {id: "", bundle: "", name: "w15-agent-vps"}; let B = {id: "", bundle: "", name: "w15-agent-clean"};
    let keyPem = ""; let enrollB = "";

    beforeAll(async () => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "w15-lab-")); priv = path.join(tmp, "private");
        for (const n of ["w15-agent-vps", "w15-agent-clean"]) { try { docker(["rm", "-f", n]); } catch { /* none */ } }
        try { docker(["network", "create", "--subnet", SUBNET, NET]); } catch { /* exists */ }
        t = await freshForkDb(); db = drizzle({client: t.pool}) as unknown as ForkDb;
        // the dashboard boots against this DB; the D21 self-check needs the default org to exist already (W04 note)
        org = (await q("insert into organization (name, slug) values ('Default Organization','default') returning id"))[0].id;
        const port = await freePort(); base = `http://${GW}:${port}`;
        child = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", GW], {cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {...process.env, NODE_ENV: "production", DATABASE_URL: t.url,
            PROJECT_URL: URL_FOR_AGENTS(), PROJECT_SECRET: "w15-lab-secret-not-a-real-secret-0123456789", PRIVATE_PATH: priv, AUTH_DEFAULT_USER: ADMIN.email, AUTH_DEFAULT_PASSWORD: ADMIN.password,
            AUTH_DEFAULT_USER_NAME: "W15 Lab", SKIP_ONBOARDING: "true", AUTH_SIGNUP_ENABLED: "false", FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", FORK_ALLOW_INSECURE_LOOPBACK: "true", FORK_MIGRATE_DUMP: "off",
            FORK_VERIFY_TICK_SECONDS: "3600", FORK_KIT_WATCH_MINUTES: "1440"}});
        child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
        await waitFor("dashboard ready", async () => out.includes("Fork initialised") && (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 180_000);
        process.env.PRIVATE_PATH = priv; // the test-side key provider reads the SAME key files the server generated
        adminId = (await q(`select id from "user" where email=$1`, [ADMIN.email]))[0].id;
        process.env.W15_ADMIN_PW = ADMIN.password;
        A.id = await seedAgent(t.pool, org, "vps"); B.id = await seedAgent(t.pool, org, "clean-host");
        for (const x of [A, B]) {
            const r = await enrolAgent({...deps(), stepUp: async () => "ok"}, {agentId: x.id, password: "x"});
            if (!r.ok) throw new Error(`enrol ${x.name}: ${r.code}`);
            x.bundle = r.bundle; keyPem = decodeBundle(r.bundle).pins[0].pem;
            if (x === B) enrollB = r.enrollId;
        }
        await startAgent(A.name, A.id, A.bundle); await startAgent(B.name, B.id, B.bundle);
    }, 420_000);

    afterAll(async () => {
        if (process.env.W15_EVIDENCE_DIR) { // evidence for ADR-007 §E: agent logs (secret-free by the last test) + the fork lines of the dashboard log
            for (const n of containers) writeFileSync(path.join(process.env.W15_EVIDENCE_DIR, `${n}.log`), logs(n).replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, ""));
            writeFileSync(path.join(process.env.W15_EVIDENCE_DIR, "dashboard-fork.log"), out.split("\n").filter((l) => /[Ff]ork|agent-channel/.test(l) && !/Received POST/.test(l)).join("\n"));
        }
        for (const n of containers) { try { docker(["rm", "-f", n]); } catch { /* gone */ } }
        try { docker(["network", "rm", NET]); } catch { /* in use / gone */ }
        child?.kill("SIGTERM"); await sleep(500); if (child?.exitCode === null) child?.kill("SIGKILL");
        await t?.drop(); rmSync(tmp, {recursive: true, force: true});
    });

    it("both real agents negotiate capabilities (no version gating) and the stock poll still works", async () => {
        const caps = await waitFor("both agents reported capabilities", async () => { const r = await q("select agent_id, capabilities from fork_agent_enrollment"); return r.length === 2 && r.every((x) => x.capabilities.length) ? r : null; });
        for (const c of caps) expect(c.capabilities).toEqual(["channel.v1", "noop.v1", "plaintext-hash.v1"]);
        expect(logs(B.name)).toMatch(/Fork task channel enabled for agent/);
        expect(logs(B.name)).toMatch(/INSECURE http transport allowed for a loopback lab host/);
    });

    it("signed no-op round trip: enqueue for the clean host ⇒ the REAL agent verifies, runs and reports; the vps agent never sees it", async () => {
        const r = await enqueueTask(deps(), {agentId: B.id, type: "noop", payload: {echo: "W15-LAB-ROUNDTRIP"}});
        expect(r.ok).toBe(true);
        const id = (r as {taskId: string}).taskId;
        const done = await waitFor("task B succeeded", async () => { const x = await task(id); return x?.status === "succeeded" ? x : null; });
        expect(done.result).toMatchObject({echo: "W15-LAB-ROUNDTRIP", agent: "fork-stacks"});
        expect(done.agent_id).toBe(B.id);
        expect(logs(B.name)).toContain(`task ${id}`);
        expect(logs(A.name)).not.toContain(id);
        expect(await q("select status from fork_agent_task where agent_id=$1", [A.id])).toHaveLength(0);
        expect((await q("select action, result from fork_audit_event where resource_id=$1 order by seq", [id])).map((a) => `${a.action}:${a.result}`)).toEqual(["fork.agent_task.result:success"]);
    }, 120_000);

    it("isolation (E2): agent A's credential cannot lease/finish B's work over the real HTTP routes; A's own lease is empty", async () => {
        const a = decodeBundle(A.bundle);
        const hit = (p: string) => fetch(`${base}/api/fork/agent/${B.id}/${p}`, {method: "POST", headers: {authorization: `Bearer ${a.credential}`, "content-type": "application/json"}, body: JSON.stringify({capabilities: ["noop.v1"], lease_id: randomUUID(), status: "succeeded"})});
        expect((await hit("lease")).status).toBe(401);
        expect((await hit(`tasks/${randomUUID()}/result`)).status).toBe(401);
        expect((await fetch(`${base}/api/fork/agent/${B.id}/lease`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"})).status).toBe(401);
        expect((await fetch(`${base}/api/fork/agent/${A.id}/lease`, {method: "POST", headers: {authorization: `Bearer ${a.credential}`, "content-type": "application/json"}, body: JSON.stringify({capabilities: ["noop.v1"]})})).status).toBeLessThan(300);
    });

    it("the REAL agent refuses tampered / forged / expired / replayed / rolled-back tasks and never runs them", async () => {
        const pinKid = kidOfPublicKey(keyPem);
        const taskKey = Buffer.from(decodeBundle(B.bundle).task_key_b64, "base64");
        const privateKeyPem = readFileSync(path.join(priv, "keys", "server_private.pem"), "utf8");
        const maxSeq = Number((await q("select max(seq) m from fork_agent_task where agent_id=$1", [B.id]))[0].m);
        const mk = (o: {seq: number; notAfterDelta?: number; sign?: string; tamper?: boolean; id?: string}) => {
            const taskId = o.id ?? randomUUID();
            const pt = Buffer.from(JSON.stringify({echo: "SHOULD-NEVER-RUN"}));
            const now = Math.floor(Date.now() / 1000);
            const env = EnvelopeSchema.parse({v: 1, task_id: taskId, agent_id: B.id, enroll_id: enrollB, type: "noop", seq: o.seq, issued_at: now - 5, not_after: now + (o.notAfterDelta ?? 600),
                nonce: randomBytes(16).toString("base64url"), payload_sha256: payloadSha256(pt), requires: ["noop.v1"], kid: pinKid});
            let text = canonicalJson(env);
            const sig = rsaSign("sha256", Buffer.from(SIGN_DOMAIN + text), createPrivateKey(o.sign ?? privateKeyPem)).toString("base64");
            if (o.tamper) text = text.replace('"type":"noop"', '"type":"nooq"');
            return {text, signature: sig, payloadEnc: encryptPayload(taskKey, {taskId, agentId: B.id, type: "noop"}, pt), enrollId: enrollB, taskId};
        };
        const expectRefused = async (name: string, rowId: string, reason: string) => {
            const x = await waitFor(`${name} refused`, async () => { const r = await task(rowId); return r && r.status !== "queued" && r.status !== "leased" ? r : null; });
            expect(x.status, name).toBe("rejected"); expect(x.result, name).toMatchObject({reason});
        };
        const good = maxSeq + 1;
        const cases: [string, ReturnType<typeof mk>, number, string][] = [
            ["tampered after signing", mk({seq: good, tamper: true}), good, "bad_signature"],
            ["signed by another key claiming the pinned kid", mk({seq: good, sign: testKeypair().privateKey}), good + 1, "bad_signature"],
            ["expired", mk({seq: good, notAfterDelta: -300}), good + 2, "expired"],
        ];
        for (const [name, c, seq, reason] of cases) { const id = await plant(B.id, {...c, seq}); await expectRefused(name, id, reason); }
        // replay: a properly signed fresh task is accepted once…
        const fresh = mk({seq: good + 3});
        const rowOk = await plant(B.id, {...fresh, seq: good + 3});
        await waitFor("fresh task ran", async () => (await task(rowOk))?.status === "succeeded");
        expect((await task(rowOk)).result).toMatchObject({echo: "SHOULD-NEVER-RUN"}); // (it IS valid and signed: this proves the fixture is accepted when honest)
        // …the SAME signed bytes planted again (new row) are never executed again: the agent re-reports the stored outcome (duplicate)
        const execBefore = (logs(B.name).match(/\) succeeded/g) ?? []).length;
        const rowReplay = await plant(B.id, {...fresh, seq: good + 4});
        await waitFor("replay answered", async () => { const s = (await task(rowReplay))?.status; return s === "succeeded" || s === "rejected"; });
        expect(logs(B.name)).toContain("already handled, re-reporting its outcome");
        expect((logs(B.name).match(/\) succeeded/g) ?? []).length).toBe(execBefore);
        // rolled back: a validly signed, unseen task whose seq is not above the last accepted one
        const rb = mk({seq: good});
        const rowRb = await plant(B.id, {...rb, seq: good + 5});
        await expectRefused("rolled-back seq", rowRb, "seq_rollback");
        expect(logs(B.name)).not.toMatch(/SHOULD-NEVER-RUN/);
    }, 240_000);

    it("a disabled channel and a revoked credential stop the real agent from receiving tasks", async () => {
        const {setChannelEnabled, revokeEnrollment} = await import("@/fork/agent-channel/admin");
        expect(await setChannelEnabled(deps(), {agentId: B.id, enabled: false})).toMatchObject({ok: true});
        expect(await enqueueTask(deps(), {agentId: B.id, type: "noop", payload: {echo: "x"}})).toMatchObject({ok: false, code: "agent_disabled"});
        await waitFor("agent notices the switch", async () => logs(B.name).includes("switched off for this agent by the operator"));
        await setChannelEnabled(deps(), {agentId: B.id, enabled: true});
        expect(await revokeEnrollment(deps(), {agentId: B.id})).toEqual({ok: true});
        await waitFor("agent notices the revocation", async () => logs(B.name).includes("rejected this agent's credential"), 150_000);
    }, 240_000);

    it("no secret leaks: neither agent log nor the dashboard log contains a credential, task key or payload echo", () => {
        for (const x of [A, B]) {
            const b = decodeBundle(x.bundle);
            for (const log of [logs(A.name), logs(B.name), out]) { expect(log).not.toContain(b.credential); expect(log).not.toContain(b.credential.split(".")[2]); expect(log).not.toContain(b.task_key_b64); }
        }
        expect(out).not.toContain("W15-LAB-ROUNDTRIP");
        void createPublicKey;
    });
});
