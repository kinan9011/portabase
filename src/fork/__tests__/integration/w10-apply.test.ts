import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {decryptSecret} from "@/features/database/utils/credential-crypto";
import {resolveBackupCron} from "@/features/database/utils/policy-resolution";
import {contentHash, type StackInventoryV1} from "@/fork/inventory/schema";
import {materializeStack, assertEncryptionForActivation, type MaterializeDeps} from "@/fork/materialize/apply";
import {removeStackSources} from "@/fork/materialize/remove";
import {ForkLockedError} from "@/fork/mode";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {w10Inventory} from "@/fork/__tests__/w10-fixtures";
import {freshForkDb, seedAgent, seedChannel, seedConnection, seedEnvironment, seedOrg, seedProject, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let org: string; let otherOrg: string; let agent: string; let chan: string; let env: string;
const KEY = Buffer.alloc(32, 9);
const USER = "00000000-0000-4000-8000-0000000000aa";
const principal = (systemRole: string, orgRole: string | null, orgId = org): ForkPrincipal => ({userId: USER, systemRole, memberships: orgRole ? [{organizationId: orgId, role: orgRole}] : []});
const deps = (p: ForkPrincipal | null = principal("admin", "owner"), over: Partial<MaterializeDeps> = {}): MaterializeDeps =>
    ({db: t.db, principal: p, masterKey: async () => KEY, assertConfigAllowed: async () => undefined, rate: () => ({ok: true}), ...over});
const q = (s: string, p: unknown[] = []) => pool.query(s, p);

async function mkStack(inv: StackInventoryV1 = w10Inventory(), envId = env): Promise<string> {
    const project = `s${randomUUID().slice(0, 8)}`;
    const i = {...inv, stack: {...inv.stack, compose_project: project, display_name: project}};
    const r = await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name) values ($1,$2,'env',$3,$3) returning id", [org, envId, project]);
    await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [r.rows[0].id, contentHash(i), JSON.stringify(i)]);
    return r.rows[0].id;
}
const audits = async () => (await q("select action, result, redacted_details as details from fork_audit_event order by seq")).rows as {action: string; result: string; details: Record<string, unknown>}[];
const DB_INV = (): StackInventoryV1 => {
    const inv = w10Inventory();
    inv.services.push({name: "db", state: "running", image: {ref: "postgres:16", pinned: false, built_locally: false}, ports: [], networks: [], mounts: ["m:00000000000000a1"], env_keys: [], database_hint: {engine: "postgresql", basis: "image"}});
    inv.mounts.push({id: "m:00000000000000a1", kind: "named_volume", volume_name: "app_pgdata", destination: "/var/lib/postgresql/data", rw: true, consumers: ["db"], ownership: "stack_owned"});
    inv.volumes.push({name: "app_pgdata", driver: "local", in_use_by: ["db"], ownership: "stack_owned"});
    return inv;
};
const DUMP = {kind: "dump" as const, host: "demo-db", port: 5432, username: "demo", database: "demo"};
const members = async (stackId: string) => (await q("select * from fork_stack_source where stack_id=$1 order by resource_key", [stackId])).rows;

beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool;
    org = await seedOrg(pool, "solo"); otherOrg = await seedOrg(pool, "other");
    agent = await seedAgent(pool, org, "lab-agent");
    await q("update agents set version='1.25.2', last_contact=now() where id=$1", [agent]);
    chan = await seedChannel(pool, org);
    env = await seedEnvironment(pool, await seedConnection(pool, org), agent, "lab-agent");
    await q("update fork_arcane_environment set enabled=true where id=$1", [env]);
});
afterAll(async () => { await t?.drop(); });
beforeEach(() => resetRateLimits());

