import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {contentHash, type StackInventoryV1} from "@/fork/inventory/schema";
import {materializeStack, type MaterializeDeps} from "@/fork/materialize/apply";
import {loadMaterializedContext} from "@/fork/materialize/context";
import {CANARY_TIMEOUT_MS, MEMBER_STALE_MS, driftStack, materializeTick} from "@/fork/materialize/drift";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {StackDetailSchema} from "@/fork/stacks/dto";
import {loadStackDetail} from "@/fork/stacks/queries";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {freshForkDb, seedAgent, seedChannel, seedConnection, seedEnvironment, seedOrg, seedProject, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let org: string; let agent: string; let chan: string; let env: string;
const KEY = Buffer.alloc(32, 9);
const principal: ForkPrincipal = {userId: "00000000-0000-4000-8000-0000000000aa", systemRole: "admin", memberships: [{organizationId: "", role: "owner"}]};
const deps = (): MaterializeDeps => ({db: t.db, principal, masterKey: async () => KEY, assertConfigAllowed: async () => undefined, rate: () => ({ok: true})});
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const NOW = new Date("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
// NB: `databases.last_contact` / `agents.last_contact` are `timestamp` WITHOUT tz and drizzle reads them as UTC: write UTC wall time (ISO string), never a Date through raw pg (that uses the process TZ).
const utc = (d: Date | null) => (d ? d.toISOString() : null);
const contact = (table: "databases" | "agents", id: string, d: Date | null) => q(`update ${table} set last_contact=$2 where id=$1`, [id, utc(d)]);

async function mkStack(inv: StackInventoryV1 = cleanInventory(), envId = env, name?: string): Promise<string> {
    const project = name ?? `s${randomUUID().slice(0, 8)}`;
    const i = {...inv, stack: {...inv.stack, compose_project: project, display_name: project}};
    const r = await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name) values ($1,$2,'env',$3,$3) returning id", [org, envId, project]);
    await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [r.rows[0].id, contentHash(i), JSON.stringify(i)]);
    return r.rows[0].id;
}
const addInventoryVersion = async (id: string, mutate: (i: StackInventoryV1) => void) => {
    const cur = (await q("select inventory, version from fork_stack_inventory where stack_id=$1 order by version desc limit 1", [id])).rows[0];
    const inv = structuredClone(cur.inventory) as StackInventoryV1; mutate(inv);
    await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,$2,$3,$4)", [id, cur.version + 1, contentHash(inv), JSON.stringify(inv)]);
};
const links = async (id: string) => (await q("select * from fork_stack_source where stack_id=$1 order by resource_key", [id])).rows;
const link = async (id: string, key: string) => (await links(id)).find((l) => l.resource_key === key);
const audits = async (like: string) => (await q("select action, result, redacted_details as details, actor_kind from fork_audit_event where action like $1 order by seq", [like])).rows;
const projectOf = async (id: string) => (await q("select project_id from fork_stack where id=$1", [id])).rows[0].project_id as string;
/** Stack with all three sources live (docker evidence seeded for its agent). */
async function liveStack(inv?: StackInventoryV1): Promise<{id: string; ag: string; envId: string}> {
    const ag = await seedAgent(pool, org, `ag-${randomUUID().slice(0, 6)}`);
    await q("update agents set version='1.25.2' where id=$1", [ag]); await contact("agents", ag, NOW);
    const envId = await seedEnvironment(pool, await seedConnection(pool, org, `c-${randomUUID().slice(0, 6)}`), ag, "a"); await q("update fork_arcane_environment set enabled=true where id=$1", [envId]);
    await q("insert into databases (name, dbms, agent_id, config, created_at, last_contact) values ('evidence','docker-volume',$1,'{\"volume_name\":\"zz1\"}',$2,$3)", [ag, utc(ago(3_600_000)), utc(NOW)]);
    const id = await mkStack(inv ?? cleanInventory(), envId);
    const r = await materializeStack(deps(), {stackId: id, storageChannelIds: [chan]});
    expect(r.ok && r.deferred).toEqual([]);
    return {id, ag, envId};
}
const run = (id: string, now = NOW) => driftStack({db: t.db, now: () => now}, id);

beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool;
    org = await seedOrg(pool, "solo"); principal.memberships[0].organizationId = org;
    agent = await seedAgent(pool, org, "lab-agent"); await q("update agents set version='1.25.2' where id=$1", [agent]);
    chan = await seedChannel(pool, org);
    env = await seedEnvironment(pool, await seedConnection(pool, org), agent, "lab-agent"); await q("update fork_arcane_environment set enabled=true where id=$1", [env]);
});
afterAll(async () => { await t?.drop(); });
beforeEach(() => resetRateLimits());

describe("D30 effective-policy drift job", () => {
    it("reverts a cron on the stack Project AND on a member within one tick, plus project- and member-level retention; audits what was seen and the revert", async () => {
        const {id} = await liveStack();
        const proj = await projectOf(id);
        const member = (await links(id))[0].database_id;
        await q("update projects set backup_policy='0 3 * * *' where id=$1", [proj]);
        await q("update databases set backup_policy='*/5 * * * *' where id=$1", [member]);
        await q("insert into retention_policies (project_id, type) values ($1,'count')", [proj]);
        await q("insert into retention_policies (database_id, type) values ($1,'days')", [member]);
        const s = await run(id);
        expect(s.reverted).toBe(1);
        expect((await q("select backup_policy from projects where id=$1", [proj])).rows[0].backup_policy).toBeNull();
        expect((await q("select backup_policy from databases where project_id=$1", [proj])).rows.every((r) => r.backup_policy === null)).toBe(true);
        expect((await q("select count(*)::int n from retention_policies where project_id=$1 or database_id in (select id from databases where project_id=$1)", [proj])).rows[0].n).toBe(0);
        const seen = await audits("fork.materialize.drift.seen"); const rev = await audits("fork.materialize.drift.reverted");
        expect(seen.at(-1)).toMatchObject({actor_kind: "system", details: {kind: "effective_policy", projectCron: true, memberCrons: 1, memberRetention: 1, projectRetention: true}});
        expect(JSON.stringify(seen.at(-1).details.crons)).toContain("0 3 * * *");
        expect(rev.at(-1).details).toMatchObject({reverted_to: null});
        // quiet afterwards: a clean tick writes nothing
        const n = (await q("select count(*)::int n from fork_audit_event")).rows[0].n;
        expect((await run(id)).reverted).toBe(0);
        expect((await q("select count(*)::int n from fork_audit_event")).rows[0].n).toBe(n);
    });
    it("a project-level cron alone is enough: the effective cron of members resolves through the Project, and the tick removes it", async () => {
        const {id} = await liveStack();
        const proj = await projectOf(id);
        await q("update projects set backup_policy='0 4 * * *' where id=$1", [proj]);
        await run(id);
        expect((await q("select backup_policy from projects where id=$1", [proj])).rows[0].backup_policy).toBeNull();
    });
    it("materializeTick walks every stack with sources, isolates failures, and counts", async () => {
        const {id} = await liveStack();
        await q("update projects set backup_policy='1 1 * * *' where id=$1", [await projectOf(id)]);
        const r = await materializeTick({db: t.db, now: () => NOW});
        expect(r.reverted).toBeGreaterThanOrEqual(1);
        expect(r.failed).toBe(0);
    });
});

