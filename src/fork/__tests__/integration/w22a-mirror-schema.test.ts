import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {freshForkDb, seedAgent, seedConnection, seedEnvironment, seedOrg, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";

let w: W04Db;
let org: string, stack: string, rp: string, agent: string, agent2: string;
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);
const H = (c: string) => c.repeat(64);
let n = 0;

beforeAll(async () => {
    w = await freshForkDb();
    org = await seedOrg(w.pool, "org-w22a");
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
    const r = await q(`insert into fork_mirror (organization_id, stack_id, runner_agent_id, runner_agent_name, name, policy, created_by, created_at, updated_at)
        values ($1,$2,$3,'runner',$4,'{}','u', now(), now()) returning id`, [org, stack, (over.runner as string | undefined) ?? agent, name]);
    return r.rows[0].id;
}
async function revision(mirrorId: string, o: Record<string, unknown> = {}) {
    const f = {seq: 1, runner: agent, project: "pbm-demo-r1", port: 41000, state: "requested", reason: null, finished: null, readied: null, final: null, spec: null, probe: null, wipe: null, steps: "[]", ...o};
    return q(`insert into fork_mirror_revision (mirror_id, organization_id, stack_id, seq, rp_id, rp_sequence, plan_hash, runner_agent_id, project, workspace, host_port, state, reason, steps,
        final_view_sha256, spec_sha256, probe_task_id, readied_at, finished_at, wipe_state, started_by, created_at, deadline_at, updated_at)
        values ($1,$2,$3,$4,$5,1,$6,$7,$8,'/srv/portabase-mirrors/x',$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,'u', now(), now() + interval '4 hours', now()) returning id`,
        [mirrorId, org, stack, f.seq, rp, H("a"), f.runner, f.project, f.port, f.state, f.reason, f.steps, f.final, f.spec, f.probe, f.readied, f.finished, f.wipe]);
}
const rejects = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };

