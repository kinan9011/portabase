// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {QuiesceViewDto} from "@/fork/quiesce/view";
import {QUIESCE} from "@/fork/ui/labels";

const refresh = vi.fn();
const enable = vi.fn();
const disable = vi.fn();
const startNow = vi.fn();
const preview = vi.fn();
vi.mock("next/navigation", () => ({useRouter: () => ({refresh})}));
vi.mock("@/fork/actions/stack-quiesce.action", () => ({
    enableQuiesceAction: (...a: unknown[]) => enable(...a), disableQuiesceAction: (...a: unknown[]) => disable(...a),
    startQuiesceNowAction: (...a: unknown[]) => startNow(...a), previewQuiesceAction: (...a: unknown[]) => preview(...a),
}));

import {QuiescePanel} from "@/fork/ui/stacks/quiesce/quiesce-panel.client";
import {QuiesceStatusRow} from "@/fork/ui/stacks/quiesce/quiesce-status-row";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const SID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const dto = (o: Partial<QuiesceViewDto> = {}): QuiesceViewDto => ({stackId: SID, stackName: "app", flagOn: true, hostRole: "test", availability: {state: "available"}, enabled: false, enabledAt: null, services: [], maxStopSeconds: 600, defaults: ["db"],
    allServices: [{name: "web", running: true}, {name: "db", running: true}], plan: {ok: true, stopOrder: ["web", "db"], startOrder: ["db", "web"], windowMembers: ["volume-data"], preMembers: ["db-dump"], notRunning: []}, last: null,
    alert: {active: false, since: null, canStartNow: false}, ...o});
const ui = (d: QuiesceViewDto, isAdmin = true) => render(<StatusAnnouncer><QuiescePanel dto={d} isAdmin={isAdmin}/></StatusAnnouncer>);

beforeEach(() => { for (const f of [refresh, enable, disable, startNow, preview]) f.mockReset(); });
afterEach(cleanup);

