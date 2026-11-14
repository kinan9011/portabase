// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {GATES, MIRROR_STEPS} from "@/fork/mirror/vocab";
import type {MirrorView} from "@/fork/mirror/view";
import {BANNER, MIRRORS, REASON_TEXT} from "@/fork/ui/mirrors/labels";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const h = vi.hoisted(() => ({view: vi.fn(), access: vi.fn(), cancel: vi.fn(), retry: vi.fn()}));
vi.mock("@/fork/actions/mirror.action", () => ({getMirrorViewAction: h.view, getMirrorAccessAction: h.access, cancelMirrorRevisionAction: h.cancel, retryMirrorWipeAction: h.retry}));

import {MIRROR_POLL_MS, MirrorProgress} from "@/fork/ui/mirrors/progress/progress.client";

const MID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const RID = "0b7e1c1e-7f3a-4b6e-9a40-222222222222";
const okGate = {ok: true, code: null};
type RevOver = Partial<MirrorView["revisions"][number]>;
const view = (o: RevOver = {}, status = "creating"): MirrorView => {
    const now = new Date().toISOString();
    return {
        mirror: {id: MID, name: "shop-3", status, runnerName: "lab-runner", stackId: "0b7e1c1e-7f3a-4b6e-9a40-333333333333", activeRevisionId: null, createdAt: now}, privacy: {containsPersonalData: true, optIn: true},
        revisions: [{id: RID, seq: 1, state: "staging", reason: null, failedStep: null, steps: MIRROR_STEPS.slice(0, 4).map((name, i) => ({name, status: i < 1 ? "done" : i === 1 ? "running" : "pending"})),
            gates: {expected_data: null, db_health: null, app_smoke: null, isolation: null, side_effects: null}, refusals: [], services: [], hostPort: 41000, rpSequence: 3, readiedAt: null, wipeState: null, deadlineAt: now, createdAt: now, ...o}],
    };
};
const ready = (): MirrorView => view({state: "ready", steps: MIRROR_STEPS.map((name) => ({name, status: "done"})), gates: {expected_data: okGate, db_health: okGate, app_smoke: okGate, isolation: okGate, side_effects: okGate},
    services: [{service: "web", state: "running", health: "none"}, {service: "db", state: "running", health: "healthy"}], readiedAt: new Date().toISOString()}, "ready");
const blocked = (wipeState: string | null): MirrorView => view({state: "blocked", reason: "compile_refused", wipeState, refusals: [{code: "docker_sock", service: "web", text: 'Service "web" mounts the Docker socket.'}]}, "failed");
const mount = (v: MirrorView, o: {canManage?: boolean; locked?: boolean} = {}) => render(<StatusAnnouncer><MirrorProgress initial={v} canManage={o.canManage ?? true} locked={o.locked ?? false}/></StatusAnnouncer>);
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const setHidden = (v: boolean) => Object.defineProperty(document, "hidden", {value: v, configurable: true});

beforeEach(() => { setHidden(false); for (const f of [h.view, h.access, h.cancel, h.retry]) f.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); setHidden(false); });

