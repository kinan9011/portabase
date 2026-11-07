import {execFileSync} from "node:child_process";
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
import {tickAllRuns, tickRun} from "@/fork/runs/service";
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
    if (!out) { const probe = await fetch(url).catch((e) => ({status: -1, headers: new Headers(), err: String(e)})); console.info("W12 LIVE hash null:", JSON.stringify({path: s.path, size: s.size, status: probe.status, len: probe.headers.get("content-length")})); }
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

describe.skipIf(!LAB)("W12 live: scheduled grouped backup of the demo stack through the real agent, MinIO and Arcane", () => {
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
        for (const k of (old.json.data as unknown as {id: string; name: string}[]) ?? []) if (k.name?.startsWith("forklab-w12-")) await api("DELETE", `/api-keys/${k.id}`);
        const perms = [{permission: "environments:list"}, ...ENV_MINIMUM.map((permission) => ({permission, environmentId: "0"}))];
        const m = await api("POST", "/api-keys", {name: "forklab-w12-view", description: "W12 live test, lab only", permissions: perms});
        if (m.status !== 200 || !m.json.data?.key) throw new Error(`key mint failed (${m.status})`);
        keyId = m.json.data.id as string;
        kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w12l-kek-")), "fork-kek");
        conn = (await insertConnectionWithSecret(db, {organizationId: org, name: "w12-lab-arcane", baseUrl: URL_, apiKey: m.json.data.key}, kekDir)).id;
        await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled, agent_id, agent_name, allowed_path_roots) values ($1,'0','local',true,$2,'lab-agent',$3)", [conn, agentId, [LAB_DIR]]);
        const r = await syncConnection({db, kekDir, allowlist: parseAllowlist("127.0.0.1")}, conn, "manual", {userId: null});
        expect(r.kind).toBe("ran");
        const list = await loadStackList(db, org, parseStackListParams({q: "forklab-demo"}));
        stackId = list.items.find((i) => i.composeProject === "forklab-demo")?.id ?? "";
        expect(stackId, `listed: ${list.items.map((i) => i.composeProject)}`).not.toBe("");
        spikePassword = ((await q("select config from databases where name='demo-postgres' and deleted_at is null"))[0].config as {password: unknown}).password;
    }, 300_000);

    afterAll(async () => {
        for (const c of ["forklab-arcane", "forklab-agent", "forklab-portabase-minio-1"]) { try { docker("start", c); } catch { /* already running */ } }
        try {
            if (keyId) await api("DELETE", `/api-keys/${keyId}`).catch(() => undefined);
            if (pool) {
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
        const keys = gaps.state === "ok" ? gaps.configuration.items.filter((i) => i.gap).map((i) => i.key) : [];
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

    it("2. UX-09: Arcane DOWN during a run ⇒ the run proceeds on the last inventory, says so, and the stack shows the stale marker", async () => {
        docker("stop", "forklab-arcane");
        try {
            const d = runDeps();
            const id = await startManual(d);
            await finish(d, id);
            const [r] = await q("select state, inventory_refresh, inventory_version from fork_stack_run where id=$1", [id]);
            expect(r.inventory_refresh).toBe("failed");
            expect(r.state).toBe("succeeded");
            const det = await detail();
            expect(det.staleSince).not.toBeNull();
            if (det.inventory.state === "ok") expect(det.inventory.protection.facets.inventoryStale).toBe(true);
            expect((await latestRp()).status).toBe("pending_verification");
        } finally {
            docker("start", "forklab-arcane");
        }
        for (let i = 0; i < 30; i++) { try { if ((await fetch(`${URL_}/api/version`)).ok) break; } catch { /* starting */ } await sleep(2000); }
    }, 420_000);

    it("3. a member FAILS for real (its path does not exist for the agent) ⇒ INCOMPLETE RP of the other members, run incomplete, alert queued", async () => {
        const bind = (await q("select l.database_id id, d.config from fork_stack_source l join databases d on d.id=l.database_id where l.stack_id=$1 and l.role='bind' order by l.resource_key limit 1", [stackId]))[0];
        await q("update databases set config = jsonb_set(config, '{path}', '\"/nonexistent-w12-path\"') where id=$1", [bind.id]);
        try {
            const d = runDeps();
            const id = await startManual(d);
            await finish(d, id);
            const [r] = await q("select state, reason from fork_stack_run where id=$1", [id]);
            const rp = await latestRp();
            console.info("W12 LIVE member-fail:", JSON.stringify({run: r, rp: [rp.status, rp.downgrade_reason, rp.required_artifact_count, rp.present_artifact_count]}));
            expect(r).toMatchObject({state: "incomplete", reason: "member_failed"});
            expect(rp).toMatchObject({status: "incomplete", downgrade_reason: "member_failed"});
            expect(Number(rp.present_artifact_count)).toBeLessThan(Number(rp.required_artifact_count));
            expect(Number(rp.present_artifact_count)).toBeGreaterThan(0);
            expect((await q("select 1 from fork_notification_outbox where dedupe_key=$1", [`run.incomplete:${id}`])).length).toBe(1);
        } finally {
            await q("update databases set config=$2::jsonb where id=$1", [bind.id, JSON.stringify(bind.config)]);
        }
    }, 420_000);

    it("4. EXIT 7 (EU-04): the validator blocks (a member probe reads unreadable, the write the W10 drift job makes) ⇒ the run still captures everything readable ⇒ INCOMPLETE RP, event queued", async () => {
        await q("update fork_stack_source set last_probe='unreadable', last_probe_at=now() where stack_id=$1 and role='bind'", [stackId]);
        const bind = (await q("select 1 from fork_stack_source where stack_id=$1 and role='bind'", [stackId])).length;
        const d = runDeps();
        const id = await startManual(d);
        await finish(d, id);
        const [r] = await q("select state, validator_blocked from fork_stack_run where id=$1", [id]);
        const rp = await latestRp();
        console.info("W12 LIVE validator-blocked:", JSON.stringify({bindMembers: bind, run: r, rp: [rp.status, rp.downgrade_reason, rp.required_artifact_count, rp.present_artifact_count]}));
        if (bind > 0) {
            expect(r).toMatchObject({state: "incomplete", validator_blocked: true});
            expect(rp).toMatchObject({status: "incomplete", downgrade_reason: "validator_blocked"});
            expect(Number(rp.present_artifact_count)).toBe(Number(rp.required_artifact_count)); // everything readable WAS captured
            expect((await q("select 1 from fork_notification_outbox where dedupe_key=$1", [`run.blocked:${id}`])).length).toBe(1);
        }
        await q("update fork_stack_source set last_probe='readable', last_probe_at=now() where stack_id=$1", [stackId]);
    }, 420_000);

    it("5. EXIT 9: the agent is DOWN ⇒ the waiting rows time out: run FAILED 'agent_did_not_start', rows cancelled, no pending/verified RP for that run", async () => {
        docker("stop", "forklab-agent");
        try {
            const d = runDeps({}, {waitTimeoutMs: 25_000});
            const id = await startManual(d);
            await finish(d, id, 120_000);
            const [r] = await q("select state, reason from fork_stack_run where id=$1", [id]);
            expect(r).toMatchObject({state: "failed", reason: "agent_did_not_start"});
            const [rp] = await q("select status, downgrade_reason from fork_recovery_point where run_id=$1", [id]);
            expect(rp).toMatchObject({status: "failed", downgrade_reason: "member_timeout"});
            const left = await q("select b.status, b.deleted_at from backups b join fork_stack_run_item i on i.backup_id=b.id where i.run_id=$1", [id]);
            expect(left.every((b) => b.status === "failed" && b.deleted_at !== null)).toBe(true);
        } finally {
            docker("start", "forklab-agent");
        }
        await sleep(10_000);
    }, 300_000);

    it("6. EXIT 9 (held lock): the agent bails and leaves the row `ongoing` ⇒ no progress ⇒ FAILED 'agent_made_no_progress' (simulated at its observable end state)", async () => {
        const d = runDeps({}, {stallTimeoutMs: 25_000});
        const id = await startManual(d);
        await tickRun(d, id); // refresh, validate, trigger
        await q("update backups set status='ongoing', updated_at=(now() at time zone 'utc') where id in (select backup_id from fork_stack_run_item where run_id=$1)", [id]); // the agent will never touch these
        await finish(d, id, 120_000);
        const [r] = await q("select state, reason from fork_stack_run where id=$1", [id]);
        expect(r).toMatchObject({state: "failed", reason: "agent_made_no_progress"});
        expect((await q("select status from fork_recovery_point where run_id=$1", [id]))[0].status).toBe("failed");
        await q("update backups set status='failed', deleted_at=now() where id in (select backup_id from fork_stack_run_item where run_id=$1)", [id]);
    }, 240_000);

    it("7. storage DOWN mid-run (MinIO stopped after the agent started) ⇒ no RP claims success", async () => {
        const d = runDeps({}, {stallTimeoutMs: 40_000, waitTimeoutMs: 60_000});
        const id = await startManual(d);
        for (let i = 0; i < 20; i++) { await tickRun(d, id); if ((await q("select 1 from fork_stack_run_item i join backups b on b.id=i.backup_id where i.run_id=$1 and b.status='ongoing'", [id])).length) break; await sleep(2000); }
        docker("stop", "forklab-portabase-minio-1");
        try {
            await finish(d, id, 200_000);
        } finally {
            docker("start", "forklab-portabase-minio-1");
        }
        const [r] = await q("select state, reason from fork_stack_run where id=$1", [id]);
        const [rp] = await q("select status, downgrade_reason from fork_recovery_point where run_id=$1", [id]);
        console.info("W12 LIVE storage-down:", JSON.stringify({run: r, rp}));
        expect(rp.status).not.toBe("pending_verification");
        expect(rp.status).not.toBe("verified");
        expect(r.state).not.toBe("succeeded");
        await sleep(8000);
    }, 360_000);

    it("8. EXIT 6 (F7): the activating administrator loses their rights ⇒ the next run PAUSES the policy, audits, queues the alert, creates no run; restoring rights alone does not resume", async () => {
        await resetRuns();
        await q("update \"user\" set role='user' where id=$1", [userId]);
        await q("update member set role='member' where user_id=$1 and organization_id=$2", [userId, org]);
        const d = runDeps();
        const before = (await q("select count(*)::int n from fork_stack_run where stack_id=$1", [stackId]))[0].n;
        const r = await startRun(d, {stackId, trigger: "manual", userId});
        expect(r).toMatchObject({kind: "refused", code: "reauth_failed", reason: "capability_lost"});
        expect((await q("select count(*)::int n from fork_stack_run where stack_id=$1", [stackId]))[0].n).toBe(before);
        expect((await q("select protection_state from fork_stack where id=$1", [stackId]))[0].protection_state).toBe("paused");
        expect((await q("select 1 from fork_notification_outbox where kind='run.policy_paused'")).length).toBeGreaterThanOrEqual(1);
        const det = await detail();
        expect(det.inventory.state === "ok" && det.inventory.protection.facets.pausedAfterReauthorization).toBe(true);
        await q("update \"user\" set role='admin' where id=$1", [userId]);
        await q("update member set role='owner' where user_id=$1 and organization_id=$2", [userId, org]);
        expect(await startRun(d, {stackId, trigger: "manual", userId})).toEqual({kind: "refused", code: "paused"});
        await q("update fork_stack_policy set paused_at=null, pause_reason=null where stack_id=$1", [stackId]);
        await q("update fork_stack set protection_state='active' where id=$1", [stackId]);
    }, 120_000);

    it("9. the whole lab dashboard-side state stayed honest: no `verified` RP anywhere, no member with a cron or retention (D33/D30)", async () => {
        expect((await q("select count(*)::int n from fork_recovery_point where status='verified'"))[0].n).toBe(0);
        const rows = await q("select d.backup_policy from databases d join fork_stack_source l on l.database_id=d.id where l.stack_id=$1", [stackId]);
        expect(rows.every((x) => x.backup_policy === null)).toBe(true);
        expect(await tickAllRuns(runDeps())).toBeDefined();
    }, 60_000);
});
