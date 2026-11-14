import {describe, expect, it} from "vitest";
import {u} from "@/fork/__tests__/w16-fixtures";
import {mirrorInput} from "@/fork/__tests__/w22a-fixtures";
import {ACCESS, CLEAN_RAW, labViewJson, PROJECT as LAB_PROJECT, WS as LAB_WS} from "@/fork/__tests__/fixtures/compose-compiler/lab";
import {PAYLOAD_SCHEMAS_FOR_TEST, validatePayload} from "@/fork/agent-channel/tasks";
import {MAINT_TASK_TYPES, MIRROR_CAPABILITY, MIRROR_TASK_TYPES, PUBLIC_TASK_TYPES, RUNNER_CAPABILITY, TARGETED_TASK_TYPES, TASK_REQUIRES} from "@/fork/agent-channel/vocab";
import {compileMirror} from "@/fork/compose-compiler/compile";
import {buildMirrorApply, buildMirrorCheck, buildMirrorDb, buildMirrorFinalize, buildMirrorProbe, buildMirrorRender, buildMirrorStage, buildMirrorStop, buildMirrorUp, buildMirrorWipe, mirrorDbWork, type MirrorBuildInput} from "@/fork/mirror/build";
import {MirrorCheckResult, MirrorDbResult, MirrorFinalizeResult, MirrorStopResult, MirrorUpResult, MirrorWipeResult} from "@/fork/mirror/payload-schema";
import {resolvePolicy} from "@/fork/mirror/policy";
import {LIMIT_DEFAULTS} from "@/fork/mirror/vocab";
import {planRestore} from "@/fork/restore/plan";
import {BuildError} from "@/fork/restore-tasks/build";

const ROOT = LAB_WS.slice(0, LAB_WS.lastIndexOf("/"));
const planned = planRestore(mirrorInput(undefined, {project: LAB_PROJECT, root: ROOT}));
const indexOf = new Map([[u(11), 0], [u(12), 1], [u(13), 2]]);
const input: MirrorBuildInput = {revisionId: u(90), planId: u(91), planHash: planned.planHash, plan: planned.plan, indexOf};
const compiled = compileMirror({view: labViewJson(), raw: CLEAN_RAW, options: {project: LAB_PROJECT, workspace: LAB_WS, access: ACCESS}});
if (!compiled.ok) throw new Error(`fixture does not compile: ${JSON.stringify(compiled.refusals)}`);
const spec = compiled.spec;
const MANIFEST = {jsonB64: "e30=", sigB64: "AAAA", sha256: "b".repeat(64)};
const urls = new Map([[0, "https://minio.example.test/b/o?sig=x"], [1, "https://minio.example.test/b/o2?sig=x"], [2, "https://minio.example.test/b/o3?sig=x"]]);
const FINAL = "e".repeat(64);
const ok = (type: string, p: unknown) => expect(validatePayload(type as never, p as Record<string, unknown>), type).toBeNull();

describe("W22a mirror task contract: builders → strict schemas", () => {
    it("the plan is ready and every builder output parses under its schema", () => {
        expect(planned.plan.outcome).toBe("ready");
        ok("mirror_probe", buildMirrorProbe(LAB_WS));
        ok("mirror_stage", buildMirrorStage(input, {manifest: MANIFEST, urls}));
        ok("mirror_apply", buildMirrorApply(input, MANIFEST.sha256));
        ok("mirror_render", buildMirrorRender(input, MANIFEST.sha256));
        ok("mirror_finalize", buildMirrorFinalize(input, MANIFEST.sha256, spec, compiled.spec_sha256, LIMIT_DEFAULTS));
        ok("mirror_db", buildMirrorDb(input, MANIFEST.sha256, FINAL, spec));
        ok("mirror_up", buildMirrorUp(input, FINAL));
        ok("mirror_check", buildMirrorCheck(input, FINAL, {access: {service: "web", target: 8080}, http_path: "/"}));
        ok("mirror_wipe", buildMirrorWipe(input));
        ok("mirror_stop", buildMirrorStop(input)); // W23
    });

    it("headers: mirror purpose, new_stack, runner, NO approvals, workspace = <root>/<project>; mirror_render carries no override and no env", () => {
        const stage = buildMirrorStage(input, {manifest: MANIFEST, urls});
        expect(stage).toMatchObject({purpose: "mirror", mode: "new_stack", host_role: "runner", approvals: [], workspace: LAB_WS, project: LAB_PROJECT, restore_id: u(90)});
        const render = buildMirrorRender(input, MANIFEST.sha256);
        expect(render.compose.override_yml).toBeNull();
        expect(render.compose.env).toEqual({});
        expect(buildMirrorApply(input, MANIFEST.sha256).networks).toEqual([]);
    });

    it("builders refuse a non-mirror plan", () => {
        const restore = planRestore(mirrorInput((i) => { i.purpose = "restore"; i.target.environments = [{id: u(70), name: "e", host_role: "production", allowed_path_roots: [], facts_fresh: true}]; i.mappings.target_project = null; i.target.runner_eligible = false; }));
        const bad: MirrorBuildInput = {...input, plan: restore.plan, planHash: restore.planHash};
        expect(() => buildMirrorStage(bad, {manifest: MANIFEST, urls})).toThrow(BuildError);
        expect(() => buildMirrorWipe(bad)).toThrow("mode_unsupported");
    });

    it("mirror_db: dumps + the spec's resets; empty work is refused (the dashboard never sends it)", () => {
        const w = mirrorDbWork(planned.plan, spec, indexOf);
        expect(w.dbs).toEqual([{index: 2, service: "db"}]);
        expect(w.resets.length).toBe(spec.credential_resets.length);
        const none = {...spec, credential_resets: []};
        const noDump: MirrorBuildInput = {...input, plan: {...planned.plan, actions: planned.plan.actions.filter((a) => a.kind !== "restore_db_dump")}};
        expect(() => buildMirrorDb(noDump, MANIFEST.sha256, FINAL, none)).toThrow("mode_unsupported");
    });

    it("mirror_up volumes are the plan's restored volumes; check carries the access target and http path", () => {
        expect(buildMirrorUp(input, FINAL).volumes).toEqual([`${LAB_PROJECT}_data`]);
        const c = buildMirrorCheck(input, FINAL, {access: {service: "web", target: 8080}, http_path: "/health"}, 60);
        expect(c).toMatchObject({access: {service: "web", target: 8080}, http_path: "/health", wait_s: 60});
    });

    it("limits resolve to the defaults; policy has no value fields", () => {
        const p = resolvePolicy({v: 1, access: {service: "web", target: 8080}, http_path: null, env: {web: {SECRET: "rotate"}}}, ["web.KEY", "api.A"]);
        expect(p.limits).toEqual(LIMIT_DEFAULTS);
        expect(p.kept_confirmed).toEqual(["api.A", "web.KEY"]);
    });
});

