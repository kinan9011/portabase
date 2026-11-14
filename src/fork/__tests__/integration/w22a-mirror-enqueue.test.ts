import {createHash} from "node:crypto";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {authenticateAgent} from "@/fork/agent-channel/auth";
import {leaseTask} from "@/fork/agent-channel/tasks";
import {enqueueMirrorTask, type EnqueueArgs, type MirrorTaskDeps} from "@/fork/mirror/enqueue";
import {createMirror, CREATE_RATE} from "@/fork/mirror/service";
import {journalRows, revisionOf} from "@/fork/mirror/steps";
import {loadPlanRow} from "@/fork/restore/service";
import {submitRender} from "@/fork/restore-tasks/render";
import {mirrorWorld, type MirrorWorld, RUNNER_CAPS} from "@/fork/__tests__/w22a-world";
import type {ForkPrincipal} from "@/fork/acl";

let w: MirrorWorld;
let orgAdmin: ForkPrincipal;
beforeAll(async () => { w = await mirrorWorld(); orgAdmin = await w.user("admin"); });
afterAll(async () => { await w?.close(); });
beforeEach(() => { w.reset(); w.flag.on = true; });

const URL_CANARY = "https://CANARY-ARTIFACT-HOST.invalid/o?X-Amz-Signature=SIGCANARY";
async function mk() {
    const stack = await w.world(false);
    const ru = await w.runner();
    const d = w.deps(orgAdmin, stack);
    const r = await createMirror(d, w.createReq(stack, ru));
    if (!r.ok) throw new Error(r.code);
    const rev = await w.rev(r.revisionId);
    const row = await loadPlanRow(d, rev.plan_id, rev.plan_hash);
    if (!row.ok) throw new Error("plan");
    const revision = {id: rev.id, mirrorId: rev.mirror_id, organizationId: rev.organization_id, planId: rev.plan_id, planHash: rev.plan_hash, runnerAgentId: rev.runner_agent_id, startedBy: rev.started_by, workspace: rev.workspace};
    const taskDeps = (over: Partial<MirrorTaskDeps> = {}, p: ForkPrincipal | null = orgAdmin): MirrorTaskDeps => {
        const {principal: _p, ...rest} = d;
        return {...rest, principal: p, artifactUrl: async () => URL_CANARY, onTaskInserted: async (tx, t) => { await tx.execute(`select 1`); void t; }, ...over} as MirrorTaskDeps;
    };
    const args = (step: EnqueueArgs["step"], over: Partial<EnqueueArgs> = {}): EnqueueArgs => ({revision, plan: row.plan, step, attempt: 1, manifest: {json: stack.manifestJson, sigB64: stack.manifestSig}, ...over});
    return {stack, ru, d, r, rev, revision, row, taskDeps, args};
}

