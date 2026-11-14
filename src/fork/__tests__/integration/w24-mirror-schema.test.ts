import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {freshForkDb, seedAgent, seedConnection, seedEnvironment, seedOrg, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";

let w: W04Db;
let org: string, stack: string, rp: string, agent: string, agent2: string;
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);
const H = (c: string) => c.repeat(64);
let n = 0;

beforeAll(async () => {
    w = await freshForkDb();
    org = await seedOrg(w.pool, "org-w24");
    const conn = await seedConnection(w.pool, org, "c");
    const env = await seedEnvironment(w.pool, conn, null, null, "x");
    stack = await seedStack(w.pool, org, env, "demo");
    rp = await seedRp(w.pool, stack, {status: "verified"});
    agent = await seedAgent(w.pool, org, "runner-1");
    agent2 = await seedAgent(w.pool, org, "runner-2");
});
afterAll(async () => { await w.drop(); });

async function mirror(over: Record<string, unknown> = {}): Promise<string> {
    const name = (over.name as string | undefined) ?? `m${++n}`;
    const r = await q(`insert into fork_mirror (organization_id, stack_id, runner_agent_id, runner_agent_name, name, policy, status, route_port, created_by, created_at, updated_at)
        values ($1,$2,$3,'runner',$4,'{}',$5,$6,'u', now(), now()) returning id`,
        [org, stack, (over.runner as string | undefined) ?? agent, name, (over.status as string | undefined) ?? "creating", over.route ?? null]);
    return r.rows[0].id;
}
async function revision(mirrorId: string, o: Record<string, unknown> = {}) {
    const f = {seq: 1, runner: agent, project: "pbm-demo-r1", port: 41000, state: "requested", reason: null, finished: null, ...o};
    return q(`insert into fork_mirror_revision (mirror_id, organization_id, stack_id, seq, rp_id, rp_sequence, plan_hash, runner_agent_id, project, workspace, host_port, state, reason,
        finished_at, started_by, created_at, deadline_at, updated_at)
        values ($1,$2,$3,$4,$5,1,$6,$7,$8,'/srv/portabase-mirrors/x',$9,$10,$11,$12,'u', now(), now() + interval '4 hours', now()) returning id`,
        [mirrorId, org, stack, f.seq, rp, H("a"), f.runner, f.project, f.port, f.state, f.reason, f.finished]);
}
const rejects = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };

describe("W24 migration 0020_mirror_refresh", () => {
    it("new columns exist and default to NULL", async () => {
        const c = await q("select column_name from information_schema.columns where (table_name = 'fork_mirror' and column_name in ('route_port','route_revision_id','op_revision_id')) or (table_name = 'fork_mirror_revision' and column_name = 'retired_at') order by 1");
        expect(c.rows.map((r) => r.column_name)).toEqual(["op_revision_id", "retired_at", "route_port", "route_revision_id"]);
    });

    it("a second ACTIVE revision of the same mirror violates the per-mirror unique index; a terminal one does not", async () => {
        const m = await mirror({name: "one-active"});
        await revision(m, {seq: 1, state: "staging", runner: agent, port: 41100});
        await rejects(revision(m, {seq: 2, state: "validating", runner: agent2, port: 41101, project: "pbm-demo-r2"}), /fork_mirror_revision_one_active_mirror_uq/);
        const m2 = await mirror({name: "one-active-b"});
        await revision(m2, {seq: 1, state: "failed", reason: "x", finished: new Date(), runner: agent2, port: 41102});
        await revision(m2, {seq: 2, state: "validating", runner: agent2, port: 41103, project: "pbm-demo-r2"}); // terminal r1 does not block r2
    });

    it("route port: unique per runner among live mirrors, range CHECK, freed by soft delete", async () => {
        await mirror({name: "rp-1", route: 41200});
        await rejects(mirror({name: "rp-2", route: 41200}), /fork_mirror_route_port_runner_uq/);
        await mirror({name: "rp-3", route: 41200, runner: agent2}); // other runner: fine
        await rejects(mirror({name: "rp-4", route: 40999}), /fork_mirror_route_port_ck/);
        await rejects(mirror({name: "rp-5", route: 42000}), /fork_mirror_route_port_ck/);
        await q("update fork_mirror set deleted_at = now() where name = 'rp-1'");
        await mirror({name: "rp-6", route: 41200}); // soft-deleted mirror no longer holds the port
    });

    it("status rolling_back, event kinds activated|retired|rolled_back and journal step route are accepted; unknown ones are not", async () => {
        const m = await mirror({name: "vocab", status: "rolling_back"});
        const r = await revision(m, {seq: 1, state: "failed", reason: "x", finished: new Date(), port: 41300});
        const rev = r.rows[0].id as string;
        for (const kind of ["activated", "retired", "rolled_back"]) {
            await q("insert into fork_mirror_event (mirror_id, revision_id, kind, actor_kind, at) values ($1,$2,$3,'system', now())", [m, rev, kind]);
        }
        await rejects(q("insert into fork_mirror_event (mirror_id, revision_id, kind, actor_kind, at) values ($1,$2,'weird','system', now())", [m, rev]), /fork_mirror_event_kind_ck/);
        await q("insert into fork_mirror_task (revision_id, step, attempt, task_type, created_at) values ($1,'route',1,'mirror_route', now())", [rev]);
        await rejects(q("insert into fork_mirror_task (revision_id, step, attempt, task_type, created_at) values ($1,'teleport',1,'mirror_route', now())", [rev]), /fork_mirror_task_step_ck/);
        await rejects(mirror({name: "vocab-bad", status: "rolling_forward"}), /fork_mirror_status_ck/);
    });

    it("route_revision_id / op_revision_id are SET NULL when the revision row goes away", async () => {
        const m = await mirror({name: "fk-null"});
        const r = await revision(m, {seq: 1, state: "failed", reason: "x", finished: new Date(), port: 41400});
        await q("update fork_mirror set route_revision_id = $2, op_revision_id = $2 where id = $1", [m, r.rows[0].id]);
        await q("delete from fork_mirror_revision where id = $1", [r.rows[0].id]);
        const row = await q("select route_revision_id, op_revision_id from fork_mirror where id = $1", [m]);
        expect(row.rows[0]).toEqual({route_revision_id: null, op_revision_id: null});
    });
});
