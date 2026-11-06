import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {drizzle} from "drizzle-orm/node-postgres";
import {runForkMigrations} from "@/fork/db/migrate";
import type {ForkDb} from "@/fork/db/handle";
import {applyUpstreamMigrations, createTestDb, type TestDb} from "@/fork/__tests__/db-helpers";

export type W04Db = TestDb & {db: ForkDb};

/** Fresh DB with the REAL upstream migrations + the fork lane (all migrations). */
export async function freshForkDb(): Promise<W04Db> {
    const t = await createTestDb();
    await applyUpstreamMigrations(t.pool);
    const lane = await runForkMigrations({databaseUrl: t.url, env: {NODE_ENV: "development"}});
    if (lane.state !== "applied") throw new Error(`lane ${lane.state}`);
    return {...t, db: drizzle({client: t.pool}) as unknown as ForkDb};
}

const q = (p: Pool, sql: string, params: unknown[] = []) => p.query(sql, params);

export async function seedOrg(p: Pool, name = `org-${randomUUID().slice(0, 8)}`): Promise<string> {
    const r = await q(p, "insert into organization (name, slug) values ($1, $2) returning id", [name, `${name}-${randomUUID().slice(0, 6)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")]);
    return r.rows[0].id;
}
export async function seedAgent(p: Pool, orgId: string | null, name = `agent-${randomUUID().slice(0, 8)}`): Promise<string> {
    const r = await q(p, "insert into agents (slug, name, description, organization_id) values ($1, $2, 'd', $3) returning id", [`${name}-${randomUUID().slice(0, 6)}`, name, orgId]);
    return r.rows[0].id;
}
export async function seedChannel(p: Pool, orgId: string | null, name = `chan-${randomUUID().slice(0, 8)}`): Promise<string> {
    const r = await q(p, "insert into storage_channel (organization_id, provider, name, config, enabled) values ($1, 'local', $2, '{}', true) returning id", [orgId, name]);
    return r.rows[0].id;
}
export async function seedProject(p: Pool, orgId: string, name = `proj-${randomUUID().slice(0, 8)}`): Promise<string> {
    const cols = await q(p, "select column_name from information_schema.columns where table_name='projects' and is_nullable='NO' and column_default is null");
    const names = cols.rows.map((c) => c.column_name);
    const vals: Record<string, unknown> = {name, slug: `${name}-${randomUUID().slice(0, 6)}`, organization_id: orgId};
    const use = Object.keys(vals).filter((k) => names.includes(k) || k === "name");
    const r = await q(p, `insert into projects (${use.join(",")}) values (${use.map((_, i) => `$${i + 1}`).join(",")}) returning id`, use.map((k) => vals[k]));
    return r.rows[0].id;
}
/** database(agent) → backup → backup_storage(channel). */
export async function seedBackup(p: Pool, agentId: string, channelId: string) {
    const d = await q(p, "insert into databases (name, dbms, agent_id) values ($1, 'postgresql', $2) returning id", [`db-${randomUUID().slice(0, 6)}`, agentId]);
    const b = await q(p, "insert into backups (database_id, status) values ($1, 'success') returning id", [d.rows[0].id]);
    const s = await q(p, "insert into backup_storage (backup_id, storage_channel_id, status, path) values ($1, $2, 'success', 'p') returning id", [b.rows[0].id, channelId]);
    return {databaseId: d.rows[0].id as string, backupId: b.rows[0].id as string, backupStorageId: s.rows[0].id as string};
}
export async function seedConnection(p: Pool, orgId: string, name = "arcane") {
    const r = await q(p, "insert into fork_arcane_connection (organization_id, name, base_url, api_key_enc) values ($1,$2,'https://arcane.lab',$3) returning id", [orgId, name, JSON.stringify({kid: "k000000000000", iv: "x", ct: "x", tag: "x"})]);
    return r.rows[0].id as string;
}
export async function seedEnvironment(p: Pool, connId: string, agentId: string | null = null, agentName: string | null = null, ext = "0") {
    const r = await q(p, "insert into fork_arcane_environment (connection_id, external_id, name, agent_id, agent_name) values ($1,$2,'env',$3,$4) returning id", [connId, ext, agentId, agentName]);
    return r.rows[0].id as string;
}
export async function seedStack(p: Pool, orgId: string, envId: string | null, composeProject = "demo", projectId: string | null = null, projectName: string | null = null) {
    const r = await q(p, "insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name, project_id, project_name) values ($1,$2,'env',$3,$3,$4,$5) returning id", [orgId, envId, composeProject, projectId, projectName]);
    return r.rows[0].id as string;
}
export async function seedRp(p: Pool, stackId: string, o: {status?: string; seq?: number; required?: number} = {}) {
    const r = await q(p, `insert into fork_recovery_point (stack_id, stack_name, sequence, status, required_artifact_count, verified_at)
        values ($1,'demo',$2,$3,$4, case when $3='verified' then now() end) returning id`, [stackId, o.seq ?? 1, o.status ?? "verified", o.required ?? 1]);
    return r.rows[0].id as string;
}
export async function seedArtifact(p: Pool, rpId: string, o: {backupId?: string | null; backupStorageId?: string | null; channelId?: string | null; presence?: string} = {}) {
    const r = await q(p, `insert into fork_recovery_point_artifact (rp_id, backup_id, backup_storage_id, source_name, engine, archive_kind, encrypted, channel_id, channel_kind, generated_id, size_bytes, presence)
        values ($1,$2,$3,'pg','postgresql','archive_enc',true,$4,'local','gen-1',123,$5) returning id`, [rpId, o.backupId ?? null, o.backupStorageId ?? null, o.channelId ?? null, o.presence ?? "present"]);
    return r.rows[0].id as string;
}
