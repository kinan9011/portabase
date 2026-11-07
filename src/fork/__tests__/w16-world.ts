import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import type {ForkPrincipal} from "@/fork/acl";
import {contentHash, type StackInventoryV1} from "@/fork/inventory/schema";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {seedAgent, seedConnection, seedEnvironment, seedOrg, seedRp, seedStack} from "@/fork/__tests__/w04-helpers";

/** A plannable world in a real Postgres: org, source stack + verified RP + pinned inventory + sources + artifacts, an enrolled target agent in its own environment. */
export type World = {
    org: string; conn: string; srcEnv: string; stack: string; rp: string; inventory: StackInventoryV1; agent: string; agentName: string; tgtEnv: string;
    sources: Record<"compose" | "volume" | "db", string>;
};
export const P = (userId: string, systemRole: string | null, ...m: [string, string][]): ForkPrincipal => ({userId, systemRole, memberships: m.map(([organizationId, role]) => ({organizationId, role}))});
export const uid = () => randomUUID();

export async function seedUser(pool: Pool, role: "admin" | "user" = "user"): Promise<string> {
    const id = randomUUID();
    await pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'u',$2,true,$3)`, [id, `${id}@t.test`, role]);
    return id;
}

export async function seedWorld(pool: Pool, o: {org?: string; project?: string; inventory?: StackInventoryV1; hostRole?: "production" | "test"; syncAt?: Date; caps?: string[]; roots?: string[]} = {}): Promise<World> {
    const org = o.org ?? await seedOrg(pool);
    const conn = await seedConnection(pool, org, `c-${randomUUID().slice(0, 6)}`);
    const srcEnv = await seedEnvironment(pool, conn, null, null, "src");
    const inventory = o.inventory ?? cleanInventory({stack: {compose_project: o.project ?? "app", display_name: "app", compose_read: "arcane_compose", working_dir_hint: "/srv/app", config_files_hint: ["/srv/app/compose.yml"]}});
    const project = inventory.stack.compose_project;
    const stack = await seedStack(pool, org, srcEnv, project);
    await pool.query("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [stack, contentHash(inventory), JSON.stringify(inventory)]);
    const rp = await seedRp(pool, stack, {status: "verified", required: 3});
    await pool.query("update fork_recovery_point set manifest_sha256=$2, manifest_sig_kid=$3, inventory_version=1, inventory_hash=$4, consistency_level='mixed' where id=$1", [rp, "a".repeat(64), "0123456789ab", contentHash(inventory)]);
    const src = async (role: string, key: string, dbms: string, member: string, covers: string[] = []) => (await pool.query(
        "insert into fork_stack_source (stack_id, role, resource_key, dbms, engine, member_name, covers_keys, desired_hash) values ($1,$2,$3,$4,'archive',$5,$6,$7) returning id", [stack, role, key, dbms, member, covers, "c".repeat(64)])).rows[0].id as string;
    const sources = {compose: await src("compose", `dir:${inventory.stack.working_dir_hint ?? "/srv/app"}`, "files", "compose_app", ["file:/srv/app/compose.yml", "env:implicit"]), volume: await src("volume", "volume:app_data", "docker-volume", "volume_app_data"), db: await src("db", "db:db", "postgresql", "db_db")};
    const chan = (await pool.query("insert into storage_channel (organization_id, provider, name, config, enabled) values ($1,'s3','s3-x','{}',true) returning id", [org])).rows[0].id as string;
    const art = async (source: string, name: string, engine: string, n: number) => pool.query(
        `insert into fork_recovery_point_artifact (rp_id, stack_source_id, source_name, engine, archive_kind, encrypted, channel_id, channel_kind, plaintext_sha256, plaintext_size, required, presence)
         values ($1,$2,$3,$4,'archive_enc',true,$5,'s3',$6,1000,true,'present')`, [rp, source, name, engine, chan, String(n).repeat(64)]);
    await art(sources.compose, "compose_app", "files", 1); await art(sources.volume, "volume_app_data", "docker-volume", 2); await art(sources.db, "db_db", "postgresql", 3);

    const agentName = `restore-host-${randomUUID().slice(0, 6)}`;
    const agent = await seedAgent(pool, org, agentName);
    await pool.query("insert into fork_agent_enrollment (agent_id, credential_hash, task_key_enc, pin_fingerprint, enrolled_by, capabilities) values ($1,$2,'{}',$3,'u',$4)",
        [agent, "d".repeat(64), "f".repeat(8), o.caps ?? ["channel.v1", "restore.target.v1", "compose.render.v1"]]);
    const tgtEnv = await seedEnvironment(pool, conn, agent, agentName, "tgt");
    await pool.query("update fork_arcane_environment set host_role=$2, last_sync_status='ok', last_sync_at=$3, allowed_path_roots=$4 where id=$1", [tgtEnv, o.hostRole ?? "production", o.syncAt ?? new Date(Date.now() + 2 * 86_400_000), o.roots ?? []]);
    return {org, conn, srcEnv, stack, rp, inventory, agent, agentName, tgtEnv, sources};
}

export const req = (w: World, over: Record<string, unknown> = {}) => ({rpId: w.rp, targetAgentId: w.agent, purpose: "restore", mode: "new_stack",
    mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: null, sqlite: null}, ...over});
