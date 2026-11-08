import {randomUUID} from "node:crypto";
import {rmSync} from "node:fs";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {verifyAuditChain} from "@/fork/audit";
import {setRestoreOverrides} from "@/fork/config/service";
import {enqueueRestoreTask} from "@/fork/restore-tasks/enqueue";
import {approveRestorePolicy, cancelRestoreRun, cleanupRestoreRun, startRestoreRun} from "@/fork/restore-run/service";
import {getRestoreRunView, listRestoreRuns, RestoreRunView} from "@/fork/restore-run/view";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {harness, CAPS, DOC, type Harness} from "@/fork/__tests__/w18a-world";
import {adminUser, newKek, seedW17World} from "@/fork/__tests__/w17-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string; let h: Harness;
const key = testKeypair();

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { h = harness(t, kek, key, org); h.reset(); });

const world = (o: {hostRole?: "production" | "test"; caps?: string[]} = {}) => seedW17World(t, kek, key, admin, {org, caps: o.caps ?? CAPS, hostRole: o.hostRole ?? "test"});
const FLAGGED = {...DOC, services: {...DOC.services, web: {...DOC.services.web, privileged: true}}};
const FLAGGED2 = {...DOC, services: {...DOC.services, web: {...DOC.services.web, privileged: true, cap_add: ["SYS_ADMIN"]}}};
const POISON = {...DOC, services: {...DOC.services, web: {...DOC.services.web, env_file: [{path: "/etc/passwd"}]}}};
const projectOf = async (planId: string) => (await h.q("select plan->'target'->>'project' p from fork_restore_plan where id=$1", [planId]))[0].p as string;
const SEL = {select: ["dir:/srv/app", "volume:app_data"], mode: "selective" as const};

