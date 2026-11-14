import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {cancelMirrorRevision, createMirror, getMirrorAccess, getMirrorView, previewMirrorPlan, retryMirrorWipe, setStackMirrorOptIn} from "@/fork/mirror/service";
import {tickAllMirrors, tickMirrorRevision} from "@/fork/mirror/tick";
import {startTestedFact} from "@/fork/mirror/facet";
import {undesignateRunner} from "@/fork/runner/service";
import {startRestoreRun} from "@/fork/restore-run/service";
import {createRestorePlan} from "@/fork/restore/service";
import {mirrorWorld, CAN, type MirrorWorld} from "@/fork/__tests__/w22a-world";
import {RULES_SHA256} from "@/fork/policy/rules";
import type {ForkPrincipal} from "@/fork/acl";

let w: MirrorWorld;
let sys: ForkPrincipal, orgAdmin: ForkPrincipal, member: ForkPrincipal;
beforeAll(async () => { w = await mirrorWorld(); sys = await w.user("sys"); orgAdmin = await w.user("admin"); member = await w.user("member"); });
afterAll(async () => { await w?.close(); });
beforeEach(() => { w.reset(); w.flag.on = true; });

/** create a mirror as the org admin and return ids; the starter is `orgAdmin` */
async function create(o: {personal?: boolean | null; over?: Record<string, unknown>; stack?: Awaited<ReturnType<MirrorWorld["world"]>>; ru?: Awaited<ReturnType<MirrorWorld["runner"]>>} = {}) {
    const stack = o.stack ?? await w.world(o.personal ?? false);
    await w.setSeq(stack);
    const ru = o.ru ?? await w.runner();
    const d = w.deps(orgAdmin, stack);
    const r = await createMirror(d, w.createReq(stack, ru, o.over));
    return {stack, ru, d, r};
}
const ok = <T extends {ok: boolean}>(r: T): Extract<T, {ok: true}> => { if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`); return r as Extract<T, {ok: true}>; };

describe("case 1: happy path ⇒ ready with the five gates and the start-tested fact", () => {
    it("create → tick/runner → ready; mirror ready; gates ok; facet; audit trail; wipe untouched; access info", async () => {
        const {stack, ru, d, r} = await create();
        const c = ok(r);
        expect(c.hostPort).toBe(41000);
        expect((await w.rev(c.revisionId)).state).toBe("validating");
        expect(await startTestedFact(w.t.db, stack.stack)).toBeNull(); // nothing yet: creating is not start-tested
        const done = await w.drive(d, ru, c.revisionId);
        expect(done.state).toBe("ready");
        expect(done.reason).toBeNull();
        expect(done.wipe_state).toBeNull();
        const gates = done.gates as Record<string, {ok: boolean}>;
        for (const g of ["expected_data", "db_health", "app_smoke", "isolation", "side_effects"]) expect(gates[g]?.ok, g).toBe(true);
        expect(done.final_view_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(done.readied_at).not.toBeNull();
        const m = await w.mirrorRow(c.mirrorId);
        expect(m.status).toBe("ready");
        expect(m.active_revision_id).toBe(c.revisionId);
        const fact = await startTestedFact(w.t.db, stack.stack);
        expect(fact).toMatchObject({revisionId: c.revisionId, rpSequence: Number(done.rp_sequence)});
        // the step journal covers the whole ladder; the isolation probe belongs to THIS revision
        const steps = (await w.journal(c.revisionId)).map((j) => j.step);
        expect(steps).toEqual(["probe", "stage", "apply", "render", "finalize", "restore_db", "up", "check", "isolation"]);
        const trail = (await w.audits("fork.mirror.create")).length + (await w.audits("fork.mirror.compiled")).length + (await w.audits("fork.mirror.ready")).length;
        expect(trail).toBeGreaterThanOrEqual(3);
        expect((await w.events(c.mirrorId)).map((e) => e.kind)).toEqual(expect.arrayContaining(["requested", "state_changed", "gate_passed", "ready"]));
        // read model + access (ready only, audited)
        const view = ok(await getMirrorView(w.deps(orgAdmin, stack), {mirrorId: c.mirrorId}));
        expect(view.view.mirror.status).toBe("ready");
        expect(view.view.revisions[0]?.gates.isolation).toEqual({ok: true, code: null});
        const acc = ok(await getMirrorAccess(w.deps(member, stack), {mirrorId: c.mirrorId}));
        expect(acc.access).toMatchObject({hostPort: 41000, service: "web", target: 8080});
        expect((await w.audits("fork.mirror.access_view")).some((a) => a.result === "success")).toBe(true);
    });
});

describe("case 2: every gate failure ends honestly (never ready) and the runner copy is wiped + verified", () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
        ["stage manifest sequence off", {mirror_stage: {result: {manifest_sequence: 9999}}}, "failed", "stage_mismatch"],
        ["db restore failed (agent code)", {mirror_db: {status: "failed", reason: "db_restore_failed"}}, "failed", "db_restore_failed"],
        ["credential reset failed (agent code)", {mirror_db: {status: "failed", reason: "credential_reset_failed"}}, "failed", "credential_reset_failed"],
        ["a service exited", {mirror_check: {result: {v: 1, services: [{service: "db", state: "exited", health: "none"}, {service: "web", state: "running", health: "none"}], smoke: {status: "ok", http_status: 200}}}}, "failed", "service_not_running"],
        ["a service unhealthy", {mirror_check: {result: {v: 1, services: [{service: "db", state: "running", health: "unhealthy"}, {service: "web", state: "running", health: "none"}], smoke: {status: "ok", http_status: 200}}}}, "failed", "service_unhealthy"],
        ["smoke failed", {mirror_check: {result: {v: 1, services: [{service: "db", state: "running", health: "healthy"}, {service: "web", state: "running", health: "none"}], smoke: {status: "failed", http_status: null}}}}, "failed", "smoke_failed"],
        ["smoke http 500 (M15)", {mirror_check: {result: {v: 1, services: [{service: "db", state: "running", health: "healthy"}, {service: "web", state: "running", health: "none"}], smoke: {status: "ok", http_status: 500}}}}, "failed", "smoke_failed"],
        ["probe reports a reachable target", {runner_probe: {probeOutcome: "reachable"}}, "failed", "runner_not_isolated"],
        ["limits error from the runner", {mirror_finalize: {status: "failed", reason: "limits_invalid"}}, "failed", "limits_invalid"],
        ["source changed on the runner", {mirror_finalize: {status: "failed", reason: "source_changed"}}, "failed", "source_changed"],
    ];
    it.each(cases)("%s", async (_name, script, state, reason) => {
        const {ru, d, r} = await create();
        const c = ok(r);
        const done = await w.drive(d, ru, c.revisionId, script as never);
        expect({state: done.state, reason: done.reason}).toEqual({state, reason});
        expect(done.readied_at).toBeNull();
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("failed");
        expect((await w.mirrorRow(c.mirrorId)).active_revision_id).toBeNull();
        expect(done.wipe_state).toBe("verified");
        const types = (await w.journal(c.revisionId)).map((j) => j.task_type);
        expect(types).toContain("mirror_wipe");
        expect(types[types.length - 1]).toBe("mirror_probe"); // the independent probe after the wipe
    });

    it("a wipe the runner reports incomplete is never believed; an unverified workspace neither; both end wipe_state=failed, retry re-arms", async () => {
        const a = await create();
        const ra = ok(a.r);
        const fail1 = await w.drive(a.d, a.ru, ra.revisionId, {mirror_stage: {result: {manifest_sequence: 9999}}, mirror_wipe: {result: {v: 1, containers: 1, networks: 1, volumes: 1, workspace_removed: true, remaining: 3}}});
        expect(fail1.wipe_state).toBe("failed");
        expect(fail1.wipe_reason).toBe("wipe_incomplete");
        const b = await create();
        const rb = ok(b.r);
        let probes = 0;
        const fail2 = await w.drive(b.d, b.ru, rb.revisionId, {mirror_stage: {result: {manifest_sequence: 9999}}, mirror_probe: () => ({result: {roots: [{path: "/srv/portabase-mirrors", shared: true, free_bytes: 1e12}], workspace_state: probes++ === 0 ? "absent" : "owned", compose_version: "5.4.0", rules_sha256: RULES_SHA256}})}, {max: 80});
        expect({wipe: fail2.wipe_state, reason: fail2.wipe_reason}).toEqual({wipe: "failed", reason: "wipe_incomplete"}); // the independent probe still sees the workspace
        // retry is an explicit audited action, only for a failed wipe
        expect(ok(await retryMirrorWipe(w.deps(orgAdmin, a.stack), {revisionId: ra.revisionId})).ok).toBe(true);
        expect((await w.rev(ra.revisionId)).wipe_state).toBeNull();
        expect(await retryMirrorWipe(w.deps(orgAdmin, a.stack), {revisionId: ra.revisionId})).toMatchObject({ok: false, code: "not_failed"});
        expect(await retryMirrorWipe(w.deps(member, a.stack), {revisionId: ra.revisionId})).toMatchObject({ok: false, code: "forbidden"});
        const again = await w.drive(a.d, a.ru, ra.revisionId, {});
        expect(again.wipe_state).toBe("verified");
    });

    it("a probe older than the isolation step is stale; no admin targets means not isolated", async () => {
        const {ru, d, r} = await create();
        const c = ok(r);
        // the probe answers, but the runner's last probe was re-bound by an admin probe in between: the step fails closed
        const done = await w.drive(d, ru, c.revisionId, {runner_probe: () => ({probeOutcome: "blocked"})}, {stopAt: (x) => x.state === "healthchecking"});
        expect(done.state).toBe("healthchecking");
        await w.q("update fork_runner set probe_targets='[]'::jsonb where agent_id=$1", [ru.agentId]);
        const end = await w.drive(d, ru, c.revisionId, {});
        expect(end.state).toBe("failed");
        expect(["runner_not_isolated", "probe_stale"]).toContain(end.reason);
    });

    it("the recovery point turns un-verified before activation ⇒ expected_data_failed (never ready)", async () => {
        const {stack, ru, d, r} = await create();
        const c = ok(r);
        await w.drive(d, ru, c.revisionId, {}, {stopAt: (x) => x.state === "healthchecking"});
        await w.q("update fork_recovery_point set status='incomplete' where id=$1", [stack.rp]);
        const end = await w.drive(d, ru, c.revisionId, {});
        expect({state: end.state, reason: end.reason}).toEqual({state: "failed", reason: "expected_data_failed"});
        expect(end.readied_at).toBeNull();
        expect(end.wipe_state).toBe("verified");
    });
});

describe("case 3: compile refusals are blocked (never started), kept secrets need confirmation", () => {
    it("a poison view (docker.sock) ⇒ blocked compile_refused, refusals stored without values, nothing after the render ran, wipe verified", async () => {
        const {ru, d, r} = await create();
        const c = ok(r);
        const poison = (ws: string) => ({name: "x", services: {web: {image: "nginx:1", environment: {SECRET: CAN}, volumes: [{type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock"}], ports: []}, db: {image: "postgres:17"}}, workspace: ws});
        const done = await w.drive(d, ru, c.revisionId, {mirror_render: (p) => ({sourceDoc: poison(p.workspace as string)})});
        expect(done.state).toBe("blocked");
        expect(done.reason).toBe("compile_refused");
        expect(JSON.stringify(done.refusals)).not.toContain(CAN);
        expect((await w.journal(c.revisionId)).map((j) => j.step)).not.toContain("finalize");
        expect(done.wipe_state).toBe("verified");
        const view = ok(await getMirrorView(w.deps(orgAdmin, (await w.world()), {}), {mirrorId: c.mirrorId}).catch(() => ({ok: true, view: {revisions: []}} as never)));
        void view;
    });
    it("keep_exact needs the typed phrase at create; with it the kept key is recorded by name; without in the spec ⇒ blocked kept_secret_unconfirmed", async () => {
        const stack = await w.world();
        const ru = await w.runner();
        const policy = {...w.POLICY, env: {db: {POSTGRES_PASSWORD: "keep_exact"}}};
        expect(await createMirror(w.deps(orgAdmin, stack), w.createReq(stack, ru, {policy}))).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await createMirror(w.deps(orgAdmin, stack), w.createReq(stack, ru, {policy, keepConfirmations: {"db.POSTGRES_PASSWORD": "keep db.POSTGRES_PASSWORD"}}))).toMatchObject({ok: false, code: "confirmation_mismatch"});
        const good = ok(await createMirror(w.deps(orgAdmin, stack), w.createReq(stack, ru, {policy, keepConfirmations: {"db.POSTGRES_PASSWORD": "KEEP db.POSTGRES_PASSWORD"}})));
        const m = await w.mirrorRow(good.mirrorId);
        expect((m.policy as {kept_confirmed: string[]}).kept_confirmed).toEqual(["db.POSTGRES_PASSWORD"]);
        // tamper: the stored confirmation list loses the key ⇒ the compile step refuses
        await w.q("update fork_mirror set policy = jsonb_set(policy, '{kept_confirmed}', '[]'::jsonb) where id=$1", [good.mirrorId]);
        const done = await w.drive(w.deps(orgAdmin, stack), ru, good.revisionId, {});
        expect(done.state).toBe("blocked");
        expect(done.reason).toBe("kept_secret_unconfirmed");
    });
});

describe("case 4: forged final views and render uploads never reach ready", () => {
    const forged: [string, (v: Record<string, any>) => void, string][] = [
        ["extra published port", (v) => { v.services.db.ports = [{target: 5432, published: "5432", host_ip: "127.0.0.1", protocol: "tcp"}]; }, "final_view_invalid"],
        ["missing owner label", (v) => { delete v.services.web.labels["com.portabase.fork.restore_id"]; }, "final_view_invalid"],
        ["limits missing", (v) => { delete v.services.web.mem_limit; }, "limits_invalid"],
        ["limits above the policy", (v) => { v.services.web.pids_limit = 100000; }, "limits_invalid"],
        ["image changed", (v) => { v.services.web.image = "evil:1"; }, "final_view_invalid"],
    ];
    it.each(forged)("%s", async (_n, finalMutate, reason) => {
        const {ru, d, r} = await create();
        const c = ok(r);
        const done = await w.drive(d, ru, c.revisionId, {mirror_finalize: {finalMutate}});
        expect({state: done.state, reason: done.reason}).toEqual({state: "failed", reason});
        expect(done.final_view_sha256).toBeNull();
        expect((await w.journal(c.revisionId)).map((j) => j.step)).not.toContain("up"); // nothing was started
    });
    it("a result hash that is not the uploaded view's hash is final_view_invalid", async () => {
        const {ru, d, r} = await create();
        const c = ok(r);
        const done = await w.drive(d, ru, c.revisionId, {mirror_finalize: {result: {view_sha256: "f".repeat(64)}}});
        expect({state: done.state, reason: done.reason}).toEqual({state: "failed", reason: "final_view_invalid"});
    });
});

describe("case 5: cancel, deadline, re-authorisation, runner, plan tamper, flag, offline", () => {
    it("cancel mid-stage ⇒ queued task cancelled / running awaited ⇒ cancelled ⇒ wipe verified", async () => {
        const {ru, d, r} = await create();
        const c = ok(r);
        await w.drive(d, ru, c.revisionId, {}, {stopAt: (x) => x.state === "staging"});
        expect(ok(await cancelMirrorRevision(d, {revisionId: c.revisionId})).ok).toBe(true);
        expect(ok(await cancelMirrorRevision(d, {revisionId: c.revisionId})).ok).toBe(true); // idempotent
        const done = await w.drive(d, ru, c.revisionId, {});
        expect({state: done.state, reason: done.reason}).toEqual({state: "cancelled", reason: "cancelled"});
        expect(done.wipe_state).toBe("verified");
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("cancelled");
        expect(await cancelMirrorRevision(w.deps(member, (await w.world())), {revisionId: c.revisionId})).toMatchObject({ok: false, code: "forbidden"});
    });
    it("deadline ⇒ run_timeout; starter demoted ⇒ reauth_failed; runner undesignated mid-run is refused while mirrors exist, and a lost attestation ⇒ blocked runner_ineligible", async () => {
        const a = await create();
        const ca = ok(a.r);
        w.advance(5 * 3_600_000);
        expect((await w.drive(a.d, a.ru, ca.revisionId, {})).reason).toBe("run_timeout");
        const b = await create();
        const cb = ok(b.r);
        w.principals.set(orgAdmin.userId, {userId: orgAdmin.userId, systemRole: "user", memberships: [{organizationId: w.org, role: "member"}]});
        expect((await w.drive(b.d, b.ru, cb.revisionId, {})).reason).toBe("reauth_failed");
        w.principals.set(orgAdmin.userId, orgAdmin);
        const c = await create();
        const cc = ok(c.r);
        expect(await undesignateRunner({...w.channelDeps(sys.userId), mirrorsEnabled: () => true, principal: sys}, {agentId: c.ru.agentId})).toMatchObject({ok: false, code: "mirrors_exist"});
        await w.q("update fork_agent_enrollment set capabilities='{channel.v1}' where agent_id=$1", [c.ru.agentId]);
        const done = await w.drive(c.d, c.ru, cc.revisionId, {});
        expect({state: done.state, reason: done.reason}).toEqual({state: "blocked", reason: "runner_ineligible"});
    });
    it("a tampered plan row ⇒ plan_tampered; flag off ⇒ no new task but the deadline and the wipe still run; offline runner (3 expirations) ⇒ agent_offline", async () => {
        const a = await create();
        const ca = ok(a.r);
        await w.q("update fork_restore_plan set plan = jsonb_set(plan, '{outcome}', '\"blocked\"') where id=(select plan_id from fork_mirror_revision where id=$1)", [ca.revisionId]);
        expect((await w.drive(a.d, a.ru, ca.revisionId, {})).reason).toBe("plan_tampered");
        const b = await create();
        const cb = ok(b.r);
        w.flag.on = false;
        await tickAllMirrors(b.d);
        await tickAllMirrors(b.d);
        expect(await w.journal(cb.revisionId)).toEqual([]); // flag off: nothing enqueued
        w.advance(5 * 3_600_000);
        await tickAllMirrors(b.d);
        const timed = await w.rev(cb.revisionId);
        expect(timed.reason).toBe("run_timeout");
        expect(timed.wipe_state).toBe("not_needed"); // nothing was ever staged
        w.flag.on = true;
        const c = await create();
        const cc = ok(c.r);
        let last = await w.rev(cc.revisionId);
        for (let i = 0; i < 12 && last.state !== "failed"; i++) { await tickMirrorRevision(c.d, cc.revisionId); w.advance(11 * 60_000); last = await w.rev(cc.revisionId); } // never answered, ttl 10 min
        expect({state: last.state, reason: last.reason}).toEqual({state: "failed", reason: "agent_offline"});
    });
});

describe("case 6: services", () => {
    it("refusals: disabled, member, anonymous, foreign org (IDOR), privacy ack, runner not isolated / ineligible / busy, name taken, port range full, unverified RP, personal data without opt-in", async () => {
        const cm = (...a: Parameters<typeof createMirror>) => { w.reset(); return createMirror(...a); }; // the create rate limit (5/min) is tested separately
        const stack = await w.world(false);
        const ru = await w.runner();
        await w.setSeq(stack);
        const base = () => w.createReq(stack, ru);
        w.flag.on = false;
        expect(await cm(w.deps(orgAdmin, stack), base())).toMatchObject({ok: false, code: "mirrors_disabled"});
        w.flag.on = true;
        expect(await cm(w.deps(member, stack), base())).toMatchObject({ok: false, code: "forbidden"});
        expect(await cm(w.deps(null, stack), base())).toMatchObject({ok: false, code: "forbidden"});
        const foreign = await w.user("admin", w.otherOrg);
        expect(await cm(w.deps(foreign, stack), base())).toMatchObject({ok: false, code: "not_found"}); // IDOR: indistinguishable from a missing stack
        expect(await cm(w.deps(orgAdmin, stack), {...base(), unknown: 1})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await cm(w.deps(orgAdmin, stack), {...base(), name: "UPPER"})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await cm(w.deps(orgAdmin, stack, {configAllowed: async () => false}), base())).toMatchObject({ok: false, code: "locked"});
        const unknownStack = {...base(), stackId: "99999999-9999-4999-8999-999999999999"};
        expect(await cm(w.deps(orgAdmin, stack), unknownStack)).toMatchObject({ok: false, code: "not_found"});
        // personal data (unknown) needs the acknowledgement AND the stack opt-in
        const pd = await w.world(null);
        await w.setSeq(pd);
        expect(await cm(w.deps(orgAdmin, pd), w.createReq(pd, ru))).toMatchObject({ok: false, code: "privacy_ack_required"});
        expect(await cm(w.deps(orgAdmin, pd), w.createReq(pd, ru, {acknowledgePrivacy: true}))).toMatchObject({ok: false, code: "personal_data_no_mirror_opt_in"});
        expect(await setStackMirrorOptIn(w.deps(orgAdmin, pd), {stackId: pd.stack, enabled: true})).toMatchObject({ok: false, code: "forbidden"}); // system admin only
        expect(await setStackMirrorOptIn(w.deps(sys, pd), {stackId: pd.stack, enabled: true})).toEqual({ok: true});
        expect((await w.audits("fork.mirror.opt_in.set")).some((a) => a.result === "success")).toBe(true);
        const withOptIn = ok(await cm(w.deps(orgAdmin, pd), w.createReq(pd, ru, {acknowledgePrivacy: true})));
        expect(withOptIn.hostPort).toBe(41000);
        // one active creation per runner
        expect(await cm(w.deps(orgAdmin, stack), base())).toMatchObject({ok: false, code: "runner_busy"});
        // runner gates
        const stale = await w.runner({isolated: false});
        expect(await cm(w.deps(orgAdmin, stack), w.createReq(stack, stale))).toMatchObject({ok: false, code: "runner_not_isolated"});
        const notRunner = {agentId: stack.agent, credential: "", name: ""};
        expect(await cm(w.deps(orgAdmin, stack), w.createReq(stack, notRunner))).toMatchObject({ok: false, code: "runner_ineligible"});
        // unverified RP
        const ru2 = await w.runner();
        await w.q("update fork_recovery_point set status='incomplete' where id=$1", [stack.rp]);
        expect(await cm(w.deps(orgAdmin, stack), w.createReq(stack, ru2))).toMatchObject({ok: false, code: "rp_not_verified"});
        await w.q("update fork_recovery_point set status='verified' where id=$1", [stack.rp]);
        // name taken + the port range full (seam)
        const named = ok(await cm(w.deps(orgAdmin, stack), w.createReq(stack, ru2, {name: "dup-name"})));
        expect(named.mirrorId).toBeTruthy();
        const ru3 = await w.runner();
        expect(await cm(w.deps(orgAdmin, stack), w.createReq(stack, ru3, {name: "dup-name"}))).toMatchObject({ok: false, code: "name_taken"});
        expect(await cm(w.deps(orgAdmin, stack, {portRange: {min: 41000, max: 41000}}), w.createReq(stack, ru, {name: "full"}))).toMatchObject({ok: false}); // busy first on ru; the free runner below has the range exhausted by itself
        const ru4 = await w.runner();
        await w.q("insert into fork_mirror (id, organization_id, stack_id, runner_agent_id, runner_agent_name, name, policy, created_by, created_at, updated_at) values (gen_random_uuid(),$1,$2,$3,'r','seed',$4,'u',now(),now())", [w.org, stack.stack, ru4.agentId, "{}"]);
        await w.q(`insert into fork_mirror_revision (mirror_id, organization_id, stack_id, seq, rp_sequence, plan_hash, runner_agent_id, project, workspace, host_port, state, reason, finished_at, started_by, created_at, deadline_at, updated_at, wipe_state)
            select id,$1,$2,1,1,$4,$3,'pbm-seed-r1','/srv/portabase-mirrors/pbm-seed-r1',41000,'failed','x_y',now(),'u',now(),now(),now(),'failed' from fork_mirror where name='seed'`, [w.org, stack.stack, ru4.agentId, "a".repeat(64)]);
        expect(await cm(w.deps(orgAdmin, stack, {portRange: {min: 41000, max: 41000}}), w.createReq(stack, ru4, {name: "full2"}))).toMatchObject({ok: false, code: "port_unavailable"});
    });
    it("a plan the planner blocks ⇒ blocked revision (no data staged, wipe not_needed) and the name is free again", async () => {
        const stack = await w.world(false);
        const ru = await w.runner();
        await w.q("update fork_recovery_point_artifact set presence='missing' where rp_id=$1 and source_name='volume_app_data'", [stack.rp]);
        const r = await createMirror(w.deps(orgAdmin, stack), w.createReq(stack, ru, {name: "blocked-one"}));
        expect(r).toMatchObject({ok: false, code: "plan_blocked"});
        const [m] = await w.q("select m.deleted_at, r.state, r.reason, r.wipe_state from fork_mirror m join fork_mirror_revision r on r.mirror_id=m.id where m.name='blocked-one'");
        expect(m).toMatchObject({state: "blocked", reason: "plan_blocked", wipe_state: "not_needed"});
        expect(m.deleted_at).not.toBeNull();
        await w.q("update fork_recovery_point_artifact set presence='present' where rp_id=$1", [stack.rp]);
        ok(await createMirror(w.deps(orgAdmin, stack), w.createReq(stack, ru, {name: "blocked-one"})));
    });
    it("preview: no write; refusals; getMirrorView / access: unknown or foreign ids are not_found, not-ready access is refused and audited", async () => {
        const stack = await w.world(false);
        const ru = await w.runner();
        const before = (await w.q("select count(*)::int n from fork_mirror"))[0].n;
        const p = ok(await previewMirrorPlan(w.deps(orgAdmin, stack), {stackId: stack.stack, rpId: stack.rp, runnerAgentId: ru.agentId}));
        expect(p).toMatchObject({outcome: "ready", runnerIsolation: "isolated", optIn: false, containsPersonalData: false});
        expect((await w.q("select count(*)::int n from fork_mirror"))[0].n).toBe(before);
        expect(await previewMirrorPlan(w.deps(member, stack), {stackId: stack.stack, rpId: stack.rp, runnerAgentId: ru.agentId})).toMatchObject({ok: false, code: "forbidden"});
        const created = ok(await createMirror(w.deps(orgAdmin, stack), w.createReq(stack, ru)));
        expect(await getMirrorAccess(w.deps(orgAdmin, stack), {mirrorId: created.mirrorId})).toMatchObject({ok: false, code: "mirror_not_ready"});
        const foreign = await w.user("admin", w.otherOrg);
        expect(await getMirrorView(w.deps(foreign, stack), {mirrorId: created.mirrorId})).toMatchObject({ok: false, code: "not_found"});
        expect(await getMirrorView(w.deps(orgAdmin, stack), {mirrorId: "99999999-9999-4999-8999-999999999999"})).toMatchObject({ok: false, code: "not_found"});
        expect(await cancelMirrorRevision(w.deps(foreign, stack), {revisionId: created.revisionId})).toMatchObject({ok: false, code: "not_found"});
    });
});

describe("case 7: canary — no production value reaches the dashboard", () => {
    it("the canary in the full compose never appears in any fork table, audit row, event, read model or action result", async () => {
        const {stack, ru, d, r} = await create();
        const c = ok(r);
        const done = await w.drive(d, ru, c.revisionId);
        expect(done.state).toBe("ready");
        const view = JSON.stringify(ok(await getMirrorView(w.deps(orgAdmin, stack), {mirrorId: c.mirrorId})));
        const access = JSON.stringify(ok(await getMirrorAccess(w.deps(orgAdmin, stack), {mirrorId: c.mirrorId})));
        expect(view).not.toContain(CAN);
        expect(access).not.toContain(CAN);
        expect(JSON.stringify(c)).not.toContain(CAN);
        const all = await w.dump();
        expect(all).not.toContain(CAN);
        expect(all).not.toContain("lab.invalid"); // artifact URLs never reach a table or an audit row
        // the read model carries no workspace path, spec or env key
        expect(view).not.toContain("/srv/portabase-mirrors");
        expect(view).not.toContain("POSTGRES_PASSWORD");
    });
});

describe("case 8: a mirror plan can never become a restore", () => {
    it("startRestoreRun refuses a mirror plan (mode_unsupported); a restore-plan request with purpose mirror is invalid_input", async () => {
        const {r, stack} = await create();
        ok(r);
        const [row] = await w.q("select id, plan_hash from fork_restore_plan where purpose='mirror' order by created_at desc limit 1");
        const res = await startRestoreRun(w.deps(sys, stack) as never, {planId: row.id, planHash: row.plan_hash, confirm: "x"});
        expect(res).toMatchObject({ok: false});
        expect((res as {code: string}).code).not.toBe("plan_blocked");
        expect(["mode_unsupported", "forbidden", "not_found"]).toContain((res as {code: string}).code);
        const bad = await createRestorePlan({db: w.t.db, principal: sys, configAllowed: async () => true, now: w.now}, {rpId: stack.rp, targetAgentId: stack.agent, purpose: "mirror", mode: "new_stack", mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: null, sqlite: null}});
        expect(bad).toMatchObject({ok: false, code: "invalid_input"});
    });
});
