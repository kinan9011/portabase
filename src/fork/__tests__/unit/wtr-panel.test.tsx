// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {TestRestoreView} from "@/fork/test-restore/view";
import {DEFAULT_TR_SCHEDULE} from "@/fork/test-restore/vocab";

const refresh = vi.fn();
const setSchedule = vi.fn();
const runNow = vi.fn();
const wipeNow = vi.fn();
const setPrivacy = vi.fn();
vi.mock("next/navigation", () => ({useRouter: () => ({refresh})}));
vi.mock("@/fork/actions/test-restore.action", () => ({
    setTestRestoreScheduleAction: (...a: unknown[]) => setSchedule(...a), runTestRestoreNowAction: (...a: unknown[]) => runNow(...a), wipeTestRestoreNowAction: (...a: unknown[]) => wipeNow(...a),
}));
vi.mock("@/fork/actions/restore-plan.action", () => ({setStackPrivacyAction: (...a: unknown[]) => setPrivacy(...a)}));

import {TR} from "@/fork/ui/stacks/test-restore/labels";
import {TestRestorePanel, isTestRestoreActive} from "@/fork/ui/stacks/test-restore/test-restore-panel";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const SID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const AGENT = "0b7e1c1e-7f3a-4b6e-9a40-222222222222";
type Last = NonNullable<TestRestoreView["last"]>;
const last = (o: Partial<Last> = {}): Last => ({runId: "0b7e1c1e-7f3a-4b6e-9a40-333333333333", state: "succeeded", reason: null, trigger: "manual", startedAt: "2031-01-02T03:00:00.000Z", finishedAt: "2031-01-02T03:02:05.000Z",
    durationSeconds: 125, integrity: {checked: 2, failed: 0, notSupported: 1}, wipe: {state: "verified", reason: null, finishedAt: "2031-01-02T03:03:00.000Z"}, ...o});
const view = (o: Partial<TestRestoreView> = {}): TestRestoreView => ({
    schedule: {configured: true, enabled: true, preset: "weekly", timezone: "UTC", cron: "30 3 * * 0", nextRuns: ["2031-01-05T03:30:00.000Z"], targetAgentName: "lab-test", staleAfterDays: 14, paused: null, lastOutcome: null},
    privacy: {containsPersonalData: false, optIn: false}, facet: {daysAgo: 0, stale: false}, last: last(),
    admin: {restoreRoot: "/srv/restore", candidates: [{id: AGENT, name: "lab-test"}], schedule: {...DEFAULT_TR_SCHEDULE}, targetAgentId: AGENT},
    can: {configure: true, runNow: true, wipeNow: true}, ...o,
});
const member = (o: Partial<TestRestoreView> = {}) => view({admin: null, can: {configure: false, runNow: false, wipeNow: false}, ...o});
const ui = (v: TestRestoreView, p: {isAdmin?: boolean; configLocked?: boolean} = {}) => render(<StatusAnnouncer><TestRestorePanel view={v} stackId={SID} isAdmin={p.isAdmin ?? true} configLocked={p.configLocked ?? false}/></StatusAnnouncer>);
const attr = (id: string, a: string) => screen.getByTestId(id).getAttribute(a);