describe("W18a policy approval (W20a token bound to the compose hash) on a run", () => {
    it("a privileged render parks the run in awaiting_approval (one notification); admin is denied, a wrong phrase is refused, the owner approves; the run finishes", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const s = await h.start(d, await h.plan(w));
        if (!s.ok) throw new Error(s.code);
        let r = await h.drive(d, w, s.runId, {compose_render: {doc: FLAGGED}});
        expect(r.state).toBe("awaiting_approval");
        expect((await h.q("select count(*)::int n from fork_notification_outbox where kind='restore.needs_approval' and dedupe_key like $1", [`restore:${s.runId}:approval:%`]))[0].n).toBe(1);
        await h.tick(d, s.runId); // idempotent: still waiting, still ONE notification
        expect((await h.q("select count(*)::int n from fork_notification_outbox where kind='restore.needs_approval' and dedupe_key like $1", [`restore:${s.runId}:approval:%`]))[0].n).toBe(1);
        const view = await getRestoreRunView(h.deps(w, starter), {runId: s.runId});
        expect(view.ok && view.view.awaiting).toMatchObject({kind: "policy_approval", services: [{service: "web", phrase: "ALLOW web"}]});

        expect(await approveRestorePolicy(h.deps(w, starter), {runId: s.runId, confirmations: {web: "ALLOW web"}})).toMatchObject({ok: false, code: "forbidden"}); // org admin ≠ owner
        const owner = await h.user("owner");
        expect(await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {web: "allow web"}})).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {}})).toMatchObject({ok: false, code: "missing_confirmation"});
        expect(await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {db: "ALLOW db"}})).toMatchObject({ok: false, code: "service_not_flagged"});
        const ok = await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {web: "ALLOW web"}});
        expect(ok).toMatchObject({ok: true, services: 1});
        expect(await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {web: "ALLOW web"}}).then((x) => x.ok)).toBe(true); // re-approving an awaiting run is allowed (token replaced by an identical one)
        r = await h.drive(d, w, s.runId, {compose_render: {doc: FLAGGED}});
        expect(r).toMatchObject({state: "succeeded", verification: "started"});
        expect(r.policy_approval_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.policy_approved_by).toBe(owner.userId);
        const audit = (await h.q("select redacted_details d from fork_audit_event where action='fork.restore.policy_override' and resource_id=$1", [s.runId]))[0].d;
        expect(audit).toMatchObject({runId: s.runId, services: 1, rules: ["privileged"]});
        expect(JSON.stringify(audit)).not.toContain("web"); // no service names in the audit
        // not awaiting any more
        expect(await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {web: "ALLOW web"}})).toMatchObject({ok: false, code: "not_awaiting"});
        expect(await verifyAuditChain(t.db)).toMatchObject({ok: true});
    });

    it("an override changed after the render: a NEW render task, the old token is cleared when the compose changed, and the run waits for a fresh approval", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const c = await h.plan(w);
        const ovd = {db: t.db, principal: starter, kekDir: kek, now: h.now, configAllowed: async () => true};
        expect(await setRestoreOverrides(ovd, {planId: c.planId, planHash: c.planHash, set: [], overrideYml: "services:\n  web:\n    privileged: true\n"})).toMatchObject({ok: true});
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        const owner = await h.user("owner");
        let r = await h.drive(d, w, s.runId, {compose_render: {doc: FLAGGED}});
        expect(r.state).toBe("awaiting_approval");
        expect(await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {web: "ALLOW web"}})).toMatchObject({ok: true});
        // the operator edits the override AFTER approving, before the tick consumed the approval
        expect(await setRestoreOverrides(ovd, {planId: c.planId, planHash: c.planHash, set: [], overrideYml: "services:\n  web:\n    privileged: true\n    cap_add: [SYS_ADMIN]\n"})).toMatchObject({ok: true});
        await h.tick(d, s.runId); // new render task enqueued (override revision bumped)
        expect((await h.journal(s.runId)).filter((x) => x.step === "render").map((x) => [x.attempt, x.override_revision])).toEqual([[2, 2], [1, 1]].reverse());
        await h.agentStep(w, {compose_render: {doc: FLAGGED2}});
        await h.tick(d, s.runId);
        r = await h.run(s.runId);
        expect(r.state).toBe("awaiting_approval");
        expect(r.policy_approval).toBeNull(); // the token was bound to the old compose bytes
        expect((await h.q("select count(*)::int n from fork_notification_outbox where kind='restore.needs_approval' and dedupe_key like $1", [`restore:${s.runId}:approval:%`]))[0].n).toBe(2);
        expect(await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {web: "ALLOW web"}})).toMatchObject({ok: true});
        expect(await h.drive(d, w, s.runId, {compose_render: {doc: FLAGGED2}})).toMatchObject({state: "succeeded"});
    });

    it("a hard-refused render (reads outside the root) fails the run policy_refused; no restore_db / compose_up task", async () => {
        const w = await world();
        const d = h.deps(w, await h.user("admin"));
        const s = await h.start(d, await h.plan(w));
        if (!s.ok) throw new Error(s.code);
        const r = await h.drive(d, w, s.runId, {compose_render: {doc: POISON}});
        expect(r).toMatchObject({state: "failed", reason: "policy_refused", failed_step: "render"});
        expect((await h.journal(s.runId)).map((x) => x.step)).toEqual(["probe", "stage", "apply", "render"]);
    });

    it("override edited between approval and enqueue is rejected by approve (render_stale) — never an approval for an old render", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const c = await h.plan(w);
        const ovd = {db: t.db, principal: starter, kekDir: kek, now: h.now, configAllowed: async () => true};
        await setRestoreOverrides(ovd, {planId: c.planId, planHash: c.planHash, set: [], overrideYml: "services:\n  web:\n    privileged: true\n"});
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        await h.drive(d, w, s.runId, {compose_render: {doc: FLAGGED}});
        await setRestoreOverrides(ovd, {planId: c.planId, planHash: c.planHash, set: [], overrideYml: "services:\n  web:\n    privileged: true\n    cap_add: [SYS_ADMIN]\n"});
        const owner = await h.user("owner");
        expect(await approveRestorePolicy(h.deps(w, owner), {runId: s.runId, confirmations: {web: "ALLOW web"}})).toMatchObject({ok: false, code: "render_stale"});
    });
});

