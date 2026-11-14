import {describe, expect, it} from "vitest";
import {MIRROR_STATUSES} from "@/fork/mirror/vocab";
import type {MirrorView} from "@/fork/mirror/view";
import {MIRRORS, STATUS_TEXT, statusText, stepText} from "@/fork/ui/mirrors/labels";
import {HEALTHS, ago, failedNewerRevision, groupSteps, mirrorActions, mirrorHealth, startTestedLabel} from "@/fork/ui/mirrors/model";
import {settled} from "@/fork/ui/mirrors/wizard/model";

const run = {state: "running", health: null};
const DAY = 86_400_000;

describe("mirrorHealth (DD-3, health at last check)", () => {
    it("pending while an operation is in flight", () => { for (const s of ["creating", "starting", "stopping", "deleting"]) expect(mirrorHealth(s, [])).toBe("pending"); });
    it("stopped ⇒ not_running", () => expect(mirrorHealth("stopped", [run])).toBe("not_running"));
    it("failed / cancelled ⇒ failed", () => { expect(mirrorHealth("failed", [])).toBe("failed"); expect(mirrorHealth("cancelled", [])).toBe("failed"); });
    it("ready + all running and healthy/none/null ⇒ healthy", () => {
        expect(mirrorHealth("ready", [run, {state: "running", health: "healthy"}, {state: "running", health: "none"}])).toBe("healthy");
    });
    it("ready otherwise ⇒ degraded", () => {
        expect(mirrorHealth("ready", [run, {state: "exited", health: null}])).toBe("degraded");
        expect(mirrorHealth("ready", [{state: "running", health: "unhealthy"}])).toBe("degraded");
        expect(mirrorHealth("ready", [])).toBe("degraded");
    });
    it("unknown status ⇒ unknown; every health has text", () => {
        expect(mirrorHealth("zzz", [])).toBe("unknown");
        for (const h of HEALTHS) expect(MIRRORS.health.text[h]).toBeTruthy();
    });
});