describe("W10 apply: members are ordinary Portabase sources (D30/D33, ADR-001)", () => {
    it("creates the stack Project and the member sources; cron NULL everywhere, no retention, no container_name; docker-volume deferred without Docker evidence", async () => {
        const id = await mkStack();
        const r = await materializeStack(deps(), {stackId: id, storageChannelIds: [chan]});
        expect(r).toMatchObject({ok: true, created: 3, updated: 0, unchanged: 0, noop: false});
        if (!r.ok) return;
        expect(r.deferred).toEqual([{key: "volume:app_data", reason: "docker_access_unconfirmed"}]);
        const proj = (await q("select p.* from projects p join fork_stack s on s.project_id = p.id where s.id=$1", [id])).rows[0];
        expect(proj.name).toMatch(/^stack:env\/s[0-9a-f]{8}$/);
        expect(proj.backup_policy).toBeNull();
        expect((await q("select * from storage_policy where project_id=$1", [proj.id])).rows.map((x) => x.storage_channel_id)).toEqual([chan]);
        expect((await q("select * from retention_policies where project_id=$1", [proj.id])).rows).toEqual([]);
        const dbs = (await q("select d.* from databases d where d.project_id=$1 order by d.name", [proj.id])).rows;
        expect(dbs.map((d) => [d.dbms, d.backup_engine, d.config])).toEqual([
            ["files", "archive", {path: "/data/uploads"}], // `bind: …` sorts before `compose: …`
            ["files", "restic", {path: "/srv/app"}],
        ]);
        for (const d of dbs) {
            expect(d.backup_policy).toBeNull();
            expect(d.agent_id).toBe(agent);
            expect(JSON.stringify(d.config)).not.toContain("container_name");
            expect(resolveBackupCron({backupPolicy: d.backup_policy, project: {backupPolicy: proj.backup_policy}} as never)).toBeNull();
        }
        const links = await members(id);
        expect(links.map((l) => [l.resource_key, l.status, l.database_id !== null])).toEqual([
            ["dir:/srv/app", "active", true], ["mount:m:0000000000000002", "active", true], ["volume:app_data", "planned", false],
        ]);
        expect(await q("select materialize_state, applied_plan_hash, storage_channel_ids from fork_stack_policy where stack_id=$1", [id]).then((x) => x.rows[0])).toMatchObject({materialize_state: "ready", storage_channel_ids: [chan]});
    });

    it("is IDEMPOTENT: the second apply changes nothing (same ids, no duplicate rows, noop audit)", async () => {
        const id = await mkStack();
        await materializeStack(deps(), {stackId: id, storageChannelIds: [chan]});
        const before = {links: await members(id), dbs: (await q("select count(*)::int n from databases")).rows[0].n, projects: (await q("select count(*)::int n from projects")).rows[0].n};
        const r = await materializeStack(deps(), {stackId: id, storageChannelIds: [chan]});
        expect(r).toMatchObject({ok: true, created: 0, updated: 0, unchanged: 3, orphaned: 0, noop: true});
        expect(await members(id)).toEqual(before.links);
        expect((await q("select count(*)::int n from databases")).rows[0].n).toBe(before.dbs);
        expect((await q("select count(*)::int n from projects")).rows[0].n).toBe(before.projects);
        expect((await audits()).at(-1)).toMatchObject({action: "fork.materialize.apply", result: "success", details: {noop: true}});
    });

    it("Docker gate (CH-22c): with evidence the docker-volume source is created; with confirm and no evidence ONE canary is created", async () => {
        const a2 = await seedAgent(pool, org, "a2"); await q("update agents set version='1.25.2', last_contact=now() where id=$1", [a2]);
        const e2 = await seedEnvironment(pool, await seedConnection(pool, org, "arcane2"), a2, "a2"); await q("update fork_arcane_environment set enabled=true where id=$1", [e2]);
        const id = await mkStack(w10Inventory(), e2);
        const c = await materializeStack(deps(), {stackId: id, confirmDockerAccess: true});
        expect(c).toMatchObject({ok: true, deferred: []});
        expect((await members(id)).find((l) => l.resource_key === "volume:app_data")).toMatchObject({status: "canary"});
        // evidence: a docker-volume source of the SAME agent that reported contact after creation
        const a3 = await seedAgent(pool, org, "a3"); await q("update agents set version='1.25.2', last_contact=now() where id=$1", [a3]);
        await q("insert into databases (name, dbms, agent_id, config, created_at, last_contact) values ('other-vol','docker-volume',$1,'{\"volume_name\":\"x1\"}', now() - interval '1 hour', now())", [a3]);
        const e3 = await seedEnvironment(pool, await seedConnection(pool, org, "arcane3"), a3, "a3"); await q("update fork_arcane_environment set enabled=true where id=$1", [e3]);
        const id3 = await mkStack(w10Inventory(), e3);
        const r3 = await materializeStack(deps(), {stackId: id3});
        expect(r3).toMatchObject({ok: true, deferred: []});
        expect((await members(id3)).find((l) => l.resource_key === "volume:app_data")).toMatchObject({status: "active"});
        const vol = (await q("select config from databases where agent_id=$1 and name like 'volume:%'", [a3])).rows[0];
        expect(vol.config).toEqual({volume_name: "app_data"});
    });

    it("DB credentials: password is encrypted into the upstream config ONLY (not in policy, audit, result); the data volume is not copied while a dump is selected", async () => {
        const id = await mkStack(DB_INV());
        const r = await materializeStack(deps(), {stackId: id, selection: {databases: {db: DUMP}}, secrets: {db: "Pw-canary-123"}, storageChannelIds: [chan]});
        expect(r.ok).toBe(true);
        const pg = (await q("select d.config, d.dbms from databases d join fork_stack_source l on l.database_id = d.id where l.stack_id=$1 and l.role='db'", [id])).rows[0];
        expect(pg.dbms).toBe("postgresql");
        expect(pg.config).toMatchObject({host: "demo-db", port: 5432, username: "demo", database: "demo"});
        expect(decryptSecret(pg.config.password, KEY)).toBe("Pw-canary-123");
        const everywhere = JSON.stringify([r, (await q("select * from fork_stack_policy where stack_id=$1", [id])).rows, await audits(), await members(id)]);
        expect(everywhere).not.toContain("Pw-canary-123");
        expect((await members(id)).some((l) => l.resource_key === "volume:app_pgdata")).toBe(false);
    });

    it("re-apply with a different password rotates the stored credential without a new source", async () => {
        const id = await mkStack(DB_INV());
        await materializeStack(deps(), {stackId: id, selection: {databases: {db: DUMP}}, secrets: {db: "first-pw-1"}});
        const r = await materializeStack(deps(), {stackId: id, selection: {databases: {db: DUMP}}, secrets: {db: "second-pw-2"}});
        expect(r).toMatchObject({ok: true, created: 0, updated: 1});
        const pg = (await q("select d.config from databases d join fork_stack_source l on l.database_id=d.id where l.stack_id=$1 and l.role='db'", [id])).rows[0];
        expect(decryptSecret(pg.config.password, KEY)).toBe("second-pw-2");
    });

    it("SQLite → an upstream `sqlite` source (D29)", async () => {
        const inv = DB_INV(); inv.services[1].database_hint = {engine: "sqlite", basis: "mount"};
        const id = await mkStack(inv);
        const r = await materializeStack(deps(), {stackId: id, selection: {databases: {db: {kind: "sqlite", path: "/lab/sqlite/app.db"}}}});
        expect(r.ok).toBe(true);
        const row = (await q("select d.dbms, d.config, d.backup_engine from databases d join fork_stack_source l on l.database_id=d.id where l.stack_id=$1 and l.role='db'", [id])).rows[0];
        expect(row).toEqual({dbms: "sqlite", config: {path: "/lab/sqlite/app.db"}, backup_engine: "archive"});
    });

    it("a plan that drops a resource marks its source ORPHANED and never deletes it", async () => {
        const id = await mkStack();
        await materializeStack(deps(), {stackId: id});
        const r = await materializeStack(deps(), {stackId: id, selection: {excludeKeys: ["mount:m:0000000000000002"]}});
        expect(r).toMatchObject({ok: true, orphaned: 1});
        const l = (await members(id)).find((x) => x.resource_key === "mount:m:0000000000000002");
        expect(l).toMatchObject({status: "orphaned", drift_reason: "not_in_plan"});
        expect((await q("select deleted_at from databases where id=$1", [l.database_id])).rows[0].deleted_at).toBeNull();
    });

    it("an existing member's backup method cannot change (upstream rule) — refused, nothing written", async () => {
        const id = await mkStack();
        await materializeStack(deps(), {stackId: id});
        const r = await materializeStack(deps(), {stackId: id, selection: {composeMethod: "archive"}});
        expect(r).toMatchObject({ok: false, code: "refused", reason: "method_change"});
        expect((await members(id)).find((l) => l.resource_key === "dir:/srv/app")).toMatchObject({engine: "restic"});
    });

    it("project channel changes are applied to the stack Project's storage policy", async () => {
        const id = await mkStack();
        const c2 = await seedChannel(pool, org);
        await materializeStack(deps(), {stackId: id, storageChannelIds: [chan]});
        await materializeStack(deps(), {stackId: id, storageChannelIds: [c2]});
        const proj = (await q("select project_id from fork_stack where id=$1", [id])).rows[0].project_id;
        expect((await q("select storage_channel_id from storage_policy where project_id=$1", [proj])).rows.map((x) => x.storage_channel_id)).toEqual([c2]);
    });
});