describe("structural drift is a BLOCKER, never auto-fixed, and clears when the live row matches again", () => {
    it.each([
        ["config changed", (db: string) => q("update databases set config='{\"path\":\"/srv/other\"}'::jsonb where id=$1", [db]), "dir:/srv/app", "config_changed"],
        ["method changed", (db: string) => q("update databases set backup_engine='archive' where id=$1", [db]), "dir:/srv/app", "method_changed"],
        ["deleted", (db: string) => q("update databases set deleted_at=now() where id=$1", [db]), "dir:/srv/app", "source_removed"],
        ["hard-deleted (FK SET NULL)", (db: string) => q("delete from databases where id=$1", [db]), "dir:/srv/app", "source_removed"],
        ["own storage policy", (db: string) => seedChannel(pool, org).then((c) => q("insert into storage_policy (storage_channel_id, database_id) values ($1,$2)", [c, db])), "dir:/srv/app", "channel_changed"],
        ["moved to another project", async (db: string) => q("update databases set project_id=$2 where id=$1", [db, await seedProject(pool, org)]), "dir:/srv/app", "source_moved"],
    ])("%s → drifted (%s)", async (_n, mutate, key, reason) => {
        const {id} = await liveStack();
        const l = await link(id, key as string);
        await mutate(l.database_id);
        expect((await run(id)).drifted).toBe(1);
        expect(await link(id, key as string)).toMatchObject({status: "drifted", drift_reason: reason});
        const mat = await loadMaterializedContext(t.db, {id, environmentId: (await q("select environment_id from fork_stack where id=$1", [id])).rows[0].environment_id}, NOW);
        expect(Object.keys(mat.coverage)).not.toContain("env:implicit"); // a drifted member covers nothing
        expect(mat.sourceIssues.map((i) => [i.reason, i.severity])).toContainEqual(["source_drifted", "blocker"]);
        expect((await audits("fork.materialize.drift.source")).at(-1).details).toMatchObject({reason});
    });
    it("clears by itself when the live row matches the plan again (config restored)", async () => {
        const {id} = await liveStack();
        const l = await link(id, "dir:/srv/app");
        await q("update databases set config='{\"path\":\"/srv/other\"}'::jsonb where id=$1", [l.database_id]);
        await run(id);
        await q("update databases set config='{\"path\":\"/srv/app\"}'::jsonb where id=$1", [l.database_id]);
        expect((await run(id)).cleared).toBe(1);
        expect(await link(id, "dir:/srv/app")).toMatchObject({status: "active", drift_reason: null});
    });
    it("SEC-24 re-check: a docker-volume member edited to a path-like volume_name or given a container_name is a blocker (unsafe_volume)", async () => {
        const ag = await seedAgent(pool, org, "a-sec"); await q("update agents set version='1.25.2' where id=$1", [ag]); await contact("agents", ag, NOW);
        const e = await seedEnvironment(pool, await seedConnection(pool, org, "c-sec"), ag, "a"); await q("update fork_arcane_environment set enabled=true where id=$1", [e]);
        await q("insert into databases (name, dbms, agent_id, config, created_at, last_contact) values ('ev','docker-volume',$1,'{\"volume_name\":\"zz2\"}',$2,$3)", [ag, utc(ago(3_600_000)), utc(NOW)]);
        const id = await mkStack(cleanInventory(), e);
        await materializeStack(deps(), {stackId: id});
        const vol = await link(id, "volume:app_data");
        await q("update databases set config='{\"volume_name\":\"/tmp/x\"}'::jsonb where id=$1", [vol.database_id]);
        await run(id);
        expect(await link(id, "volume:app_data")).toMatchObject({status: "drifted", drift_reason: "unsafe_volume"});
        await q("update databases set config='{\"volume_name\":\"app_data\",\"container_name\":\"portabase-agent\"}'::jsonb where id=$1", [vol.database_id]);
        await run(id);
        expect(await link(id, "volume:app_data")).toMatchObject({status: "drifted", drift_reason: "unsafe_volume"});
    });
    it("project storage channel set differing from the configured one blocks the stack (policy:channels) and clears when restored", async () => {
        const {id} = await liveStack();
        const proj = await projectOf(id);
        const c2 = await seedChannel(pool, org);
        await q("insert into storage_policy (storage_channel_id, project_id) values ($1,$2)", [c2, proj]);
        await run(id);
        expect((await q("select materialize_state from fork_stack_policy where stack_id=$1", [id])).rows[0].materialize_state).toBe("blocked");
        const mat = await loadMaterializedContext(t.db, {id, environmentId: null}, NOW);
        expect(mat.sourceIssues.map((i) => i.key)).toContain("policy:channels");
        await q("delete from storage_policy where project_id=$1 and storage_channel_id=$2", [proj, c2]);
        await run(id);
        expect((await q("select materialize_state from fork_stack_policy where stack_id=$1", [id])).rows[0].materialize_state).toBe("ready");
    });
});

