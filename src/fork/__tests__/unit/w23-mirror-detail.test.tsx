// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {MirrorDetailExtras, MirrorLogEntry} from "@/fork/mirror/list-view";
import {GATES, MIRROR_STEPS} from "@/fork/mirror/vocab";
import type {MirrorView} from "@/fork/mirror/view";
import {BANNER, GATE_TEXT, MIRRORS, REASON_TEXT, stepText} from "@/fork/ui/mirrors/labels";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const h = vi.hoisted(() => ({view: vi.fn(), access: vi.fn(), cancel: vi.fn(), retry: vi.fn(), del: vi.fn(), stop: vi.fn(), start: vi.fn(), refresh: vi.fn()}));
vi.mock("@/fork/actions/mirror.action", () => ({getMirrorViewAction: h.view, getMirrorAccessAction: h.access, cancelMirrorRevisionAction: h.cancel, retryMirrorWipeAction: h.retry, deleteMirrorAction: h.del, stopMirrorAction: h.stop, startMirrorAction: h.start}));
vi.mock("next/navigation", () => ({useRouter: () => ({refresh: h.refresh, push: vi.fn()}), usePathname: () => "/dashboard/mirrors/x"}));

import {MirrorDetail, type DetailProps} from "@/fork/ui/mirrors/detail/detail.client";

const MID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const SID = "0b7e1c1e-7f3a-4b6e-9a40-333333333333";
const okGate = {ok: true, code: null};
const now = new Date();
const rev = (o: Partial<MirrorView["revisions"][number]> = {}): MirrorView["revisions"][number] => ({
    id: "r1", seq: 1, state: "ready", reason: null, failedStep: null, steps: MIRROR_STEPS.map((name) => ({name, status: "done"})),
    gates: {expected_data: okGate, db_health: okGate, app_smoke: okGate, isolation: okGate, side_effects: okGate}, refusals: [],
    services: [{service: "web", state: "running", health: "none"}, {service: "db", state: "running", health: "healthy"}], hostPort: 41000, rpSequence: 3,
    readiedAt: new Date(now.getTime() - 3 * 3600e3).toISOString(), activatedAt: null, retiredAt: null, wipeState: null, deadlineAt: now.toISOString(), createdAt: new Date(now.getTime() - 3 * 3600e3 - 60_000).toISOString(), ...o,
});
const view = (status = "ready", revisions = [rev()], active: string | null = "r1"): MirrorView => ({
    mirror: {id: MID, name: "shop-3", status, runnerName: "lab-runner", stackId: SID, activeRevisionId: active, opRevisionId: null, retentionDue: false, createdAt: now.toISOString()}, revisions, privacy: {containsPersonalData: true, optIn: true},
});
const extras = (o: Partial<MirrorDetailExtras> = {}): MirrorDetailExtras => ({
    stack: {id: SID, name: "Shop"}, rpDates: {"3": "2026-11-01T10:00:00.000Z"},
    config: {access: {service: "web", target: 8080, hostPort: 41000}, httpPath: "/health", limits: {memBytes: 1073741824, pids: 512, nanoCpus: 1_000_000_000},
        overrides: [{service: "web", key: "SMTP_URL", action: "disable"}, {service: "db", key: "API_KEY", action: "keep_exact"}], overrideCount: 2, keptCount: 1},
    runnerIsolation: {state: "isolated", probedAt: new Date(now.getTime() - 2 * 3600e3).toISOString(), reason: null},
    facet: {readiedAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(), rpSequence: 3}, lastOp: null, ...o,
});
const LOG: MirrorLogEntry[] = [
    {at: new Date(now.getTime() - 1000).toISOString(), kind: "event", title: "Mirror ready", code: null, status: null, actor: "system", durationSeconds: null},
    {at: new Date(now.getTime() - 5000).toISOString(), kind: "task", title: "Health checks", code: "smoke_failed", status: "failed", actor: null, durationSeconds: 4},
];
const props = (o: Partial<DetailProps> = {}): DetailProps => ({initial: view(), extras: extras(), log: LOG, canManage: true, locked: false, flagOn: true, now: now.toISOString(), staleAfterDays: 14, tab: "overview", ...o});
const mount = (p: DetailProps) => render(<StatusAnnouncer><MirrorDetail {...p}/></StatusAnnouncer>);
beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(() => cleanup());