describe("polling from durable server state", () => {
    beforeEach(() => { vi.useFakeTimers(); }); // only here: axe and waitFor need real timers
    it("polls the view action every 3 s while active and stops once the mirror is ready; the access action is never called by the poll", async () => {
        h.view.mockResolvedValueOnce({data: {ok: true, view: view()}}).mockResolvedValue({data: {ok: true, view: ready()}});
        mount(view());
        expect(h.view).not.toHaveBeenCalled();
        await tick(MIRROR_POLL_MS);
        expect(h.view).toHaveBeenCalledTimes(1);
        expect(h.view).toHaveBeenCalledWith({mirrorId: MID});
        await tick(MIRROR_POLL_MS);
        expect(h.view).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId("mirror-headline").textContent).toBe(MIRRORS.progress.ready("lab-runner"));
        await tick(MIRROR_POLL_MS * 5);
        expect(h.view).toHaveBeenCalledTimes(2); // settled: no more polling
        expect(h.access).not.toHaveBeenCalled();
    });
    it("a view that is already settled does not poll at all", async () => {
        mount(ready());
        await tick(MIRROR_POLL_MS * 3);
        expect(h.view).not.toHaveBeenCalled();
    });
    it("a terminal state keeps polling until the wipe is over", async () => {
        h.view.mockResolvedValueOnce({data: {ok: true, view: blocked("running")}}).mockResolvedValue({data: {ok: true, view: blocked("verified")}});
        mount(blocked(null));
        await tick(MIRROR_POLL_MS); await tick(MIRROR_POLL_MS);
        expect(h.view).toHaveBeenCalledTimes(2);
        await tick(MIRROR_POLL_MS * 4);
        expect(h.view).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId("wipe-line").textContent).toBe(MIRRORS.progress.wipe.verified);
    });
    it("pauses while the tab is hidden and resumes when it is visible again", async () => {
        h.view.mockResolvedValue({data: {ok: true, view: view()}});
        mount(view());
        setHidden(true);
        await tick(MIRROR_POLL_MS * 3);
        expect(h.view).not.toHaveBeenCalled();
        setHidden(false);
        await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
        await tick(MIRROR_POLL_MS * 2);
        expect(h.view).toHaveBeenCalled();
    });
    it("a failed poll keeps the last state and says so", async () => {
        h.view.mockRejectedValue(new Error("net"));
        mount(view());
        await tick(MIRROR_POLL_MS);
        expect(screen.getByTestId("poll-error").textContent).toBe(MIRRORS.progress.pollError);
        expect(screen.getByTestId("mirror-headline").textContent).toContain(MIRRORS.progress.creating);
    });
    it("a state change is announced in the single shared role=status region", async () => {
        h.view.mockResolvedValue({data: {ok: true, view: ready()}});
        const {container} = mount(view());
        await tick(MIRROR_POLL_MS);
        expect(container.querySelectorAll("[role=status]").length).toBe(1);
        expect(screen.getByTestId("job-status").textContent).toBe(MIRRORS.progress.ready("lab-runner"));
    });
});

