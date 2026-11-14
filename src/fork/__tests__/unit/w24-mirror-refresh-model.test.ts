import {describe, expect, it} from "vitest";
import {PAYLOAD_SCHEMAS_FOR_TEST} from "@/fork/agent-channel/tasks";
import {TASK_REQUIRES, TARGETED_TASK_TYPES, MIRROR_CAPABILITY, RUNNER_CAPABILITY} from "@/fork/agent-channel/vocab";
import {checkRouteSwitch} from "@/fork/mirror/derive";
import {nextMirrorStatus, type LifecycleEvent} from "@/fork/mirror/lifecycle";
import {MirrorRoutePayload, MirrorRouteRemoveResult, MirrorRouteResult, MirrorRouteSwitchResult} from "@/fork/mirror/payload-schema";
import {toMirrorView} from "@/fork/mirror/view";
import {isWipeEligible} from "@/fork/mirror/wipe";
import {MIRROR_STATUSES, type MirrorStatus, REVISION_MAX_AGE_DAYS} from "@/fork/mirror/vocab";
import {mirrorActions, mirrorHealth} from "@/fork/ui/mirrors/model";

const NEW_LEGAL: [MirrorStatus, LifecycleEvent, MirrorStatus][] = [
    ["ready", "refresh_requested", "refreshing"], ["refreshing", "refresh_done", "ready"], ["refreshing", "refresh_failed", "ready"], ["refreshing", "refresh_broken", "failed"],
    ["ready", "rollback_requested", "rolling_back"], ["rolling_back", "rollback_done", "ready"], ["rolling_back", "rollback_failed", "ready"], ["rolling_back", "rollback_broken", "failed"],
];
const NEW_EVENTS = NEW_LEGAL.map((l) => l[1]).filter((e, i, a) => a.indexOf(e) === i);

describe("W24 lifecycle status table", () => {
    it("every new legal pair moves, every other pair of the new events throws (a refresh / rollback only starts from ready, only ends from its own status)", () => {
        for (const [from, ev, to] of NEW_LEGAL) expect(nextMirrorStatus(from, ev), `${from} ${ev}`).toBe(to);
        for (const from of MIRROR_STATUSES) for (const ev of NEW_EVENTS) {
            if (NEW_LEGAL.some((l) => l[0] === from && l[1] === ev)) continue;
            expect(() => nextMirrorStatus(from, ev), `${from} ${ev}`).toThrow(/illegal mirror status move/);
        }
    });
    it("a stopped / failed / creating mirror can neither refresh nor roll back", () => {
        for (const s of ["stopped", "failed", "creating", "deleting", "refreshing", "rolling_back"] as const) {
            expect(() => nextMirrorStatus(s, "refresh_requested")).toThrow();
            expect(() => nextMirrorStatus(s, "rollback_requested")).toThrow();
        }
    });
});

describe("isWipeEligible (W24)", () => {
    it("terminal non-ready and rolled_back: always; ready: only while deleting or once retired; the active/serving ready one never", () => {
        for (const s of ["blocked", "failed", "cancelled", "rolled_back"]) expect(isWipeEligible(s, "ready"), s).toBe(true);
        expect(isWipeEligible("ready", "ready")).toBe(false);
        expect(isWipeEligible("ready", "ready", null)).toBe(false);
        expect(isWipeEligible("ready", "stopped", undefined)).toBe(false);
        expect(isWipeEligible("ready", "deleting")).toBe(true);
        expect(isWipeEligible("ready", "ready", new Date(0))).toBe(true);
        expect(isWipeEligible("validating", "ready", new Date(0))).toBe(false); // an in-flight revision is never wiped
    });
});

