// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {extras, hoursAgo, rev, view} from "@/fork/__tests__/w25-fixtures";
import type {MirrorDetailExtras} from "@/fork/mirror/list-view";
import {MIRRORS, reasonText} from "@/fork/ui/mirrors/labels";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const h = vi.hoisted(() => ({view: vi.fn(), cancel: vi.fn(), refresh: vi.fn()}));
vi.mock("@/fork/actions/mirror.action", () => ({getMirrorViewAction: h.view, getMirrorAccessAction: vi.fn(), cancelMirrorRevisionAction: h.cancel, retryMirrorWipeAction: vi.fn(), deleteMirrorAction: vi.fn(), stopMirrorAction: vi.fn(), startMirrorAction: vi.fn(),
    previewMirrorRefreshAction: vi.fn(), refreshMirrorAction: vi.fn(), rollbackMirrorAction: vi.fn()}));
vi.mock("next/navigation", () => ({useRouter: () => ({refresh: h.refresh, push: vi.fn()}), usePathname: () => "/dashboard/mirrors/x"}));

import {MirrorDetail, type DetailProps} from "@/fork/ui/mirrors/detail/detail.client";
import {MIRROR_POLL_MS} from "@/fork/ui/mirrors/progress/progress.client";

const now = new Date();
const R = MIRRORS.refresh;
const props = (o: Partial<DetailProps> = {}): DetailProps => ({initial: view(now), extras: extras(now), log: [], canManage: true, locked: false, flagOn: true, now: now.toISOString(), staleAfterDays: 14, tab: "overview", refreshFacts: {newerVerifiedCount: 2}, ...o});
const mount = (p: DetailProps) => render(<StatusAnnouncer><MirrorDetail {...p}/></StatusAnnouncer>);
const op = (o: Partial<NonNullable<MirrorDetailExtras["lastOp"]>>): NonNullable<MirrorDetailExtras["lastOp"]> => ({status: "ready", from: "refreshing", code: "insufficient_disk", at: hoursAgo(now, 0.1), ...o});
const building = () => rev(now, {id: "r3", seq: 3, rpSequence: 6, state: "restoring_db", steps: [{name: "verify_manifest", status: "done"}, {name: "stage", status: "running"}], activatedAt: null, readiedAt: null});

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("buttons and notes on Overview", () => {
    it("Refresh and Roll back are enabled with newer backups and a kept revision; no reason text shown", () => {
        mount(props());
        expect(screen.getByTestId("mirror-refresh").getAttribute("aria-disabled")).toBeNull();
        expect(screen.getByTestId("mirror-rollback").getAttribute("aria-disabled")).toBeNull();
    });
    it("no newer backup / no target ⇒ visible reasons (aria-disabled)", () => {
        mount(props({refreshFacts: {newerVerifiedCount: 0}, initial: view(now, {revisions: [rev(now, {id: "r2", seq: 2})]})}));
        expect(screen.getByTestId("mirror-refresh").getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(R.reasons.noNewer)).toBeTruthy();
        expect(screen.getByTestId("mirror-rollback").getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(R.reasons.noTarget)).toBeTruthy();
    });
    it("without the optional refreshFacts prop (older callers) the Refresh reason is shown", () => {
        mount(props({refreshFacts: undefined}));
        expect(screen.getByText(R.reasons.noNewer)).toBeTruthy();
    });
    it("a member sees neither button (read-only page); flag off and locked give reasons", () => {
        mount(props({canManage: false}));
        expect(screen.queryByTestId("mirror-refresh")).toBeNull();
        expect(screen.queryByTestId("mirror-rollback")).toBeNull();
        cleanup();
        mount(props({flagOn: false}));
        expect(screen.getAllByText(MIRRORS.list.flagOff).length).toBeGreaterThan(0);
        cleanup();
        mount(props({locked: true}));
        expect(screen.getAllByText(MIRRORS.lifecycle.reasons.locked).length).toBeGreaterThan(0);
    });
    it("retentionDue shows the 30-day note (role=note, icon + text)", () => {
        mount(props({initial: view(now, {retentionDue: true})}));
        const n = screen.getByTestId("retention-due");
        expect(n.getAttribute("role")).toBe("note");
        expect(n.textContent).toContain(R.retention);
        expect(n.querySelector("svg")).toBeTruthy();
    });
    it("History marks the rollback target and moves with the view", () => {
        mount(props({tab: "history"}));
        const t = screen.getAllByTestId("history-rollback-target");
        expect(t.length).toBe(1);
        expect(t[0]!.closest("tr")?.textContent).toContain("#1");
        // W25 browser finding: only the ACTIVE copy is "the running copy"; a kept rollback target is stopped
        const rows = screen.getAllByTestId("history-row");
        for (const r of rows) {
            if (r.getAttribute("data-active") === "true") expect(r.textContent).toContain("this is the running copy");
            else if (r.textContent?.includes("Ready")) { expect(r.textContent).not.toContain("this is the running copy"); expect(r.textContent).toContain("Kept, not running"); }
        }
    });
});