describe("W18a enqueue refusals inside a run", () => {
    it("a permanent refusal fails the step with the exact code and enqueues nothing; a transient one (rate limit) only waits", async () => {
        const w = await world();
        const starter = await h.user("admin");
        let limited = true;
        const d = h.deps(w, starter, {rate: (_k, _l, _w, _n) => (limited ? {ok: false, retryAfterSeconds: 5} : {ok: true, remaining: 1})});
        const s = await h.start(h.deps(w, starter), await h.plan(w, SEL));
        if (!s.ok) throw new Error(s.code);
        await h.tick(d, s.runId); // verify ok; probe enqueue rate-limited
        expect(await h.tasks(w.agent)).toEqual([]);
        expect((await h.run(s.runId)).state).toBe("running");
        limited = false;
        await h.tick(d, s.runId);
        expect((await h.tasks(w.agent)).length).toBe(1);
        await h.agentStep(w); // the probe is served
        await pool.query("update fork_agent_enrollment set enabled=false where agent_id=$1", [w.agent]); // the operator disables the target mid-run
        await h.tick(d, s.runId); // probe checked, the stage enqueue is refused: permanent
        const r = await h.run(s.runId);
        expect({state: r.state, reason: r.reason, step: r.failed_step}).toEqual({state: "failed", reason: "stale", step: "stage"});
        expect((await h.tasks(w.agent)).length).toBe(1); // nothing was enqueued for the refused step
        await pool.query("update fork_agent_enrollment set enabled=true where agent_id=$1", [w.agent]);
    });
});