describe("W22a mirror task contract: vocabulary", () => {
    it("every mirror type requires runner.v1 AND mirror.v1, is targeted, never public or maint, and has a payload schema", () => {
        expect(MIRROR_TASK_TYPES).toHaveLength(11); // W22a: 9, W23: mirror_stop, W24: mirror_route
        for (const t of MIRROR_TASK_TYPES) {
            expect(TASK_REQUIRES[t], t).toEqual([RUNNER_CAPABILITY, MIRROR_CAPABILITY]);
            expect(TARGETED_TASK_TYPES).toContain(t);
            expect(PUBLIC_TASK_TYPES as readonly string[]).not.toContain(t);
            expect(MAINT_TASK_TYPES as readonly string[]).not.toContain(t);
            expect(PAYLOAD_SCHEMAS_FOR_TEST[t], t).toBeDefined();
        }
    });
});

describe("W22a mirror results are strict", () => {
    const h = "a".repeat(64);
    it("accepts the documented shapes and refuses extra keys / wrong values", () => {
        expect(MirrorFinalizeResult.safeParse({v: 1, view_sha256: h, services: 2}).success).toBe(true);
        expect(MirrorFinalizeResult.safeParse({v: 1, view_sha256: h, services: 2, x: 1}).success).toBe(false);
        expect(MirrorDbResult.safeParse({v: 1, dbs: [{index: 0, service: "db", status: "restored"}], resets: [{service: "db", status: "done"}]}).success).toBe(true);
        expect(MirrorDbResult.safeParse({v: 1, dbs: [{index: 0, service: "db", status: "failed"}], resets: []}).success).toBe(false);
        expect(MirrorUpResult.safeParse({v: 1, services: [{service: "web", state: "running"}]}).success).toBe(true);
        expect(MirrorUpResult.safeParse({v: 1, services: [{service: "web", state: "paused"}]}).success).toBe(false);
        expect(MirrorCheckResult.safeParse({v: 1, services: [{service: "web", state: "running", health: "healthy"}], smoke: {status: "ok", http_status: 200}}).success).toBe(true);
        expect(MirrorCheckResult.safeParse({v: 1, services: [], smoke: {status: "ok", http_status: 99}}).success).toBe(false);
        expect(MirrorWipeResult.safeParse({v: 1, containers: 1, networks: 1, volumes: 1, workspace_removed: true, remaining: 0}).success).toBe(true);
        expect(MirrorWipeResult.safeParse({v: 1, containers: 1, networks: 1, volumes: 1, workspace_removed: true, remaining: 1}).success).toBe(false);
        // W23: a stop result with anything still running is never believed (the agent reports `stop_incomplete` instead)
        expect(MirrorStopResult.safeParse({v: 1, stopped: 2, services: [{service: "web", state: "exited"}], remaining: 0}).success).toBe(true);
        expect(MirrorStopResult.safeParse({v: 1, stopped: 2, services: [], remaining: 1}).success).toBe(false);
        expect(MirrorStopResult.safeParse({v: 1, stopped: 2, services: [], remaining: 0, x: 1}).success).toBe(false);
    });
});
