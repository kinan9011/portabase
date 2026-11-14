import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";
import {extras, hoursAgo, preview, rev, view, RP_A} from "@/fork/__tests__/w25-fixtures";
import {capacityFacts} from "@/fork/mirror/derive";
import {MIRRORS} from "@/fork/ui/mirrors/labels";
import {mirrorActions} from "@/fork/ui/mirrors/model";
import {headline} from "@/fork/ui/mirrors/progress/progress.client";
import {capacityWarning, refreshRows, revisionsWipedByRefresh, rollbackRows, rollbackTargets} from "@/fork/ui/mirrors/refresh/model";
import {settled} from "@/fork/ui/mirrors/wizard/model";

vi.mock("@/fork/actions/mirror.action", () => ({})); // headline() lives in a client module that imports the server actions
vi.mock("next/navigation", () => ({useRouter: () => ({refresh: vi.fn()})}));

const now = new Date();
const GIB = 1024 ** 3;
const R = MIRRORS.refresh;

describe("rollbackTargets (predicate == server)", () => {
    const v = (...revs: ReturnType<typeof rev>[]) => view(now, {revisions: revs, active: "r3"});
    const active = rev(now, {id: "r3", seq: 3});
    it("table: only a kept, activated, not retired, not wiped READY revision that is not the active one", () => {
        expect(rollbackTargets(v(active, rev(now, {id: "r2", seq: 2}))).map((r) => r.id)).toEqual(["r2"]);
        expect(rollbackTargets(v(active, rev(now, {id: "r2", seq: 2, state: "failed"}))).length).toBe(0);
        expect(rollbackTargets(v(active, rev(now, {id: "r2", seq: 2, activatedAt: null}))).length).toBe(0); // never activated
        expect(rollbackTargets(v(active, rev(now, {id: "r2", seq: 2, retiredAt: hoursAgo(now, 1)}))).length).toBe(0);
        expect(rollbackTargets(v(active, rev(now, {id: "r2", seq: 2, wipeState: "running"}))).length).toBe(0);
        expect(rollbackTargets(v(active, rev(now, {id: "r2", seq: 2, state: "rolled_back"}))).length).toBe(0);
    });
    it("two candidates keep the newest-first order of the view; the active one is never a target", () => {
        expect(rollbackTargets(v(active, rev(now, {id: "r2", seq: 2}), rev(now, {id: "r1", seq: 1}))).map((r) => r.id)).toEqual(["r2", "r1"]);
    });
    it("the five clauses are exactly the ones rollbackMirror enforces (static check of service.ts)", () => {
        const src = readFileSync("src/fork/mirror/service.ts", "utf8");
        const line = src.split("\n").find((l) => l.includes("no_rollback_target") && l.includes("t.id === m.activeRevisionId")) ?? "";
        for (const clause of ['t.id === m.activeRevisionId', 't.state !== "ready"', "t.activatedAt === null", "t.retiredAt !== null", "t.wipeState !== null"]) expect(line, clause).toContain(clause);
    });
});

describe("revisionsWipedByRefresh", () => {
    it("names the kept non-active READY revision, none once it is retired or wiped", () => {
        expect(revisionsWipedByRefresh(view(now)).map((r) => r.seq)).toEqual([1]);
        const gone = view(now, {revisions: [rev(now, {id: "r2", seq: 2}), rev(now, {id: "r1", seq: 1, wipeState: "verified"})]});
        expect(revisionsWipedByRefresh(gone)).toEqual([]);
    });
});

describe("capacityWarning", () => {
    it("fresh and enough ⇒ null", () => expect(capacityWarning(preview(now), now)).toBeNull());
    it("free disk below the need ⇒ warn", () => expect(capacityWarning(preview(now, {lastCapacity: {freeDiskBytes: 1 * GIB, memAvailableBytes: 16 * GIB, at: hoursAgo(now, 1)}}), now)).toBe(R.capacityWarn));
    it("memory below the need ⇒ warn", () => expect(capacityWarning(preview(now, {lastCapacity: {freeDiskBytes: 50 * GIB, memAvailableBytes: 1 * GIB, at: hoursAgo(now, 1)}}), now)).toBe(R.capacityWarn));
    it("no report ⇒ warn", () => expect(capacityWarning(preview(now, {lastCapacity: null}), now)).toBe(R.capacityWarn));
    it("a report older than 24 h ⇒ warn (computed from the real clock)", () => {
        expect(capacityWarning(preview(now, {lastCapacity: {freeDiskBytes: 50 * GIB, memAvailableBytes: 16 * GIB, at: hoursAgo(now, 25)}}), now)).toBe(R.capacityWarn);
        expect(capacityWarning(preview(now, {lastCapacity: {freeDiskBytes: 50 * GIB, memAvailableBytes: 16 * GIB, at: hoursAgo(now, 23)}}), now)).toBeNull();
    });
    it("no selection ⇒ nothing to warn about", () => expect(capacityWarning(preview(now, {selected: null}), now)).toBeNull());
});