describe("W18a start: typed confirmation bound to the plan hash, refusals, IDOR", () => {
    it("production target: confirm required, bound to RESTORE <project>; another plan's hash ⇒ hash_mismatch; a test host needs none", async () => {
        const w = await world({hostRole: "production"});
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const c = await h.plan(w, SEL);
        const project = await projectOf(c.planId);
        const base = {planId: c.planId, planHash: c.planHash, acceptMissingInputs: true};
        expect(await startRestoreRun(d, base)).toMatchObject({ok: false, code: "confirmation_required"});
        expect(await startRestoreRun(d, {...base, confirm: "   "})).toMatchObject({ok: false, code: "confirmation_required"});
        expect(await startRestoreRun(d, {...base, confirm: "restore " + project})).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await startRestoreRun(d, {...base, confirm: `RESTORE ${project}x`})).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await startRestoreRun(d, {...base, planHash: "b".repeat(64), confirm: `RESTORE ${project}`})).toMatchObject({ok: false, code: "hash_mismatch"});
        const s = await startRestoreRun(d, {...base, confirm: `  RESTORE ${project}  `}); // outer whitespace is trimmed
        expect(s).toMatchObject({ok: true});
        if (!s.ok) return;
        const run = await h.run(s.runId);
        expect(run).toMatchObject({confirmation: "typed", plan_hash: c.planHash});
        expect((await h.q("select redacted_details d from fork_audit_event where action='fork.restore_run.start' and resource_id=$1", [s.runId]))[0].d).toMatchObject({planHash: c.planHash, confirmation: "typed"});
        // test host: no confirmation, recorded as such
        const w2 = await world();
        const c2 = await h.plan(w2, SEL);
        const s2 = await startRestoreRun(h.deps(w2, starter), {planId: c2.planId, planHash: c2.planHash, acceptMissingInputs: true});
        expect(s2).toMatchObject({ok: true});
        if (s2.ok) expect(await h.run(s2.runId)).toMatchObject({confirmation: "not_required"});
    });

    it("refusals: blocked plan, missing production approval, inputs_missing (accepted ⇒ audited), plan_used, already_running, locked, strict input", async () => {
        const starter = await h.user("admin");
        // blocked: the agent has no compose capability, the plan has compose_up
        const nocaps = await world({caps: ["channel.v1", "noop.v1", "restore.target.v1"]});
        const cb = await h.plan(nocaps);
        expect(await h.start(h.deps(nocaps, starter), cb)).toMatchObject({ok: false, code: "plan_blocked"});
        // production plan without the production approval
        const prod = await world({hostRole: "production"});
        const cp = await h.plan(prod, {...SEL, approve: false});
        expect(await startRestoreRun(h.deps(prod, starter), {planId: cp.planId, planHash: cp.planHash, confirm: `RESTORE ${await projectOf(cp.planId)}`, acceptMissingInputs: true})).toMatchObject({ok: false, code: "approval_missing"});
        // required inputs
        const w = await world();
        const d = h.deps(w, starter);
        const c1 = await h.plan(w);
        const miss = await startRestoreRun(d, {planId: c1.planId, planHash: c1.planHash});
        if (miss.ok) throw new Error("expected inputs_missing");
        expect(miss.code).toBe("inputs_missing");
        const s = await startRestoreRun(d, {planId: c1.planId, planHash: c1.planHash, acceptMissingInputs: true});
        expect(s).toMatchObject({ok: true});
        if (!s.ok) return;
        expect((await h.q("select redacted_details d from fork_audit_event where action='fork.restore_run.start' and resource_id=$1", [s.runId]))[0].d).toMatchObject({acceptMissingInputs: true});
        expect(await h.run(s.runId)).toMatchObject({accept_missing_inputs: true});
        // the same plan again; another plan on the same target while the first run is active
        expect(await startRestoreRun(d, {planId: c1.planId, planHash: c1.planHash, acceptMissingInputs: true})).toMatchObject({ok: false, code: "plan_used"});
        const c2 = await h.plan(w, SEL);
        expect(await startRestoreRun(d, {planId: c2.planId, planHash: c2.planHash, acceptMissingInputs: true})).toMatchObject({ok: false, code: "already_running"});
        // locked
        expect(await startRestoreRun(h.deps(w, starter, {configAllowed: async () => false}), {planId: c2.planId, planHash: c2.planHash})).toMatchObject({ok: false, code: "locked"});
        // strict input
        expect(await startRestoreRun(d, {planId: c2.planId, planHash: c2.planHash, extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await startRestoreRun(d, {planId: "not-a-uuid", planHash: c2.planHash})).toMatchObject({ok: false, code: "invalid_input"});
        // the one-active index is the DB-level backstop; existing_stack is excluded at the DB level (#145)
        await expect(pool.query("update fork_restore_run set mode='existing_stack' where id=$1", [s.runId])).rejects.toThrow(/fork_restore_run_mode_ck/);
        // a terminal run frees the target
        await cancelRestoreRun(d, {runId: s.runId});
        await h.tick(d, s.runId);
        expect(await startRestoreRun(d, {planId: c2.planId, planHash: c2.planHash, acceptMissingInputs: true})).toMatchObject({ok: true});
    });

    it("IDOR: outsiders and random ids get the same answer on every service; a member without the capability gets forbidden", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const c = await h.plan(w, SEL);
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        const otherOrg = await seedOrg(pool);
        const outsider = {userId: (await h.user("member")).userId, systemRole: "user", memberships: [{organizationId: otherOrg, role: "owner"}]};
        const member = await h.user("member");
        const random = randomUUID();
        const each = async (p: ForkPrincipal, id: string, planId: string) => [
            await startRestoreRun(h.deps(w, p), {planId, planHash: c.planHash}),
            await approveRestorePolicy(h.deps(w, p), {runId: id, confirmations: {}}),
            await cancelRestoreRun(h.deps(w, p), {runId: id}),
            await cleanupRestoreRun(h.deps(w, p), {runId: id}),
            await getRestoreRunView(h.deps(w, p), {runId: id}),
        ].map((x) => (x.ok ? "ok" : x.code));
        const a = await each(outsider, s.runId, c.planId); // real ids, foreign org
        const b = await each(outsider, random, random); // random ids
        expect(a).toEqual(b);
        expect(new Set(a)).toEqual(new Set(["not_found"]));
        expect(await listRestoreRuns(h.deps(w, outsider), {stackId: w.stack})).toMatchObject({ok: false, code: "not_found"});
        // a plain member of the owning org: honest forbidden
        const mine = await each(member, s.runId, c.planId);
        expect(new Set(mine)).toEqual(new Set(["forbidden"]));
        expect(await startRestoreRun(h.deps(w, null), {planId: c.planId, planHash: c.planHash})).toMatchObject({ok: false, code: "forbidden"});
    });
});