beforeEach(() => { for (const f of [refresh, setSchedule, runNow, wipeNow, setPrivacy]) f.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("W-TR-f panel", () => {
    it("1 member: read-only, visible reasons, axe clean", async () => {
        const {container} = ui(member(), {isAdmin: false});
        expect(attr("tr-run-now", "aria-disabled")).toBe("true");
        expect(screen.getByText(TR.reasons.member)).toBeTruthy();
        expect(attr("tr-edit-open", "aria-disabled")).toBe("true");
        expect(screen.getByText(TR.reasons.configure)).toBeTruthy();
        for (const t of ["tr-pd-yes", "tr-pd-no", "tr-pd-unset", "tr-optin"]) expect(attr(t, "aria-disabled"), t).toBe("true");
        expect(screen.getByText(TR.reasons.privacy)).toBeTruthy();
        expect(screen.queryByTestId("tr-wipe-now")).toBeNull();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("2 admin without candidates: select is aria-disabled and the visible reason is linked", async () => {
        const v = view(); v.admin!.candidates = []; v.admin!.targetAgentId = null;
        const {container} = ui(v);
        fireEvent.click(screen.getByTestId("tr-edit-open"));
        const sel = screen.getByTestId("tr-target");
        expect(sel.getAttribute("aria-disabled")).toBe("true");
        const id = sel.getAttribute("aria-describedby")!;
        expect(document.getElementById(id)!.textContent).toBe(TR.edit.noCandidates);
        expect(await axeViolations(container)).toEqual([]);
    }, 30_000); // axe over the form with the full time-zone <select> takes ~3.5 s locally, more on CI runners
    it("3 admin save: needs target + folder; exact request body; a refusal is shown and nothing refreshes", async () => {
        ui(view({admin: {restoreRoot: null, candidates: [{id: AGENT, name: "lab-test"}], schedule: null, targetAgentId: null}, schedule: {...view().schedule, enabled: false, configured: false}}));
        fireEvent.click(screen.getByTestId("tr-edit-open"));
        fireEvent.click(screen.getByTestId("tr-enabled"));
        expect(attr("tr-edit-save", "aria-disabled")).toBe("true");
        expect(screen.getByText(TR.edit.needTargetRoot)).toBeTruthy();
        fireEvent.change(screen.getByTestId("tr-target"), {target: {value: AGENT}});
        fireEvent.change(screen.getByTestId("tr-root"), {target: {value: " /srv/restore "}});
        expect(attr("tr-edit-save", "aria-disabled")).toBeNull();
        setSchedule.mockResolvedValueOnce({data: {ok: false, code: "target_not_test"}});
        fireEvent.click(screen.getByTestId("tr-edit-save"));
        await waitFor(() => expect(screen.getByTestId("tr-edit-error").textContent).toBe(TR.refusal.target_not_test));
        expect(setSchedule).toHaveBeenCalledWith({stackId: SID, enabled: true, schedule: DEFAULT_TR_SCHEDULE, targetAgentId: AGENT, restoreRoot: "/srv/restore", staleAfterDays: 14});
        expect(refresh).not.toHaveBeenCalled();
        setSchedule.mockResolvedValueOnce({data: {ok: true}});
        fireEvent.click(screen.getByTestId("tr-edit-save"));
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId("tr-edit-form")).toBeNull();
    });
    it("4 succeeded: duration, both integrity lines, wipe verified", () => {
        ui(view());
        expect(screen.getByTestId("tr-duration").textContent).toBe("Took 2 min 5 s");
        const i = screen.getByTestId("tr-integrity").textContent!;
        expect(i).toContain("2 databases checked");
        expect(i).toContain("1 database not engine-checked");
        expect(screen.getByTestId("tr-wipe").textContent).toBe(TR.wipe.verified);
        expect(screen.getByTestId("tr-last").textContent).toContain(TR.last.succeeded);
    });
    it("5 succeeded without an engine check says so", () => {
        ui(view({last: last({integrity: null})}));
        expect(screen.getByTestId("tr-integrity").textContent).toBe(TR.integrity.none);
    });
    it("6 failed integrity run: failure sentence, no success headline", () => {
        ui(view({last: last({state: "failed", reason: "integrity_failed", integrity: null})}));
        const t = screen.getByTestId("tr-last").textContent!;
        expect(t).toContain("Did not finish: The restored data failed the database's own integrity check.");
        expect(t).not.toContain(TR.last.succeeded);
        expect(screen.queryByTestId("tr-integrity")).toBeNull();
        expect(screen.getByTestId("tr-wipe").textContent).toBe(TR.wipe.verified);
    });
    it("7 wipe failed: alert with reason, Wipe now only for can.wipeNow, run-now says wipe first", async () => {
        const v = view({last: last({wipe: {state: "failed", reason: "wipe_unverified", finishedAt: null}})});
        const {container} = ui(v);
        expect(screen.getByRole("alert").textContent).toBe(TR.wipe.failed(TR.wipeReason.wipe_unverified));
        expect(screen.getByText(TR.reasons.wipeFirst)).toBeTruthy();
        wipeNow.mockResolvedValueOnce({data: {ok: true}});
        fireEvent.click(screen.getByTestId("tr-wipe-now"));
        await waitFor(() => expect(wipeNow).toHaveBeenCalledWith({runId: v.last!.runId}));
        expect(await axeViolations(container)).toEqual([]);
        cleanup();
        ui(member({last: v.last}), {isAdmin: false});
        expect(screen.queryByTestId("tr-wipe-now")).toBeNull();
    });
    it("8 facet copy: never-run and stale", () => {
        const a = ui(view({facet: {daysAgo: null, stale: false}, last: null}));
        expect(screen.getByTestId("tr-facet").textContent).toContain(TR.facet.none);
        expect(screen.getByTestId("tr-facet").textContent).not.toContain("Not tested");
        a.unmount();
        ui(view({facet: {daysAgo: 15, stale: true}}));
        expect(screen.getByTestId("tr-facet").textContent).toContain("15 d ago · Out of date");
        expect(screen.getByTestId("tr-facet").textContent).toContain(TR.facet.staleNote(14));
    });
    it("9 polling: every 10 s while active, never while idle, cleared when it turns idle", () => {
        vi.useFakeTimers();
        const r = ui(view({last: last({state: "running", finishedAt: null, durationSeconds: null, integrity: null, wipe: {state: null, reason: null, finishedAt: null}})}));
        act(() => { vi.advanceTimersByTime(9_999); });
        expect(refresh).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        expect(refresh).toHaveBeenCalledTimes(1);
        r.rerender(<StatusAnnouncer><TestRestorePanel view={view()} stackId={SID} isAdmin configLocked={false}/></StatusAnnouncer>);
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(refresh).toHaveBeenCalledTimes(1);
        cleanup(); refresh.mockReset();
        ui(view());
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(refresh).not.toHaveBeenCalled();
    });
    it("10 privacy: refusal line, opt-in needs the confirm dialog, exact request, 'No' disables the opt-in", async () => {
        ui(view({privacy: {containsPersonalData: null, optIn: false}}));
        expect(screen.getByRole("note").textContent).toBe(TR.privacy.refusedLine);
        expect(screen.getByText(TR.refusal.personal_data_no_opt_in)).toBeTruthy();
        fireEvent.click(screen.getByTestId("tr-optin"));
        expect(await screen.findByText(TR.privacy.d44)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", {name: TR.privacy.confirm}));
        await waitFor(() => expect((screen.getByTestId("tr-optin") as HTMLInputElement).checked).toBe(true));
        setPrivacy.mockResolvedValueOnce({data: {ok: true}});
        fireEvent.click(screen.getByTestId("tr-privacy-save"));
        await waitFor(() => expect(setPrivacy).toHaveBeenCalledWith({stackId: SID, containsPersonalData: null, testRestoreOptIn: true}));
        fireEvent.click(screen.getByTestId("tr-pd-no"));
        expect(attr("tr-optin", "aria-disabled")).toBe("true");
        expect(screen.getByText(TR.privacy.optInNeedsYes)).toBeTruthy();
    });
    it("11 canary: a non-admin render never contains the restore folder or the agent id", () => {
        const v = view(); v.admin!.restoreRoot = "/srv/CANARY";
        const {container} = ui(v, {isAdmin: false});
        expect(container.innerHTML).not.toContain("/srv/CANARY");
        expect(container.innerHTML).not.toContain(AGENT);
    });
    it("12 isTestRestoreActive truth table", () => {
        const w = (state: string, wipe: string | null) => view({last: last({state, wipe: {state: wipe, reason: null, finishedAt: null}})});
        for (const [s, wp] of [["running", null], ["awaiting_approval", null], ["succeeded", null], ["failed", "running"]] as const) expect(isTestRestoreActive(w(s, wp)), `${s}/${wp}`).toBe(true);
        for (const wp of ["verified", "not_needed", "failed"]) expect(isTestRestoreActive(w("succeeded", wp)), wp).toBe(false);
        expect(isTestRestoreActive(view({last: null}))).toBe(false);
    });
    it("13 keyboard focus: opening the editor moves focus into the form, Cancel returns it to the opener", async () => {
        ui(view());
        fireEvent.click(screen.getByTestId("tr-edit-open"));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("tr-enabled")));
        fireEvent.click(screen.getByTestId("tr-edit-cancel"));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("tr-edit-open")));
    });
});