describe("W22a migration 0018_mirror", () => {
    it("applies on a fresh DB: the four tables + stack opt-in columns exist", async () => {
        const t = await q("select table_name from information_schema.tables where table_name like 'fork_mirror%' order by 1");
        expect(t.rows.map((r) => r.table_name)).toEqual(["fork_mirror", "fork_mirror_event", "fork_mirror_revision", "fork_mirror_task"]);
        const c = await q("select column_name from information_schema.columns where table_name = 'fork_stack' and column_name like 'mirror_opt_in%' order by 1");
        expect(c.rows.map((r) => r.column_name)).toEqual(["mirror_opt_in_at", "mirror_opt_in_by"]);
    });

    it("CHECKs: name, project, port, state, workspace-less ready, oversized jsonb", async () => {
        await rejects(mirror({name: "Bad_Name"}), /fork_mirror_name_ck/);
        await rejects(mirror({name: "-x"}), /fork_mirror_name_ck/);
        const m = await mirror({name: "checks"});
        await rejects(revision(m, {project: "demo-r1"}), /fork_mirror_revision_project_ck/);
        await rejects(revision(m, {port: 40999}), /fork_mirror_revision_port_ck/);
        await rejects(revision(m, {port: 42000}), /fork_mirror_revision_port_ck/);
        await rejects(revision(m, {state: "weird", finished: new Date()}), /fork_mirror_revision_state_ck/);
        await rejects(revision(m, {state: "failed", finished: new Date()}), /fork_mirror_revision_failed_ck/); // failed needs a reason
        await rejects(revision(m, {state: "failed", reason: "BAD CODE", finished: new Date()}), /fork_mirror_revision_reason_ck/);
        await rejects(revision(m, {state: "blocked", reason: "compile_refused"}), /fork_mirror_revision_final_ck/); // terminal needs finished_at
        await rejects(revision(m, {steps: JSON.stringify([{pad: "x".repeat(70000)}])}), /fork_mirror_revision_size_ck/);
        await rejects(q("insert into fork_mirror (organization_id, stack_id, runner_agent_name, name, policy, created_by, created_at, updated_at) values ($1,$2,'r','okname',$3,'u',now(),now())", [org, stack, JSON.stringify({pad: "x".repeat(20000)})]), /fork_mirror_policy_size_ck/);
    });

    it("`ready` needs readied_at, final view, spec and a probe task (the start-tested fact is a complete row)", async () => {
        const m = await mirror({name: "ready-ck"});
        await rejects(revision(m, {state: "ready", finished: new Date()}), /fork_mirror_revision_ready_ck/);
        await rejects(revision(m, {state: "ready", finished: new Date(), readied: new Date(), final: H("b"), spec: H("c")}), /fork_mirror_revision_ready_ck/); // no probe task
    });

    it("one ACTIVE revision per runner; a terminal one frees the runner", async () => {
        const m1 = await mirror({name: "act-1"});
        const m2 = await mirror({name: "act-2"});
        await revision(m1, {state: "staging", runner: agent2, port: 41010});
        await rejects(revision(m2, {state: "validating", runner: agent2, port: 41011}), /fork_mirror_revision_one_active_runner_uq/);
        await revision(m2, {state: "failed", reason: "run_timeout", finished: new Date(), runner: agent2, port: 41012, wipe: "verified"});
    });

    it("loopback port is unique per runner while the copy may still exist; a verified/not_needed wipe frees it; another runner may reuse it", async () => {
        const m1 = await mirror({name: "port-1"});
        const m2 = await mirror({name: "port-2"});
        const m3 = await mirror({name: "port-3"});
        await revision(m1, {state: "failed", reason: "smoke_failed", finished: new Date(), port: 41100, wipe: "running"});
        await rejects(revision(m2, {state: "failed", reason: "smoke_failed", finished: new Date(), port: 41100, wipe: null}), /fork_mirror_revision_port_runner_uq/);
        await revision(m3, {state: "failed", reason: "smoke_failed", finished: new Date(), port: 41101, wipe: "verified"});
        await revision(m2, {state: "failed", reason: "smoke_failed", finished: new Date(), port: 41101, wipe: "not_needed"}); // verified wipe released 41101
        await revision(await mirror({name: "port-4"}), {state: "failed", reason: "smoke_failed", finished: new Date(), port: 41100, runner: agent2, wipe: "running"}); // other runner
    });

    it("(mirror, seq) is unique; mirror names are unique per org while not deleted", async () => {
        const m = await mirror({name: "seq"});
        await revision(m, {seq: 1, state: "failed", reason: "x_y", finished: new Date(), port: 41200, wipe: "verified"});
        await rejects(revision(m, {seq: 1, state: "failed", reason: "x_y", finished: new Date(), port: 41201, wipe: "verified"}), /fork_mirror_revision_seq_uq/);
        await rejects(mirror({name: "seq"}), /fork_mirror_org_name_uq/);
        await q("update fork_mirror set deleted_at = now() where name = 'seq'");
        await mirror({name: "seq"}); // a deleted mirror frees its name
    });

    it("event + task journal CHECKs", async () => {
        const m = await mirror({name: "events"});
        await rejects(q("insert into fork_mirror_event (mirror_id, kind, actor_kind, at) values ($1,'nope','system',now())", [m]), /fork_mirror_event_kind_ck/);
        await rejects(q("insert into fork_mirror_event (mirror_id, kind, actor_kind, at) values ($1,'ready','robot',now())", [m]), /fork_mirror_event_actor_ck/);
        await rejects(q("insert into fork_mirror_event (mirror_id, kind, actor_kind, code, at) values ($1,'failed','system','Bad Code',now())", [m]), /fork_mirror_event_code_ck/);
        await q("insert into fork_mirror_event (mirror_id, kind, actor_kind, at) values ($1,'requested','user',now())", [m]);
        const rev = (await revision(m, {state: "failed", reason: "x_y", finished: new Date(), port: 41300, wipe: "verified"})).rows[0].id;
        await rejects(q("insert into fork_mirror_task (revision_id, step, attempt, task_type, created_at) values ($1,'nope',1,'mirror_probe',now())", [rev]), /fork_mirror_task_step_ck/);
        await rejects(q("insert into fork_mirror_task (revision_id, step, attempt, task_type, created_at) values ($1,'stage',0,'mirror_stage',now())", [rev]), /fork_mirror_task_attempt_ck/);
        await q("insert into fork_mirror_task (revision_id, step, attempt, task_type, created_at) values ($1,'stage',1,'mirror_stage',now())", [rev]);
        // W23 (0019): the stop step is a journal step
        await q("insert into fork_mirror_task (revision_id, step, attempt, task_type, created_at) values ($1,'stop',1,'mirror_stop',now())", [rev]);
        await rejects(q("insert into fork_mirror_task (revision_id, step, attempt, task_type, created_at) values ($1,'stage',1,'mirror_stage',now())", [rev]), /fork_mirror_task_step_attempt_uq/);
    });

    it("stack opt-in columns are all-or-nothing", async () => {
        await rejects(q("update fork_stack set mirror_opt_in_at = now() where id = $1", [stack]), /fork_stack_mirror_opt_in_ck/);
        await q("update fork_stack set mirror_opt_in_at = now(), mirror_opt_in_by = 'u' where id = $1", [stack]);
        await q("update fork_stack set mirror_opt_in_at = null, mirror_opt_in_by = null where id = $1", [stack]);
    });

    it("fork_restore_plan accepts purpose mirror; fork_restore_run still rejects purpose and mode mirror", async () => {
        const plan = async (purpose: string) => q(`insert into fork_restore_plan (organization_id, stack_id, rp_id, rp_sequence, target_agent_name, purpose, mode, plan_version, plan, plan_hash, inputs_digest, outcome, created_by, created_at, expires_at)
            values ($1,$2,$3,1,'host',$4,'new_stack',2,'{}',$5,$5,'blocked','u', now(), now() + interval '1 day') returning id`, [org, stack, rp, purpose, H("b")]);
        const id = (await plan("mirror")).rows[0].id;
        await rejects(plan("nonsense"), /fork_restore_plan_purpose_ck/);
        const run = (purpose: string, mode: string) => q(`insert into fork_restore_run (id, organization_id, stack_id, plan_id, plan_hash, rp_sequence, target_agent_name, purpose, mode, confirmation, started_by, created_at, deadline_at, updated_at)
            values (gen_random_uuid(),$1,$2,$3,$4,1,'host',$5,$6,'not_required','u', now(), now() + interval '1 day', now())`, [org, stack, id, H("b"), purpose, mode]);
        await rejects(run("mirror", "new_stack"), /fork_restore_run_purpose_ck/);
        await rejects(run("restore", "mirror"), /fork_restore_run_mode_ck/);
    });

    it("deleting the organization cascades the mirror rows (runner-side data is NOT wiped by a cascade: recorded residual, W25)", async () => {
        const o2 = await seedOrg(w.pool, "org-cascade");
        const c2 = await seedConnection(w.pool, o2, "c2");
        const e2 = await seedEnvironment(w.pool, c2, null, null, "y");
        const s2 = await seedStack(w.pool, o2, e2, "demo2");
        const m = (await q(`insert into fork_mirror (organization_id, stack_id, runner_agent_name, name, policy, created_by, created_at, updated_at) values ($1,$2,'r','cascade','{}','u',now(),now()) returning id`, [o2, s2])).rows[0].id;
        await q("insert into fork_mirror_event (mirror_id, kind, actor_kind, at) values ($1,'requested','system',now())", [m]);
        await q("delete from organization where id = $1", [o2]);
        expect((await q("select count(*)::int as n from fork_mirror where id = $1", [m])).rows[0].n).toBe(0);
        expect((await q("select count(*)::int as n from fork_mirror_event where mirror_id = $1", [m])).rows[0].n).toBe(0);
    });
});