describe("inventory change → warning state, orphans, never deleted", () => {
    it("a new resource flips the policy to inventory_changed (and the validator shows it uncovered); re-apply returns to ready", async () => {
        const {id} = await liveStack();
        await addInventoryVersion(id, (i) => { i.volumes.push({name: "new_vol", driver: "local", in_use_by: ["web"], ownership: "stack_owned"}); });
        expect((await run(id)).inventoryChanged).toBe(1);
        const st = async () => (await q("select materialize_state s from fork_stack_policy where stack_id=$1", [id])).rows[0].s;
        expect(await st()).toBe("inventory_changed");
        const mat = await loadMaterializedContext(t.db, {id, environmentId: null}, NOW);
        expect(mat.sourceIssues).toContainEqual(expect.objectContaining({reason: "inventory_changed", severity: "warn"}));
        const d = await loadStackDetail(t.db, org, id, {now: NOW});
        if (d?.inventory.state !== "ok") throw new Error("not ok");
        expect(d.inventory.configuration.items.find((x) => x.key === "volume:new_vol")).toMatchObject({status: "missing", gap: true});
        expect(d.inventory.protection.complete).toBe(false);
        await materializeStack(deps(), {stackId: id, storageChannelIds: [chan]});
        expect(await st()).toBe("ready");
    });
    it("a vanished resource orphans its source (kept, never deleted)", async () => {
        const {id} = await liveStack();
        await addInventoryVersion(id, (i) => { i.mounts = i.mounts.filter((m) => m.kind !== "bind"); i.services[0].mounts = i.services[0].mounts.filter((m) => m !== "m:0000000000000002"); });
        expect((await run(id)).orphaned).toBe(1);
        const l = await link(id, "mount:m:0000000000000002");
        expect(l).toMatchObject({status: "orphaned", drift_reason: "not_in_plan"});
        expect((await q("select deleted_at from databases where id=$1", [l.database_id])).rows[0].deleted_at).toBeNull();
    });
});