describe("enqueueMirrorTask", () => {
    it("builds + signs a probe and a stage task; the journal row is written in the same transaction; the audit holds no URL, path or payload", async () => {
        const x = await mk();
        let inserted = 0;
        const deps = x.taskDeps({onTaskInserted: async (tx, t) => { inserted += 1; const {forkMirrorTask} = await import("@/fork/db/schema/mirror"); await tx.insert(forkMirrorTask).values({revisionId: x.revision.id, step: t.type === "mirror_probe" ? "probe" : "stage", attempt: 1, taskType: t.type, taskId: t.taskId, createdAt: w.now()}); }});
        expect(await enqueueMirrorTask(deps, x.args("probe"))).toMatchObject({ok: true});
        expect(await enqueueMirrorTask(deps, x.args("stage"))).toMatchObject({ok: true});
        expect(inserted).toBe(2);
        expect((await journalRows(w.t.db, x.revision.id, "stage"))[0]?.task?.status).toBe("queued");
        const audit = JSON.stringify(await w.audits("fork.mirror_task.enqueue"));
        expect(audit).not.toContain("CANARY");
        expect(audit).not.toContain("/srv/portabase-mirrors");
        expect(await w.dump()).not.toContain("SIGCANARY");
        // the runner leases a SIGNED, targeted task of the mirror type (role + capabilities checked by the real lease path)
        const auth = await authenticateAgent(w.t.db, {agentId: x.ru.agentId, authorization: `Bearer ${x.ru.credential}`, source: "1.2.3.4", now: w.now()});
        if (!auth.ok) throw new Error("auth");
        const l = await leaseTask(w.t.db, auth.enrollment, {capabilities: RUNNER_CAPS, leaseSeconds: 60, now: w.now()});
        expect(JSON.parse(l!.envelope)).toMatchObject({type: "mirror_probe", requires: ["mirror.v1", "runner.v1"], target_agent_id: x.ru.agentId});
    });

    it("a throw in the journal callback rolls the task row back", async () => {
        const x = await mk();
        const before = (await w.q("select count(*)::int n from fork_agent_task where agent_id=$1", [x.ru.agentId]))[0].n;
        await expect(enqueueMirrorTask(x.taskDeps({onTaskInserted: async () => { throw new Error("journal down"); }}), x.args("probe"))).rejects.toThrow("journal down");
        expect((await w.q("select count(*)::int n from fork_agent_task where agent_id=$1", [x.ru.agentId]))[0].n).toBe(before);
    });

    it("refusals: foreign principal, member, no principal, locked, non-runner target, disabled enrolment, missing mirror.v1, wrong root, missing inputs", async () => {
        const x = await mk();
        const foreign = await w.user("admin", w.otherOrg);
        const member = await w.user("member");
        for (const p of [foreign, member, null]) expect(await enqueueMirrorTask(x.taskDeps({}, p), x.args("probe")), String(p?.userId)).toMatchObject({ok: false, code: "forbidden"});
        expect(await enqueueMirrorTask(x.taskDeps({configAllowed: async () => false}), x.args("probe"))).toMatchObject({ok: false, code: "locked"});
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("up"))).toMatchObject({ok: false, code: "invalid_input"}); // no final sha
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("finalize"))).toMatchObject({ok: false, code: "invalid_input"}); // no spec
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("stage", {manifest: undefined}))).toMatchObject({ok: false, code: "invalid_input"});
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("stage", {manifest: {json: "{}", sigB64: "AAAA"}}))).toMatchObject({ok: false, code: "manifest_mismatch"});
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("probe", {revision: {...x.revision, workspace: "/etc/pbm-x"}}))).toMatchObject({ok: false, code: "invalid_input"});
        expect(await enqueueMirrorTask(x.taskDeps({artifactUrl: async () => null}), x.args("stage"))).toMatchObject({ok: false, code: "artifact_unavailable"});
        // runner state changes
        await w.q("update fork_agent_enrollment set capabilities='{channel.v1,runner.v1}' where agent_id=$1", [x.ru.agentId]);
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("probe"))).toMatchObject({ok: false, code: "capability_missing"});
        await w.q("update fork_agent_enrollment set enabled=false where agent_id=$1", [x.ru.agentId]);
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("probe"))).toMatchObject({ok: false, code: "runner_ineligible"});
        await w.q("update fork_agent_enrollment set enabled=true, capabilities=$2 where agent_id=$1", [x.ru.agentId, RUNNER_CAPS]);
        // a revision pointing at an agent that is not a runner
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("probe", {revision: {...x.revision, runnerAgentId: x.stack.agent}}))).toMatchObject({ok: false, code: "runner_ineligible"});
        expect(await enqueueMirrorTask(x.taskDeps(), x.args("probe", {revision: {...x.revision, runnerAgentId: null}}))).toMatchObject({ok: false, code: "runner_ineligible"});
        const denials = await w.audits("fork.mirror_task.denied");
        expect(denials.length).toBeGreaterThanOrEqual(8);
        expect(JSON.stringify(denials)).not.toContain("CANARY");
    });

    it("the wipe steps need no principal and no config lock (removing data is always allowed); every other step does", async () => {
        const x = await mk();
        const dep = x.taskDeps({configAllowed: async () => false}, null);
        expect(await enqueueMirrorTask(dep, x.args("wipe"))).toMatchObject({ok: true});
        expect(await enqueueMirrorTask(dep, x.args("wipe_check", {attempt: 1}))).toMatchObject({ok: true});
        expect(await enqueueMirrorTask(dep, x.args("probe"))).toMatchObject({ok: false});
    });

    it("the render upload route accepts mirror types only for mirror tasks and still refuses a runner_probe task", async () => {
        const x = await mk();
        const {requestRunnerProbe} = await import("@/fork/runner/service");
        const p = await requestRunnerProbe({...w.channelDeps(w.adminId), mirrorsEnabled: () => true, resolve: w.resolve}, {agentId: x.ru.agentId});
        if (!p.ok) throw new Error(p.code);
        const auth = await authenticateAgent(w.t.db, {agentId: x.ru.agentId, authorization: `Bearer ${x.ru.credential}`, source: "1.2.3.4", now: w.now()});
        if (!auth.ok) throw new Error("auth");
        const view = Buffer.from(JSON.stringify({name: "x", services: {}}));
        const body = {lease_id: "00000000-0000-4000-8000-000000000001", restore_id: x.revision.id, view_b64: view.toString("base64"), view_sha256: createHash("sha256").update(view).digest("hex"), raw: {refused: false, violations: [], reason: null}, roots: ["/srv/x"], files: [], compose_version: null, rules_sha256: null};
        expect(await submitRender(w.t.db, auth.enrollment, {taskId: p.taskId, body, organizationId: w.org, now: w.now()})).toMatchObject({ok: false, code: "wrong_type"});
        void revisionOf;
    });

    it("the create rate limit (5 per minute per user) answers rate_limited", async () => {
        const stack = await w.world(false);
        let last: {ok: boolean; code?: string} = {ok: true};
        for (let i = 0; i <= CREATE_RATE.limit; i++) last = await createMirror(w.deps(orgAdmin, stack), w.createReq(stack, await w.runner({targets: false}), {name: `rl${i}`}));
        expect(last).toMatchObject({ok: false, code: "rate_limited"});
    });
});