describe("W17b Stop + copy panel", () => {
    it("off + available: states in text + icon, defaults prefilled, preview shows both orders, axe clean", async () => {
        const {container} = ui(dto());
        expect(screen.getByTestId("quiesce-status").textContent).toContain(QUIESCE.status.off);
        expect((screen.getByTestId("quiesce-service-db") as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId("quiesce-service-web") as HTMLInputElement).checked).toBe(false);
        expect(screen.getByTestId("quiesce-preview").textContent).toContain("web → db");
        expect(screen.getByTestId("quiesce-preview").textContent).toContain("db → web");
        expect(await axeViolations(container)).toEqual([]);
    });
    it("unavailable: the button is aria-disabled with a VISIBLE reason and a click sends nothing", () => {
        ui(dto({availability: {state: "unavailable", reason: "capability_missing"}}));
        const b = screen.getByTestId("quiesce-enable");
        expect(b.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getAllByText(QUIESCE.skip.capability_missing).length).toBeGreaterThan(0);
        fireEvent.click(b);
        expect(enable).not.toHaveBeenCalled();
    });
    it("a member sees it read-only with the reason; blockers render as words", async () => {
        const {container} = ui(dto({plan: {ok: false, blockers: [{code: "manager_in_stack", service: "mgr"}, {code: "writer_not_stopped", service: "worker", member: "v"}]}}), false);
        expect(screen.getByTestId("quiesce-enable").getAttribute("aria-disabled")).toBe("true");
        expect(container.textContent).toContain(QUIESCE.readOnly);
        expect(container.textContent).toContain(QUIESCE.blockers.manager_in_stack);
        expect(container.textContent).not.toMatch(/manager_in_stack|writer_not_stopped/);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("enable on a TEST host: confirm dialog, real action, the server's verdict is what is shown (no optimistic success)", async () => {
        enable.mockResolvedValue({data: {ok: false, code: "plan_blocked", message: "x"}});
        ui(dto());
        fireEvent.click(screen.getByTestId("quiesce-enable"));
        fireEvent.click(await screen.findByRole("button", {name: QUIESCE.actions.enable, hidden: false}).then((b) => b) as HTMLElement);
        await waitFor(() => expect(enable).toHaveBeenCalledWith({stackId: SID, services: ["db"], maxStopSeconds: 600}));
        expect((await screen.findByTestId("quiesce-outcome")).textContent).toBe(QUIESCE.errors.plan_blocked);
        expect(refresh).not.toHaveBeenCalled();
    });
    it("enable on a PRODUCTION host asks for the stack name and sends it", async () => {
        enable.mockResolvedValue({data: {ok: true}});
        ui(dto({hostRole: "production"}));
        fireEvent.click(screen.getByTestId("quiesce-enable"));
        fireEvent.change(await screen.findByTestId("quiesce-confirm-name"), {target: {value: "app"}});
        const confirm = (await screen.findAllByRole("button", {name: QUIESCE.actions.enable})).at(-1) as HTMLElement;
        fireEvent.click(confirm);
        await waitFor(() => expect(enable).toHaveBeenCalledWith({stackId: SID, services: ["db"], maxStopSeconds: 600, confirmName: "app"}));
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });
    it("alert: 'Stopped since HH:MM UTC' + Start now; the click calls the real action", async () => {
        startNow.mockResolvedValue({data: {ok: true, mode: "release"}});
        const {container} = ui(dto({enabled: true, services: ["web", "db"], alert: {active: true, since: "2026-11-08T03:02:00.000Z", canStartNow: true}}));
        expect(screen.getByTestId("quiesce-alert").textContent).toContain(QUIESCE.alert.line("03:02"));
        expect(await axeViolations(container)).toEqual([]);
        fireEvent.click(screen.getByTestId("quiesce-start-now"));
        fireEvent.click((await screen.findAllByRole("button", {name: QUIESCE.actions.startNow})).at(-1) as HTMLElement);
        await waitFor(() => expect(startNow).toHaveBeenCalledWith({stackId: SID}));
        expect((await screen.findByTestId("quiesce-outcome")).textContent).toBe(QUIESCE.alert.requested);
    });
    it("offline agent: the refusal shows the manual `docker start` fallback", async () => {
        startNow.mockResolvedValue({data: {ok: false, code: "agent_offline", message: "x", manual: {projectLabel: "app", containers: ["0123456789ab"]}}});
        ui(dto({enabled: true, services: ["db"], alert: {active: true, since: null, canStartNow: true}}));
        fireEvent.click(screen.getByTestId("quiesce-start-now"));
        fireEvent.click((await screen.findAllByRole("button", {name: QUIESCE.actions.startNow})).at(-1) as HTMLElement);
        expect((await screen.findByTestId("quiesce-outcome")).textContent).toContain("docker start 0123456789ab");
    });
    it("last result: measured downtime and per-service outcomes in words", async () => {
        const {container} = ui(dto({enabled: true, services: ["web", "db"], last: {runId: SID, state: "restarted", reason: null, releasedBy: "dashboard", windowIntact: true, downtimeMs: 72_000, stoppedAt: null, startedAt: "2026-11-08T03:00:00.000Z", containers: [{service: "web", outcome: "verified"}, {service: "db", outcome: "unhealthy"}]}}));
        expect(screen.getByTestId("quiesce-last").textContent).toContain("App paused for 1 min 12 s (2 containers).");
        expect(container.textContent).toContain(QUIESCE.lastResult.outcome.unhealthy);
        expect(container.textContent).not.toMatch(/db: unhealthy/);
    });
});

describe("W17b wizard status row", () => {
    it("read-only: text only, no control; blocked shows the reason", async () => {
        const {container, rerender} = render(<QuiesceStatusRow reason={null}/>);
        expect(container.textContent).toBe(`○ ${QUIESCE.statusRow.available}`);
        rerender(<QuiesceStatusRow reason="flag_off"/>);
        expect(container.textContent).toContain(QUIESCE.skip.flag_off);
        expect(container.querySelector("button, input, select, a, form")).toBeNull();
        expect(await axeViolations(container)).toEqual([]);
    });
});
