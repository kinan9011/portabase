import {execFileSync} from "node:child_process";
import {generateKeyPairSync, hkdfSync} from "node:crypto";
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {unwrapDigitalKit} from "@/fork/kit/digital";
import {loadKitBanner} from "@/fork/kit/banner-data";
import {beginKitGeneration, confirmKitFingerprint, generateKitArtifact, isKitVerified, loadKitView, type KitDeps} from "@/fork/kit/service";
import {loadTrustAnchors} from "@/fork/manifest/anchors";
import {manifestRepoPassword} from "@/fork/manifest/repo-password";
import {createResticRunner} from "@/fork/manifest/restic-runner";
import {listManifestSnapshots, readManifestSnapshot} from "@/fork/manifest/store";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {verifyRecoveryPoint, type VerifyDeps} from "@/fork/verify/service";

import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {createHash} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {Client as Minio} from "minio";
import {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {ENV_MINIMUM} from "@/fork/arcane/endpoints";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import type {ForkDb} from "@/fork/db/handle";
import {runForkMigrations} from "@/fork/db/migrate";
import {syncConnection} from "@/fork/discovery/sync";
import type {MaterializeDeps} from "@/fork/materialize/apply";
import {parseAllowlist} from "@/fork/net/guard";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {hashUrl} from "@/fork/recovery-point/hash";
import type {RunConfig} from "@/fork/runs/config";
import type {RunDeps} from "@/fork/runs/deps";
import {runsTick} from "@/fork/runs/job";
import {startRun} from "@/fork/runs/start";
import {activateStackPolicy} from "@/fork/stack-policy/activate";
import {parseStackListParams} from "@/fork/stacks/params";
import {loadStackDetail, loadStackList} from "@/fork/stacks/queries";

/**
 * LIVE W12 test (FORK_LAB=1, loopback/docker-bridge lab ONLY): the real fork code drives the REAL lab — upstream dashboard 1.35.2 + the unchanged
 * agent 1.25.2 + MinIO + Arcane v2.17.3 — against the lab dashboard's database: scheduled grouped backup of the demo stack → RecoveryPoint with
 * artifact checksums that equal an INDEPENDENT read of the MinIO objects; then injected failures (member fails, validator blocked, agent down,
 * storage down, Arcane down, held-lock bail state, revoked rights).
 *
 * Needs (dev/fork-lab/README.md + the W10 handoff): `lab.sh up`, `lab.sh agent attach-demo-net host-bind w10-real-paths`, a lab-only DB role created
 * through `docker exec … psql`, and  W10_LAB_DATABASE_URL=postgres://<role>:<pw>@<lab-db-container-ip>:5432/portabase  W10_LAB_DIR=<abs dev/fork-lab>.
 * Injection notes (honest): "held per-source lock" is simulated at its observable end state (upstream row `ongoing`, agent created nothing);
 * the unreadable probe is the same write the W10 drift job makes. Retention against real storage is NOT exercised here (the dashboard-side
 * delete path needs the docker-internal MinIO name); it is covered by `w12-runs-retention` with the real upstream delete service wired.
 */
const LAB = process.env.FORK_LAB === "1" && !!process.env.W10_LAB_DATABASE_URL;
const URL_ = process.env.ARCANE_URL ?? "http://127.0.0.1:13552";
const ADMIN_USER = process.env.LAB_ARCANE_ADMIN_USER ?? "arcane";
const ADMIN_PASS = process.env.LAB_ARCANE_ADMIN_PASSWORD ?? "arcane-admin";
const LAB_DIR = process.env.W10_LAB_DIR ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...a: string[]) => execFileSync("docker", a, {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();

let pool: Pool; let db: ForkDb; let org = ""; let agentId = ""; let userId = ""; let token = ""; let keyId = ""; let conn = ""; let stackId = ""; let channel = ""; let kekDir = "";
let sink: Server | undefined; const sunk: {title: string; message: string; level: string; event: string}[] = [];
let minio: Minio; let bucket = ""; let spikePassword: unknown;
const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows as Record<string, any>[];
const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${URL_}/api${p}`, {method, headers: {"content-type": "application/json", authorization: `Bearer ${token}`}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, json: (await r.json().catch(() => ({}))) as {data?: {id?: string; key?: string}}};
};
const principal = (): ForkPrincipal => ({userId, systemRole: "admin", memberships: [{organizationId: org, role: "owner"}]});
const mdeps = (): MaterializeDeps => ({db, principal: principal(), masterKey: async () => Buffer.alloc(32, 7), assertConfigAllowed: async () => undefined, rate: () => ({ok: true})});
const cfg = (o: Partial<RunConfig> = {}): RunConfig => ({tickMs: 3000, waitTimeoutMs: 120_000, stallTimeoutMs: 300_000, maxRunMs: 900_000, captureWindowMs: 3_600_000, maxPerAgent: 1, maxPerOrg: 3, hashMaxBytes: 1 << 30, hashTimeoutMs: 120_000, ...o});
const refresh: RunDeps["refresh"] = async () => {
    const r = await syncConnection({db, kekDir, allowlist: parseAllowlist("127.0.0.1")}, conn, "cron");
    return r.kind === "ran" && r.run.status !== "failed" ? "ok" : "failed";
};
/** The fork's hasher over the lab: presigned URL from the HOST-published MinIO port + the fork's own streaming `hashUrl`. */
const hash: RunDeps["hash"] = async (r) => {
    const [s] = await q("select path, size from backup_storage where id=$1", [r.backupStorageId]);
    const url = await minio.presignedGetObject(bucket, s.path as string, 600);
    const out = await hashUrl(url, r);
    if (!out) { const probe = await fetch(url).catch((e) => ({status: -1, headers: new Headers(), err: String(e)})); console.info("W14 LIVE hash null:", JSON.stringify({path: s.path, size: s.size, status: probe.status, len: probe.headers.get("content-length")})); }
    return out;
};
const runDeps = (o: Partial<RunDeps> = {}, c: Partial<RunConfig> = {}): RunDeps => ({db, cfg: cfg(c), mode: async () => "on", refresh, hash, owner: "lab-test", ...o});
const independentSha = async (objectPath: string) => {
    const h = createHash("sha256"); let n = 0;
    for await (const chunk of await minio.getObject(bucket, objectPath)) { h.update(chunk as Buffer); n += (chunk as Buffer).length; }
    return {sha: h.digest("hex"), bytes: n};
};
async function finish(d: RunDeps, runId: string, ms = 240_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        await runsTick(d);
        const [r] = await q("select state from fork_stack_run where id=$1", [runId]);
        if (!["starting", "running", "finalizing"].includes(r.state)) return;
        await sleep(3000);
    }
    throw new Error("run did not finish in time");
}
const latestRp = async () => (await q("select * from fork_recovery_point where stack_id=$1 order by sequence desc limit 1", [stackId]))[0];
const arts = async (rp: string) => q("select a.*, s.size as storage_size from fork_recovery_point_artifact a left join backup_storage s on s.id=a.backup_storage_id where a.rp_id=$1 order by a.source_name, a.channel_id", [rp]);
const startManual = async (d: RunDeps) => { const r = await startRun(d, {stackId, trigger: "manual", userId}); if (r.kind !== "started") throw new Error(JSON.stringify(r)); return r.runId; };
const SELECTION = () => ({includeKeys: [] as string[], excludeKeys: [] as string[], databases: {db: {kind: "dump" as const, host: "demo-db", port: 5432, username: "demo", database: "demo"}}, manual: [{path: path.join(LAB_DIR, "demo-stack"), covers: ["env:undetermined"]}]});
const detail = async () => { const d = (await loadStackDetail(db, org, stackId))!; if (d.inventory.state !== "ok") throw new Error("inventory"); return d; };
const resetRuns = async () => { await q("update fork_stack_run set state='failed', reason='interrupted', finished_at=now() where stack_id=$1 and state in ('starting','running','finalizing')", [stackId]); await q("delete from fork_lock where name like 'run:%'"); };

describe.skipIf(!LAB)("W14 live (M2 gate): scheduled backup → verify job → signed manifest in MinIO → plain openssl; truncated object ⇒ failed; kit + fingerprint", () => {
    beforeAll(async () => {
        expect(["127.0.0.1", "localhost"]).toContain(new globalThis.URL(URL_).hostname);
        pool = new Pool({connectionString: process.env.W10_LAB_DATABASE_URL, options: "-c TimeZone=UTC0", max: 6});
        db = drizzle({client: pool}) as unknown as ForkDb;
        const lane = await runForkMigrations({databaseUrl: process.env.W10_LAB_DATABASE_URL, env: {NODE_ENV: "development"}});
        if (lane.state !== "applied") throw new Error(`lane ${lane.state} ${lane.detail ?? ""}`);
        org = (await q("select id from organization where slug='default'"))[0].id as string;
        agentId = (await q("select id from agents where slug='lab-agent'"))[0].id as string;
        const ch = (await q("select id, config from storage_channel where name='lab-minio'"))[0];
        channel = ch.id as string;
        const c = ch.config as {accessKey: string; secretKey: string; bucketName: string};
        bucket = c.bucketName;
        minio = new Minio({endPoint: "127.0.0.1", port: 19000, useSSL: false, accessKey: c.accessKey, secretKey: c.secretKey});
        userId = (await q("select id from \"user\" where role in ('admin','superadmin') order by created_at limit 1"))[0].id as string;
        await q("update member set role='owner' where user_id=$1 and organization_id=$2", [userId, org]);
        await q("update settings set encryption=true"); // D39: the agent encrypts only when the dashboard says so
        for (let i = 0; i < 2 && !token; i++) {
            const r = await fetch(`${URL_}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({username: ADMIN_USER, password: ADMIN_PASS})});
            if (r.status === 429) { await sleep((Number(r.headers.get("retry-after")) || 60) * 1000); continue; }
            token = ((await r.json()) as {data?: {token?: string}}).data?.token ?? "";
        }
        if (!token) throw new Error("lab Arcane admin login failed");
        const old = await api("GET", "/api-keys?limit=200");
        for (const k of (old.json.data as unknown as {id: string; name: string}[]) ?? []) if (k.name?.startsWith("forklab-w14-")) await api("DELETE", `/api-keys/${k.id}`);
        const perms = [{permission: "environments:list"}, ...ENV_MINIMUM.map((permission) => ({permission, environmentId: "0"}))];
        const m = await api("POST", "/api-keys", {name: "forklab-w14-view", description: "W12 live test, lab only", permissions: perms});
        if (m.status !== 200 || !m.json.data?.key) throw new Error(`key mint failed (${m.status})`);
        keyId = m.json.data.id as string;
        kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w14l-kek-")), "fork-kek");
        conn = (await insertConnectionWithSecret(db, {organizationId: org, name: "w14-lab-arcane", baseUrl: URL_, apiKey: m.json.data.key}, kekDir)).id;
        await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled, agent_id, agent_name, allowed_path_roots) values ($1,'0','local',true,$2,'lab-agent',$3)", [conn, agentId, [LAB_DIR]]);
        const r = await syncConnection({db, kekDir, allowlist: parseAllowlist("127.0.0.1")}, conn, "manual", {userId: null});
        expect(r.kind).toBe("ran");
        const list = await loadStackList(db, org, parseStackListParams({q: "forklab-demo"}));
        stackId = list.items.find((i) => i.composeProject === "forklab-demo")?.id ?? "";
        expect(stackId, `listed: ${list.items.map((i) => i.composeProject)}`).not.toBe("");
        spikePassword = ((await q("select config from databases where name='demo-postgres' and deleted_at is null"))[0].config as {password: unknown}).password;

        // W13: a REAL upstream notification channel (webhook) pointing at a local sink; it is the instance default channel
        sink = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { sunk.push(JSON.parse(b)); } catch { /* ignore */ } res.statusCode = 200; res.end("ok"); }); });
        await new Promise<void>((r) => sink!.listen(0, "127.0.0.1", r));
        const hook = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
        const chId = (await q("insert into notification_channel (provider, name, config, enabled) values ('webhook','w13-sink',$1,true) returning id", [JSON.stringify({webhookUrl: hook})]))[0].id as string;
        await q("update settings set default_notification_channel_id=$1 where name='system'", [chId]);
        await q("delete from fork_notification_outbox");    }, 300_000);

    afterAll(async () => {
        for (const c of ["forklab-arcane", "forklab-agent", "forklab-portabase-minio-1"]) { try { docker("start", c); } catch { /* already running */ } }
        try {
            if (keyId) await api("DELETE", `/api-keys/${keyId}`).catch(() => undefined);
            if (pool) await q("update settings set default_notification_channel_id = null where name='system'").catch(() => undefined);
            if (pool && !process.env.W13_KEEP) {
                await q("update \"user\" set role='admin' where id=$1", [userId]).catch(() => undefined);
                await q("update backups set deleted_at=now() where database_id in (select id from databases where project_id in (select id from projects where name like 'stack:%'))").catch(() => undefined);
                await q("delete from fork_stack_run").catch(() => undefined);
                await q("delete from fork_recovery_point").catch(() => undefined);
                await q("delete from databases where project_id in (select id from projects where name like 'stack:%')").catch(() => undefined);
                await q("delete from storage_policy where project_id in (select id from projects where name like 'stack:%')").catch(() => undefined);
                await q("update fork_stack set project_id = null").catch(() => undefined);
                await q("delete from projects where name like 'stack:%'").catch(() => undefined);
                await q("delete from fork_stack_policy").catch(() => undefined);
                await q("delete from fork_stack_source").catch(() => undefined);
                await q("delete from fork_stack").catch(() => undefined);
                await q("delete from fork_arcane_environment").catch(() => undefined);
                await q("delete from fork_arcane_connection").catch(() => undefined);
                await q("update settings set encryption=false").catch(() => undefined);
            }
        } finally {
            sink?.close();
            await pool?.end();
        }
    });


    it("0. activates the demo stack through the REAL activation (materialize + D31 record) and makes the sources work with the real agent", async () => {
        resetRateLimits();
        const inv0 = await detail();
        const sel = SELECTION();
        if (inv0.inventory.state === "ok" && inv0.inventory.configuration.items.some((i) => i.key === "db:web")) sel.excludeKeys.push("db:web");
        const uploads = inv0.inventory.state === "ok" ? inv0.inventory.configuration.items.find((i) => i.kind === "bind" && i.name.endsWith("/demo-stack/uploads")) : undefined;
        if (uploads) sel.includeKeys.push(uploads.key);
        const minute = (new Date().getUTCMinutes() + 58) % 60; // the hourly slot 2 minutes ago: due now, inside the capture window
        const input = {stackId, selection: sel, storageChannelIds: [channel], secrets: {db: "demo-synthetic-not-a-secret"}, confirmDockerAccess: true, schedule: {preset: "hourly" as const, timezone: "UTC", minute, hour: 2, weekday: 0, monthday: 1}};
        let r = await activateStackPolicy(mdeps(), input);
        for (let i = 0; i < 20 && r.ok && r.deferred.length; i++) { await sleep(5000); r = await activateStackPolicy(mdeps(), input); }
        expect(r.ok, JSON.stringify(r)).toBe(true);
        // the lab stack has gaps by design (W09/W10: the anonymous volume of `web`, …): the operator ACCEPTS them (UX-20, audited) so a complete run can be told apart from a blocked one
        await sleep(6000);
        const gaps = (await detail()).inventory;
        const keys = gaps.state === "ok" ? gaps.configuration.items.filter((i) => i.gap).map((i) => i.key).filter((k) => !k.startsWith("agent:")) : []; // an agent gap is not an exclusion
        console.info("W12 LIVE accepted exclusions:", JSON.stringify(keys));
        if (keys.length) { r = await activateStackPolicy(mdeps(), {...input, acceptedExclusions: keys}); expect(r.ok, JSON.stringify(r)).toBe(true); }
        await q(`update databases set config = jsonb_set(config, '{password}', $1::jsonb) where id = (select database_id from fork_stack_source where stack_id=$2 and role='db')`, [JSON.stringify(spikePassword), stackId]);
        await q("update fork_stack_policy set activated_at = now() - interval '3 hours' where stack_id=$1", [stackId]);
        const pol = (await q("select activation, schedule, protection_state from fork_stack_policy p join fork_stack s on s.id=p.stack_id where p.stack_id=$1", [stackId]))[0];
        expect(pol.activation).toMatchObject({userId, capability: "stacks.backup.manage"});
        console.info("W12 LIVE activated:", JSON.stringify({sources: (await q("select role, status from fork_stack_source where stack_id=$1 order by role", [stackId])).map((x) => `${x.role}:${x.status}`)}));
    }, 300_000);

    it("1. EXIT 1/2/10: the REAL scheduler starts the slot; the grouped run ends `pending_verification` with every artifact linked and its checksum equal to an independent MinIO read; the finalizer never says verified", async () => {
        // wait until every member answered a ping (probes feed the validator)
        const d = runDeps();
        for (let i = 0; i < 24; i++) { const left = (await q("select 1 from fork_stack_source where stack_id=$1 and role<>'env' and status<>'active'", [stackId])); if (!left.length) break; await sleep(5000); }
        const tick = await runsTick(d);
        expect(tick.scheduler.started, JSON.stringify(tick)).toBe(1);
        const [run] = await q("select id, trigger, scheduled_for from fork_stack_run where stack_id=$1", [stackId]);
        expect(run.trigger).toBe("schedule");
        await finish(d, run.id as string);
        const [r] = await q("select * from fork_stack_run where id=$1", [run.id]);
        const rp = await latestRp();
        console.info("W12 LIVE run:", JSON.stringify({state: r.state, reason: r.reason, blocked: r.validator_blocked, refresh: r.inventory_refresh, rp: [rp.status, rp.downgrade_reason, rp.consistency_level, rp.required_artifact_count, rp.present_artifact_count]}));
        const items = await q("select source_name, dbms, state, reason from fork_stack_run_item where run_id=$1 order by source_name", [run.id]);
        console.info("W12 LIVE items:", JSON.stringify(items));
        expect(rp, JSON.stringify({run: r, items})).toMatchObject({status: "pending_verification", downgrade_reason: null, verified_at: null});
        expect(r).toMatchObject({state: "succeeded", inventory_refresh: "ok"});
        const list = await arts(rp.id as string);
        expect(list.length).toBe(rp.required_artifact_count);
        expect(list.length).toBeGreaterThanOrEqual(3);
        for (const a of list) {
            expect(a).toMatchObject({presence: "present", required: true, encrypted: true, channel_id: channel, channel_kind: "s3"});
            expect(a.backup_id).toBeTruthy(); expect(a.backup_storage_id).toBeTruthy(); expect(a.stack_source_id).toBeTruthy(); expect(a.generated_id).toBeTruthy();
            expect(Number(a.size_bytes)).toBe(Number(a.storage_size));
            if (a.archive_kind === "restic_snapshot") {
                expect(a.path_or_snapshot_id).toMatch(/^[0-9a-f]{64}$/);
                expect(a.ciphertext_sha256).toBeNull();
            } else {
                expect(a.archive_kind).toBe("archive_enc");
                expect(a.path_or_snapshot_id).toMatch(/\.enc$/);
                const ind = await independentSha(a.path_or_snapshot_id as string);
                console.info("W12 LIVE checksum:", a.source_name, a.engine, a.ciphertext_sha256, "independent:", ind.sha, ind.bytes);
                expect(a.ciphertext_sha256).toBe(ind.sha);
                expect(ind.bytes).toBeGreaterThanOrEqual(Number(a.size_bytes)); // the agent reports the size before encryption; the stored object adds header + tags
                console.info("W12 LIVE size:", a.size_bytes, "reported vs", ind.bytes, "stored");
            }
        }
        expect(list.some((a) => a.archive_kind === "restic_snapshot")).toBe(true);
        expect(list.some((a) => a.engine === "postgresql")).toBe(true);
        expect((await q("select count(*)::int n from fork_recovery_point where status='verified'"))[0].n).toBe(0);
        expect(rp.consistency_level).toBe("mixed");
        // the same hourly slot is not run twice
        expect((await runsTick(d)).scheduler.started).toBe(0);
        expect((await q("select state from fork_schedule_state where stack_id=$1", [stackId]).catch(() => []))).toBeDefined();
        const ss = (await q("select last_run_status from fork_schedule_state where stack_id=$1", [stackId]))[0];
        expect(ss.last_run_status).toBe("success");
    }, 420_000);

    // ---------------------------------------------------------------- W14 -----------------------------------------------------------------------------
    const MASTER_FILE = process.env.W14_LAB_MASTER_FILE ?? "";
    const signing = (() => { const k = generateKeyPairSync("rsa", {modulusLength: 2048, publicKeyEncoding: {type: "spki", format: "pem"}, privateKeyEncoding: {type: "pkcs1", format: "pem"}}); return {...k, kid: kidOfPublicKey(k.publicKey)}; })(); // TEST-ONLY, lab run
    const kitDir = () => { const d = path.join(LAB_DIR, "results", "w14-kit"); mkdirSync(d, {recursive: true}); return d; }; // results/ is git-ignored (dev/fork-lab/.gitignore)
    const master = () => Buffer.from(readFileSync(MASTER_FILE, "utf8").trim(), "base64");
    let cache = "";
    const s3env = () => { const c = (spikeChannel as {accessKey: string; secretKey: string}); cache ||= mkdtempSync(path.join(os.tmpdir(), "w14-rcache-")); return {AWS_ACCESS_KEY_ID: c.accessKey, AWS_SECRET_ACCESS_KEY: c.secretKey, RESTIC_CACHE_DIR: cache}; };
    let spikeChannel: unknown;
    const repoUrl = (rel: string) => `s3:http://127.0.0.1:19000/${bucket}/${rel}`;
    const resticPw = (generatedId: string) => Buffer.from(hkdfSync("sha256", master(), Buffer.alloc(0), `portabase/restic/v1/${generatedId}`, 32)).toString("hex");
    const verifyDeps = (): VerifyDeps => ({
        db, now: () => new Date(),
        keys: {master: async () => master(), signing: async () => ({privateKeyPem: signing.privateKey, publicKeyPem: signing.publicKey})},
        openArchive: async (id) => {
            const [s] = await q("select path from backup_storage where id=$1", [id]);
            const resp = await fetch(await minio.presignedGetObject(bucket, s.path as string, 600));
            return {status: resp.status, body: resp.ok && resp.body ? (resp.body as unknown as AsyncIterable<Uint8Array>) : null, abort() {}};
        },
        checkResticSnapshot: async ({generatedId, snapshotId}) => {
            const run = createResticRunner({repository: repoUrl(`backups/restic/${generatedId}`), password: resticPw(generatedId), env: s3env()});
            const cat = await run(["cat", "snapshot", snapshotId]);
            if (cat.code !== 0) return false;
            const ls = await run(["ls", "--json", snapshotId]);
            return ls.code === 0 && ls.stdout.length > 0;
        },
        manifestRunner: async (_ch, stack, m) => ({run: createResticRunner({repository: repoUrl(`backups/fork-manifest/${stack}`), password: manifestRepoPassword(m, stack), env: s3env()}), cleanup: async () => undefined}),
        limits: {maxPlaintextBytes: 1 << 30, maxInflatedBytes: 4 * 1024 * 1024 * 1024, downloadTimeoutMs: 120_000}, maxAttempts: 2, backoffMinutes: [1], crossCheckAgentSize: true,
    });

    it("2. M2 GATE: the REAL pending_verification RP (real agent, real MinIO) is promoted to `verified` by the verify job on real evidence; plaintext hash/size equal an INDEPENDENT python decrypt; agent-reported size = decrypted size", async () => {
        expect(MASTER_FILE, "W14_LAB_MASTER_FILE (lab throw-away master key, 0600 file)").not.toBe("");
        spikeChannel = (await q("select config from storage_channel where id=$1", [channel]))[0].config;
        const rp = await latestRp();
        expect(rp.status).toBe("pending_verification");
        const out = await verifyRecoveryPoint(verifyDeps(), rp.id as string);
        console.info("W14 LIVE verify outcome:", JSON.stringify(out));
        expect(out).toMatchObject({outcome: "verified", manifestChannels: 1});
        const v = await latestRp();
        expect(v).toMatchObject({status: "verified", downgrade_reason: null});
        expect(v.verified_at).toBeTruthy();
        console.info("W14 LIVE RP:", JSON.stringify({seq: v.sequence, status: v.status, sig_kid: v.manifest_sig_kid, manifest_sha256: v.manifest_sha256, refs: v.manifest_refs}));
        const list = await arts(rp.id as string);
        const tmp = mkdtempSync(path.join(os.tmpdir(), "w14-ind-"));
        for (const a of list.filter((x) => x.archive_kind === "archive_enc")) {
            const bytes = Buffer.concat(await (async () => { const cs: Buffer[] = []; for await (const c of await minio.getObject(bucket, a.path_or_snapshot_id as string)) cs.push(c as Buffer); return cs; })());
            writeFileSync(path.join(tmp, "in.enc"), bytes);
            const ind = execFileSync("python3", [path.join(process.cwd(), "scripts/fork/recover/decrypt-archive"), "--key-file", MASTER_FILE, path.join(tmp, "in.enc"), path.join(tmp, `${a.id}.tar.gz`)], {encoding: "utf8"}).trim();
            execFileSync("gzip", ["-t", path.join(tmp, `${a.id}.tar.gz`)]);
            console.info("W14 LIVE plaintext:", a.source_name, a.engine, `db: sha=${a.plaintext_sha256} size=${a.plaintext_size} dump=${a.dump_format} agent_size=${a.size_bytes}`, "| independent:", ind);
            expect(ind).toBe(`sha256=${a.plaintext_sha256} size=${a.plaintext_size}`);
            expect(Number(a.size_bytes)).toBe(Number(a.plaintext_size)); // real agent: reported size == decrypted plaintext size
        }
        expect(list.some((a) => a.engine === "postgresql" && a.dump_format === "pg_custom")).toBe(true);
        // the manifest snapshot really is in MinIO (listed by the S3 API, not by the fork)
        const objs: string[] = [];
        for await (const o of minio.listObjectsV2(bucket, `backups/fork-manifest/${stackId}/`, true)) if (o.name) objs.push(o.name);
        console.info("W14 LIVE manifest repo objects in MinIO:", objs.length, objs.slice(0, 3));
        expect(objs.some((n) => n.endsWith("/config"))).toBe(true);
        // plain restic + plain openssl, the way the CLI/operator does it (nothing of the fork involved)
        const pw = execFileSync("openssl", ["kdf", "-keylen", "32", "-kdfopt", "digest:SHA256", "-kdfopt", `hexkey:${master().toString("hex")}`, "-kdfopt", `info:portabase-fork/manifest/v1/${stackId}`, "-binary", "HKDF"]).toString("hex");
        const out2 = path.join(tmp, "restore");
        execFileSync("restic", ["-r", repoUrl(`backups/fork-manifest/${stackId}`), "restore", "latest", "--tag", `rp:${rp.id}`, "--target", out2], {env: {...process.env, ...s3env(), RESTIC_PASSWORD: pw}, stdio: "pipe"});
        const mf = execFileSync("find", [out2, "-name", "manifest.json"]).toString().trim();
        const dir = path.dirname(mf);
        writeFileSync(path.join(tmp, "kit-pub.pem"), signing.publicKey); // the trust anchor comes from the KIT, not from the snapshot
        const verdict = execFileSync("openssl", ["dgst", "-sha256", "-verify", path.join(tmp, "kit-pub.pem"), "-signature", path.join(dir, "manifest.json.sig"), mf]).toString().trim();
        console.info("W14 LIVE openssl dgst -verify:", verdict);
        expect(verdict).toContain("Verified OK");
        // forged / rolled-back / replayed against the REAL stored manifest
        const bundle = {json: readFileSync(mf), sig: readFileSync(path.join(dir, "manifest.json.sig"))};
        const anchors = await loadTrustAnchors(db);
        expect(verifyManifestBundle(bundle, anchors, {stackId, rpId: rp.id as string, sequence: Number(rp.sequence)}).ok).toBe(true);
        expect(verifyManifestBundle(bundle, anchors, {stackId, minSequence: Number(rp.sequence) + 1})).toEqual({ok: false, code: "rollback"});
        expect(verifyManifestBundle(bundle, anchors, {stackId: "00000000-0000-4000-8000-000000000000"})).toEqual({ok: false, code: "stack_mismatch"});
        expect(verifyManifestBundle({json: bundle.json.toString().replace(/"plaintext_size":\d+/, '"plaintext_size":1'), sig: bundle.sig}, anchors, {stackId})).toEqual({ok: false, code: "bad_signature"});
        expect((await q("select count(*)::int n from fork_recovery_point where status='verified'"))[0].n).toBe(1);
        const [sched] = await q("select last_verified_rp_at from fork_schedule_state where stack_id=$1", [stackId]);
        expect(sched.last_verified_rp_at).toBeTruthy();
    }, 300_000);

    it("3. M2 / D41: kit generated (paper + digital) with step-up seam, fingerprint STORED; active-policy stack reads `kit not verified` + banner; entry of the independently recomputed code verifies it", async () => {
        resetRateLimits();
        const kek = path.join(mkdtempSync(path.join(os.tmpdir(), "w14-kek2-")), "fork-kek");
        const keys = {master: async () => master(), signing: async () => ({privateKeyPem: signing.privateKey, publicKeyPem: signing.publicKey})};
        const kd: KitDeps = {db, principal: principal(), keys, kekDir: kek, verifyPassword: async () => true, assertConfigAllowed: async () => undefined};
        const PASS = `Lab-pass-${Date.now()}-Zq9!`; // TEST-ONLY
        const b = await beginKitGeneration(kd, {types: ["paper", "digital"], password: "lab-throwaway"});
        if (!b.ok) throw new Error(`begin refused ${b.code}`);
        const paper = await generateKitArtifact(kd, {kind: "paper", token: b.tokens.paper});
        const digital = await generateKitArtifact(kd, {kind: "digital", token: b.tokens.digital, passphrase: PASS, passphraseConfirm: PASS});
        if (!paper.ok || paper.kind !== "paper" || !digital.ok || digital.kind !== "digital") throw new Error("kit generation failed");
        const dir = kitDir();
        writeFileSync(path.join(dir, "kit-paper.html"), paper.body, {mode: 0o600});
        writeFileSync(path.join(dir, digital.filename), digital.body, {mode: 0o600});
        const [k] = await q("select status, types, fingerprint, signing_kid, kek_kids from fork_kit where superseded_at is null");
        console.info("W14 LIVE kit row:", JSON.stringify({status: k.status, types: k.types, fingerprint_stored: /^([0-9A-F]{4}-){4}[0-9A-F]{4}$/.test(k.fingerprint), signing_kid: k.signing_kid, kek_kids: k.kek_kids}), "files:", dir);
        expect(k.status).toBe("issued");
        expect([...k.types].sort()).toEqual(["digital", "paper"]);
        expect(paper.body).not.toContain(k.fingerprint);
        expect(unwrapDigitalKit(digital.body, PASS).master_key_b64).toBe(master().toString("base64"));
        expect(await isKitVerified(db)).toBe(false);
        const banner = await loadKitBanner(db, org);
        console.info("W14 LIVE banner inputs:", JSON.stringify({kit: banner.view.state, hasActivePolicy: banner.hasActivePolicy}));
        expect(banner).toMatchObject({hasActivePolicy: true, view: {state: "issued"}});
        const d = await loadStackDetail(db, org, stackId);
        const primary = JSON.stringify(d).match(/"primary":"([a-z_]+)"/)?.[1] ?? JSON.stringify(d).match(/kit_not_verified/)?.[0];
        console.info("W14 LIVE stack primary state:", primary);
        expect(JSON.stringify(d)).toContain("kit_not_verified");
        // the code, recomputed with plain tools (openssl for the SPKI hash, python for the documented byte layout): what a verifier would print
        const pubf = path.join(path.dirname(kek), "pub.pem"); writeFileSync(pubf, signing.publicKey);
        const spki = execFileSync("sh", ["-c", `openssl pkey -pubin -in ${pubf} -outform DER | openssl dgst -sha256 -hex | awk '{print $NF}'`]).toString().trim();
        const py = `
import hashlib,glob,os,sys
m=open(sys.argv[1]).read().strip(); import base64; m=base64.b64decode(m)
keks=sorted((os.path.basename(f)[:-4],open(f,"rb").read()) for f in glob.glob(sys.argv[2]+"/*.key"))
h=hashlib.sha256(); h.update(b"portabase-fork-kit/v1\\0"+m+b"\\0")
for kid,k in keks: h.update(kid.encode()+b":"+k+b"\\0")
h.update(bytes.fromhex(sys.argv[3])); x=h.hexdigest()[:20].upper(); print("-".join(x[i:i+4] for i in range(0,20,4)))`;
        const code = execFileSync("python3", ["-c", py, MASTER_FILE, kek, spki]).toString().trim();
        expect(code).toBe(k.fingerprint);
        const bad = await confirmKitFingerprint(kd, {fingerprint: "0000-0000-0000-0000-0000", type: "paper"});
        expect(bad).toMatchObject({ok: false, code: "wrong_code"});
        const ok = await confirmKitFingerprint(kd, {fingerprint: code, type: "paper"});
        expect(ok).toMatchObject({ok: true});
        expect((await loadKitView(db)).state).toBe("verified");
        console.info("W14 LIVE kit verified via fingerprint entry (code recomputed with plain openssl+python; the offline verifier is W14b)");
        const canary = JSON.stringify(await q("select * from fork_audit_event where action like 'fork.kit.%' or action like 'fork.recovery_point.%'"));
        for (const secret of [master().toString("base64"), master().toString("hex"), PASS, signing.privateKey, k.fingerprint]) expect(canary).not.toContain(secret);
    }, 120_000);

    it("4. M2 / D43 TRUNCATED OBJECT (real agent object cut in MinIO): the next RP is rejected, ends `failed` with a plain reason, never `verified`, no manifest written", async () => {
        const d = runDeps();
        const runId = await startManual(d);
        await finish(d, runId);
        const rp = await latestRp();
        expect(rp.status).toBe("pending_verification");
        const a = (await arts(rp.id as string)).find((x) => x.archive_kind === "archive_enc") as Record<string, any>;
        const cs: Buffer[] = []; for await (const c of await minio.getObject(bucket, a.path_or_snapshot_id as string)) cs.push(c as Buffer);
        const full = Buffer.concat(cs);
        await minio.putObject(bucket, a.path_or_snapshot_id as string, full.subarray(0, full.length - 1000));
        console.info("W14 LIVE truncated object:", a.source_name, `${full.length} -> ${full.length - 1000} bytes`);
        const out = await verifyRecoveryPoint(verifyDeps(), rp.id as string);
        console.info("W14 LIVE truncated verify outcome:", JSON.stringify(out));
        expect(out).toMatchObject({outcome: "failed", reason: "verify_failed", code: "truncated"});
        const after = await latestRp();
        console.info("W14 LIVE truncated RP:", JSON.stringify({status: after.status, reason: after.downgrade_reason, verified_at: after.verified_at, report: after.verify_report}));
        expect(after).toMatchObject({status: "failed", downgrade_reason: "verify_failed", verified_at: null, manifest_sha256: null});
        const run = createResticRunner({repository: repoUrl(`backups/fork-manifest/${stackId}`), password: manifestRepoPassword(master(), stackId), env: s3env()});
        expect(await listManifestSnapshots(run, rp.id as string)).toEqual([]);
        expect((await q("select count(*)::int n from fork_recovery_point where status='verified'"))[0].n).toBe(1); // still only the first, honest one
        const back = await readManifestSnapshot(run, JSON.parse(JSON.stringify((await latestVerified()).manifest_refs))[0].snapshot_id);
        expect(back.json.length).toBeGreaterThan(100);
    }, 420_000);

    it("5. W14b / D41: the REAL offline verifier (`portabase-recover verify-kit`, digital + paper) opens the live MinIO repo and prints the code; wrong code refused; the code from the CLI verifies the kit and ONLY THEN `kit not verified` clears", async () => {
        resetRateLimits();
        const {spawnSync} = await import("node:child_process");
        const kek = path.join(mkdtempSync(path.join(os.tmpdir(), "w14b-kek-")), "fork-kek");
        const keys = {master: async () => master(), signing: async () => ({privateKeyPem: signing.privateKey, publicKeyPem: signing.publicKey})};
        const kd: KitDeps = {db, principal: principal(), keys, kekDir: kek, verifyPassword: async () => true, assertConfigAllowed: async () => undefined};
        const PASS = `Lab-pass-${Date.now()}-Zq9!`; // TEST-ONLY
        const b = await beginKitGeneration(kd, {types: ["paper", "digital"], password: "lab-throwaway"});
        if (!b.ok) throw new Error(`begin refused ${b.code}`);
        const paper = await generateKitArtifact(kd, {kind: "paper", token: b.tokens.paper});
        const digital = await generateKitArtifact(kd, {kind: "digital", token: b.tokens.digital, passphrase: PASS, passphraseConfirm: PASS});
        if (!paper.ok || paper.kind !== "paper" || !digital.ok || digital.kind !== "digital") throw new Error("kit generation failed");
        const [row] = await q("select status, fingerprint from fork_kit where superseded_at is null");
        expect(row.status).toBe("issued");
        // (the stack's PRIMARY state can legitimately be Failed here: test 4 left a failed RP and Failed outranks Kit-not-verified, §4.6; the kit gate itself is `isKitVerified`)
        expect(await isKitVerified(db)).toBe(false);
        expect((await loadKitView(db)).state).toBe("issued");
        // files for the CLI (lab results/ is git-ignored; the passphrase is TEST-ONLY)
        const dir = path.join(LAB_DIR, "results", "w14b"); mkdirSync(dir, {recursive: true, mode: 0o700});
        const kitFile = path.join(dir, "kit.pbkit"); writeFileSync(kitFile, digital.body, {mode: 0o600});
        const passFile = path.join(dir, "passphrase.txt"); writeFileSync(passFile, `${PASS}\n`, {mode: 0o600});
        const text = paper.body.replace(/<\/?(h1|h2|p|pre|ul|li|div|body|title)[^>]*>/g, "\n").replace(/<[^>]+>/g, "");
        const lines = text.split("\n").map((l) => l.trim()).filter((l) => /^(MASTER|KEK-k[0-9a-f]{12}) \d:|^[0-9a-f]{12} \((current|retired)\)/.test(l));
        const paperFile = path.join(dir, "paper-lines.txt"); writeFileSync(paperFile, `${lines.join("\n")}\n`, {mode: 0o600});
        const sc = spikeChannel as {accessKey: string; secretKey: string};
        const rcloneFile = path.join(dir, "rclone.conf");
        writeFileSync(rcloneFile, `[lab]\ntype = s3\nprovider = Other\naccess_key_id = ${sc.accessKey}\nsecret_access_key = ${sc.secretKey}\nendpoint = http://127.0.0.1:19000\nregion = us-east-1\nforce_path_style = true\nno_check_bucket = true\n`, {mode: 0o600});
        writeFileSync(path.join(dir, "info.json"), JSON.stringify({stackId, bucket, storageRoot: `lab:${bucket}`}), {mode: 0o600});
        const CLI = path.join(process.cwd(), "scripts/fork/recover/portabase-recover");
        const run = (kitArgs: string[]) => spawnSync("bash", [CLI, "verify-kit", ...kitArgs, "--rclone-config", rcloneFile, "--storage-root", `lab:${bucket}`, "--stack", stackId], {encoding: "utf8"});
        const t0 = Date.now();
        const rd = run(["--kit", kitFile, "--passphrase-file", passFile]);
        const dMs = Date.now() - t0;
        const rp = run(["--paper-file", paperFile]);
        console.info(`W14b LIVE verify-kit digital: exit ${rd.status} in ${dMs} ms; paper: exit ${rp.status}`);
        expect(rd.status, rd.stderr).toBe(0);
        expect(rp.status, rp.stderr).toBe(0);
        expect(rd.stdout).toContain("repository opened");
        const grab = (o: string) => o.match(/Verification code[^:]*: ([0-9A-F]{4}(?:-[0-9A-F]{4}){4})/)?.[1] ?? "";
        const codeD = grab(rd.stdout); const codeP = grab(rp.stdout);
        expect(codeD).toBe(codeP);
        expect(codeD).toBe(row.fingerprint);
        console.info("W14b LIVE both kit types print the stored verification code (value not logged here beyond equality)");
        for (const secret of [master().toString("base64"), master().toString("hex"), PASS]) expect(rd.stdout + rd.stderr + rp.stdout + rp.stderr).not.toContain(secret);
        const wrong = await confirmKitFingerprint(kd, {fingerprint: "0000-0000-0000-0000-0000", type: "paper"});
        expect(wrong).toMatchObject({ok: false, code: "wrong_code"});
        expect(await isKitVerified(db)).toBe(false); // a wrong code verifies nothing
        expect((await loadKitView(db)).state).toBe("issued");
        expect(await confirmKitFingerprint(kd, {fingerprint: codeP, type: "paper"})).toMatchObject({ok: true});
        expect((await loadKitView(db)).state).toBe("verified");
        expect(await isKitVerified(db)).toBe(true);
        console.info("W14b LIVE kit not verified -> verified ONLY after the CLI-printed code was entered (wrong code refused first)");
    }, 180_000);

    const latestVerified = async () => (await q("select * from fork_recovery_point where stack_id=$1 and status='verified' order by sequence desc limit 1", [stackId]))[0];

});
