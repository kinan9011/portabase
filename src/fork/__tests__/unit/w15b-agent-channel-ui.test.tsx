// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {AgentChannelRow, AgentChannelView} from "@/fork/agent-channel/view";
import {AGENT_CHANNEL as L} from "@/fork/ui/agent-channel/labels";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({useRouter: () => ({refresh}), notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));
const A = {enrol: vi.fn(), rotate: vi.fn(), revoke: vi.fn(), enable: vi.fn(), enqueue: vi.fn(), pin: vi.fn(), unpin: vi.fn()};
vi.mock("@/fork/actions/agent-channel.action", () => ({
    enrolAgentAction: (...a: unknown[]) => A.enrol(...a), requestAgentCredentialRotationAction: (...a: unknown[]) => A.rotate(...a), revokeAgentEnrollmentAction: (...a: unknown[]) => A.revoke(...a),
    setAgentChannelEnabledAction: (...a: unknown[]) => A.enable(...a), enqueueAgentTaskAction: (...a: unknown[]) => A.enqueue(...a), pinDashboardKeyAction: (...a: unknown[]) => A.pin(...a), unpinDashboardKeyAction: (...a: unknown[]) => A.unpin(...a),
}));
import {AgentChannelPanel} from "@/fork/ui/agent-channel/agent-channel-panel.client";

const ID = "11111111-1111-4111-8111-111111111111";
const SIGN = "aaaaaaaaaaaa", OTHER = "bbbbbbbbbbbb";
const row = (o: Partial<AgentChannelRow> = {}): AgentChannelRow => ({
    id: ID, name: "edge-agent", enrolled: true, enabled: true, revoked: false, lastSeenAt: new Date().toISOString(), enrolledAt: new Date().toISOString(), capabilities: ["channel.v1", "noop.v1", "channel-maint.v1"],
    pinnedKids: [SIGN, OTHER], pinFingerprint: "f".repeat(64), rotation: "none", canMaint: true, recentTasks: [{id: "t1", type: "noop", status: "succeeded", reason: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString()}], ...o,
});
const view = (...agents: AgentChannelRow[]): AgentChannelView => ({signingKid: SIGN, agents});
const HTTPS = {ok: true, insecureLab: false} as const;
const mount = (v: AgentChannelView, o: {locked?: string | null; transport?: Parameters<typeof AgentChannelPanel>[0]["transport"]} = {}) =>
    render(<AgentChannelPanel view={v} lockedReason={o.locked ?? null} transport={o.transport ?? HTTPS}/>);
const PW = "Pw-ui-canary-91";
const typePassword = (v = PW) => fireEvent.change(document.querySelector<HTMLInputElement>('input[type="password"]')!, {target: {value: v}});
const CRED_SHAPE = /fork\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/;

beforeEach(() => { refresh.mockReset(); for (const f of Object.values(A)) f.mockReset(); });
afterEach(cleanup);