describe("last operation lines (F-4)", () => {
    it("a failed refresh while the newest revision is NOT the failed one (route switch failed): refresh failedLine", () => {
        mount(props({extras: extras(now, {lastOp: op({})})}));
        expect(screen.getByTestId("last-op").textContent).toBe(R.failedLine(reasonText("insufficient_disk"), 2));
    });
    it("suppressed when the failed-newer panel already explains it", () => {
        const failed = rev(now, {id: "r3", seq: 3, state: "failed", reason: "insufficient_disk", activatedAt: null, readiedAt: null});
        mount(props({initial: view(now, {revisions: [failed, rev(now, {id: "r2", seq: 2}), rev(now, {id: "r1", seq: 1})]}), extras: extras(now, {lastOp: op({})})}));
        expect(screen.getByTestId("failed-newer")).toBeTruthy();
        expect(screen.queryByTestId("last-op")).toBeNull();
    });
    it("a failed rollback: rollback failedLine; broken lines come from the headline, no extra line", () => {
        mount(props({extras: extras(now, {lastOp: op({from: "rolling_back", code: "route_failed"})})}));
        expect(screen.getByTestId("last-op").textContent).toBe(MIRRORS.rollback.failedLine(reasonText("route_failed"), 2));
        cleanup();
        mount(props({initial: view(now, {status: "failed"}), extras: extras(now, {lastOp: op({status: "failed", from: "refreshing", code: "route_incomplete"})})}));
        expect(screen.getByTestId("mirror-headline").textContent).toBe(R.brokenLine);
        expect(screen.queryByTestId("last-op")).toBeNull();
        cleanup();
        mount(props({initial: view(now, {status: "failed"}), extras: extras(now, {lastOp: op({status: "failed", from: "rolling_back", code: "route_incomplete"})})}));
        expect(screen.getByTestId("mirror-headline").textContent).toBe(MIRRORS.rollback.brokenLine);
    });
    it("a stop failure keeps its W23 wording; an older failure for another status is not shown", () => {
        mount(props({initial: view(now, {status: "failed"}), extras: extras(now, {lastOp: op({status: "failed", from: "stopping", code: "stop_incomplete"})})}));
        expect(screen.getByTestId("last-op").textContent).toBe(MIRRORS.lifecycle.lastStopFailed(reasonText("stop_incomplete")));
        cleanup();
        mount(props({extras: extras(now, {lastOp: op({status: "stopped", from: "starting", code: "route_failed"})})}));
        expect(screen.queryByTestId("last-op")).toBeNull();
    });
});

