import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {Pool} from "pg";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {RAW} from "@/fork/__tests__/discovered-fixtures";
import {type FakeArcane, MIN_PERMS, startFakeArcane } from "@/fork/__tests__/fake-arcane";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import type {ForkPrincipal} from "@/fork/acl";
import type {ServiceDeps} from "@/fork/arcane/connection-service";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import type {ForkDb} from "@/fork/db/handle";
import {type SyncDeps, type SyncResult, type SyncRun, syncConnection, syncNow } from "@/fork/discovery/sync";
import {BREAKER, circuitOpenMs, leaseName, listDueConnections} from "@/fork/discovery/sync-state";
import {parseAllowlist} from "@/fork/net/guard";
import {resetRateLimits} from "@/fork/net/rate-limit";

const USER = "00000000-0000-4000-8000-0000000000aa";
const P = (systemRole: string | null, ...m: [string, string][]): ForkPrincipal => ({userId: USER, systemRole, memberships: m.map(([organizationId, role]) => ({organizationId, role}))});
const noSleep = async () => {};
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

let w: W04Db;
let org: string;
let kekDir: string;
let fake: FakeArcane;
let conn: string;
let clock = new Date("2026-11-07T10:00:00Z");
const tick = (ms: number) => { clock = new Date(clock.getTime() + ms); };
const lists = (over: {containers?: unknown[]} = {}) => ({containers: clone(RAW.containers.data), volumes: clone(RAW.volumes.data), networks: clone(RAW.networks.data), images: clone(RAW.images.data), projects: clone(RAW.projects.data), ...over});
const deps = (extra: Partial<SyncDeps> = {}): SyncDeps => ({db: w.db, kekDir, allowlist: parseAllowlist("127.0.0.1"), sleep: noSleep, now: () => clock, ...extra});
const nowDeps = (principal: ForkPrincipal | null, extra: Partial<ServiceDeps> = {}): ServiceDeps => ({db: w.db, principal, kekDir, allowlist: parseAllowlist("127.0.0.1"), sleep: noSleep, assertConfigAllowed: async () => {}, now: () => clock, ...extra});
const ran = (r: SyncResult): SyncRun => { if (r.kind !== "ran") throw new Error(`skipped: ${r.reason}`); return r.run; };
const stacks = async () => (await q("select id, compose_project, runtime_state, stale_since, environment_id from fork_stack order by compose_project")).rows;
const versions = async () => (await q("select version, content_hash from fork_stack_inventory order by stack_id, version")).rows;
const envRow = async (ext = "0") => (await q("select id, enabled, last_sync_status, last_sync_error_class, last_sync_summary s from fork_arcane_environment where external_id=$1", [ext])).rows[0];
const connRow = async () => (await q("select health_status, last_error_class, sync_failure_streak, circuit_open_until, last_sync_attempt_at from fork_arcane_connection where id=$1", [conn])).rows[0];
const audits = async () => (await q("select action, result, actor_kind, redacted_details d from fork_audit_event where action='fork.discovery.sync' order by seq")).rows;

beforeAll(async () => {
    w = await freshForkDb();
    org = await seedOrg(w.pool, "solo");
    kekDir = path.join(await mkdtemp(path.join(os.tmpdir(), "w07-kek-")), "fork-kek");
});
afterAll(async () => { await w.drop(); });
beforeEach(async () => {
    resetRateLimits();
    clock = new Date("2026-11-07T10:00:00Z");
    await q("delete from fork_stack");
    await q("delete from fork_arcane_connection");
    await q("delete from fork_lock");
    await q("delete from fork_notification_outbox");
    fake = await startFakeArcane({lists: {"0": lists()}});
    conn = (await insertConnectionWithSecret(w.db, {organizationId: org, name: "arcane", baseUrl: fake.url, apiKey: fake.state.validKey}, kekDir)).id;
    await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled) values ($1,'0','local',true)", [conn]);
});
afterEach(async () => { await fake.close(); });