describe("refreshRows", () => {
    const keys = (p: ReturnType<typeof preview>) => refreshRows(p, view(now), now).map((r) => r.key);
    it("six rows with the sentences of the labels", () => {
        const rows = refreshRows(preview(now), view(now), now);
        expect(rows.map((r) => r.key)).toEqual(["age", "space", "memory", "app", "lost", "wiped"]);
        const t = (k: string) => rows.find((r) => r.key === k)?.text ?? "";
        expect(t("age")).toContain("Data from");
        expect(t("space")).toContain("2.0 GiB");
        expect(t("space")).toContain("Runner reported");
        expect(t("memory")).toContain("2.0 GiB");
        expect(t("app")).toBe(R.app.same);
        expect(t("lost")).toContain("revision #2");
        expect(t("wiped")).toContain("Revision #1 (backup #3) is deleted");
    });
    it("sizeUnknown replaces the space sentence", () => {
        const p = preview(now); p.selected = {...p.selected!, sizeUnknown: true};
        expect(refreshRows(p, view(now), now).find((r) => r.key === "space")?.text).toBe(R.spaceUnknown);
    });
    it("app definition: changed / unknown", () => {
        const c = preview(now); c.selected = {...c.selected!, appChanged: true};
        expect(refreshRows(c, view(now), now).find((r) => r.key === "app")?.text).toBe(R.app.changed);
        const u = preview(now); u.selected = {...u.selected!, appChanged: null};
        expect(refreshRows(u, view(now), now).find((r) => r.key === "app")?.text).toBe(R.app.unknown);
    });
    it("nothing else is deleted when no earlier revision is kept; no report says so", () => {
        const single = view(now, {revisions: [rev(now, {id: "r2", seq: 2})]});
        const p = preview(now, {lastCapacity: null});
        const rows = refreshRows(p, single, now);
        expect(rows.find((r) => r.key === "wiped")?.text).toBe(R.wipedNone);
        expect(rows.find((r) => r.key === "space")?.text).toContain(R.notReported);
    });
    it("no selection ⇒ no rows; the warning tone sits on the space row", () => {
        expect(keys(preview(now, {selected: null}))).toEqual([]);
        expect(refreshRows(preview(now, {lastCapacity: null}), view(now), now).find((r) => r.key === "space")?.tone).toBe("warning");
    });
});

describe("rollbackRows", () => {
    it("impact / capacity / lost / checks name both revisions and the deletion of the current one", () => {
        const v = view(now);
        const rows = rollbackRows(v, rollbackTargets(v)[0]!, extras(now).rpDates, 1073741824);
        expect(rows.map((r) => r.key)).toEqual(["impact", "capacity", "lost", "checks"]);
        expect(rows[0]!.text).toContain("#2");
        expect(rows[0]!.text).toContain("#1");
        expect(rows[1]!.text).toContain("2.0 GiB"); // 1 GiB × 2 services of the target
        expect(rows[2]!.text).toContain("Revision #2 and every change made in it are deleted");
    });
});

describe("mirrorActions refresh / rollback", () => {
    const base = {hasActiveRevision: true, activeCreation: false, wipeFailed: false};
    const can = {manage: true, locked: false, flagOn: true, stopStart: true};
    const kind = (a: object) => ("hidden" in a ? "hidden" : "enabled" in a ? "enabled" : "reason");
    it("every status × manage × locked × flag × counts", () => {
        for (const status of ["creating", "deleting", "deleted", "cancelled", "stopping", "starting", "refreshing", "rolling_back", "stopped", "failed", "ready"]) {
            for (const manage of [true, false]) for (const locked of [true, false]) for (const flagOn of [true, false]) for (const [newer, targets] of [[0, 0], [2, 1]] as const) {
                const a = mirrorActions({...base, status, newerVerifiedCount: newer, rollbackTargetCount: targets}, {...can, manage, locked, flagOn});
                const tag = JSON.stringify({status, manage, locked, flagOn, newer});
                if (!manage || ["creating", "deleting", "deleted", "cancelled"].includes(status)) { expect(kind(a.refresh), tag).toBe("hidden"); expect(kind(a.rollback), tag).toBe("hidden"); continue; }
                if (["stopping", "starting", "refreshing", "rolling_back"].includes(status)) { expect(a.refresh, tag).toEqual({reason: MIRRORS.lifecycle.reasons.busy}); expect(a.rollback, tag).toEqual({reason: MIRRORS.lifecycle.reasons.busy}); continue; }
                if (!flagOn) { expect(a.refresh, tag).toEqual({reason: MIRRORS.list.flagOff}); continue; }
                if (locked) { expect(a.refresh, tag).toEqual({reason: MIRRORS.lifecycle.reasons.locked}); continue; }
                if (status === "stopped") { expect(a.refresh, tag).toEqual({reason: R.reasons.startFirst}); continue; }
                if (status === "failed") { expect(a.refresh, tag).toEqual({reason: R.reasons.notReady}); continue; }
                expect(kind(a.refresh), tag).toBe(newer > 0 ? "enabled" : "reason");
                expect(kind(a.rollback), tag).toBe(targets > 0 ? "enabled" : "reason");
            }
        }
    });
    it("without the facts the buttons show their nothing-to-do reasons", () => {
        const a = mirrorActions({...base, status: "ready"}, can);
        expect(a.refresh).toEqual({reason: R.reasons.noNewer});
        expect(a.rollback).toEqual({reason: R.reasons.noTarget});
    });
    it("a failed creation (no active revision) offers neither", () => {
        const a = mirrorActions({...base, hasActiveRevision: false, status: "failed"}, can);
        expect(kind(a.refresh)).toBe("hidden");
    });
});