describe("mirror_route contract (W24)", () => {
    const hdr = {v: 1, restore_id: "11111111-1111-4111-8111-111111111111", plan_id: "22222222-2222-4222-8222-222222222222", plan_hash: "a".repeat(64), stack_id: "33333333-3333-4333-8333-333333333333", rp_id: "44444444-4444-4444-8444-444444444444",
        purpose: "mirror", mode: "new_stack", host_role: "runner", approvals: [], workspace: "/srv/portabase-mirrors/pbm-demo-r2", project: "pbm-demo-r2"};
    const good = {...hdr, action: "switch", mirror_id: "55555555-5555-4555-8555-555555555555", route_port: 41500, service: "web", target: 80, http_path: "/"};
    it("is a registered, targeted type that needs runner.v1 + mirror.v1", () => {
        expect(TARGETED_TASK_TYPES).toContain("mirror_route");
        expect(TASK_REQUIRES.mirror_route).toEqual([RUNNER_CAPABILITY, MIRROR_CAPABILITY]);
        expect(PAYLOAD_SCHEMAS_FOR_TEST.mirror_route).toBe(MirrorRoutePayload);
    });
    it("accepts a switch and a remove; rejects every forged shape", () => {
        expect(MirrorRoutePayload.safeParse(good).success).toBe(true);
        expect(MirrorRoutePayload.safeParse({...good, action: "remove", http_path: null}).success).toBe(true);
        for (const bad of [{...good, route_port: 40999}, {...good, route_port: 42000}, {...good, extra: 1}, {...good, action: "restart"}, {...good, mirror_id: "x"}, {...good, service: "a b"}, {...good, target: 0}, {...good, target: 70000},
            {...good, http_path: "/a b"}, {...good, host_role: "production"}, {...good, project: "demo"}, {...good, workspace: "/srv/portabase-mirrors/other"}, {...good, approvals: ["x"]}]) {
            expect(MirrorRoutePayload.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
        }
    });
    it("results: strict union; `remaining` is always 0; switch needs switched:true", () => {
        const sw = {v: 1, route_port: 41500, switched: true, smoke: {status: "ok", http_status: 200}};
        expect(MirrorRouteSwitchResult.safeParse(sw).success).toBe(true);
        expect(MirrorRouteResult.safeParse(sw).success).toBe(true);
        expect(MirrorRouteSwitchResult.safeParse({...sw, switched: false}).success).toBe(false);
        expect(MirrorRouteSwitchResult.safeParse({...sw, extra: 1}).success).toBe(false);
        const rm = {v: 1, removed: {container: 1, dir: true}, remaining: 0};
        expect(MirrorRouteRemoveResult.safeParse(rm).success).toBe(true);
        expect(MirrorRouteRemoveResult.safeParse({...rm, remaining: 1}).success).toBe(false);
        expect(MirrorRouteRemoveResult.safeParse({...rm, removed: {container: 2, dir: true}}).success).toBe(false);
        expect(MirrorRouteResult.safeParse({v: 1}).success).toBe(false);
    });
    it("checkRouteSwitch: the port must be the allocated one, the smoke through the route must be ok (and a 5xx / unreported status is not)", () => {
        const sw = (o: Record<string, unknown> = {}) => ({v: 1, route_port: 41500, switched: true, smoke: {status: "ok", http_status: 200}, ...o});
        expect(checkRouteSwitch(sw(), 41500, {http_path: "/"})).toEqual({ok: true});
        expect(checkRouteSwitch(sw(), 41501, {http_path: "/"})).toEqual({ok: false, code: "route_failed"});
        expect(checkRouteSwitch(sw(), null, {http_path: "/"})).toEqual({ok: false, code: "route_failed"});
        expect(checkRouteSwitch(sw({smoke: {status: "failed", http_status: null}}), 41500, {http_path: null})).toEqual({ok: false, code: "route_failed"});
        expect(checkRouteSwitch(sw({smoke: {status: "ok", http_status: 503}}), 41500, {http_path: "/"})).toEqual({ok: false, code: "route_failed"});
        expect(checkRouteSwitch(sw({smoke: {status: "ok", http_status: null}}), 41500, {http_path: "/"})).toEqual({ok: false, code: "route_failed"});
        expect(checkRouteSwitch(sw({smoke: {status: "ok", http_status: null}}), 41500, {http_path: null})).toEqual({ok: true}); // plain TCP smoke
        expect(checkRouteSwitch({v: 1, removed: {container: 0, dir: false}, remaining: 0}, 41500, {http_path: null})).toEqual({ok: false, code: "route_failed"});
    });
});

describe("UI model (W24): refreshing / rolling_back", () => {
    it("the active revision keeps serving: health is evaluated like ready", () => {
        const ok = [{state: "running", health: "healthy"}];
        for (const s of ["ready", "refreshing", "rolling_back"]) expect(mirrorHealth(s, ok), s).toBe("healthy");
        for (const s of ["refreshing", "rolling_back"]) expect(mirrorHealth(s, [{state: "exited", health: null}]), s).toBe("degraded");
        expect(mirrorHealth("starting", ok)).toBe("pending");
    });
    it("no Stop / Start / Delete while refreshing or rolling back (visible reason); no Refresh / Rollback control exists in W24", () => {
        const can = {manage: true, locked: false, flagOn: true, stopStart: true};
        for (const status of ["refreshing", "rolling_back"]) {
            const a = mirrorActions({status, hasActiveRevision: true, activeCreation: false, wipeFailed: false}, can);
            expect(a.stop).toHaveProperty("reason"); expect(a.start).toHaveProperty("reason"); expect(a.delete).toHaveProperty("reason");
            expect(Object.keys(a).sort()).toEqual(["cancel", "delete", "retryWipe", "start", "stop"]);
        }
    });
});

describe("toMirrorView (W24 fields)", () => {
    const NOW = new Date("2027-03-01T12:00:00Z");
    const m = {id: "m", organizationId: "o", stackId: "s", runnerAgentId: null, runnerAgentName: "r", name: "demo", policy: {}, status: "ready", activeRevisionId: "r1", routePort: 41500, routeRevisionId: "r1", opRevisionId: null, createdBy: "u", createdAt: NOW, updatedAt: NOW, deletedAt: null};
    const rev = (o: Record<string, unknown>) => ({id: "r1", mirrorId: "m", organizationId: "o", stackId: "s", seq: 1, rpId: null, rpSequence: 1, planId: null, planHash: "a".repeat(64), runnerAgentId: null, project: "pbm-demo-r1", workspace: "/srv/x", hostPort: 41000, state: "ready", reason: null, failedStep: null,
        steps: [], refusals: null, spec: null, specSha256: null, sourceViewSha256: null, finalViewSha256: null, services: [], gates: {}, probeTaskId: null, startedBy: "u", createdAt: NOW, deadlineAt: NOW, readiedAt: NOW, activatedAt: NOW, retiredAt: null, finishedAt: NOW, durationSeconds: 1,
        cancelRequestedAt: null, cancelRequestedBy: null, wipeState: null, wipeReason: null, wipeStartedAt: null, wipeFinishedAt: null, updatedAt: NOW, ...o});
    const view = (now: Date, o: Record<string, unknown> = {}) => toMirrorView(m as never, [rev(o)] as never, {containsPersonalData: false, optIn: false}, now);
    it("retentionDue only for an ACTIVE revision older than 30 days, computed from the explicit now (never the real clock)", () => {
        expect(view(new Date(NOW.getTime() + (REVISION_MAX_AGE_DAYS - 1) * 86_400_000)).mirror.retentionDue).toBe(false);
        expect(view(new Date(NOW.getTime() + (REVISION_MAX_AGE_DAYS + 1) * 86_400_000)).mirror.retentionDue).toBe(true);
        expect(view(new Date(NOW.getTime() + 90 * 86_400_000), {readiedAt: null}).mirror.retentionDue).toBe(false);
    });
    it("exposes opRevisionId, activatedAt, retiredAt and nothing about the route port (it is shown only by the audited access call)", () => {
        const v = view(NOW, {retiredAt: NOW});
        expect(v.mirror).toMatchObject({opRevisionId: null});
        expect(v.revisions[0]).toMatchObject({activatedAt: NOW.toISOString(), retiredAt: NOW.toISOString()});
        expect(JSON.stringify(v)).not.toContain("41500");
        expect(JSON.stringify(v)).not.toContain("routePort");
    });
});