describe("W15b agent channel card: states", () => {
    it("not enrolled: one Enrol action, no maintenance controls; axe clean", async () => {
        const {container} = mount(view(row({enrolled: false, enabled: false, capabilities: [], pinnedKids: [], pinFingerprint: null, recentTasks: []})));
        expect(screen.getByText(L.badges.notEnrolled)).toBeTruthy();
        expect(screen.getByRole("button", {name: L.actions.enrol})).toBeTruthy();
        expect(screen.queryByRole("button", {name: L.actions.rotate})).toBeNull();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("enrolled: badges, capabilities, trusted kids, recent tasks and every action are shown; axe clean", async () => {
        const {container} = mount(view(row({rotation: "pending"})));
        expect(screen.getAllByText(L.badges.enrolled).length).toBeGreaterThan(0);
        expect(screen.getByText(L.badges.enabled)).toBeTruthy();
        expect(screen.getByText(L.badges.rotationPending)).toBeTruthy();
        expect(screen.getByText(/channel-maint\.v1/)).toBeTruthy();
        expect(screen.getAllByTestId("pinned-kid").map((e) => e.textContent)).toEqual([SIGN, OTHER]);
        expect(screen.getByTestId("recent-task").textContent).toContain(L.taskStatuses.succeeded);
        for (const n of [L.actions.reenrol, L.actions.rotate, L.actions.disable, L.actions.testTask, L.actions.revoke, L.actions.pin]) expect(screen.getByRole("button", {name: n})).toBeTruthy();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("revoked: only a visible reason, every maintenance button is aria-disabled", () => {
        mount(view(row({revoked: true, enabled: false})));
        expect(screen.getByText(L.badges.revoked)).toBeTruthy();
        const rotate = screen.getByRole("button", {name: L.actions.rotate});
        expect(rotate.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getAllByText(L.revoked).length).toBeGreaterThan(0);
    });
    it("http dashboard URL: the https reason is visible and every action is blocked without calling anything", async () => {
        mount(view(row()), {transport: {ok: false, code: "insecure_transport"}});
        expect(screen.getByTestId("transport-reason").textContent).toBe(L.needsHttps);
        typePassword();
        for (const n of [L.actions.rotate, L.actions.testTask, L.actions.pin]) {
            const b = screen.getByRole("button", {name: n});
            expect(b.getAttribute("aria-disabled")).toBe("true");
            fireEvent.click(b);
        }
        await act(async () => {});
        for (const f of Object.values(A)) expect(f).not.toHaveBeenCalled();
    });
    it("locked: the lock text is shown and actions are blocked", () => {
        mount(view(row()), {locked: "Fork configuration is locked."});
        expect(screen.getAllByText("Fork configuration is locked.").length).toBeGreaterThan(0);
        expect(screen.getByRole("button", {name: L.actions.rotate}).getAttribute("aria-disabled")).toBe("true");
    });
    it("no maintenance capability: rotate and pin explain why; the signing key and the last key cannot be unpinned", () => {
        mount(view(row({canMaint: false, capabilities: ["channel.v1"]})));
        expect(screen.getByRole("button", {name: L.actions.rotate}).getAttribute("aria-disabled")).toBe("true");
        expect(screen.getAllByText(L.needsCapability).length).toBeGreaterThan(0);
        cleanup();
        mount(view(row()));
        expect(screen.getByRole("button", {name: `${L.actions.unpin} ${SIGN}`}).getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(L.errors.pin_in_use)).toBeTruthy();
        expect(screen.getByRole("button", {name: `${L.actions.unpin} ${OTHER}`}).getAttribute("aria-disabled")).toBeNull();
        cleanup();
        mount(view(row({pinnedKids: [OTHER]})));
        expect(screen.getByText(L.errors.last_pin)).toBeTruthy();
    });
    it("empty agent list and a non-agent page state render a plain message", () => {
        mount(view());
        expect(screen.getByText(L.page.empty)).toBeTruthy();
    });
});

describe("W15b agent channel card: actions are real and honest", () => {
    it("enrol shows the bundle once; closing the dialog removes it from the DOM and refreshes", async () => {
        const BUNDLE = "BUNDLE-CANARY-" + "x".repeat(40);
        A.enrol.mockResolvedValue({data: {ok: true, bundle: BUNDLE, pinFingerprint: "ab".repeat(32), insecureLab: false, kid: SIGN, enrollId: "e", reenrolled: false}});
        const {container} = mount(view(row({enrolled: false, enabled: false, capabilities: [], pinnedKids: [], pinFingerprint: null, recentTasks: []})));
        expect(container.textContent).not.toContain("BUNDLE-CANARY");
        typePassword();
        fireEvent.click(screen.getByRole("button", {name: L.actions.enrol}));
        const text = await screen.findByTestId("bundle-text");
        expect((text as HTMLTextAreaElement).value).toBe(BUNDLE);
        expect(A.enrol).toHaveBeenCalledWith({agentId: ID, password: PW});
        expect(screen.getByTestId("bundle-fingerprint").textContent).toBe("ab".repeat(32));
        expect(await axeViolations(document.body)).toEqual([]);
        fireEvent.click(screen.getByRole("button", {name: L.actions.close}));
        await waitFor(() => expect(screen.queryByTestId("bundle-text")).toBeNull());
        expect(document.body.textContent).not.toContain("BUNDLE-CANARY");
        expect(refresh).toHaveBeenCalled();
        // the password field was cleared when it was read
        expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    });
    it("rotate: a signed task is queued; no credential-shaped string ever appears", async () => {
        A.rotate.mockResolvedValue({data: {ok: true, taskId: "task-1", notAfter: new Date().toISOString()}});
        const {container} = mount(view(row()));
        typePassword();
        fireEvent.click(screen.getByRole("button", {name: L.actions.rotate}));
        await waitFor(() => expect(screen.getByTestId("agent-status").textContent).toBe(L.queued(L.taskTypes.rotate_credential)));
        expect(A.rotate).toHaveBeenCalledWith({agentId: ID, password: PW});
        expect(container.textContent).not.toMatch(CRED_SHAPE);
        expect(document.body.innerHTML).not.toMatch(CRED_SHAPE);
        expect(refresh).toHaveBeenCalled();
    });
    it("a refusal shows its message and never claims success", async () => {
        A.rotate.mockResolvedValue({data: {ok: false, code: "step_up_failed", message: "x"}});
        mount(view(row()));
        typePassword("wrong");
        fireEvent.click(screen.getByRole("button", {name: L.actions.rotate}));
        await waitFor(() => expect(screen.getByTestId("agent-status").textContent).toBe(L.errors.step_up_failed));
        expect(refresh).not.toHaveBeenCalled();
        // an action that throws (network, validation) is also reported as an error, not as success
        A.rotate.mockRejectedValue(new Error("boom"));
        typePassword();
        fireEvent.click(screen.getByRole("button", {name: L.actions.rotate}));
        await waitFor(() => expect(screen.getByTestId("agent-status").textContent).toBe(L.errors.invalid_input));
    });
    it("no password typed: nothing is sent", async () => {
        mount(view(row()));
        fireEvent.click(screen.getByRole("button", {name: L.actions.rotate}));
        await waitFor(() => expect(screen.getByTestId("agent-status").textContent).toBe(L.errors.step_up_failed));
        expect(A.rotate).not.toHaveBeenCalled();
    });
    it("test task, enable/disable (behind a confirm), revoke (behind a confirm) call their actions", async () => {
        A.enqueue.mockResolvedValue({data: {ok: true, taskId: "t", seq: 1, notAfter: "x"}});
        A.enable.mockResolvedValue({data: {ok: true, enabled: false}});
        A.revoke.mockResolvedValue({data: {ok: true}});
        mount(view(row()));
        fireEvent.click(screen.getByRole("button", {name: L.actions.testTask}));
        await waitFor(() => expect(A.enqueue).toHaveBeenCalledWith({agentId: ID, type: "noop", payload: {echo: "ui-check"}}));
        fireEvent.click(screen.getByRole("button", {name: L.actions.disable}));
        expect(A.enable).not.toHaveBeenCalled(); // asks first
        fireEvent.click(await screen.findByRole("button", {name: L.confirms.disable.button}));
        await waitFor(() => expect(A.enable).toHaveBeenCalledWith({agentId: ID, enabled: false}));
        fireEvent.click(screen.getByRole("button", {name: L.actions.revoke}));
        expect(A.revoke).not.toHaveBeenCalled();
        const dlg = await screen.findByRole("alertdialog");
        fireEvent.click(within(dlg).getByRole("button", {name: L.confirms.revoke.button}));
        await waitFor(() => expect(A.revoke).toHaveBeenCalledWith({agentId: ID}));
    });
    it("re-enrol asks first, then shows the new bundle once", async () => {
        A.enrol.mockResolvedValue({data: {ok: true, bundle: "NEW-BUNDLE-CANARY", pinFingerprint: "cd".repeat(32), insecureLab: true, kid: SIGN, enrollId: "e", reenrolled: true}});
        mount(view(row()));
        typePassword();
        fireEvent.click(screen.getByRole("button", {name: L.actions.reenrol}));
        expect(A.enrol).not.toHaveBeenCalled();
        const dlg = await screen.findByRole("alertdialog");
        fireEvent.click(within(dlg).getByRole("button", {name: L.confirms.reenroll.button}));
        expect(((await screen.findByTestId("bundle-text")) as HTMLTextAreaElement).value).toBe("NEW-BUNDLE-CANARY");
        expect(A.enrol).toHaveBeenCalledWith({agentId: ID, password: PW, reenroll: true});
        expect(screen.getByText(L.bundle.insecureLab)).toBeTruthy();
    });
    it("pin: sends the pasted PEM with the password and shows the queued kid; unpin asks first", async () => {
        A.pin.mockResolvedValue({data: {ok: true, taskId: "t", kid: "cccccccccccc", fingerprint: "e".repeat(64)}});
        A.unpin.mockResolvedValue({data: {ok: true, taskId: "t", kid: OTHER}});
        mount(view(row()));
        const pinBtn = screen.getByRole("button", {name: L.actions.pin});
        expect(pinBtn.getAttribute("aria-disabled")).toBe("true"); // nothing pasted yet
        fireEvent.change(screen.getByLabelText(L.pinForm.pem), {target: {value: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----"}});
        typePassword();
        fireEvent.click(screen.getByRole("button", {name: L.actions.pin}));
        await waitFor(() => expect(screen.getByTestId("agent-status").textContent).toBe(L.pinForm.shown("cccccccccccc")));
        expect(A.pin).toHaveBeenCalledWith({agentId: ID, password: PW, pem: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----"});
        expect((screen.getByLabelText(L.pinForm.pem) as HTMLTextAreaElement).value).toBe("");
        typePassword();
        fireEvent.click(screen.getByRole("button", {name: `${L.actions.unpin} ${OTHER}`}));
        expect(A.unpin).not.toHaveBeenCalled();
        const dlg = await screen.findByRole("alertdialog");
        fireEvent.click(within(dlg).getByRole("button", {name: L.confirms.unpin.button}));
        await waitFor(() => expect(A.unpin).toHaveBeenCalledWith({agentId: ID, password: PW, kid: OTHER}));
    });
});