describe("first sync, versions, hash stability (exit: lab stack visible with correct classification)", () => {
    it("creates the stack + inventory v1, summary on the environment, connection healthy, audited", async () => {
        const run = ran(await syncConnection(deps(), conn, "manual", {userId: USER}));
        expect(run).toMatchObject({status: "ok", connectionError: null, totals: {found: 1, created: 1, changed: 0, absent: 0, rejected: 0}});
        const [s] = await stacks();
        expect(s).toMatchObject({compose_project: "forklab-demo", runtime_state: "running", stale_since: null});
        const inv = (await q("select inventory i, provenance p, warnings wr from fork_stack_inventory")).rows[0];
        expect(inv.i.services.map((x: {name: string}) => x.name)).toEqual(["db", "web"]);
        expect(inv.i.source).toMatchObject({arcane_version: "2.17.3", environment_id: "0"});
        expect(inv.p["/services"]).toBe("arcane_list");
        expect(inv.wr.length).toBeGreaterThan(0);
        expect((await envRow()).s).toMatchObject({trigger: "manual", stacks_found: 1, stacks_new: 1, partial: false, errors: []});
        expect(await envRow()).toMatchObject({last_sync_status: "ok", last_sync_error_class: null});
        expect(await connRow()).toMatchObject({health_status: "healthy", last_error_class: null, sync_failure_streak: 0});
        expect((await audits())[0]).toMatchObject({result: "success", actor_kind: "user", d: {trigger: "manual", status: "ok"}});
        // read-only: only GETs, and only the list/preflight endpoints
        expect(new Set(fake.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
        expect(fake.requests.map((r) => r.path.split("?")[0].replace(/^\/api/, "")).filter((p, i, a) => a.indexOf(p) === i).sort()).toEqual(
            ["/auth/me/api-keys", "/environments", "/environments/0/containers", "/environments/0/images", "/environments/0/networks", "/environments/0/projects", "/environments/0/volumes", "/version"]);
    });
    it("second sync = no new version; a changed container = version 2 (v1 kept)", async () => {
        ran(await syncConnection(deps(), conn, "manual"));
        const second = ran(await syncConnection(deps(), conn, "manual"));
        expect(second.totals).toMatchObject({created: 0, changed: 0, unchanged: 1});
        expect((await versions()).map((v) => v.version)).toEqual([1]);
        fake.state.lists["0"]!.containers = clone(RAW.containers.data).map((c: {names: string[]; image: string}) => (c.names[0] === "forklab-demo-web-1" ? {...c, image: "postgres:17-alpine"} : c));
        const third = ran(await syncConnection(deps(), conn, "manual"));
        expect(third.totals).toMatchObject({changed: 1, unchanged: 0});
        const v = await versions();
        expect(v.map((x) => x.version)).toEqual([1, 2]);
        expect(v[0].content_hash).not.toBe(v[1].content_hash);
    });
});

describe("stale, absent, partial, reconcile", () => {
    it("Arcane down: connection-level failure, cached inventory kept, stacks stale, health unreachable; recovery clears it", async () => {
        ran(await syncConnection(deps(), conn, "manual"));
        const before = await versions();
        fake.state.forceStatus = 503;
        tick(60_000);
        const bad = ran(await syncConnection(deps(), conn, "manual"));
        expect(bad).toMatchObject({status: "failed", connectionError: "unreachable", environments: [{status: "error", errorCode: "unreachable"}]});
        expect((await stacks())[0].stale_since).not.toBeNull();
        expect(await versions()).toEqual(before);
        expect(await envRow()).toMatchObject({last_sync_status: "error", last_sync_error_class: "unreachable"});
        expect(await connRow()).toMatchObject({health_status: "unreachable", last_error_class: "unreachable", sync_failure_streak: 1});
        fake.state.forceStatus = undefined;
        tick(60_000);
        expect(ran(await syncConnection(deps(), conn, "manual")).status).toBe("ok");
        expect((await stacks())[0].stale_since).toBeNull();
        expect(await connRow()).toMatchObject({health_status: "healthy", sync_failure_streak: 0});
    });
    it("a list failing on one environment only (403) = partial run; the healthy environment is written; no breaker", async () => {
        fake.state.grants.push(...MIN_PERMS("e2"));
        fake.state.environments.push({id: "e2", name: "remote", status: "online", apiUrl: "http://x.invalid"});
        fake.state.lists["e2"] = lists();
        await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled) values ($1,'e2','remote',true)", [conn]);
        fake.state.listStatus["e2:volumes"] = 403;
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run.status).toBe("partial");
        expect(run.environments.map((e) => `${e.status}:${e.errorCode}`).sort()).toEqual(["error:permission", "ok:null"]);
        expect((await envRow("0")).last_sync_status).toBe("ok");
        expect(await envRow("e2")).toMatchObject({last_sync_status: "error", last_sync_error_class: "permission"});
        expect(await connRow()).toMatchObject({sync_failure_streak: 0, health_status: "degraded", last_error_class: "partial"});
        expect((await stacks()).length).toBe(1); // nothing written for e2
    });
    it("stack disappears from a reachable environment ⇒ runtime_state absent (not stale), inventory kept; reappears ⇒ running", async () => {
        ran(await syncConnection(deps(), conn, "manual"));
        fake.state.lists["0"] = lists({containers: []});
        fake.state.lists["0"]!.projects = [];
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run.totals.absent).toBe(1);
        expect((await stacks())[0]).toMatchObject({runtime_state: "absent", stale_since: null});
        expect((await versions()).length).toBe(1);
        fake.state.lists["0"] = lists();
        ran(await syncConnection(deps(), conn, "manual"));
        expect((await stacks())[0].runtime_state).toBe("running");
        expect((await versions()).length).toBe(1); // same content ⇒ same hash ⇒ no new version
    });
    it("reconcile: an environment the key no longer covers is marked gone (stacks stale, cache kept); new covered ones appear disabled; covered again clears the mark", async () => {
        ran(await syncConnection(deps(), conn, "manual"));
        fake.state.environments = fake.state.environments.filter((e) => e.id !== "0");
        fake.state.grants.push(...MIN_PERMS("e3"));
        fake.state.environments.push({id: "e3", name: "new-one", status: "online", apiUrl: "http://x.invalid"});
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run).toMatchObject({status: "partial", reconcile: {gone: 1, added: 1}});
        expect(await envRow("0")).toMatchObject({last_sync_status: "error", last_sync_error_class: "not_found"});
        expect(await envRow("e3")).toMatchObject({enabled: false});
        expect((await stacks())[0].stale_since).not.toBeNull();
        expect((await versions()).length).toBe(1);
        fake.state.environments.push({id: "0", name: "local", status: "online", apiUrl: "http://x.invalid"});
        expect(ran(await syncConnection(deps(), conn, "manual")).status).toBe("ok");
        expect((await stacks())[0].stale_since).toBeNull();
    });
    it("a gone environment next to a failing one: the connection error is the failing one's class, not `not_found`", async () => {
        fake.state.environments.push({id: "e4", name: "remote", status: "online", apiUrl: "http://x.invalid"});
        fake.state.grants.push(...MIN_PERMS("e4"));
        await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled) values ($1,'e4','remote',true)", [conn]);
        await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled) values ($1,'gone','gone-env',true)", [conn]);
        fake.state.listStatus["0:containers"] = 503;
        fake.state.listStatus["e4:containers"] = 503;
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run).toMatchObject({status: "failed", connectionError: "unreachable", reconcile: {gone: 1}});
    });
    it("a lease stolen mid-run stops the run (no writes without the lease), reports partial and does NOT count towards the breaker", async () => {
        fake.state.grants.push(...MIN_PERMS("e5"));
        fake.state.environments.push({id: "e5", name: "second", status: "online", apiUrl: "http://x.invalid"});
        fake.state.lists["e5"] = lists();
        await q("insert into fork_arcane_environment (connection_id, external_id, name, enabled) values ($1,'e5','second',true)", [conn]);
        fake.state.delayMs = 60;
        const p = syncConnection(deps({owner: "victim"}), conn, "manual");
        await new Promise((r) => setTimeout(r, 100));
        await q("update fork_lock set owner='thief', expires_at = now() + interval '10 days' where name=$1", [leaseName(conn)]);
        const run = ran(await p);
        expect(run.status).toBe("partial");
        expect(run.environments).toHaveLength(1); // the second environment was never touched
        expect(run.circuit.streak).toBe(0);
        expect((await q("select owner from fork_lock where name=$1", [leaseName(conn)])).rows[0].owner).toBe("thief"); // the thief's lease was not released by the victim
    });
    it("a project label that cannot be a stack identity rejects only that stack (partial), never echoed", async () => {
        const bad = clone(RAW.containers.data[0]);
        bad.id = "f".repeat(64); bad.labels["com.docker.compose.project"] = "../../etc; drop table";
        fake.state.lists["0"] = lists({containers: [...RAW.containers.data, bad]});
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run.status).toBe("partial");
        expect(run.totals).toMatchObject({found: 1, rejected: 1});
        expect((await envRow()).s.errors).toEqual([{code: "invalid_project", count: 1}]);
        expect(JSON.stringify((await q("select * from fork_audit_event")).rows)).not.toContain("drop table");
    });
    it("environment budget exceeded ⇒ error `deadline`, nothing half-written", async () => {
        fake.state.delayMs = 30;
        const run = ran(await syncConnection(deps({environmentBudgetMs: 40}), conn, "manual"));
        expect(run.environments[0]).toMatchObject({status: "error", errorCode: "deadline"});
        expect(await stacks()).toEqual([]);
    });
    it("a key that gained a read permission is refused for sync (policy re-checked every run)", async () => {
        fake.state.grants.push({permission: "containers:read", environmentId: "0"});
        const run = ran(await syncConnection(deps(), conn, "manual"));
        expect(run).toMatchObject({status: "failed", connectionError: "key_too_broad"});
        expect(fake.requests.some((r) => /\/containers/.test(r.path))).toBe(false);
        expect(await stacks()).toEqual([]);
    });
});