describe("W10 apply: authorization, gates, compensation", () => {
    it("only a system admin with the upstream-equivalent agent ACL may materialize; every refusal is audited; foreign and missing ids look the same", async () => {
        const id = await mkStack();
        const before = await q("select count(*)::int n from databases").then((x) => x.rows[0].n);
        expect(await materializeStack(deps(null), {stackId: id})).toMatchObject({ok: false, code: "forbidden"});
        expect(await materializeStack(deps(principal("user", "owner")), {stackId: id})).toMatchObject({ok: false, code: "forbidden"}); // org owner, not system admin (D21)
        expect(await materializeStack(deps(principal("user", "member")), {stackId: id})).toMatchObject({ok: false, code: "forbidden"});
        const stranger = await materializeStack(deps(principal("user", null)), {stackId: id});
        const missing = await materializeStack(deps(principal("user", null)), {stackId: randomUUID()});
        expect(stranger).toEqual(missing);
        expect(stranger).toMatchObject({ok: false, code: "not_found"});
        // a system admin who is NOT a member of the org fails the upstream agent ACL (canManageAgents needs an org role)
        expect(await materializeStack(deps(principal("admin", null)), {stackId: id})).toMatchObject({ok: false, code: "forbidden"});
        expect(await q("select count(*)::int n from databases").then((x) => x.rows[0].n)).toBe(before);
        expect((await audits()).filter((a) => a.action === "fork.materialize.apply" && a.result === "denied").length).toBeGreaterThanOrEqual(5);
    });

    it("gates: no agent, environment disabled, agent too old, archived agent, channel of another org, missing secret, unknown input", async () => {
        const noAgentEnv = await seedEnvironment(pool, await seedConnection(pool, org, "c-noagent"), null, null);
        expect(await materializeStack(deps(), {stackId: await mkStack(w10Inventory(), noAgentEnv)})).toMatchObject({reason: "no_agent"});
        const disabled = await seedEnvironment(pool, await seedConnection(pool, org, "c-dis"), agent, "lab-agent");
        expect(await materializeStack(deps(), {stackId: await mkStack(w10Inventory(), disabled)})).toMatchObject({reason: "environment_disabled"});
        const old = await seedAgent(pool, org, "old"); await q("update agents set version='1.23.0' where id=$1", [old]);
        const eOld = await seedEnvironment(pool, await seedConnection(pool, org, "c-old"), old, "old"); await q("update fork_arcane_environment set enabled=true where id=$1", [eOld]);
        expect(await materializeStack(deps(), {stackId: await mkStack(w10Inventory(), eOld)})).toMatchObject({reason: "agent_version"});
        const arch = await seedAgent(pool, org, "arch"); await q("update agents set version='1.25.2', is_archived=true where id=$1", [arch]);
        const eArch = await seedEnvironment(pool, await seedConnection(pool, org, "c-arch"), arch, "arch"); await q("update fork_arcane_environment set enabled=true where id=$1", [eArch]);
        expect(await materializeStack(deps(), {stackId: await mkStack(w10Inventory(), eArch)})).toMatchObject({reason: "agent_unavailable"});
        const foreign = await seedChannel(pool, otherOrg);
        expect(await materializeStack(deps(), {stackId: await mkStack(), storageChannelIds: [foreign]})).toMatchObject({reason: "channels_unavailable"});
        const dbId = await mkStack(DB_INV());
        expect(await materializeStack(deps(), {stackId: dbId, selection: {databases: {db: DUMP}}})).toMatchObject({reason: "secret_required", services: ["db"]});
        expect(await q("select count(*)::int n from fork_stack_source where stack_id=$1", [dbId]).then((x) => x.rows[0].n)).toBe(0);
        expect(await materializeStack(deps(), {stackId: "nope"})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await materializeStack(deps(), {stackId: await mkStack(), bogus: 1})).toMatchObject({ok: false, code: "invalid_input"});
    });

    it("D21 gate and rate limit are enforced server-side", async () => {
        const id = await mkStack();
        const locked = await materializeStack(deps(undefined, {assertConfigAllowed: async () => { throw new ForkLockedError("locked", "self-check-failed"); }}), {stackId: id});
        expect(locked).toMatchObject({ok: false, code: "locked"});
        const limited = await materializeStack(deps(undefined, {rate: () => ({ok: false, retryAfterSeconds: 7})}), {stackId: id});
        expect(limited).toMatchObject({ok: false, code: "rate_limited", retryAfterSeconds: 7});
        expect(await members(id)).toEqual([]);
    });

    it("a stack Project name already used by something else is refused and nothing is left behind", async () => {
        const id = await mkStack();
        const name = (await q("select 'stack:env/' || compose_project n from fork_stack where id=$1", [id])).rows[0].n;
        await seedProject(pool, org, name);
        expect(await materializeStack(deps(), {stackId: id})).toMatchObject({ok: false, reason: "project_name_taken"});
        expect(await members(id)).toEqual([]);
        expect((await q("select project_id from fork_stack where id=$1", [id])).rows[0].project_id).toBeNull();
    });

    it("COMPENSATION: a failure half-way rolls the whole apply back (no project, no sources, no links) and is audited as failure", async () => {
        await q(`create or replace function w10_fail() returns trigger language plpgsql as $$ begin if new.name like 'bind:%' then raise exception 'boom'; end if; return new; end $$`);
        await q("create trigger w10_fail before insert on databases for each row execute function w10_fail()");
        try {
            const id = await mkStack();
            await expect(materializeStack(deps(), {stackId: id})).rejects.toThrow();
            expect(await members(id)).toEqual([]);
            expect((await q("select project_id from fork_stack where id=$1", [id])).rows[0].project_id).toBeNull();
            expect((await q("select count(*)::int n from databases where name like 'compose:%' and agent_id=$1 and project_id is not null and created_at > now() - interval '1 minute' and id in (select database_id from fork_stack_source)", [agent])).rows[0].n).toBeGreaterThanOrEqual(0);
            expect((await audits()).at(-1)).toMatchObject({action: "fork.materialize.apply", result: "failure"});
            const orphans = await q("select d.id from databases d join projects p on p.id = d.project_id where p.name = 'stack:env/' || (select compose_project from fork_stack where id=$1)", [id]);
            expect(orphans.rows).toEqual([]);
        } finally {
            await q("drop trigger w10_fail on databases");
        }
    });
});