describe("W18a cleanup (owned resources only, never automatic) and the read model", () => {
    it("cleanup: refused while active and after success; after a failure one restore_cleanup task (journal step cleanup); a second request while in flight is already_queued; the view shows its status", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const s = await h.start(d, await h.plan(w, SEL));
        if (!s.ok) throw new Error(s.code);
        expect(await cleanupRestoreRun(d, {runId: s.runId})).toMatchObject({ok: false, code: "not_allowed"}); // active
        const r = await h.drive(d, w, s.runId, {restore_apply: {status: "failed", reason: "volume_exists"}});
        expect(r.state).toBe("failed");
        // nothing is cleaned automatically
        expect((await h.journal(s.runId)).map((x) => x.step)).not.toContain("cleanup");
        const c1 = await cleanupRestoreRun(d, {runId: s.runId});
        expect(c1).toMatchObject({ok: true});
        expect(await cleanupRestoreRun(d, {runId: s.runId})).toMatchObject({ok: false, code: "already_queued"});
        const view = await getRestoreRunView(d, {runId: s.runId});
        expect(view.ok && view.view.cleanup).toMatchObject({status: "queued", attempts: 0});
        expect((await h.journal(s.runId)).find((x) => x.step === "cleanup")).toMatchObject({task_type: "restore_cleanup", attempt: 1});
        expect((await h.agentStep(w))?.type).toBe("restore_cleanup");
        const v2 = await getRestoreRunView(d, {runId: s.runId});
        expect(v2.ok && v2.view.cleanup).toMatchObject({status: "succeeded"});
        expect(await cleanupRestoreRun(d, {runId: s.runId})).toMatchObject({ok: true}); // a failed run may be cleaned again once the previous task finished
        // a succeeded restore is never cleaned (it would delete the restored stack)
        const w2 = await world();
        const d2 = h.deps(w2, starter);
        const s2 = await h.start(d2, await h.plan(w2, SEL));
        if (!s2.ok) throw new Error(s2.code);
        expect((await h.drive(d2, w2, s2.runId)).state).toBe("succeeded");
        expect(await cleanupRestoreRun(d2, {runId: s2.runId})).toMatchObject({ok: false, code: "not_allowed"});
    });

    it("the view of a finished run is the strict allow-list, tells what to do next, and listing shows newest first", async () => {
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter);
        const s = await h.start(d, await h.plan(w));
        if (!s.ok) throw new Error(s.code);
        await h.drive(d, w, s.runId);
        const v = await getRestoreRunView(d, {runId: s.runId});
        if (!v.ok) throw new Error(v.code);
        expect(RestoreRunView.safeParse(v.view).success).toBe(true);
        expect(v.view).toMatchObject({state: "succeeded", verification: "started", nextSteps: ["reattach_backups"], cleanup: null});
        expect(v.view.steps.map((x) => x.name)).toEqual(["verify_manifest", "probe", "stage", "apply", "render", "restore_db", "compose_up", "check_services"]);
        expect(v.view.steps.find((x) => x.name === "stage")?.task).toMatchObject({status: "succeeded"});
        expect(v.view.steps.find((x) => x.name === "verify_manifest")?.task).toBeNull();
        const l = await listRestoreRuns(d, {stackId: w.stack});
        expect(l.ok && l.runs[0]).toMatchObject({id: s.runId, state: "succeeded", verification: "started"});
    });
});

