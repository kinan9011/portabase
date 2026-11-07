import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {ENV_MINIMUM} from "@/fork/arcane/endpoints";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import type {ForkDb} from "@/fork/db/handle";
import {runForkMigrations} from "@/fork/db/migrate";
import {syncConnection} from "@/fork/discovery/sync";
import {materializeStack, type MaterializeDeps} from "@/fork/materialize/apply";
import {driftStack} from "@/fork/materialize/drift";
import {parseAllowlist} from "@/fork/net/guard";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {parseStackListParams} from "@/fork/stacks/params";
import {loadStackDetail, loadStackList} from "@/fork/stacks/queries";

/**
 * LIVE W10 test (FORK_LAB=1, loopback/docker-bridge lab ONLY): the real fork code materialises the REAL discovery of the demo stack into the LAB
 * dashboard's database (upstream 1.35.2 image + the unchanged 1.25.2 agent polling it), then proves: the generated sources match the W02 spike
 * shapes, they ping OK through the real agent, apply is idempotent, an inventory change is flagged, a cron/retention set on the stack Project is
 * reverted, SEC-24 refusals, and the per-agent "poll failing" blocker with the real agent.
 *
 * Needs (see dev/fork-lab/README.md + the W10 handoff): `lab.sh up`, demo stack `db web`, agent recreated with
 * `lab.sh agent attach-demo-net host-bind w10-real-paths`, a lab-only DB role `w10lab` (created through `docker exec … psql`), and
 *   W10_LAB_DATABASE_URL=postgres://w10lab:<pw>@<lab-db-container-ip>:5432/portabase   W10_LAB_DIR=<abs path of dev/fork-lab>
 * The lab master key is root-only in a docker volume and is deliberately NOT extracted: the DB credential is encrypted with a throw-away key
 * here (its upstream round trip is pinned by w10-upstream-contract) and replaced by the bootstrap-encrypted envelope of the W02 spike source so
 * the real agent can use it.
 */