describe("tabs", () => {
    it("four tabs, Overview selected by default; unknown initial tab is the caller's job (the page parses with .catch)", () => {
        mount(props());
        expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Configuration", "Refresh History", "Logs"]);
        expect(screen.getByRole("tab", {name: "Overview"}).getAttribute("aria-selected")).toBe("true");
    });
    it("?tab= initial selection", () => {
        mount(props({tab: "history"}));
        expect(screen.getByRole("tab", {name: "Refresh History"}).getAttribute("aria-selected")).toBe("true");
        expect(screen.getByTestId("history-tab")).toBeTruthy();
    });
    it("Arrow keys move between the triggers and sync the URL", async () => {
        const spy = vi.spyOn(window.history, "replaceState");
        mount(props());
        const o = screen.getByRole("tab", {name: "Overview"});
        o.focus();
        fireEvent.keyDown(o, {key: "ArrowRight"});
        const c = screen.getByRole("tab", {name: "Configuration"});
        await waitFor(() => expect(c.getAttribute("aria-selected")).toBe("true"));
        expect(String(spy.mock.calls.at(-1)?.[2])).toContain("?tab=configuration");
        fireEvent.keyDown(c, {key: "ArrowLeft"});
        await waitFor(() => expect(screen.getByRole("tab", {name: "Overview"}).getAttribute("aria-selected")).toBe("true"));
        spy.mockRestore();
    });
    it("the privacy banner (runner-specific) is present on every tab, exactly one status region", async () => {
        mount(props());
        expect(screen.getByTestId("privacy-banner").textContent).toBe(BANNER("lab-runner"));
        for (const name of ["Configuration", "Refresh History", "Logs"]) {
            const t = screen.getByRole("tab", {name});
            t.focus(); fireEvent.keyDown(t, {key: "Enter"}); fireEvent.mouseDown(t); fireEvent.click(t);
            await waitFor(() => expect(t.getAttribute("aria-selected")).toBe("true"));
            expect(screen.getByTestId("privacy-banner").textContent).toBe(BANNER("lab-runner"));
        }
        expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    });
});