describe("progress during a refresh / rollback (F-1, F-2, F-3)", () => {
    it("shows the building headline, 'Refreshing' badge, 'Cancel refresh' and keeps access open", () => {
        mount(props({initial: view(now, {status: "refreshing", revisions: [building(), rev(now, {id: "r2", seq: 2})], op: "r3"})}));
        expect(screen.getByTestId("mirror-headline").textContent).toContain("Refreshing: building revision #3");
        expect(screen.getByText("Refreshing", {selector: "span, div"})).toBeTruthy();
        expect(screen.getByTestId("mirror-cancel").textContent).toBe(R.cancel.label);
        expect(screen.getByTestId("mirror-access")).toBeTruthy();
        expect(screen.queryByTestId("ready-note")).toBeNull();
        expect(screen.queryByText(MIRRORS.progress.cancel)).toBeNull(); // never "Cancel creation" during a refresh
    });
    it("Cancel refresh opens the refresh-specific confirm", async () => {
        mount(props({initial: view(now, {status: "refreshing", revisions: [building(), rev(now, {id: "r2", seq: 2})], op: "r3"})}));
        fireEvent.click(screen.getByTestId("mirror-cancel"));
        expect(await screen.findByText(R.cancel.title(3))).toBeTruthy();
        expect(screen.getByText(R.cancel.body(2))).toBeTruthy();
    });
    it("the poller keeps polling while refreshing and ends on Ready on the new revision", async () => {
        vi.useFakeTimers();
        const done = view(now, {status: "ready", revisions: [rev(now, {id: "r3", seq: 3, rpSequence: 6}), rev(now, {id: "r2", seq: 2})], active: "r3"});
        const switching = view(now, {status: "refreshing", revisions: [rev(now, {id: "r3", seq: 3, rpSequence: 6, activatedAt: null}), rev(now, {id: "r2", seq: 2})], op: "r3"});
        h.view.mockResolvedValueOnce({data: {ok: true, view: switching}}).mockResolvedValue({data: {ok: true, view: done}});
        mount(props({initial: view(now, {status: "refreshing", revisions: [building(), rev(now, {id: "r2", seq: 2})], op: "r3"})}));
        await act(async () => { await vi.advanceTimersByTimeAsync(MIRROR_POLL_MS + 10); });
        expect(screen.getByTestId("mirror-headline").textContent).toBe(R.switching(3, 2));
        await act(async () => { await vi.advanceTimersByTimeAsync(MIRROR_POLL_MS + 10); });
        expect(h.view.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(screen.getByTestId("mirror-headline").textContent).toMatch(/^Ready/);
        const calls = h.view.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(MIRROR_POLL_MS * 3); });
        expect(h.view.mock.calls.length).toBe(calls); // settled: polling stopped
        // W25 browser finding: the commit (new active revision) makes the page re-read the server-rendered tabs + Refresh facts, once
        expect(h.refresh).toHaveBeenCalledTimes(1);
    });
    it("rolling back: names the target; a Ready mirror with a failed newest revision says Ready and announces the failed-newer sentence", async () => {
        mount(props({initial: view(now, {status: "rolling_back", op: "r1"})}));
        expect(screen.getByTestId("mirror-headline").textContent).toBe(MIRRORS.rollback.line(1, 2));
        cleanup();
        vi.useFakeTimers();
        const failed = rev(now, {id: "r3", seq: 3, state: "failed", reason: "insufficient_disk", wipeState: "verified", activatedAt: null, readiedAt: null});
        const after = view(now, {status: "ready", revisions: [failed, rev(now, {id: "r2", seq: 2}), rev(now, {id: "r1", seq: 1})]});
        h.view.mockResolvedValue({data: {ok: true, view: after}});
        mount(props({initial: view(now, {status: "refreshing", revisions: [building(), rev(now, {id: "r2", seq: 2})], op: "r3"})}));
        await act(async () => { await vi.advanceTimersByTimeAsync(MIRROR_POLL_MS + 10); });
        expect(screen.getByTestId("mirror-headline").textContent).toMatch(/^Ready/);
        expect(screen.getByTestId("failed-newer")).toBeTruthy();
        expect(screen.getByRole("status").textContent).toContain("The newer revision #3 failed");
    });
});

describe("axe", () => {
    it("Overview with the new buttons and notes is clean", async () => {
        const {container} = mount(props({initial: view(now, {retentionDue: true}), extras: extras(now, {lastOp: op({})})}));
        expect(await axeViolations(container)).toEqual([]);
    });
});