const LAB = process.env.FORK_LAB === "1" && !!process.env.W10_LAB_DATABASE_URL;
const URL_ = process.env.ARCANE_URL ?? "http://127.0.0.1:13552";
const ADMIN_USER = process.env.LAB_ARCANE_ADMIN_USER ?? "arcane";
const ADMIN_PASS = process.env.LAB_ARCANE_ADMIN_PASSWORD ?? "arcane-admin";
const LAB_DIR = process.env.W10_LAB_DIR ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pool: Pool; let db: ForkDb; let org = ""; let agentId = ""; let token = ""; let keyId = ""; let conn = ""; let envId = ""; let stackId = ""; let channel = ""; let kekDir = "";
const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows as Record<string, unknown>[];
const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${URL_}/api${p}`, {method, headers: {"content-type": "application/json", authorization: `Bearer ${token}`}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, json: (await r.json().catch(() => ({}))) as {data?: {id?: string; key?: string}}};
};
const principal = (): ForkPrincipal => ({userId: "00000000-0000-4000-8000-0000000000aa", systemRole: "admin", memberships: [{organizationId: org, role: "owner"}]});
const deps = (): MaterializeDeps => ({db, principal: principal(), masterKey: async () => randomBytes(32), assertConfigAllowed: async () => undefined, rate: () => ({ok: true})});
const sync = () => syncConnection({db, kekDir, allowlist: parseAllowlist("127.0.0.1")}, conn, "manual", {userId: null});
const tick = () => driftStack({db}, stackId);
const detail = async () => {
    const d = (await loadStackDetail(db, org, stackId))!;
    if (d.inventory.state !== "ok") throw new Error("inventory not ok");
    return d.inventory;
};
const docker = (...a: string[]) => execFileSync("docker", a, {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const agentLog = (since: string) => execFileSync("docker", ["logs", "forklab-agent", "--since", since], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024}).replace(ANSI, "");
const waitLog = async (since: string, needle: RegExp, ms = 45_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const l = agentLog(since).split("\n").filter((x) => needle.test(x)); if (l.length) return l; await sleep(3000); }
    return [];
};
const SELECTION = () => ({
    includeKeys: [] as string[], excludeKeys: [] as string[],
    databases: {db: {kind: "dump" as const, host: "demo-db", port: 5432, username: "demo", database: "demo"}},
    manual: [{path: path.join(LAB_DIR, "demo-stack"), covers: ["env:undetermined"]}],
});
const mem = async () => q(`select d.id, d.name, d.dbms, d.backup_engine, d.config, d.backup_policy, l.resource_key, l.status, l.last_probe, l.role
    from fork_stack_source l left join databases d on d.id = l.database_id where l.stack_id=$1 order by l.resource_key`, [stackId]);

describe.skipIf(!LAB)("W10 live: materialize the demo stack through the real agent", () => {
    beforeAll(async () => {
        expect(["127.0.0.1", "localhost"]).toContain(new globalThis.URL(URL_).hostname);
        pool = new Pool({connectionString: process.env.W10_LAB_DATABASE_URL, options: "-c TimeZone=UTC0", max: 4});
        db = drizzle({client: pool}) as unknown as ForkDb;
        const lane = await runForkMigrations({databaseUrl: process.env.W10_LAB_DATABASE_URL, env: {NODE_ENV: "development"}});
        if (lane.state !== "applied") throw new Error(`lane ${lane.state} ${lane.detail ?? ""}`);
        org = (await q("select id from organization where slug='default'"))[0].id as string;
        agentId = (await q("select id from agents where slug='lab-agent'"))[0].id as string;
        channel = (await q("select id from storage_channel where name='lab-minio'"))[0].id as string;
        for (let i = 0; i < 2 && !token; i++) {
            const r = await fetch(`${URL_}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({username: ADMIN_USER, password: ADMIN_PASS})});
            if (r.status === 429) { await sleep((Number(r.headers.get("retry-after")) || 60) * 1000); continue; }
            token = ((await r.json()) as {data?: {token?: string}}).data?.token ?? "";
        }
        if (!token) throw new Error("lab Arcane admin login failed");
        const old = await api("GET", "/api-keys?limit=200");
        for (const k of (old.json.data as unknown as {id: string; name: string}[]) ?? []) if (k.name?.startsWith("forklab-w10-")) await api("DELETE", `/api-keys/${k.id}`);
        const perms = [{permission: "environments:list"}, ...ENV_MINIMUM.map((permission) => ({permission, environmentId: "0"}))];
        const m = await api("POST", "/api-keys", {name: "forklab-w10-view", description: "W10 live test, lab only", permissions: perms});
        if (m.status !== 200 || !m.json.data?.key) throw new Error(`key mint failed (${m.status})`);
        keyId = m.json.data.id as string;
        kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w10l-kek-")), "fork-kek");
        conn = (await insertConnectionWithSecret(db, {organizationId: org, name: "w10-lab-arcane", baseUrl: URL_, apiKey: m.json.data.key}, kekDir)).id;
        envId = (await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled, agent_id, agent_name, allowed_path_roots) values ($1,'0','local',true,$2,'lab-agent',$3) returning id", [conn, agentId, [LAB_DIR]]))[0].id as string;
        const r = await sync();
        expect(r.kind).toBe("ran");
        if (r.kind === "ran") expect(r.run.status, JSON.stringify(r.run.environments)).toBe("ok");
        const list = await loadStackList(db, org, parseStackListParams({q: "forklab-demo"}));
        stackId = list.items.find((i) => i.composeProject === "forklab-demo")?.id ?? "";
        expect(stackId, `listed: ${list.items.map((i) => i.composeProject)}`).not.toBe("");
    }, 300_000);

    afterAll(async () => {
        try {
            if (keyId) await api("DELETE", `/api-keys/${keyId}`).catch(() => undefined);
            if (pool) {
                await q("delete from databases where project_id in (select id from projects where name like 'stack:%')").catch(() => undefined);
                await q("delete from storage_policy where project_id in (select id from projects where name like 'stack:%')").catch(() => undefined);
                await q("delete from retention_policies where project_id in (select id from projects where name like 'stack:%')").catch(() => undefined);
                await q("update fork_stack set project_id = null").catch(() => undefined);
                await q("delete from projects where name like 'stack:%'").catch(() => undefined);
                await q("delete from fork_stack_policy").catch(() => undefined);
                await q("delete from fork_stack_source").catch(() => undefined);
                await q("delete from fork_stack").catch(() => undefined);
                await q("delete from fork_arcane_environment").catch(() => undefined);
                await q("delete from fork_arcane_connection").catch(() => undefined);
            }
        } finally {
            await pool?.end();
        }
    });

    it("1. materialises the demo stack: compose dir, env, binds, named volume, database — as ORDINARY sources shaped like the W02 spike", async () => {
        resetRateLimits();
        const inv0 = await detail();
        const hasWebDb = inv0.configuration.items.some((i) => i.key === "db:web");
        const sel = SELECTION();
        if (hasWebDb) sel.excludeKeys.push("db:web"); // `web` runs a postgres image as a tool (W09 finding)
        const uploads = inv0.configuration.items.find((i) => i.kind === "bind" && i.name.endsWith("/demo-stack/uploads"));
        if (uploads) sel.includeKeys.push(uploads.key); // own source, like the spike's demo-uploads
        // Docker evidence: the W02 spike docker-volume source must have reported contact through the real agent
        let r = await materializeStack(deps(), {stackId, selection: sel, secrets: {db: "demo-synthetic-not-a-secret"}, storageChannelIds: [channel]});
        for (let i = 0; i < 20 && r.ok && r.deferred.length; i++) { await sleep(5000); r = await materializeStack(deps(), {stackId, selection: sel, secrets: {db: "demo-synthetic-not-a-secret"}, storageChannelIds: [channel]}); }
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (!r.ok) return;
        console.info("W10 LIVE materialize:", JSON.stringify({created: r.created, updated: r.updated, unchanged: r.unchanged, deferred: r.deferred, skipped: r.skipped}));
        expect(r.deferred, "docker-volume members need agent Docker evidence").toEqual([]);

        // the DB credential: replace the throw-away-key envelope by the bootstrap-encrypted one of the spike source (real master key, never extracted)
        const spike = (await q("select config from databases where name='demo-postgres' and deleted_at is null"))[0].config as {password: unknown};
        await q(`update databases set config = jsonb_set(config, '{password}', $1::jsonb) where id = (select database_id from fork_stack_source where stack_id=$2 and role='db')`, [JSON.stringify(spike.password), stackId]);

        const rows = await mem();
        const byRole = (role: string) => rows.filter((x) => x.role === role);
        const spikeRows = Object.fromEntries((await q("select name, dbms, backup_engine, config, backup_policy from databases where name like 'demo-%' and deleted_at is null")).map((x) => [x.name as string, x]));
        const wd = path.join(LAB_DIR, "demo-stack");
        // compose dir: files / restic / {path} (spike: demo-compose-snapshot at the mounted path)
        expect(byRole("compose")[0]).toMatchObject({dbms: "files", backup_engine: "restic", config: {path: wd}, backup_policy: null});
        expect(spikeRows["demo-compose-snapshot"]).toMatchObject({dbms: "files", backup_engine: "restic"});
        // bind (uploads): files / archive / {path}
        const up = byRole("bind").find((x) => (x.config as {path: string}).path === path.join(wd, "uploads"));
        expect(up).toMatchObject({dbms: "files", backup_engine: "archive", backup_policy: null});
        expect(spikeRows["demo-uploads"]).toMatchObject({dbms: "files", backup_engine: "archive"});
        // named volume: docker-volume / archive / {volume_name} (spike: demo-appdata-volume)
        const vol = byRole("volume").find((x) => (x.config as {volume_name: string}).volume_name === "forklab-demo_appdata");
        expect(vol).toMatchObject({dbms: "docker-volume", backup_engine: "archive", config: {volume_name: "forklab-demo_appdata"}, backup_policy: null});
        expect(spikeRows["demo-appdata-volume"]).toMatchObject({dbms: "docker-volume", backup_engine: "archive", config: {volume_name: "forklab-demo_appdata"}});
        // database: postgresql / archive / same non-secret fields as the spike's demo-postgres; credential is an encrypted envelope
        const pg = byRole("db")[0];
        const sp = spikeRows["demo-postgres"].config as Record<string, unknown>;
        expect(pg).toMatchObject({dbms: "postgresql", backup_engine: "archive", backup_policy: null});
        expect({...(pg.config as object), password: undefined}).toEqual({host: sp.host, port: sp.port, database: sp.database, username: sp.username, password: undefined});
        // nothing carries a cron / container_name, and the stack Project has no policy (D30/D33)
        for (const x of rows) { expect(x.backup_policy).toBeNull(); expect(JSON.stringify(x.config)).not.toContain("container_name"); }
        const proj = (await q("select p.* from projects p join fork_stack s on s.project_id=p.id where s.id=$1", [stackId]))[0];
        expect(proj.name).toBe("stack:local/forklab-demo");
        expect(proj.backup_policy).toBeNull();
        expect((await q("select count(*)::int n from retention_policies where project_id=$1", [proj.id]))[0].n).toBe(0);
        expect((await q("select storage_channel_id from storage_policy where project_id=$1", [proj.id])).map((x) => x.storage_channel_id)).toEqual([channel]);
    }, 240_000);

    it("2. the REAL agent pings them: probes turn `readable`; the W09 views show the materialised resources as captured", async () => {
        let probed = 0;
        for (let i = 0; i < 24; i++) { probed += (await tick()).probed; const left = (await mem()).filter((x) => x.last_probe !== "readable"); if (!left.length) break; await sleep(5000); }
        const rows = await mem();
        console.info("W10 LIVE probes:", JSON.stringify(rows.map((x) => [x.role, x.status, x.last_probe])));
        expect(rows.filter((x) => x.role !== "env" ).every((x) => x.last_probe === "readable"), JSON.stringify(rows.map((x) => [x.resource_key, x.status, x.last_probe]))).toBe(true);
        const inv = await detail();
        const st = (key: string) => inv.configuration.items.find((i) => i.key === key);
        console.info("W10 LIVE items:", JSON.stringify(inv.configuration.items.map((i) => [i.kind, i.name.slice(-40), i.status, i.reason])));
        expect(inv.configuration.items.filter((i) => i.kind === "compose_file").every((i) => i.status === "captured")).toBe(true);
        expect(st("env:implicit")).toMatchObject({status: "captured"});
        expect(st("env:undetermined")).toMatchObject({status: "captured", reason: "captured_manual"}); // D19 manual source
        expect(inv.configuration.items.find((i) => i.kind === "volume" && i.name === "forklab-demo_appdata")).toMatchObject({status: "captured"});
        expect(inv.configuration.items.find((i) => i.kind === "volume" && i.name === "forklab-demo_pgdata")).toMatchObject({status: "captured"}); // covered by the dump
        expect(inv.configuration.items.find((i) => i.key === "db:db")).toMatchObject({status: "captured", consistency: "engine_dump"});
        expect(inv.configuration.items.filter((i) => i.kind === "bind").every((i) => i.status === "captured")).toBe(true);
        // honest: still NOT Protected (no active policy, no recovery point, kit unverified) and the anonymous volume of `web` is still a gap
        expect(inv.protection.primary).toBe("unprotected");
        expect(inv.configuration.sources.length).toBe(rows.length);
        expect(probed).toBeGreaterThan(0);
    }, 240_000);

    it("3. IDEMPOTENT: applying the same selection again changes nothing in the lab dashboard database", async () => {
        resetRateLimits();
        const before = {m: await mem(), d: (await q("select count(*)::int n from databases"))[0].n, p: (await q("select count(*)::int n from projects"))[0].n};
        const sel = SELECTION();
        if ((await detail()).configuration.items.some((i) => i.key === "db:web")) sel.excludeKeys.push("db:web");
        const uploads = (await detail()).configuration.items.find((i) => i.kind === "bind" && i.name.endsWith("/demo-stack/uploads"));
        if (uploads) sel.includeKeys.push(uploads.key);
        const r = await materializeStack(deps(), {stackId, selection: sel, storageChannelIds: [channel]});
        expect(r).toMatchObject({ok: true, created: 0, updated: 0, noop: true});
        expect((await mem()).map((x) => x.id)).toEqual(before.m.map((x) => x.id));
        expect((await q("select count(*)::int n from databases"))[0].n).toBe(before.d);
        expect((await q("select count(*)::int n from projects"))[0].n).toBe(before.p);
    }, 60_000);

    it("4. a REAL inventory change (a new compose-labelled volume appears on the host) is flagged, and clears when it is gone", async () => {
        const name = "forklab-demo_w10extra";
        docker("volume", "create", "--label", "com.docker.compose.project=forklab-demo", "--label", "com.docker.compose.volume=w10extra", name);
        try {
            await sync();
            await tick();
            expect((await q("select materialize_state s from fork_stack_policy where stack_id=$1", [stackId]))[0].s).toBe("inventory_changed");
            const inv = await detail();
            expect(inv.configuration.items.find((i) => i.name === name)).toMatchObject({status: "missing", gap: true});
            expect(inv.protection.complete).toBe(false);
        } finally {
            docker("volume", "rm", "-f", name);
        }
        await sync();
        await tick();
        expect((await q("select materialize_state s from fork_stack_policy where stack_id=$1", [stackId]))[0].s).toBe("ready");
    }, 120_000);

    it("5. D30: a cron and retention set on the `stack:` Project (as the upstream UI writes them) are reverted within ONE tick, and the REAL agent drops the schedule (cron = null)", async () => {
        const proj = (await q("select project_id p from fork_stack where id=$1", [stackId]))[0].p as string;
        const member = (await mem())[0];
        const agentDbId = (await q("select agent_database_id a from databases where id=$1", [member.id]))[0].a as string;
        const t0 = new Date().toISOString();
        await q("update projects set backup_policy='7 3 * * *' where id=$1", [proj]);
        await q("insert into retention_policies (project_id, type) values ($1,'count')", [proj]);
        await q("update databases set backup_policy='*/10 * * * *' where id=$1", [member.id]);
        await q("insert into retention_policies (database_id, type) values ($1,'days')", [member.id]);
        // the REAL agent first receives the schedule (it logs the cron it scheduled for every source that resolves to one)
        const got = await waitLog(t0, /Task cron normalized: unix "(\*\/10 \* \* \* \*|7 3 \* \* \*)"/);
        console.info("W10 LIVE agent received cron:", JSON.stringify(got.slice(0, 2).map((x) => x.slice(0, 120))));
        expect(got.length, "agent never received the cron").toBeGreaterThan(0);
        const t1 = new Date().toISOString();
        const s = await tick(); // ONE tick
        expect(s.reverted).toBe(1);
        expect((await q("select backup_policy from projects where id=$1", [proj]))[0].backup_policy).toBeNull();
        expect((await q("select count(*)::int n from databases where project_id=$1 and backup_policy is not null", [proj]))[0].n).toBe(0);
        expect((await q("select count(*)::int n from retention_policies where project_id=$1 or database_id in (select id from databases where project_id=$1)", [proj]))[0].n).toBe(0);
        // …and the agent now gets cron = null: it removes the periodic task of that source
        const gone = await waitLog(t1, new RegExp(`Task periodic\\.backup_${agentDbId} removed`));
        console.info("W10 LIVE agent dropped schedule:", JSON.stringify(gone.slice(0, 2).map((x) => x.slice(0, 120))));
        expect(gone.length, "agent kept the schedule").toBeGreaterThan(0);
        const aud = await q("select action, redacted_details d from fork_audit_event where action like 'fork.materialize.drift.%' order by seq desc limit 2");
        console.info("W10 LIVE audit:", JSON.stringify(aud));
        expect(aud.map((a) => a.action).sort()).toEqual(["fork.materialize.drift.reverted", "fork.materialize.drift.seen"]);
    }, 180_000);

    it("6. SEC-24: a volume named /tmp/x never becomes a source; an edited live member (volume_name=/tmp/x, container_name set) is a BLOCKER; manual /tmp/x is refused", async () => {
        const row = (await q("select id, inventory from fork_stack_inventory where stack_id=$1 order by version desc limit 1", [stackId]))[0];
        const inv = structuredClone(row.inventory as {volumes: {name: string; driver: string; in_use_by: string[]; ownership: string}[]});
        inv.volumes.push({name: "/tmp/x", driver: "local", in_use_by: ["web"], ownership: "stack_owned"});
        const ver = ((await q("select max(version)::int v from fork_stack_inventory where stack_id=$1", [stackId]))[0].v as number) + 1;
        await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,$2,$3,$4)", [stackId, ver, randomBytes(32).toString("hex"), JSON.stringify(inv)]);
        resetRateLimits();
        const sel = SELECTION(); sel.manual.push({path: "/tmp/x", covers: ["env:undetermined"]});
        if ((await detail()).configuration.items.some((i) => i.key === "db:web")) sel.excludeKeys.push("db:web");
        const r = await materializeStack(deps(), {stackId, selection: sel, storageChannelIds: [channel]});
        expect(r.ok && r.skipped.map((s) => `${s.key}:${s.reason}`)).toEqual(expect.arrayContaining(["volume:/tmp/x:volume_name_invalid", "manual:/tmp/x:manual_invalid"]));
        expect((await q("select count(*)::int n from databases where config::text like '%/tmp/x%'"))[0].n).toBe(0);
        // an operator editing a live docker-volume member in the upstream UI
        const vol = (await mem()).find((x) => x.role === "volume")!;
        await q(`update databases set config='{"volume_name":"/tmp/x","container_name":"forklab-agent"}'::jsonb where id=$1`, [vol.id]);
        await tick();
        expect((await mem()).find((x) => x.role === "volume")).toMatchObject({status: "drifted"});
        expect((await detail()).configuration.sources.find((s) => s.role === "volume")).toMatchObject({status: "drifted", reason: "unsafe_volume"});
        // put it back: the blocker clears by itself
        await q(`update databases set config='{"volume_name":"forklab-demo_appdata"}'::jsonb where id=$1`, [vol.id]);
        await tick();
        expect((await mem()).find((x) => x.role === "volume")).toMatchObject({status: "active"});
    }, 120_000);

    it("7. P-2 / CH-22c with the REAL agent: without Docker socket access the agent stops reporting → ONE 'Agent poll failing' blocker for the agent; restoring the socket clears it", async () => {
        const labDir = path.join(LAB_DIR);
        const agentCmd = (...v: string[]) => execFileSync("bash", [path.join(labDir, "lab.sh"), "agent", ...v], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
        try {
            agentCmd("attach-demo-net", "host-bind", "w10-real-paths", "no-docker-sock");
            // the agent poll is blocked by the docker-volume ping Err: wait until the agent has been silent for longer than AGENT_FRESH_MS (120 s)
            let issue: {name: string; consumers?: unknown} | undefined;
            for (let i = 0; i < 40 && !issue; i++) {
                await sleep(10_000);
                const d = await detail();
                issue = d.configuration.items.find((x) => x.reason === "agent_poll_failing") as typeof issue;
            }
            const inv = await detail();
            const polls = inv.configuration.items.filter((x) => x.reason === "agent_poll_failing");
            console.info("W10 LIVE poll guard:", JSON.stringify(polls.map((p) => [p.kind, p.name, p.severity, p.status])));
            expect(polls).toHaveLength(1);
            expect(polls[0]).toMatchObject({kind: "agent", severity: "blocker", status: "inaccessible", gap: true});
            expect(polls[0].name).toContain("forklab-demo_appdata");
            expect(inv.protection.complete).toBe(false);
        } finally {
            agentCmd("attach-demo-net", "host-bind", "w10-real-paths");
        }
        for (let i = 0; i < 24; i++) {
            await sleep(5000);
            if (!(await detail()).configuration.items.some((x) => x.reason === "agent_poll_failing")) break;
        }
        expect((await detail()).configuration.items.some((x) => x.reason === "agent_poll_failing")).toBe(false);
    }, 420_000);
});