describe("ARCH-10 scheduler semantics", () => {
    it("overlap = skip: two simultaneous triggers ⇒ exactly one runs, the other is skipped (lease released afterwards)", async () => {
        fake.state.delayMs = 120;
        const [a, b] = await Promise.all([syncConnection(deps(), conn, "manual"), syncConnection(deps(), conn, "cron")]);
        expect([a.kind, b.kind].sort()).toEqual(["ran", "skipped"]);
        expect([a, b].find((r) => r.kind === "skipped")).toEqual({kind: "skipped", reason: "already_running"});
        expect((await q("select count(*)::int c from fork_lock where name=$1", [leaseName(conn)])).rows[0].c).toBe(0);
        expect((await versions()).length).toBe(1);
    });
    it("replicas: a second process with its own pool/db handle and owner token cannot run while the first holds the lease", async () => {
        fake.state.delayMs = 120;
        const pool2 = new Pool({connectionString: w.url, max: 2});
        try {
            const db2 = drizzle({client: pool2}) as unknown as ForkDb;
            const [a, b] = await Promise.all([syncConnection(deps({owner: "replica-1"}), conn, "cron"), syncConnection(deps({db: db2, owner: "replica-2"}), conn, "cron")]);
            expect([a.kind, b.kind].sort()).toEqual(["ran", "skipped"]);
        } finally { await pool2.end(); }
    });
    it("a crashed worker's lease is stolen only after it expired", async () => {
        await q("insert into fork_lock (name, owner, expires_at) values ($1,'dead-replica',$2)", [leaseName(conn), new Date(clock.getTime() + 60_000)]);
        expect(await syncConnection(deps(), conn, "cron")).toEqual({kind: "skipped", reason: "already_running"});
        tick(61_000);
        expect(ran(await syncConnection(deps(), conn, "cron")).status).toBe("ok");
    });
    it("missed runs: due-ness comes from the persisted attempt time; downtime ⇒ ONE catch-up, then not due again", async () => {
        const due = (ms = 15 * 60_000, random = () => 0.5) => listDueConnections(w.db, {now: clock, intervalMs: ms, random});
        expect(await due()).toEqual([conn]); // never attempted
        ran(await syncConnection(deps(), conn, "cron"));
        expect(await due()).toEqual([]);
        tick(10 * 60_000);
        expect(await due()).toEqual([]);
        tick(3 * 3600_000); // process was down for 3 h
        expect(await due()).toEqual([conn]);
        ran(await syncConnection(deps(), conn, "cron"));
        expect(await due()).toEqual([]); // no backlog replay
        // jitter ±20 %: 12 min is the earliest, 18 min the latest
        tick(11 * 60_000); expect(await due(15 * 60_000, () => 0.5)).toEqual([]);
        tick(2 * 60_000); expect(await due(15 * 60_000, () => 0)).toEqual([conn]);
        expect(await due(15 * 60_000, () => 0.999)).toEqual([]); // 13 min < 18 min
        tick(6 * 60_000); expect(await due(15 * 60_000, () => 0.999)).toEqual([conn]);
    });
    it("nothing to do: no enabled environment ⇒ skipped without any network call, never due", async () => {
        await q("update fork_arcane_environment set enabled=false");
        expect(await syncConnection(deps(), conn, "cron")).toEqual({kind: "skipped", reason: "no_enabled_environment"});
        expect(fake.requests.length).toBe(0);
        expect(await listDueConnections(w.db, {now: clock, intervalMs: 1})).toEqual([]);
    });
});

