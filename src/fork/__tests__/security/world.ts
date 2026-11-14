/** W27a SEC-09: one throw-away world per test — two organizations, a user per role, and one row of every resource kind in org A. */
import {randomUUID} from "node:crypto";
import {randomBytes} from "node:crypto";
import {drizzle} from "drizzle-orm/node-postgres";
import {Pool} from "pg";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import type {ForkDb} from "@/fork/db/handle";
import {freshForkDb, seedArtifact, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {seedWorld} from "@/fork/__tests__/w16-world";
import type {Role} from "./roles";

export type SecUser = {id: string; role: string; banned: boolean; orgRole: string | null};
export type SecWorld = {
    t: W04Db; pool: Pool; db: W04Db["db"]; orgA: string; orgB: string;
    users: Record<Exclude<Role, "anon">, SecUser> & {foreignOwner: SecUser};
    ids: {connection: string; environment: string; stack: string; stackRun: string; rp: string; rpArtifact: string; restorePlan: string; restoreRun: string; agent: string; planHash: string; source: string; mirror: string; mirrorRevision: string};
    drop: () => Promise<void>;
    /** template name (set on the seeded template only) */
    name: string;
};

const SPEC: Record<Exclude<Role, "anon"> | "foreignOwner", {role: string; banned?: boolean; orgRole: string | null; org?: "B"}> = {
    pending: {role: "pending", orgRole: "owner"}, banned: {role: "user", banned: true, orgRole: "owner"},
    member: {role: "user", orgRole: "member"}, orgAdmin: {role: "user", orgRole: "admin"}, owner: {role: "user", orgRole: "owner"},
    sysAdmin: {role: "admin", orgRole: null}, superOwner: {role: "superadmin", orgRole: "owner"},
    foreignOwner: {role: "user", orgRole: "owner", org: "B"},
};

export async function seedSecWorld(): Promise<SecWorld> {
    const t = await freshForkDb();
    const {pool} = t;
    const orgA = await seedOrg(pool, "sec-a");
    const orgB = await seedOrg(pool, "sec-b");
    const base = await seedWorld(pool, {org: orgA});
    // a connection WITH an encrypted key (needs PRIVATE_PATH): test/rotate/disconnect read it
    const keyed = (await insertConnectionWithSecret(t.db, {organizationId: orgA, name: "arcane-sec", baseUrl: "http://127.0.0.1:9", apiKey: "arcane_sec_not_a_real_key_0123456789"})).id;
    const rpArtifact = (await pool.query("select id from fork_recovery_point_artifact where rp_id=$1 limit 1", [base.rp])).rows[0].id as string;
    void seedArtifact;
    const stackRun = (await pool.query("insert into fork_stack_run (stack_id, trigger, state) values ($1,'manual','failed') returning id", [base.stack])).rows[0].id as string;
    const planHash = "b".repeat(64);
    const restorePlan = (await pool.query(`insert into fork_restore_plan (organization_id, stack_id, rp_id, rp_sequence, target_agent_name, purpose, mode, plan_version, plan, plan_hash, inputs_digest, outcome, created_by, created_at, expires_at)
        values ($1,$2,$3,1,'host','restore','new_stack',1,'{}',$4,$4,'blocked','u', now(), now() + interval '1 day') returning id`, [orgA, base.stack, base.rp, planHash])).rows[0].id as string;
    const restoreRun = (await pool.query(`insert into fork_restore_run (id, organization_id, stack_id, plan_id, plan_hash, rp_sequence, target_agent_name, purpose, mode, confirmation, started_by, created_at, deadline_at, updated_at)
        values (gen_random_uuid(),$1,$2,$3,$4,1,'host','restore','new_stack','not_required','u', now(), now() + interval '1 day', now()) returning id`, [orgA, base.stack, restorePlan, planHash])).rows[0].id as string;
    const mirror = (await pool.query(`insert into fork_mirror (organization_id, stack_id, runner_agent_name, name, policy, status, created_by, created_at, updated_at) values ($1,$2,'runner','sec-mirror','{}','failed','u',now(),now()) returning id`, [orgA, base.stack])).rows[0].id as string;
    const mirrorRevision = (await pool.query(`insert into fork_mirror_revision (mirror_id, organization_id, stack_id, seq, rp_sequence, plan_hash, project, workspace, host_port, state, reason, finished_at, wipe_state, started_by, created_at, deadline_at, updated_at)
        values ($1,$2,$3,1,1,$4,'pbm-sec-r1','/srv/portabase-mirrors/pbm-sec-r1',41000,'failed','x_y',now(),'failed','u',now(),now(),now()) returning id`, [mirror, orgA, base.stack, planHash])).rows[0].id as string;
    const users = {} as SecWorld["users"];
    for (const [k, s] of Object.entries(SPEC)) {
        const id = randomUUID();
        await pool.query(`insert into "user" (id, name, email, email_verified, role, banned) values ($1,$2,$3,true,$4,$5)`, [id, k, `${id}@sec.test`, s.role, s.banned ?? false]);
        if (s.orgRole) await pool.query("insert into member (organization_id, user_id, role) values ($1,$2,$3)", [s.org === "B" ? orgB : orgA, id, s.orgRole]);
        (users as Record<string, SecUser>)[k] = {id, role: s.role, banned: s.banned ?? false, orgRole: s.orgRole};
    }
    return {t, pool, db: t.db, orgA, orgB, users, name: t.name, drop: () => t.drop(),
        ids: {connection: keyed, environment: base.srcEnv, stack: base.stack, stackRun, rp: base.rp, rpArtifact, restorePlan, restoreRun, agent: base.agent, planHash, source: base.sources.db, mirror, mirrorRevision}};
}

const adminUrl = () => process.env.FORK_TEST_DATABASE_URL!;

/** Closes the template's connections (CREATE DATABASE ... TEMPLATE needs the template idle). */
export async function sealTemplate(w: SecWorld): Promise<void> { await w.pool.end(); }

/** A private copy of a sealed template world: one test (or one denied-calls batch) mutates freely, nothing leaks between tests. */
export async function cloneWorld(tpl: SecWorld): Promise<SecWorld> {
    const name = `w27_${randomBytes(6).toString("hex")}`;
    const admin = new Pool({connectionString: adminUrl(), max: 1});
    await admin.query(`create database ${name} template ${tpl.name}`);
    await admin.end();
    const u = new URL(adminUrl());
    u.pathname = `/${name}`;
    const pool = new Pool({connectionString: u.toString(), max: 4});
    const drop = async () => {
        await pool.end();
        const a = new Pool({connectionString: adminUrl(), max: 1});
        await a.query(`drop database if exists ${name} with (force)`);
        await a.end();
    };
    return {...tpl, pool, db: drizzle({client: pool}) as unknown as ForkDb, drop, name, t: {...tpl.t, pool, drop, name}};
}