describe("probes (P-2) and the coverage/probe feed into the W09 views", () => {
    it("fresh member contact → readable; the stack then reads COMPLETE through the real loader (still not Protected: kit/RP gates)", async () => {
        const {id, ag} = await liveStack();
        for (const l of await links(id)) await contact("databases", l.database_id, NOW);
        await contact("agents", ag, NOW);
        const s = await run(id);
        expect(s.probed).toBe(3);
        const d = await loadStackDetail(t.db, org, id, {now: NOW});
        StackDetailSchema.parse(d);
        if (d?.inventory.state !== "ok") throw new Error("not ok");
        expect(d.inventory.protection.complete).toBe(true);
        expect(d.inventory.protection.counts.blockers).toBe(0);
        expect(d.inventory.protection.primary).toBe("unprotected"); // no active policy yet (W11) — nothing is promised
        expect(d.inventory.configuration.sources.map((x) => [x.role, x.status, x.probe]).sort()).toEqual([["bind", "active", "readable"], ["compose", "active", "readable"], ["volume", "active", "readable"]]);
        expect(JSON.stringify(d.inventory.configuration.sources)).not.toMatch(/password|"config"|database_id|desired/);
    });
    it("agent fresh but a member never contacted after > 3 min → unreadable (blocker, resolvable); agent silent → no probe written; sqlite never probed", async () => {
        const inv = cleanInventory();
        inv.services.push({name: "lite", state: "running", image: {ref: "x", pinned: false, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: [], database_hint: {engine: "sqlite", basis: "mount"}});
        const {id, ag} = await liveStack(inv);
        await materializeStack(deps(), {stackId: id, storageChannelIds: [chan], selection: {databases: {lite: {kind: "sqlite", path: "/lab/s/app.db"}}}});
        await q("update fork_stack_source set created_at=$2 where stack_id=$1", [id, ago(MEMBER_STALE_MS + 1000)]);
        const bind = await link(id, "mount:m:0000000000000002");
        for (const l of (await links(id)).filter((x) => x.resource_key !== "mount:m:0000000000000002")) await contact("databases", l.database_id, NOW);
        await contact("databases", bind.database_id, null);
        await contact("agents", ag, ago(300_000)); // silent agent
        expect((await run(id)).probed).toBe(0);
        await contact("agents", ag, NOW);
        const s = await run(id);
        expect(s.probed).toBe(3); // compose, bind, volume — not sqlite
        expect(await link(id, "mount:m:0000000000000002")).toMatchObject({last_probe: "unreadable"});
        expect(await link(id, "db:lite")).toMatchObject({last_probe: null});
        const d = await loadStackDetail(t.db, org, id, {now: NOW});
        if (d?.inventory.state !== "ok") throw new Error("not ok");
        expect(d.inventory.configuration.items.find((x) => x.key === "mount:m:0000000000000002")).toMatchObject({status: "inaccessible", reason: "unreadable", gap: true});
    });
    it("a stale probe (older than the TTL) is not trusted: the item falls back to unknown (fail closed)", async () => {
        const {id, ag} = await liveStack();
        for (const l of await links(id)) await contact("databases", l.database_id, NOW);
        await contact("agents", ag, NOW);
        await run(id);
        const later = new Date(NOW.getTime() + 11 * 60_000);
        const mat = await loadMaterializedContext(t.db, {id, environmentId: null}, later);
        expect(mat.probes).toEqual({});
    });
});

describe("Docker gate: canary, promotion, rollback, one finding per agent (CH-22c)", () => {
    const fresh = async () => {
        const ag = await seedAgent(pool, org, `ag-${randomUUID().slice(0, 6)}`);
        await q("update agents set version='1.25.2' where id=$1", [ag]); await contact("agents", ag, NOW);
        const e = await seedEnvironment(pool, await seedConnection(pool, org, `c-${randomUUID().slice(0, 6)}`), ag, "a"); await q("update fork_arcane_environment set enabled=true where id=$1", [e]);
        return {ag, e};
    };
    const twoVolumes = () => { const i = cleanInventory(); i.volumes.push({name: "app_data2", driver: "local", in_use_by: ["web"], ownership: "stack_owned"}); return i; };

    it("canary confirmed by the agent's first contact → active, and the other planned docker-volume members are created", async () => {
        const {ag, e} = await fresh();
        const id = await mkStack(twoVolumes(), e);
        const r = await materializeStack(deps(), {stackId: id, confirmDockerAccess: true});
        expect(r).toMatchObject({ok: true, deferred: [{key: "volume:app_data2", reason: "waiting_for_canary"}]});
        const canary = await link(id, "volume:app_data");
        expect(canary).toMatchObject({status: "canary"});
        // no contact yet: nothing changes
        expect((await run(id, new Date(NOW.getTime() + 30_000))).promoted).toBe(0);
        // the agent pinged the canary successfully
        const later = new Date(NOW.getTime() + 60_000);
        await contact("databases", canary.database_id, later); await contact("agents", ag, later);
        const s = await run(id, later);
        expect(s.promoted).toBe(2);
        expect((await links(id)).filter((l) => l.dbms === "docker-volume").map((l) => [l.status, l.database_id !== null])).toEqual([["active", true], ["active", true]]);
        expect((await audits("fork.materialize.canary.confirmed")).length).toBeGreaterThan(0);
    });
    it("no contact after the canary within the timeout → the canary WE created is rolled back (poll unblocked) and the agent finding appears once", async () => {
        const {ag, e} = await fresh();
        const id = await mkStack(twoVolumes(), e);
        await materializeStack(deps(), {stackId: id, confirmDockerAccess: true});
        const canary = await link(id, "volume:app_data");
        await q("update fork_stack_source set last_probe_at=$2 where id=$1", [canary.id, NOW]); // canary start
        await contact("agents", ag, ago(1000)); // last contact BEFORE the canary start, then silence
        const later = new Date(NOW.getTime() + CANARY_TIMEOUT_MS + 5000);
        const s = await run(id, later);
        expect(s.rolledBack).toBe(1);
        expect(await link(id, "volume:app_data")).toMatchObject({status: "blocked", drift_reason: "agent_poll_failing", database_id: null});
        expect((await q("select deleted_at from databases where id=$1", [canary.database_id])).rows[0].deleted_at).not.toBeNull();
        const envId = (await q("select environment_id from fork_stack where id=$1", [id])).rows[0].environment_id;
        const mat = await loadMaterializedContext(t.db, {id, environmentId: envId}, later);
        expect(mat.sourceIssues.filter((i) => i.reason === "agent_poll_failing")).toHaveLength(1);
        expect((await audits("fork.materialize.canary.rolled_back")).at(-1).details).toMatchObject({reason: "agent_poll_failing"});
    });
    it("planned docker-volume members are promoted once Docker access is evidenced (no operator word needed)", async () => {
        const {ag, e} = await fresh();
        const id = await mkStack(cleanInventory(), e);
        await materializeStack(deps(), {stackId: id});
        expect(await link(id, "volume:app_data")).toMatchObject({status: "planned", database_id: null});
        await q("insert into databases (name, dbms, agent_id, config, created_at, last_contact) values ('ev','docker-volume',$1,'{\"volume_name\":\"zz3\"}',$2,$3)", [ag, utc(ago(3_600_000)), utc(NOW)]);
        expect((await run(id)).promoted).toBe(1);
        expect(await link(id, "volume:app_data")).toMatchObject({status: "active"});
    });
    it("ONE poll-failing finding per agent per stack, naming the culprit source and the other affected stacks (not N duplicates)", async () => {
        const {ag, e} = await fresh();
        await q("insert into databases (name, dbms, agent_id, config, created_at, last_contact) values ('ev','docker-volume',$1,'{\"volume_name\":\"zz4\"}',$2,$3)", [ag, utc(ago(3_600_000)), utc(NOW)]);
        const a = await mkStack(twoVolumes(), e, "stack-a"); const b = await mkStack(cleanInventory(), e, "stack-b");
        await materializeStack(deps(), {stackId: a}); await materializeStack(deps(), {stackId: b});
        await contact("agents", ag, ago(600_000)); // agent stopped reporting
        const envId = e;
        const ma = await loadMaterializedContext(t.db, {id: a, environmentId: envId}, NOW);
        const issues = ma.sourceIssues.filter((i) => i.reason === "agent_poll_failing");
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({key: `agent:${ag}`, kind: "agent", severity: "blocker", status: "inaccessible", consumers: ["stack-b"]});
        expect(issues[0].name).toContain("volume: app_data");
        // an agent that reports again clears it
        await contact("agents", ag, NOW);
        expect((await loadMaterializedContext(t.db, {id: a, environmentId: envId}, NOW)).sourceIssues.filter((i) => i.reason === "agent_poll_failing")).toHaveLength(0);
        // and the finding reaches the real blockers list as "Agent poll failing"
        await contact("agents", ag, ago(600_000));
        const d = await loadStackDetail(t.db, org, a, {now: NOW});
        if (d?.inventory.state !== "ok") throw new Error("not ok");
        const item = d.inventory.configuration.items.find((x) => x.reason === "agent_poll_failing");
        expect(item).toMatchObject({kind: "agent", gap: true, severity: "blocker", consumers: ["stack-b"]});
        expect(d.inventory.protection.complete).toBe(false);
    });
});

describe("D39 and agent mapping findings", () => {
    it("encryption off with an ACTIVE policy is a blocker; on (or no active policy) is not", async () => {
        const {id} = await liveStack();
        await q("delete from settings"); await q("insert into settings (name, encryption) values ('s', false)");
        const get = async () => (await loadMaterializedContext(t.db, {id, environmentId: null}, NOW)).sourceIssues.filter((i) => i.reason === "encryption_off");
        expect(await get()).toHaveLength(0);
        await q("update fork_stack_policy set activated_at=now() where stack_id=$1", [id]);
        expect(await get()).toHaveLength(1);
        await q("update settings set encryption=true");
        expect(await get()).toHaveLength(0);
        await q("delete from settings");
    });
    it("an environment that lost its agent after sources were created is an agent_unavailable blocker", async () => {
        const {id, envId} = await liveStack();
        await q("update fork_arcane_environment set agent_id=null where id=$1", [envId]);
        const mat = await loadMaterializedContext(t.db, {id, environmentId: envId}, NOW);
        expect(mat.sourceIssues).toContainEqual(expect.objectContaining({reason: "agent_unavailable", severity: "blocker"}));
    });
});