describe("circuit breaker (persisted, replica-safe)", () => {
    it("back-off table: 5 → 5 min, 6 → 10, 7 → 20, 8 → 40, 9+ → 60 (cap)", () => {
        expect([4, 5, 6, 7, 8, 9, 30].map(circuitOpenMs).map((m) => m / 60_000)).toEqual([0, 5, 10, 20, 40, 60, 60]);
        expect(BREAKER.threshold).toBe(5);
    });
    it("5 consecutive failures open it (one notification), cron skips while open, half-open probe after the back-off, manual is always allowed, success closes it", async () => {
        fake.state.forceStatus = 503;
        for (let i = 1; i <= 4; i++) { tick(15 * 60_000); expect(ran(await syncConnection(deps(), conn, "cron")).circuit).toMatchObject({open: false, streak: i}); }
        tick(15 * 60_000);
        const fifth = ran(await syncConnection(deps(), conn, "cron"));
        expect(fifth.circuit).toMatchObject({open: true, opened: true, streak: 5});
        const c = await connRow();
        expect(new Date(c.circuit_open_until).getTime() - clock.getTime()).toBe(5 * 60_000);
        expect((await q("select kind, payload from fork_notification_outbox")).rows).toEqual([{kind: "discovery.circuit_open", payload: {state: "circuit_open", link: "/dashboard/integrations"}}]);
        // open: cron neither runs nor is even listed as due
        tick(60_000);
        expect(await syncConnection(deps(), conn, "cron")).toEqual({kind: "skipped", reason: "circuit_open"});
        expect(await listDueConnections(w.db, {now: clock, intervalMs: 1})).toEqual([]);
        const requests = fake.requests.length;
        // manual probe is allowed; failing again re-opens longer, without a second notification
        const manual = ran(await syncConnection(deps(), conn, "manual", {userId: USER}));
        expect(manual.circuit).toMatchObject({open: true, opened: false, streak: 6});
        expect(fake.requests.length).toBeGreaterThan(requests);
        expect(new Date((await connRow()).circuit_open_until).getTime() - clock.getTime()).toBe(10 * 60_000);
        // back-off elapsed ⇒ cron probes (half-open); Arcane recovered ⇒ closed
        tick(11 * 60_000);
        fake.state.forceStatus = undefined;
        const probe = ran(await syncConnection(deps(), conn, "cron"));
        expect(probe).toMatchObject({status: "ok", circuit: {open: false, closed: true, streak: 0, until: null}});
        expect(await connRow()).toMatchObject({sync_failure_streak: 0, circuit_open_until: null, health_status: "healthy"});
        expect((await q("select count(*)::int c from fork_notification_outbox")).rows[0].c).toBe(1);
        const circuits = (await audits()).map((a) => a.d.circuit);
        expect(circuits).toContain("opened");
        expect(circuits).toContain("closed");
    });
    it("a manual success also closes it", async () => {
        await q("update fork_arcane_connection set sync_failure_streak=7, circuit_open_until=$2 where id=$1", [conn, new Date(clock.getTime() + 600_000)]);
        const run = ran(await syncConnection(deps(), conn, "manual", {userId: USER}));
        expect(run.circuit).toMatchObject({open: false, closed: true, streak: 0});
        expect(await connRow()).toMatchObject({sync_failure_streak: 0, circuit_open_until: null});
    });
    it("cron audits only changes/problems, manual always (bounded audit volume)", async () => {
        const n0 = (await audits()).length; // audit is append-only: earlier tests' rows stay
        ran(await syncConnection(deps(), conn, "cron")); // created a stack ⇒ audited
        const n1 = (await audits()).length;
        expect(n1).toBe(n0 + 1);
        tick(20 * 60_000);
        ran(await syncConnection(deps(), conn, "cron")); // nothing changed ⇒ not audited
        expect((await audits()).length).toBe(n1);
        ran(await syncConnection(deps(), conn, "manual", {userId: USER}));
        expect((await audits()).length).toBe(n1 + 1);
        expect((await audits())[n0].actor_kind).toBe("system");
    });
});