describe("W18a no secret in any fork table, audit detail, view or log-able field (canary sweep)", () => {
    it("override value, presigned query, agent bundle: absent everywhere after a full run", async () => {
        const CANARY = `CANARY_W18A_${randomUUID()}`;
        const SIG = `SIGCANARY${randomUUID().replace(/-/g, "")}`;
        const w = await world();
        const starter = await h.user("admin");
        const d = h.deps(w, starter, {artifactUrl: async (id) => `https://lab.invalid/${id}?X-Amz-Signature=${SIG}`});
        const c = await h.plan(w);
        const ovd = {db: t.db, principal: starter, kekDir: kek, now: h.now, configAllowed: async () => true};
        expect(await setRestoreOverrides(ovd, {planId: c.planId, planHash: c.planHash, set: [{service: "web", key: "A", value: CANARY}]})).toMatchObject({ok: true});
        const s = await h.start(d, c);
        if (!s.ok) throw new Error(s.code);
        const r = await h.drive(d, w, s.runId);
        expect(r.state).toBe("succeeded");
        const tables = (await h.q("select table_name from information_schema.tables where table_schema='public' and table_name like 'fork\\_%'")).map((x) => x.table_name as string);
        let everything = "";
        for (const tn of tables) everything += JSON.stringify(await h.q(`select row_to_json(x)::text j from "${tn}" x`));
        const view = await getRestoreRunView(d, {runId: s.runId});
        everything += JSON.stringify(view);
        for (const secret of [CANARY, SIG, w.agentBundle]) expect(everything.includes(secret), secret.slice(0, 12)).toBe(false);
        expect((await h.q("select count(*)::int n from fork_restore_override where plan_id=$1", [c.planId]))[0].n).toBe(0); // purged at the terminal state
        expect((await h.q("select count(*)::int n from fork_audit_event where action='fork.restore_override.purge' and redacted_details->>'reason'='terminal'"))[0].n).toBeGreaterThan(0);
    });
});

describe("W18a enqueue transaction hook (D-4)", () => {
    it("onTaskInserted runs inside the enqueue transaction: it commits with the task, a throw rolls the task back and writes no success audit", async () => {
        const w = await world();
        const starter = await h.user("admin");
        await h.plan(w, SEL);
        const base = {...h.deps(w, starter), principal: starter};
        const taskDeps = (hook: (tx: never, t: {taskId: string; type: string}) => Promise<void>) => ({...base, onTaskInserted: hook as never});
        const count = async () => (await h.tasks(w.agent)).length;
        const seen: string[] = [];
        const ok = await enqueueRestoreTask(taskDeps(async (_tx, tk) => { seen.push(`${tk.type}`); }), {type: "restore_probe", agentId: w.agent, workspace: "/srv/restore/app"});
        expect(ok).toMatchObject({ok: true});
        expect(seen).toEqual(["restore_probe"]);
        expect(await count()).toBe(1);
        const audits = async () => (await h.q("select count(*)::int n from fork_audit_event where action='fork.restore_task.enqueue'"))[0].n;
        const before = await audits();
        await expect(enqueueRestoreTask(taskDeps(async () => { throw new Error("boom"); }), {type: "restore_probe", agentId: w.agent, workspace: "/srv/restore/app"})).rejects.toThrow("boom");
        expect(await count()).toBe(1);
        expect(await audits()).toBe(before);
    });
});