describe("mirrorActions (DD-7 table)", () => {
    const facts = (status: string, o: Partial<{hasActiveRevision: boolean; activeCreation: boolean; wipeFailed: boolean}> = {}) => ({status, hasActiveRevision: false, activeCreation: false, wipeFailed: false, ...o});
    const can = {manage: true, locked: false, flagOn: true, stopStart: true};
    it("members get no button at all", () => {
        const a = mirrorActions(facts("ready", {hasActiveRevision: true}), {...can, manage: false});
        expect(Object.values(a).every((x) => "hidden" in x)).toBe(true);
    });
    it("creating: delete blocked with a reason, cancel offered while a revision is active", () => {
        const a = mirrorActions(facts("creating", {activeCreation: true}), can);
        expect(a.delete).toEqual({reason: MIRRORS.lifecycle.reasons.cancelFirst});
        expect(a.cancel).toEqual({enabled: true});
        expect(a.stop).toEqual({hidden: true});
    });
    it("ready: delete + stop; no start", () => {
        const a = mirrorActions(facts("ready", {hasActiveRevision: true}), can);
        expect(a).toMatchObject({delete: {enabled: true}, stop: {enabled: true}, start: {hidden: true}});
    });
    it("Part A (stopStart false) never offers stop/start", () => {
        const a = mirrorActions(facts("stopped", {hasActiveRevision: true}), {...can, stopStart: false});
        expect(a.stop).toEqual({hidden: true});
        expect(a.start).toEqual({hidden: true});
        expect(a.delete).toEqual({enabled: true});
    });
    it("stopped: delete + start; start blocked when locked / flag off", () => {
        expect(mirrorActions(facts("stopped", {hasActiveRevision: true}), can).start).toEqual({enabled: true});
        expect(mirrorActions(facts("stopped", {hasActiveRevision: true}), {...can, locked: true}).start).toEqual({reason: MIRRORS.lifecycle.reasons.startLocked});
        expect(mirrorActions(facts("stopped", {hasActiveRevision: true}), {...can, flagOn: false}).start).toEqual({reason: MIRRORS.list.flagOff});
        expect(mirrorActions(facts("stopped", {hasActiveRevision: true}), {...can, locked: true}).delete).toEqual({enabled: true}); // OD-W23-2
    });
    it("busy statuses block with the wait reason; deleting hides delete", () => {
        for (const s of ["stopping", "starting"]) {
            const a = mirrorActions(facts(s, {hasActiveRevision: true}), can);
            expect(a.delete).toEqual({reason: MIRRORS.lifecycle.reasons.busy});
            expect(a.stop).toEqual({reason: MIRRORS.lifecycle.reasons.busy});
        }
        expect(mirrorActions(facts("deleting"), can).delete).toEqual({hidden: true});
    });
    it("failed with an active revision: stop (retry) + delete; without one: delete only", () => {
        expect(mirrorActions(facts("failed", {hasActiveRevision: true}), can)).toMatchObject({stop: {enabled: true}, delete: {enabled: true}});
        expect(mirrorActions(facts("failed"), can)).toMatchObject({stop: {hidden: true}, delete: {enabled: true}});
        expect(mirrorActions(facts("cancelled"), can).delete).toEqual({enabled: true});
    });
    it("retry wipe only when the wipe failed; blocked while locked; deleted mirror has nothing", () => {
        expect(mirrorActions(facts("failed", {wipeFailed: true}), can).retryWipe).toEqual({enabled: true});
        expect(mirrorActions(facts("failed", {wipeFailed: true}), {...can, locked: true}).retryWipe).toEqual({reason: MIRRORS.lifecycle.reasons.locked});
        expect(mirrorActions(facts("failed"), can).retryWipe).toEqual({hidden: true});
        expect(Object.values(mirrorActions(facts("deleted"), can)).every((x) => "hidden" in x)).toBe(true);
    });
});

describe("groupSteps", () => {
    it("collapses render / compile / finalize into one line, failure wins", () => {
        const g = groupSteps([{name: "probe", status: "done"}, {name: "render", status: "done"}, {name: "compile", status: "running"}, {name: "finalize", status: "pending"}, {name: "up", status: "pending"}], stepText);
        expect(g.map((x) => x.text)).toEqual([stepText("probe"), stepText("render"), stepText("up")]);
        expect(g[1]?.status).toBe("running");
        expect(groupSteps([{name: "render", status: "done"}, {name: "compile", status: "failed"}, {name: "finalize", status: "pending"}], stepText)[0]?.status).toBe("failed");
    });
    it("does not merge non-consecutive equal sentences", () => {
        expect(groupSteps([{name: "verify_manifest", status: "done"}, {name: "stage", status: "done"}, {name: "probe", status: "done"}], stepText)).toHaveLength(3);
    });
});

describe("startTestedLabel (ADR-016 decay, DD-8) — clock is the real clock", () => {
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    it("null when there is no fact", () => expect(startTestedLabel({readiedAt: null, now, staleAfterDays: 14})).toBeNull());
    it("fresh now / 14 d exactly ⇒ not stale (strict >)", () => {
        expect(startTestedLabel({readiedAt: at(0), now, staleAfterDays: 14})).toEqual({text: "App start-tested · 0 d ago", tone: "success"});
        expect(startTestedLabel({readiedAt: at(14 * DAY), now, staleAfterDays: 14})?.tone).toBe("success");
    });
    it("14 d + 1 ms and 15 d ⇒ out of date", () => {
        expect(startTestedLabel({readiedAt: at(14 * DAY + 1), now, staleAfterDays: 14})).toEqual({text: "App start-tested · Out of date (14 d ago)", tone: "warning"});
        expect(startTestedLabel({readiedAt: at(15 * DAY), now, staleAfterDays: 14})?.tone).toBe("warning");
    });
    it("future ⇒ 0 d; window 30 d widens the fresh range", () => {
        expect(startTestedLabel({readiedAt: new Date(now.getTime() + DAY).toISOString(), now, staleAfterDays: 14})?.text).toBe("App start-tested · 0 d ago");
        expect(startTestedLabel({readiedAt: at(20 * DAY), now, staleAfterDays: 30})?.tone).toBe("success");
    });
    it("never claims more than started (copy guard)", () => {
        const copy = JSON.stringify([MIRRORS.facet.fresh(1), MIRRORS.facet.stale(1), MIRRORS.facet.meaning, MIRRORS.lifecycle, STATUS_TEXT]).replace(/not a full restore test/i, "");
        expect(copy).not.toMatch(/verified|restore-tested/i);
    });
});