describe("Overview", () => {
    it("start-tested facet: fresh / stale texts, never verified or restore-tested; hidden without a fact", async () => {
        const {container, unmount} = mount(props());
        expect(screen.getByTestId("start-tested").textContent).toContain("App start-tested · 2 d ago");
        expect(screen.getByTestId("start-tested").textContent).toContain(MIRRORS.facet.meaning);
        expect(screen.getByTestId("start-tested").textContent).not.toMatch(/restore-tested|verified/i); // (the Ready note elsewhere says "does not mean restore-tested")
        expect(await axeViolations(container)).toEqual([]);
        unmount();
        mount(props({extras: extras({facet: {readiedAt: new Date(now.getTime() - 20 * 86_400_000).toISOString(), rpSequence: 3}})}));
        expect(screen.getByTestId("start-tested").textContent).toContain("Out of date (20 d ago)");
        cleanup();
        mount(props({extras: extras({facet: null})}));
        expect(screen.queryByTestId("start-tested")).toBeNull();
    });
    it("failed newer revision next to the active one: alert text with both numbers and the reason", () => {
        const v = view("ready", [rev({id: "r2", seq: 2, state: "failed", reason: "smoke_failed", failedStep: "check", wipeState: "verified"}), rev()], "r1");
        mount(props({initial: v}));
        expect(screen.getByTestId("failed-newer").textContent).toBe(MIRRORS.detail.failedNewer(2, 1, REASON_TEXT.smoke_failed));
    });
    it("grouped steps: the transform sentence appears once", () => {
        mount(props());
        const texts = screen.getAllByTestId("mirror-step").map((s) => s.textContent ?? "");
        expect(texts.filter((t) => t.includes(stepText("render"))).length).toBe(1);
        expect(texts.filter((t) => t.includes(stepText("probe"))).length).toBe(1);
    });
    it("Delete is offered to managers (enabled for ready), absent for members, blocked with a reason while creating", () => {
        mount(props());
        expect(screen.getByTestId("mirror-delete").getAttribute("aria-disabled")).toBeNull();
        cleanup();
        mount(props({canManage: false}));
        expect(screen.queryByTestId("mirror-delete")).toBeNull();
        cleanup();
        mount(props({initial: view("creating", [rev({state: "staging", readiedAt: null})], null)}));
        expect(screen.getByTestId("mirror-delete").getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(MIRRORS.lifecycle.reasons.cancelFirst)).toBeTruthy();
    });
    it("Delete from the Overview calls the action with the typed name, then re-reads the view and shows the deleting state", async () => {
        h.del.mockResolvedValue({data: {ok: true}});
        h.view.mockResolvedValue({data: {ok: true, view: view("deleting", [rev({wipeState: "running"})])}});
        mount(props());
        fireEvent.click(screen.getByTestId("mirror-delete"));
        const dialog = await screen.findByRole("alertdialog");
        fireEvent.change(within(dialog).getByLabelText(MIRRORS.lifecycle.deleteInput), {target: {value: "shop-3"}});
        fireEvent.click(within(dialog).getByRole("button", {name: MIRRORS.lifecycle.deleteConfirm}));
        await waitFor(() => expect(h.del).toHaveBeenCalledWith({mirrorId: MID, confirmName: "shop-3"}));
        await waitFor(() => expect(screen.getByTestId("mirror-headline").textContent).toBe(MIRRORS.lifecycle.deletingLine));
        expect(screen.getByTestId("wipe-line").textContent).toBe(MIRRORS.progress.wipe.running);
        expect(screen.queryByTestId("mirror-access")).toBeNull();
    });
    it("a deleted mirror shows the deleted sentence and no actions", () => {
        mount(props({initial: view("deleted")}));
        expect(screen.getByTestId("mirror-headline").textContent).toBe(MIRRORS.detail.deleted);
        expect(screen.queryByTestId("mirror-delete")).toBeNull();
    });
});

