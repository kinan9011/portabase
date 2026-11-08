/** W27a SEC-09: one throw-away world per test — two organizations, a user per role, and one row of every resource kind in org A. */
import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {freshForkDb, seedArtifact, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {seedWorld} from "@/fork/__tests__/w16-world";
import type {Role} from "./roles";

export type SecUser = {id: string; role: string; banned: boolean; orgRole: string | null};
export type SecWorld = {
    t: W04Db; pool: Pool; db: W04Db["db"]; orgA: string; orgB: string;
    users: Record<Exclude<Role, "anon">, SecUser> & {foreignOwner: SecUser};
    ids: {connection: string; environment: string; stack: string; stackRun: string; rp: string; rpArtifact: string; restorePlan: string; restoreRun: string; agent: string; planHash: string; source: string};
    drop: () => Promise<void>;
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
    const rpArtifact = (await pool.query("select id from fork_recovery_point_artifact where rp_id=$1 limit 1", [base.rp])).rows[0].id as string;
    void seedArtifact;
    const stackRun = (await pool.query("insert into fork_stack_run (stack_id, trigger, state) values ($1,'manual','failed') returning id", [base.stack])).rows[0].id as string;
    const planHash = "b".repeat(64);
    const restorePlan = (await pool.query(`insert into fork_restore_plan (organization_id, stack_id, rp_id, rp_sequence, target_agent_name, purpose, mode, plan_version, plan, plan_hash, inputs_digest, outcome, created_by, created_at, expires_at)
        values ($1,$2,$3,1,'host','restore','new_stack',1,'{}',$4,$4,'blocked','u', now(), now() + interval '1 day') returning id`, [orgA, base.stack, base.rp, planHash])).rows[0].id as string;
    const restoreRun = (await pool.query(`insert into fork_restore_run (id, organization_id, stack_id, plan_id, plan_hash, rp_sequence, target_agent_name, purpose, mode, confirmation, started_by, created_at, deadline_at, updated_at)
        values (gen_random_uuid(),$1,$2,$3,$4,1,'host','restore','new_stack','not_required','u', now(), now() + interval '1 day', now()) returning id`, [orgA, base.stack, restorePlan, planHash])).rows[0].id as string;
    const users = {} as SecWorld["users"];
    for (const [k, s] of Object.entries(SPEC)) {
        const id = randomUUID();
        await pool.query(`insert into "user" (id, name, email, email_verified, role, banned) values ($1,$2,$3,true,$4,$5)`, [id, k, `${id}@sec.test`, s.role, s.banned ?? false]);
        if (s.orgRole) await pool.query("insert into member (organization_id, user_id, role) values ($1,$2,$3)", [s.org === "B" ? orgB : orgA, id, s.orgRole]);
        (users as Record<string, SecUser>)[k] = {id, role: s.role, banned: s.banned ?? false, orgRole: s.orgRole};
    }
    return {t, pool, db: t.db, orgA, orgB, users, drop: () => t.drop(),
        ids: {connection: base.conn, environment: base.srcEnv, stack: base.stack, stackRun, rp: base.rp, rpArtifact, restorePlan, restoreRun, agent: base.agent, planHash, source: base.sources.db}};
}