const rev = (o: Partial<MirrorView["revisions"][number]>): MirrorView["revisions"][number] => ({
    id: "r", seq: 1, state: "ready", reason: null, failedStep: null, steps: [], gates: {expected_data: null, db_health: null, app_smoke: null, isolation: null, side_effects: null}, refusals: [], services: [],
    hostPort: 41000, rpSequence: 1, readiedAt: null, wipeState: null, deadlineAt: new Date().toISOString(), createdAt: new Date().toISOString(), ...o,
});
const view = (status: string, revisions: MirrorView["revisions"], activeRevisionId: string | null): MirrorView => ({
    mirror: {id: "m", name: "demo", status, runnerName: "box", stackId: "s", activeRevisionId, createdAt: new Date().toISOString()}, revisions, privacy: {containsPersonalData: true, optIn: true},
});

describe("failedNewerRevision", () => {
    it("null when the newest revision is the active one or there is no active revision", () => {
        expect(failedNewerRevision(view("ready", [rev({id: "a", seq: 1})], "a"))).toBeNull();
        expect(failedNewerRevision(view("failed", [rev({id: "b", seq: 2, state: "failed", reason: "smoke_failed"})], null))).toBeNull();
    });
    it("object when a newer revision failed / was blocked while an older one is active", () => {
        const v = view("ready", [rev({id: "b", seq: 2, state: "failed", reason: "smoke_failed", failedStep: "check"}), rev({id: "a", seq: 1})], "a");
        expect(failedNewerRevision(v)).toEqual({seq: 2, reason: "smoke_failed", failedStep: "check", activeSeq: 1});
        expect(failedNewerRevision(view("ready", [rev({id: "b", seq: 2, state: "blocked", reason: "plan_blocked"}), rev({id: "a", seq: 1})], "a"))?.seq).toBe(2);
    });
    it("a newer revision still being built is not a failure", () => {
        expect(failedNewerRevision(view("ready", [rev({id: "b", seq: 2, state: "staging"}), rev({id: "a", seq: 1})], "a"))).toBeNull();
    });
});

describe("settled (G7) + labels exhaustiveness", () => {
    it("is false while a lifecycle action is in flight, even with a ready revision", () => {
        for (const s of ["deleting", "stopping", "starting"]) expect(settled(view(s, [rev({id: "a"})], "a"))).toBe(false);
        expect(settled(view("ready", [rev({id: "a"})], "a"))).toBe(true);
    });
    it("every mirror status has text", () => { for (const s of MIRROR_STATUSES) expect(STATUS_TEXT[s]).toBeTruthy(); expect(statusText("zzz")).toBe("zzz"); });
});

describe("ago", () => {
    const now = new Date();
    it("buckets", () => {
        expect(ago(null, now)).toBe("");
        expect(ago(new Date(now.getTime() - 5_000).toISOString(), now)).toBe("just now");
        expect(ago(new Date(now.getTime() - 3 * 3600e3).toISOString(), now)).toBe("3 h ago");
        expect(ago(new Date(now.getTime() - 2 * DAY).toISOString(), now)).toBe("2 d ago");
    });
});