describe("honest states", () => {
    it("READY says isolated and health-checked, never verified or restore-tested; shows five passed gates, the steps and the services", async () => {
        const {container} = mount(ready());
        const head = screen.getByTestId("mirror-headline").textContent!;
        expect(head).toBe(MIRRORS.progress.ready("lab-runner"));
        expect(head).not.toMatch(/verified|restore-tested/i);
        expect(screen.getByTestId("ready-note").textContent).toBe(MIRRORS.progress.readyNote);
        const gates = screen.getAllByTestId("mirror-gate");
        expect(gates.map((g) => g.getAttribute("data-gate"))).toEqual([...GATES]);
        for (const g of gates) expect(g.textContent).toContain(MIRRORS.progress.gate.ok);
        expect(screen.getAllByTestId("mirror-step").length).toBe(MIRROR_STEPS.length);
        for (const st of screen.getAllByTestId("mirror-step")) expect(st.textContent).toContain("done"); // the engine vocabulary is pending|running|done|failed
        expect(within(screen.getByTestId("mirror-services")).getAllByRole("listitem").length).toBe(2);
        expect(container.querySelectorAll("[role=status]").length).toBe(1);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("creating: current step in the headline, gates 'not reached', Cancel offered", async () => {
        const {container} = mount(view());
        expect(screen.getByTestId("mirror-headline").textContent).toBe(`${MIRRORS.progress.creating}: Check the backup and the runner`);
        for (const g of screen.getAllByTestId("mirror-gate")) expect(g.textContent).toContain(MIRRORS.progress.gate.notReached);
        expect(screen.getByTestId("mirror-cancel")).toBeTruthy();
        expect(screen.queryByTestId("mirror-access")).toBeNull();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("blocked: the refusal sentence, the reason text and the wipe line; no Cancel", async () => {
        const {container} = mount(blocked("verified"));
        expect(screen.getByTestId("mirror-headline").textContent).toContain(REASON_TEXT.compile_refused);
        expect(screen.getByTestId("mirror-refusals").textContent).toContain('Service "web" mounts the Docker socket.');
        expect(screen.getByTestId("wipe-line").textContent).toBe(MIRRORS.progress.wipe.verified);
        expect(screen.queryByTestId("mirror-cancel")).toBeNull();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("the ADR-009 §4 banner is always present", () => {
        const {unmount} = mount(view());
        expect(screen.getByTestId("privacy-banner").textContent).toBe(BANNER("lab-runner"));
        unmount();
        mount(ready());
        expect(screen.getByTestId("privacy-banner").textContent).toBe(BANNER("lab-runner"));
    });
    it("a cancelled mirror says so", () => {
        mount(view({state: "cancelled", reason: "cancelled", wipeState: "verified"}, "cancelled"));
        expect(screen.getByTestId("mirror-headline").textContent).toBe(MIRRORS.progress.cancelled);
    });
});

describe("actions", () => {
    it("Cancel asks first (Escape closes, focus returns), then calls the audited action with the revision id", async () => {
        h.cancel.mockResolvedValue({data: {ok: true}});
        h.view.mockResolvedValue({data: {ok: true, view: view()}});
        mount(view());
        const btn = screen.getByTestId("mirror-cancel");
        btn.focus();
        fireEvent.click(btn);
        const dlg = await screen.findByRole("alertdialog");
        expect(dlg.textContent).toContain(MIRRORS.progress.cancelBody);
        fireEvent.keyDown(dlg, {key: "Escape"});
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(h.cancel).not.toHaveBeenCalled();
        fireEvent.click(btn);
        fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", {name: MIRRORS.progress.cancelConfirm}));
        await waitFor(() => expect(h.cancel).toHaveBeenCalledWith({revisionId: RID}));
        await waitFor(() => expect(screen.getByTestId("mirror-note").textContent).toBe(MIRRORS.progress.cancelRequested));
        expect(screen.queryByTestId("mirror-cancel")).toBeNull();
    });
    it("a refused cancel is reported with its sentence", async () => {
        h.cancel.mockResolvedValue({data: {ok: false, code: "locked"}});
        mount(view());
        fireEvent.click(screen.getByTestId("mirror-cancel"));
        fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", {name: MIRRORS.progress.cancelConfirm}));
        expect((await screen.findByTestId("mirror-error")).textContent).toContain("Configuration is locked");
    });
    it("a member sees no Cancel and no Retry wipe (a failed wipe says to ask an administrator)", () => {
        const {unmount} = mount(view(), {canManage: false});
        expect(screen.queryByTestId("mirror-cancel")).toBeNull();
        unmount();
        mount(view({state: "failed", reason: "execution_error", wipeState: "failed"}, "failed"), {canManage: false});
        expect(screen.queryByTestId("mirror-retry-wipe")).toBeNull();
        expect(screen.getByTestId("wipe-admin").textContent).toBe(MIRRORS.progress.wipeAdmin);
    });
    it("Retry wipe exists only when the wipe failed, and calls the action with the revision id", async () => {
        h.retry.mockResolvedValue({data: {ok: true}});
        h.view.mockResolvedValue({data: {ok: true, view: view({state: "failed", reason: "execution_error", wipeState: "verified"}, "failed")}});
        const {unmount} = mount(blocked("verified"));
        expect(screen.queryByTestId("mirror-retry-wipe")).toBeNull();
        unmount();
        mount(view({state: "failed", reason: "wipe_incomplete", wipeState: "failed"}, "failed"));
        expect(screen.getByTestId("wipe-line").textContent).toBe(MIRRORS.progress.wipe.failed);
        fireEvent.click(screen.getByTestId("mirror-retry-wipe"));
        await waitFor(() => expect(h.retry).toHaveBeenCalledWith({revisionId: RID}));
    });
    it("Show how to connect calls the access action exactly once per click (audited read) and shows the loopback port and tunnel hint", async () => {
        h.access.mockResolvedValue({data: {ok: true, access: {runnerName: "lab-runner", hostPort: 41000, service: "web", target: 8080, tunnelHint: "ssh -L 41000:127.0.0.1:41000 <your-user>@<address of lab-runner>"}}});
        const {container} = mount(ready());
        expect(h.access).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId("mirror-access"));
        await waitFor(() => expect(h.access).toHaveBeenCalledTimes(1));
        expect(h.access).toHaveBeenCalledWith({mirrorId: MID});
        const panel = await screen.findByTestId("mirror-access-panel");
        expect(panel.textContent).toContain("127.0.0.1:41000");
        expect(screen.getByTestId("tunnel-hint").textContent).toContain("ssh -L 41000");
        expect(await axeViolations(container)).toEqual([]);
        fireEvent.click(screen.getByTestId("mirror-access"));
        await waitFor(() => expect(h.access).toHaveBeenCalledTimes(2));
    });
    it("a refused access read is reported, not swallowed", async () => {
        h.access.mockResolvedValue({data: {ok: false, code: "mirror_not_ready"}});
        mount(ready());
        fireEvent.click(screen.getByTestId("mirror-access"));
        expect((await screen.findByTestId("mirror-error")).textContent).toBe(MIRRORS.progress.accessFailed);
        expect(screen.queryByTestId("mirror-access-panel")).toBeNull();
    });
});
