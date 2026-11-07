import {createHash, randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {contentHash} from "@/fork/inventory/schema";
import type {RunDeps} from "@/fork/runs/deps";
import type {RunConfig} from "@/fork/runs/config";
import {cleanInventory, FULL_COVERAGE} from "@/fork/__tests__/w09-fixtures";
import {seedAgent, seedConnection, seedEnvironment, seedOrg, seedProject, type W04Db} from "@/fork/__tests__/w04-helpers";

/**
 * W12 world builder: an organization with an ACTIVE stack policy, member sources (upstream `databases` rows + `fork_stack_source` links),
 * an activating admin user, and helpers that play the AGENT against the upstream tables (pick up, succeed, fail). Time is a fake clock.
 */
export const CLEAN_KEYS = Object.keys(FULL_COVERAGE.coverage);
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Upstream tables use timestamp WITHOUT time zone and drizzle reads them as UTC: raw SQL must write the UTC wall time (never a JS Date, whose local-time string pg would store). */
export const naive = (d: Date): string => d.toISOString().slice(0, -1);
export const T0 = new Date("2026-11-07T10:00:00Z");

export const smallCfg = (o: Partial<RunConfig> = {}): RunConfig => ({
    tickMs: 1000, waitTimeoutMs: 10 * 60_000, stallTimeoutMs: 30 * 60_000, maxRunMs: 6 * 3_600_000, captureWindowMs: 60 * 60_000, maxPerAgent: 1, maxPerOrg: 3,
    hashMaxBytes: 1 << 30, hashTimeoutMs: 60_000, ...o,
});

export type World = {
    org: string; userId: string; agent: string; env: string; stackId: string; project: string; channels: string[];
    members: {linkId: string; databaseId: string; dbms: string; name: string}[];
    clock: {t: Date}; deps: RunDeps;
};

export type WorldOpts = {
    dbms?: string[]; channels?: number; encryption?: boolean; schedule?: Record<string, unknown>; covers?: boolean; userRole?: string; orgRole?: string; cfg?: Partial<RunConfig>;
    deps?: Partial<RunDeps>; agentOrg?: boolean;
    /** Use an organization / user that already exist (the e2e boots a real dashboard whose default org and admin were created by upstream). */
    existing?: {orgId: string; userId: string};
};

export async function setEncryption(p: Pool, on: boolean) {
    await p.query("delete from settings");
    await p.query("insert into settings (name, encryption) values ('w12', $1)", [on]);
}

export async function mkWorld(t: W04Db, o: WorldOpts = {}): Promise<World> {
    const p = t.pool;
    const tag = randomUUID().slice(0, 8);
    const org = o.existing?.orgId ?? (await seedOrg(p, `org-${tag}`));
    const userId = o.existing?.userId ?? randomUUID();
    if (!o.existing) {
        await p.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'admin',$2,true,$3)`, [userId, `${userId}@t.test`, o.userRole ?? "admin"]);
        await p.query("insert into member (organization_id, user_id, role) values ($1,$2,$3)", [org, userId, o.orgRole ?? "owner"]);
        await setEncryption(p, o.encryption ?? true);
    } else {
        await p.query("update settings set encryption=$1", [o.encryption ?? true]);
    }
    const agent = await seedAgent(p, o.agentOrg === false ? null : org, `agent-${tag}`);
    await p.query("update agents set version='1.25.2', last_contact=$2 where id=$1", [agent, naive(T0)]);
    const env = await seedEnvironment(p, await seedConnection(p, org, `c-${tag}`), agent, `agent-${tag}`, tag);
    await p.query("update fork_arcane_environment set enabled=true where id=$1", [env]);
    const channels: string[] = [];
    for (let i = 0; i < (o.channels ?? 1); i++) {
        channels.push((await p.query("insert into storage_channel (organization_id, provider, name, config, enabled) values ($1,'s3',$2,'{}',true) returning id", [org, `s3-${tag}-${i}`])).rows[0].id);
    }
    const project = await seedProject(p, org, `stack:${tag}`);
    const inv = {...cleanInventory(), stack: {...cleanInventory().stack, compose_project: `app-${tag}`, display_name: `app-${tag}`}};
    const stackId = (await p.query("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name, project_id, project_name, protection_state) values ($1,$2,'env',$3,$3,$4,'p','active') returning id", [org, env, `app-${tag}`, project])).rows[0].id as string;
    await p.query("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [stackId, contentHash(inv), JSON.stringify(inv)]);
    await p.query(`insert into fork_stack_policy (stack_id, activated_at, activated_by, schedule, policy, storage_channel_ids, materialize_state, activation)
        values ($1,$2,$3,$4,$5,$6,'ready',$7)`, [stackId, new Date(T0.getTime() - 2 * 86_400_000), userId,
        JSON.stringify(o.schedule ?? {preset: "daily", timezone: "UTC", minute: 0, hour: 2, weekday: 0, monthday: 1}),
        JSON.stringify({keep_last: 3, daily: 7, weekly: 4, monthly: 6, yearly: 0}), channels,
        JSON.stringify({userId, capability: "stacks.backup.manage", aclAgentId: agent, organizationId: org, encryption: true, channelIds: channels, at: T0.toISOString()})]);
    const members: World["members"] = [];
    const kinds = o.dbms ?? ["files", "postgresql"];
    for (const [i, dbms] of kinds.entries()) {
        const name = `${dbms}-${i}`;
        const d = await p.query("insert into databases (name, dbms, agent_id, project_id, config, backup_engine, agent_database_id, last_contact) values ($1,$2,$3,$4,'{}',$5,$6,$7) returning id",
            [name, dbms, agent, project, "archive", randomUUID(), naive(T0)]);
        const covers = o.covers === false || i > 0 ? [] : CLEAN_KEYS;
        const l = await p.query(`insert into fork_stack_source (stack_id, role, resource_key, status, database_id, dbms, engine, member_name, covers_keys, desired_hash, last_probe, last_probe_at)
            values ($1,$2,$3,'active',$4,$5,'archive',$6,$7,$8,'readable',$9) returning id`, [stackId, dbms === "files" ? "compose" : "db", `m:${name}`, d.rows[0].id, dbms, name, covers, "0".repeat(64), T0]);
        members.push({linkId: l.rows[0].id, databaseId: d.rows[0].id, dbms, name});
    }
    const clock = {t: new Date(T0)};
    const deps: RunDeps = {
        db: t.db, now: () => clock.t, cfg: smallCfg(o.cfg), mode: async () => "on", refresh: async () => "ok", owner: `owner-${tag}`,
        hash: async (r) => ({sha256: sha(r.backupStorageId), bytes: r.expectedSize ?? 0}), ...o.deps,
    };
    return {org, userId, agent, env, stackId, project, channels, members, clock, deps};
}

/** Keeps the agent's contact fresh (a silent agent is a blocker of the completeness model after a few minutes). */
export const touchAgent = (p: Pool, w: World) => p.query("update agents set last_contact=$2 where id=$1", [w.agent, naive(w.clock.t)]).then(() => p.query("update databases set last_contact=$2 where agent_id=$1", [w.agent, naive(w.clock.t)]));

const q = (p: Pool, s: string, a: unknown[] = []) => p.query(s, a);
export const waitingBackups = async (p: Pool, w: World) => (await q(p, "select id, database_id, status, deleted_at from backups where database_id = any($1::uuid[]) order by created_at", [w.members.map((m) => m.databaseId)])).rows as {id: string; database_id: string; status: string; deleted_at: Date | null}[];

export const agent = {
    pickUp: (p: Pool, w: World, backupId: string) => q(p, "update backups set status='ongoing', updated_at=$2 where id=$1", [backupId, naive(w.clock.t)]),
    succeed: async (p: Pool, w: World, backupId: string, o: {engine?: "archive" | "restic"; ext?: string; size?: number; channels?: string[]; storageStatus?: string} = {}) => {
        const engine = o.engine ?? "archive";
        for (const [i, ch] of (o.channels ?? w.channels).entries()) {
            const path = engine === "restic" ? sha(`snap-${backupId}-${i}`) : `/backups/${backupId}-${i}${o.ext ?? ".tar.gz.enc"}`;
            await q(p, "insert into backup_storage (backup_id, storage_channel_id, status, path, size, engine, updated_at) values ($1,$2,$3,$4,$5,$6,$7)", [backupId, ch, o.storageStatus ?? "success", path, o.size ?? 1000, engine, naive(w.clock.t)]);
        }
        await q(p, "update backups set status='success', file_size=$2, updated_at=$3 where id=$1", [backupId, o.size ?? 1000, naive(w.clock.t)]);
    },
    fail: (p: Pool, w: World, backupId: string) => q(p, "update backups set status='failed', updated_at=$2 where id=$1", [backupId, naive(w.clock.t)]),
};