describe("F-1 settled() keeps polling during a refresh / rollback (even when the newest revision is already READY)", () => {
    it("refreshing + newest ready ⇒ not settled; rolling_back ⇒ not settled; ready ⇒ settled", () => {
        const newestReady = [rev(now, {id: "r3", seq: 3}), rev(now, {id: "r2", seq: 2})];
        expect(settled(view(now, {status: "refreshing", revisions: newestReady, active: "r2", op: "r3"}))).toBe(false);
        expect(settled(view(now, {status: "rolling_back", op: "r1"}))).toBe(false);
        expect(settled(view(now, {status: "ready"}))).toBe(true);
    });
});

describe("F-2 headline()", () => {
    const building = rev(now, {id: "r3", seq: 3, rpSequence: 6, state: "restoring_db", steps: [{name: "verify_manifest", status: "done"}, {name: "stage", status: "running"}], activatedAt: null, readiedAt: null});
    it("refreshing: names the build and says the old revision keeps serving; switching once the new one is READY", () => {
        const h = headline(view(now, {status: "refreshing", revisions: [building, rev(now, {id: "r2", seq: 2})], op: "r3"}));
        expect(h.text).toContain("Refreshing: building revision #3 from backup #6");
        expect(h.text).toContain("Revision #2 keeps serving");
        expect(h.tone).toBe("active");
        const s = headline(view(now, {status: "refreshing", revisions: [rev(now, {id: "r3", seq: 3, activatedAt: null}), rev(now, {id: "r2", seq: 2})], op: "r3"}));
        expect(s.text).toBe(R.switching(3, 2));
        expect(s.text).not.toContain("Creating");
    });
    it("rolling_back: names the target, never says Ready", () => {
        const h = headline(view(now, {status: "rolling_back", op: "r1"}));
        expect(h.text).toBe(MIRRORS.rollback.line(1, 2));
        expect(h.text).not.toMatch(/^Ready/);
    });
    it("failed after refresh_broken / rollback_broken says the route switch back failed, not the stop sentence", () => {
        const v = view(now, {status: "failed"});
        expect(headline(v, {lastFrom: "refreshing"}).text).toBe(R.brokenLine);
        expect(headline(v, {lastFrom: "rolling_back"}).text).toBe(MIRRORS.rollback.brokenLine);
        expect(headline(v, {lastFrom: "stopping"}).text).toBe(MIRRORS.lifecycle.stopFailedLine);
        expect(headline(v).text).toBe(MIRRORS.lifecycle.stopFailedLine);
        expect(headline(v, {lastFrom: "refreshing"}).tone).toBe("danger");
    });
    it("a Ready mirror whose newest (refresh) revision failed is still Ready, not 'could not be created'", () => {
        const failed = rev(now, {id: "r3", seq: 3, state: "failed", reason: "insufficient_disk", activatedAt: null, readiedAt: null});
        const h = headline(view(now, {revisions: [failed, rev(now, {id: "r2", seq: 2})]}));
        expect(h.text).toMatch(/^Ready/);
        expect(h.text).not.toContain("could not be created");
    });
});

describe("capacityFacts (shared with checkMirrorCapacity)", () => {
    it("first matching root wins, non-finite ⇒ null", () => {
        const r = {roots: [{path: "/other", free_bytes: 1}, {path: "/srv/restore", free_bytes: 7}, {path: "/srv", free_bytes: 9}], mem_available_bytes: 5};
        expect(capacityFacts(r, "/srv/restore/x")).toEqual({free: 7, mem: 5});
        expect(capacityFacts({roots: [{path: "/srv/restore", free_bytes: Number.NaN}], mem_available_bytes: -1}, "/srv/restore")).toEqual({free: null, mem: null});
        expect(capacityFacts(null, "/srv/restore")).toEqual({free: null, mem: null});
        expect(capacityFacts(r, null)).toEqual({free: null, mem: 5});
    });
});

describe("RP_A fixture sanity", () => { it("is a uuid", () => expect(RP_A).toMatch(/^[0-9a-f-]{36}$/)); });