describe("Sync now: role × action, gates, rate limit, audit (D21, SEC-12)", () => {
    it("system admin and superadmin run it; the result is code-only", async () => {
        for (const role of ["admin", "superadmin"]) {
            const r = await syncNow(nowDeps(P(role, [org, "member"])), {connectionId: conn});
            expect(r.ok).toBe(true);
            if (r.ok) expect(JSON.stringify(r.run)).not.toMatch(/forklab|arc_|http/);
            tick(1000);
        }
    });
    it("org owner / admin / member / pending / no membership / no principal are refused, nothing synced, every denial audited", async () => {
        const before = (await audits()).length;
        const who: [string, ForkPrincipal | null][] = [["owner", P("user", [org, "owner"])], ["org admin", P("user", [org, "admin"])], ["member", P("user", [org, "member"])], ["pending", P("pending", [org, "member"])], ["none", P("user")], ["no principal", null]];
        for (const [label, p] of who) {
            const r = await syncNow(nowDeps(p), {connectionId: conn});
            expect(r.ok, label).toBe(false);
            expect(["forbidden", "not_found"]).toContain((r as {code: string}).code);
        }
        expect(fake.requests.length).toBe(0);
        expect(await stacks()).toEqual([]);
        expect((await audits()).slice(before).filter((a) => a.result === "denied").length).toBeGreaterThanOrEqual(5);
    });
    it("no existence oracle: unknown id and another organization's connection answer identically", async () => {
        const other = await seedOrg(w.pool, "foreign");
        const c2 = (await insertConnectionWithSecret(w.db, {organizationId: other, name: "b", baseUrl: fake.url, apiKey: "arc_FAKEPFX1_x_______"}, kekDir)).id;
        const a = await syncNow(nowDeps(P("user", [org, "owner"])), {connectionId: c2});
        const b = await syncNow(nowDeps(P("user", [org, "owner"])), {connectionId: "00000000-0000-4000-8000-00000000dead"});
        expect(a).toEqual(b);
        expect(a).toMatchObject({ok: false, code: "not_found"});
    });
    it("locked / off ⇒ refused before any network call and audited", async () => {
        const {ForkLockedError} = await import("@/fork/mode");
        const r = await syncNow(nowDeps(P("admin", [org, "owner"]), {assertConfigAllowed: async () => { throw new ForkLockedError("locked", "self-check-failed"); }}), {connectionId: conn});
        expect(r).toMatchObject({ok: false, code: "locked"});
        expect(fake.requests.length).toBe(0);
        expect((await audits()).at(-1)).toMatchObject({result: "denied", d: {reason: "locked:self-check-failed"}});
    });
    it("rate limit: the 7th request within a minute is refused (audited)", async () => {
        const d = nowDeps(P("admin", [org, "owner"]));
        for (let i = 0; i < 6; i++) expect((await syncNow(d, {connectionId: conn})).ok).toBe(true);
        const r = await syncNow(d, {connectionId: conn});
        expect(r).toMatchObject({ok: false, code: "rate_limited"});
        expect((await audits()).at(-1)).toMatchObject({result: "denied", d: {reason: "rate-limited"}});
    });
    it("honest refusals: already running / nothing enabled; invalid input", async () => {
        await q("insert into fork_lock (name, owner, expires_at) values ($1,'x',$2)", [leaseName(conn), new Date(clock.getTime() + 60_000)]);
        expect(await syncNow(nowDeps(P("admin", [org, "owner"])), {connectionId: conn})).toMatchObject({ok: false, code: "already_running"});
        await q("delete from fork_lock");
        await q("update fork_arcane_environment set enabled=false");
        expect(await syncNow(nowDeps(P("admin", [org, "owner"])), {connectionId: conn})).toMatchObject({ok: false, code: "no_enabled_environment"});
        expect(await syncNow(nowDeps(P("admin", [org, "owner"])), {connectionId: "nope", extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
    });
});