describe("W10 remove: confirmed, only sources that never ran", () => {
    it("requires confirm:true; removes never-run sources (soft delete like upstream) and refuses backed-up ones", async () => {
        const id = await mkStack();
        await materializeStack(deps(), {stackId: id});
        const links = await members(id);
        const [a, b] = links.filter((l) => l.database_id);
        expect(await removeStackSources(deps(), {stackId: id, sourceIds: [a.id], confirm: false})).toMatchObject({ok: false, code: "invalid_input"});
        await q("insert into backups (database_id, status) values ($1, 'success')", [b.database_id]);
        const r = await removeStackSources(deps(), {stackId: id, sourceIds: [a.id, b.id, randomUUID()], confirm: true});
        expect(r).toMatchObject({ok: true, removed: 1});
        if (r.ok) expect(r.refused.map((x) => x.reason).sort()).toEqual(["has_backups", "not_in_stack"]);
        expect((await q("select deleted_at, project_id, agent_id from databases where id=$1", [a.database_id])).rows[0]).toMatchObject({project_id: null, agent_id: null});
        expect((await q("select deleted_at from databases where id=$1", [a.database_id])).rows[0].deleted_at).not.toBeNull();
        expect((await q("select deleted_at from databases where id=$1", [b.database_id])).rows[0].deleted_at).toBeNull();
        expect(await members(id).then((x) => x.some((l) => l.id === a.id))).toBe(false);
        expect(await removeStackSources(deps(principal("user", "owner")), {stackId: id, sourceIds: [b.id], confirm: true})).toMatchObject({ok: false, code: "forbidden"});
    });
});

describe("D39 encryption precondition", () => {
    it("is exposed by the materializer and follows setting.encryption", async () => {
        await q("delete from settings");
        expect(await assertEncryptionForActivation(t.db)).toEqual({ok: false, reason: "encryption_required"});
        await q("insert into settings (name, encryption) values ('s', false)");
        expect(await assertEncryptionForActivation(t.db)).toEqual({ok: false, reason: "encryption_required"});
        await q("update settings set encryption = true");
        expect(await assertEncryptionForActivation(t.db)).toEqual({ok: true});
        await q("delete from settings");
    });
});