describe("Configuration", () => {
    const open = async () => { const t = screen.getByRole("tab", {name: "Configuration"}); t.focus(); fireEvent.mouseDown(t); fireEvent.click(t); await screen.findByTestId("config-tab"); };
    it("manager: access, health path, limits, fixed Strict profile, five gates with texts, runner isolation, overridden key NAMES with the kept flag", async () => {
        const {container} = mount(props());
        await open();
        expect(screen.getByTestId("config-access").textContent).toContain("127.0.0.1:41000 on lab-runner");
        expect(screen.getByTestId("config-health-path").textContent).toBe("/health");
        const gates = screen.getAllByTestId("config-gate");
        expect(gates).toHaveLength(5);
        for (const g of GATES) expect(screen.getByText(GATE_TEXT[g])).toBeTruthy();
        expect(screen.getByTestId("config-runner-isolation").textContent).toContain("Isolated (checked 2 h ago)");
        const rows = screen.getAllByTestId("config-override").map((r) => r.textContent ?? "");
        expect(rows.some((t) => t.includes("SMTP_URL"))).toBe(true);
        expect(rows.some((t) => t.includes("API_KEY") && t.includes(MIRRORS.config.envKept))).toBe(true);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("member: counts only, no key names", async () => {
        const {container} = mount(props({canManage: false, extras: extras({config: {...extras().config, overrides: null}})}));
        await open();
        expect(screen.queryAllByTestId("config-override")).toHaveLength(0);
        expect(screen.getByTestId("config-env").textContent).toContain(MIRRORS.config.envCounts(2, 1));
        expect(container.textContent).not.toContain("SMTP_URL");
    });
    it("runner isolation now: not isolated / unknown; a gate that failed or was not reached", async () => {
        const v = view("failed", [rev({state: "failed", reason: "smoke_failed", gates: {expected_data: okGate, db_health: okGate, app_smoke: {ok: false, code: "smoke_failed"}, isolation: null, side_effects: null}})], "r1");
        mount(props({initial: v, extras: extras({runnerIsolation: {state: "not_isolated", probedAt: null, reason: null}})}));
        await open();
        expect(screen.getByTestId("config-runner-isolation").textContent).toContain(MIRRORS.config.runnerState.not_isolated);
        expect(screen.getByText(REASON_TEXT.smoke_failed)).toBeTruthy();
        expect(screen.getAllByText(MIRRORS.config.notReached).length).toBe(2);
        cleanup();
        mount(props({extras: extras({runnerIsolation: {state: "unknown", probedAt: null, reason: "stale"}})}));
        await open();
        expect(screen.getByTestId("config-runner-isolation").textContent).toContain(MIRRORS.config.runnerState.unknown);
    });
});

describe("Refresh History + Logs", () => {
    it("history rows: active marker, reason text of the failed newer revision, wipe line", async () => {
        const v = view("ready", [rev({id: "r2", seq: 2, state: "failed", reason: "smoke_failed", wipeState: "verified", readiedAt: null}), rev()], "r1");
        const {container} = mount(props({initial: v, tab: "history"}));
        const rows = screen.getAllByTestId("history-row");
        expect(rows).toHaveLength(2);
        expect(rows[0]!.textContent).toContain(REASON_TEXT.smoke_failed);
        expect(rows[0]!.textContent).toContain(MIRRORS.history.wipe.verified);
        expect(rows[1]!.getAttribute("data-active")).toBe("true");
        expect(rows[1]!.textContent).toContain(MIRRORS.history.ready);
        expect(rows[1]!.textContent).toContain("2026-11-01");
        expect(screen.getByText(MIRRORS.history.note)).toBeTruthy();
        expect(screen.queryByText(/refresh now|roll back/i)).toBeNull(); // no dead W24 / W25 controls
        expect(await axeViolations(container)).toEqual([]);
    });
    it("logs: entries, failed task carries only its reason sentence, Reload re-reads the server state, no secret-looking text", async () => {
        const {container} = mount(props({tab: "logs"}));
        const rows = screen.getAllByTestId("log-row");
        expect(rows).toHaveLength(2);
        expect(rows[1]!.textContent).toContain(REASON_TEXT.smoke_failed);
        expect(container.textContent).not.toMatch(/\/srv\/|https?:|password/i);
        fireEvent.click(screen.getByTestId("logs-reload"));
        expect(h.refresh).toHaveBeenCalledTimes(1);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("empty logs", () => {
        mount(props({tab: "logs", log: []}));
        expect(screen.getByText(MIRRORS.logs.empty)).toBeTruthy();
    });
});

describe("Stop / Start (W23 Part B)", () => {
    const L = MIRRORS.lifecycle;
    it("Stop (confirmed) calls the action once, announces, re-reads the view and shows the stopping state without the access button", async () => {
        h.stop.mockResolvedValue({data: {ok: true}});
        h.view.mockResolvedValue({data: {ok: true, view: view("stopping")}});
        mount(props());
        expect(screen.queryByTestId("mirror-start")).toBeNull();
        fireEvent.click(screen.getByTestId("mirror-stop"));
        const dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getByText(L.stopTitle("shop-3"))).toBeTruthy();
        fireEvent.click(within(dialog).getByRole("button", {name: L.stopConfirm}));
        await waitFor(() => expect(h.stop).toHaveBeenCalledTimes(1));
        expect(h.stop).toHaveBeenCalledWith({mirrorId: MID});
        await waitFor(() => expect(screen.getByTestId("mirror-headline").textContent).toBe(L.stoppingLine));
        expect(screen.queryByTestId("mirror-access")).toBeNull(); // the revision stays ready, the mirror is not: no tunnel hint while it does not run
        expect(screen.getByRole("status").textContent).toBe(L.stopRequested);
    });
    it("a stopped mirror: Stopped headline, no access, Start offered with the data note; Start calls the action", async () => {
        h.start.mockResolvedValue({data: {ok: true}});
        h.view.mockResolvedValue({data: {ok: true, view: view("starting")}});
        const m = mount(props({initial: view("stopped")}));
        expect(screen.getByTestId("mirror-headline").textContent).toBe(L.stoppedLine);
        expect(screen.queryByTestId("mirror-access")).toBeNull();
        expect(screen.queryByTestId("mirror-stop")).toBeNull();
        expect(screen.getByText(L.startNote)).toBeTruthy();
        expect(await axeViolations(m.container)).toEqual([]);
        fireEvent.click(screen.getByTestId("mirror-start"));
        await waitFor(() => expect(h.start).toHaveBeenCalledWith({mirrorId: MID}));
        await waitFor(() => expect(screen.getByTestId("mirror-headline").textContent).toBe(L.startingLine));
    });
    it("Start is blocked with a visible reason while locked or with the flag off; Delete stays available", () => {
        mount(props({initial: view("stopped"), locked: true}));
        expect(screen.getByTestId("mirror-start").getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(L.reasons.startLocked)).toBeTruthy();
        expect(screen.getByTestId("mirror-delete").getAttribute("aria-disabled")).toBeNull();
        cleanup();
        mount(props({initial: view("stopped"), flagOn: false}));
        expect(screen.getByTestId("mirror-start").getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(MIRRORS.list.flagOff)).toBeTruthy();
    });
    it("failed with its revision (a stop that did not finish): honest sentence with the reason, Stop can be retried, Delete works, axe clean", async () => {
        const m = mount(props({initial: view("failed"), extras: extras({lastOp: {status: "failed", code: "stop_incomplete", at: now.toISOString()}})}));
        expect(screen.getByTestId("mirror-headline").textContent).toBe(L.stopFailedLine);
        expect(screen.getByTestId("last-op").textContent).toBe(L.lastStopFailed(REASON_TEXT.stop_incomplete));
        expect(screen.getByTestId("mirror-stop").getAttribute("aria-disabled")).toBeNull();
        expect(screen.getByTestId("mirror-delete").getAttribute("aria-disabled")).toBeNull();
        expect(screen.queryByTestId("mirror-access")).toBeNull();
        expect(await axeViolations(m.container)).toEqual([]);
    });
    it("a start that did not complete says why and that the mirror is stopped", () => {
        mount(props({initial: view("stopped"), extras: extras({lastOp: {status: "stopped", code: "smoke_failed", at: now.toISOString()}})}));
        expect(screen.getByTestId("last-op").textContent).toBe(L.startFailedLine(REASON_TEXT.smoke_failed));
    });
    it("a refused Stop shows the refusal text in role=alert and does not refresh", async () => {
        h.stop.mockResolvedValue({data: {ok: false, code: "mirror_busy"}});
        mount(props());
        fireEvent.click(screen.getByTestId("mirror-stop"));
        fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", {name: L.stopConfirm}));
        const alert = await screen.findByTestId("lifecycle-error");
        expect(alert.getAttribute("role")).toBe("alert");
        expect(h.refresh).not.toHaveBeenCalled();
    });
    it("members get no Stop / Start / Delete at all", () => {
        mount(props({initial: view("stopped"), canManage: false}));
        for (const id of ["mirror-stop", "mirror-start", "mirror-delete"]) expect(screen.queryByTestId(id)).toBeNull();
    });
});
