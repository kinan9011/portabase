// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {RunViewSchema, type RunView} from "@/fork/runs/view";
import {RP_STATUS_LABELS, RUNS} from "@/fork/ui/labels";

const refresh = vi.fn();
const start = vi.fn();
const cancel = vi.fn();
vi.mock("next/navigation", () => ({useRouter: () => ({refresh})}));
vi.mock("@/fork/actions/stack-run.action", () => ({startStackRunAction: (...a: unknown[]) => start(...a), cancelStackRunAction: (...a: unknown[]) => cancel(...a)}));

import {RunNowButton} from "@/fork/ui/stacks/run-controls.client";
import {RunPanel} from "@/fork/ui/stacks/run-panel";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const ID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const view = (o: Partial<RunView> = {}): RunView => RunViewSchema.parse({limits: {waitMinutes: 10, stallMinutes: 30}, active: null, latest: null, paused: null, ...o});
const latest = (o: Record<string, unknown> = {}) => ({state: "succeeded", trigger: "schedule", startedAt: "2026-11-07T02:00:00.000Z", finishedAt: "2026-11-07T02:03:00.000Z", reason: null, skipReason: null, validatorBlocked: false, inventoryRefresh: "ok", rp: {sequence: 3, status: "pending_verification", reason: null}, ...o}) as unknown as NonNullable<RunView["latest"]>;

beforeEach(() => { refresh.mockReset(); start.mockReset(); cancel.mockReset(); });
afterEach(cleanup);

describe("runs UI: honest outcomes", () => {
    it("a finished complete run reads 'Backed up · verifying' — never 'Verified' (D43)", async () => {
        const {container} = render(<RunPanel runs={view({latest: latest()})} canRun={false}/>);
        expect(screen.getByTestId("run-state").textContent).toBe(RUNS.states.succeeded);
        expect(container.textContent).toContain(RP_STATUS_LABELS.pending_verification.label);
        expect(container.textContent).not.toMatch(/\bVerified\b/);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("failure reasons are plain sentences with the configured minutes; no raw code leaks", () => {
        const {container, rerender} = render(<RunPanel runs={view({latest: latest({state: "failed", reason: "agent_did_not_start", rp: {sequence: 4, status: "failed", reason: "member_timeout"}})})} canRun={false}/>);
        expect(screen.getByTestId("run-reason").textContent).toBe("Agent did not start the backup within 10 min");
        rerender(<RunPanel runs={view({latest: latest({state: "failed", reason: "agent_made_no_progress"})})} canRun={false}/>);
        expect(screen.getByTestId("run-reason").textContent).toContain("30 min");
        expect(container.textContent).not.toMatch(/agent_did_not_start|member_timeout|agent_made_no_progress/);
    });
    it("incomplete + blocked validator, stale inventory and skipped slots say so in words", () => {
        const {container, rerender} = render(<RunPanel runs={view({latest: latest({state: "incomplete", validatorBlocked: true, inventoryRefresh: "failed", rp: {sequence: 5, status: "incomplete", reason: "validator_blocked"}})})} canRun={false}/>);
        expect(container.textContent).toContain(RUNS.blocked);
        expect(container.textContent).toContain(RUNS.refresh.failed);
        expect(container.textContent).toContain(RP_STATUS_LABELS.incomplete.label);
        rerender(<RunPanel runs={view({latest: latest({state: "skipped", skipReason: "missed", rp: null, finishedAt: null})})} canRun={false}/>);
        expect(container.textContent).toContain(RUNS.skip.missed);
    });
    it("paused policy: the notice names the reason and the fix (facet 6 companion)", async () => {
        const {container} = render(<RunPanel runs={view({paused: {reason: "capability_lost", at: "2026-11-07T01:00:00.000Z"}})} canRun={true}/>);
        const n = screen.getByTestId("paused-notice");
        expect(n.textContent).toContain(RUNS.paused.reasons.capability_lost);
        expect(n.textContent).toContain(RUNS.paused.fix);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("no run yet: says so; the Cancel control appears only for an ACTIVE run and only for someone who may run backups", () => {
        const {rerender} = render(<RunPanel runs={view()} canRun={true}/>);
        expect(screen.getByTestId("run-none")).toBeTruthy();
        rerender(<RunPanel runs={view({active: {id: ID, state: "running", startedAt: "2026-11-07T02:00:00.000Z"}, latest: latest({state: "running", finishedAt: null, rp: null})})} canRun={true}/>);
        expect(screen.getByTestId("cancel-run")).toBeTruthy();
        rerender(<RunPanel runs={view({active: {id: ID, state: "running", startedAt: "2026-11-07T02:00:00.000Z"}, latest: latest({state: "running", finishedAt: null, rp: null})})} canRun={false}/>);
        expect(screen.queryByTestId("cancel-run")).toBeNull();
    });
});

describe("runs UI: the button", () => {
    const mount = (reason: string | null) => render(<StatusAnnouncer><RunNowButton stackId={ID} label="Back up now" reason={reason}/></StatusAnnouncer>);

    it("with a reason it is aria-disabled, focusable, does nothing, and the reason is visible text", () => {
        mount(RUNS.action.reasons.no_policy);
        const b = screen.getByRole("button", {name: "Back up now"});
        expect(b.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(b);
        expect(start).not.toHaveBeenCalled();
        expect(document.getElementById(b.getAttribute("aria-describedby")!)!.textContent).toBe(RUNS.action.reasons.no_policy);
    });
    it("a click sends ONLY the stack id; success is shown only when the server answered ok, then the page refreshes", async () => {
        start.mockResolvedValue({data: {ok: true, runId: "r1"}});
        mount(null);
        fireEvent.click(screen.getByRole("button", {name: "Back up now"}));
        await waitFor(() => expect(screen.getByTestId("run-now-outcome").textContent).toBe(RUNS.action.outcome.started));
        expect(start).toHaveBeenCalledWith({stackId: ID});
        expect(refresh).toHaveBeenCalled();
    });
    it("a refusal is NEVER shown as success: it says why in words", async () => {
        start.mockResolvedValue({data: {ok: false, code: "capacity"}});
        mount(null);
        fireEvent.click(screen.getByRole("button", {name: "Back up now"}));
        await waitFor(() => expect(screen.getByTestId("run-now-outcome").textContent).toBe(RUNS.action.outcome.capacity));
        expect(screen.getByTestId("run-now-outcome").textContent).not.toBe(RUNS.action.outcome.started);
    });
    it("a transport failure says it failed (nothing is claimed)", async () => {
        start.mockRejectedValue(new Error("network down"));
        mount(null);
        fireEvent.click(screen.getByRole("button", {name: "Back up now"}));
        await waitFor(() => expect(screen.getByTestId("run-now-outcome").textContent).toBeTruthy());
        expect(screen.getByTestId("run-now-outcome").textContent).not.toBe(RUNS.action.outcome.started);
        expect(screen.getByTestId("run-now-outcome").textContent).not.toMatch(/network down/);
    });
    it("a double click sends one request", async () => {
        let release: (v: unknown) => void = () => {};
        start.mockReturnValue(new Promise((r) => { release = r; }));
        mount(null);
        const b = screen.getByRole("button", {name: "Back up now"});
        fireEvent.click(b); fireEvent.click(b);
        expect(start).toHaveBeenCalledTimes(1);
        release({data: {ok: true, runId: "r"}});
        await waitFor(() => expect(screen.getByTestId("run-now-outcome")).toBeTruthy());
    });
});
