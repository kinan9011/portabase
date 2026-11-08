// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {ForkPrincipal} from "@/fork/acl";
import type {RestoreRunView} from "@/fork/restore-run/view";
import {CANCEL_REFUSAL_TEXT, HEADLINE, POLICY_REFUSAL_TEXT, R_PROD, RECOVERY, RULE_TEXT} from "@/fork/ui/recovery/labels";
import {TONE_MAP} from "@/fork/ui/tone";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const RUN = "0b7e1c1e-7f3a-4b6e-9a40-bbbbbbbbbbbb";
const STACK = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const h = vi.hoisted(() => ({principal: null as null | ForkPrincipal, mode: {mode: "on"} as {mode: string}, resource: vi.fn(), view: vi.fn(), name: vi.fn(),
    get: vi.fn(), allow: vi.fn(), cancel: vi.fn(), cleanup: vi.fn(), refresh: vi.fn()}));
vi.mock("next/navigation", () => ({notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({refresh: h.refresh, push: vi.fn()})}));
vi.mock("@/fork/principal", () => ({getForkPrincipal: async () => h.principal}));
vi.mock("@/fork/mode", () => ({currentForkMode: async () => h.mode}));
vi.mock("@/fork/db/handle", () => ({appDb: async () => ({tag: "db"})}));
vi.mock("@/fork/keys", () => ({fileKeyProvider: {}}));
vi.mock("@/utils/get-server-url", () => ({getServerUrl: () => "http://x"}));
vi.mock("@/fork/resource-scope", () => ({assertForkResource: h.resource}));
vi.mock("@/fork/restore-run/view", () => ({getRestoreRunView: h.view}));
vi.mock("@/fork/restore-wizard/view", () => ({loadStackName: h.name}));
vi.mock("@/fork/actions/restore-run.action", () => ({getRestoreRunViewAction: (...a: unknown[]) => h.get(...a), approveRestorePolicyAction: (...a: unknown[]) => h.allow(...a), cancelRestoreRunAction: (...a: unknown[]) => h.cancel(...a), cleanupRestoreRunAction: (...a: unknown[]) => h.cleanup(...a)}));

import {RunView} from "@/fork/ui/recovery/run-view.client";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import RunPage from "../../../../app/(customer)/dashboard/(organization)/recovery/runs/[runId]/page";

const now = new Date();
const DAY = 86_400_000;
const step = (name: string, status: string, o: Record<string, unknown> = {}) => ({name, status, startedAt: null, finishedAt: null, code: null, attempts: 1, task: null, ...o});
const view = (o: Partial<RestoreRunView> = {}): RestoreRunView => ({
    id: RUN, planId: "0b7e1c1e-7f3a-4b6e-9a40-aaaaaaaaaaaa", planHash: "h".repeat(64), stackId: STACK, rpSequence: 8, targetAgentName: "clean-host", targetProject: "notes", purpose: "restore", mode: "new_stack",
    state: "running", reason: null, failedStep: null, verification: null, createdAt: new Date(now.getTime() - 3600_000).toISOString(), deadlineAt: new Date(now.getTime() + DAY).toISOString(), finishedAt: null, cancelRequested: false,
    steps: [step("verify_manifest", "done"), step("probe", "done"), step("stage", "running", {task: {status: "leased", reason: null}}), step("apply", "pending", {attempts: 0})],
    awaiting: null, services: [], overrides: {applicable: true, missingRequired: 0, frozen: false}, cleanup: null, nextSteps: [], ...o,
} as RestoreRunView);
const awaiting = {kind: "policy_approval" as const, composeSha256: "c".repeat(64), services: [{service: "traefik", rules: ["docker_sock"], phrase: "ALLOW traefik"}]};
const ui = (v: RestoreRunView, o: {exec?: boolean; owner?: boolean; locked?: boolean} = {}) => render(<StatusAnnouncer><RunView initial={v} appName="notes" canExecute={o.exec ?? true} canApproveProduction={o.owner ?? true} locked={o.locked ?? false} serverNowIso={now.toISOString()}/></StatusAnnouncer>);
const ok = (v: RestoreRunView) => ({data: {ok: true, view: v}});

beforeEach(() => {
    vi.useFakeTimers({shouldAdvanceTime: false}); vi.setSystemTime(now);
    h.principal = {userId: "u", systemRole: "user", memberships: [{organizationId: ORG, role: "owner"}]}; h.mode = {mode: "on"};
    for (const f of [h.resource, h.view, h.name, h.get, h.allow, h.cancel, h.cleanup, h.refresh]) f.mockReset();
    h.resource.mockResolvedValue({organizationId: ORG}); h.name.mockResolvedValue("notes");
    h.get.mockResolvedValue(ok(view()));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const SUCCESS = TONE_MAP.success.badge;
describe("W18b run page (Screen 6): honest states", () => {
    it("m1 each terminal state renders its headline; only succeeded uses the success tone, with no success text on failed / incomplete / cancelled", async () => {
        const cases: [Partial<RestoreRunView>, RegExp, boolean][] = [
            [{state: "succeeded", verification: "started", finishedAt: now.toISOString()}, /the app was started\. All its services were running right after start/, true],
            [{state: "succeeded", verification: "data_only", finishedAt: now.toISOString()}, /The app was not started/, true],
            [{state: "incomplete", reason: "service_not_running", verification: null, services: [{service: "web", state: "running"}, {service: "migrate", state: "exited"}], finishedAt: now.toISOString()}, /some services were not running right after start: migrate/, false],
            [{state: "failed", reason: "artifact_unavailable", failedStep: "stage", finishedAt: now.toISOString()}, /Restore failed at 'Download the backup': The backup storage could not be reached from clean-host/, false],
            [{state: "cancelled", finishedAt: now.toISOString()}, /Restore cancelled/, false],
        ];
        for (const [o, re, good] of cases) {
            const {container, unmount} = ui(view(o));
            expect(screen.getByTestId("run-headline").textContent).toMatch(re);
            const chip = container.querySelector("span.inline-flex")!;
            expect(chip.className.includes(SUCCESS), String(o.state)).toBe(good);
            if (!good) expect(container.textContent).not.toMatch(/the app was started|Restore finished/);
            unmount();
        }
    });
    it("m5 steps after the failure are 'Not run', the failed step shows its reason in words, a raw code never appears", async () => {
        const v = view({state: "failed", reason: "checksum_mismatch", failedStep: "stage", finishedAt: now.toISOString(), steps: [step("verify_manifest", "done"), step("probe", "done"), step("stage", "failed", {code: "checksum_mismatch"}), step("apply", "failed"), step("render", "pending", {attempts: 0})]});
        const {container} = ui(v);
        const kinds = screen.getAllByTestId("run-step").map((e) => e.getAttribute("data-kind"));
        expect(kinds).toEqual(["done", "done", "failed", "not_run", "not_run"]);
        expect(container.textContent).toContain("Part of the backup is damaged");
        expect(container.textContent).not.toContain("checksum_mismatch");
        vi.useRealTimers(); expect(await axeViolations(container)).toEqual([]);
    });
    it("DD-9 running steps in the UI: waiting for the machine, in progress, retry text", () => {
        const {container} = ui(view({steps: [step("probe", "running", {task: {status: "queued", reason: null}}), step("stage", "running", {attempts: 2, task: {status: "queued", reason: null}}), step("apply", "running", {task: {status: "leased", reason: null}})]}));
        expect(container.textContent).toContain("Waiting for clean-host to pick this up");
        expect(container.textContent).toContain("The machine did not respond. Trying again (attempt 2 of 3)");
        expect(container.textContent).toContain("In progress");
    });
    it("services panel (after the app was started) shows names with state words; a one-shot exited service is not green", () => {
        const {container} = ui(view({state: "incomplete", reason: "service_not_running", services: [{service: "web", state: "running"}, {service: "migrate", state: "exited"}], finishedAt: now.toISOString()}));
        const li = [...screen.getByTestId("run-services").querySelectorAll("li")];
        expect(li[1]!.textContent).toContain("Exited");
        expect(li[1]!.querySelector("span.inline-flex")!.className.includes(SUCCESS)).toBe(false);
        expect(container.textContent).toContain("Some services stop on purpose after a one-time job");
    });
    it("succeeded: the Next steps checklist is shown with the protect-again item and a link; it never claims anything was re-attached", async () => {
        const {container} = ui(view({state: "succeeded", verification: "started", finishedAt: now.toISOString(), nextSteps: ["reattach_backups"]}));
        const n = screen.getByTestId("run-next");
        expect(n.textContent).toContain("until a backup on the new machine is verified");
        expect(n.querySelector("a")?.getAttribute("href")).toBe("/dashboard/stacks");
        expect(container.textContent).not.toMatch(/re-?attached|adopted/i);
        vi.useRealTimers(); expect(await axeViolations(container)).toEqual([]);
    });
});

describe("W18b run page: polling", () => {
    it("m6 polls every 5 s while active, updates the view, stops once the run is terminal, and never polls again", async () => {
        h.get.mockResolvedValueOnce(ok(view({steps: [step("probe", "done"), step("stage", "done")]}))).mockResolvedValue(ok(view({state: "succeeded", verification: "started", finishedAt: now.toISOString()})));
        ui(view());
        expect(h.get).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(h.get).toHaveBeenCalledTimes(1);
        expect(h.get).toHaveBeenCalledWith({runId: RUN});
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId("run-headline").textContent).toContain("the app was started");
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(h.get).toHaveBeenCalledTimes(2);
    });
    it("a terminal run with no cleanup in flight is never polled; a cleanup in flight keeps polling until it ends", async () => {
        ui(view({state: "failed", reason: "agent_offline", failedStep: "probe", finishedAt: now.toISOString()}));
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
        expect(h.get).not.toHaveBeenCalled();
        cleanup();
        h.get.mockResolvedValue(ok(view({state: "failed", reason: "agent_offline", failedStep: "probe", finishedAt: now.toISOString(), cleanup: {status: "succeeded", reason: null, attempts: 1}})));
        ui(view({state: "failed", reason: "agent_offline", failedStep: "probe", finishedAt: now.toISOString(), cleanup: {status: "running", reason: null, attempts: 1}}));
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(h.get).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("cleanup-line").textContent).toBe(RECOVERY.run.cleanupDone);
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
        expect(h.get).toHaveBeenCalledTimes(1);
    });
    it("pauses while the tab is hidden and resumes when visible again; a failed poll shows the retry note and keeps trying", async () => {
        h.get.mockRejectedValueOnce(new Error("net")).mockResolvedValue(ok(view()));
        ui(view());
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(screen.getByTestId("poll-error").textContent).toBe(RECOVERY.run.pollError);
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId("poll-error")).toBeNull();
        Object.defineProperty(document, "hidden", {configurable: true, value: true});
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
        expect(h.get).toHaveBeenCalledTimes(2);
        Object.defineProperty(document, "hidden", {configurable: true, value: false});
        document.dispatchEvent(new Event("visibilitychange"));
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(h.get.mock.calls.length).toBeGreaterThan(2);
    });
    it("announcements go to the ONE status region and the alert region only on a transition into failed", async () => {
        h.get.mockResolvedValue(ok(view({state: "failed", reason: "stale", failedStep: "stage", finishedAt: now.toISOString()})));
        const {container} = ui(view());
        expect(screen.queryByTestId("run-alert")).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(screen.getByTestId("run-alert").textContent).toContain("Restore failed");
        expect(screen.getByTestId("job-status").textContent).toContain("Restore failed");
        expect(container.querySelectorAll("[role=status]").length).toBe(1);
    });
});

describe("W18b run page: awaiting approval (ALLOW)", () => {
    const aw = (o: Partial<RestoreRunView> = {}) => view({state: "awaiting_approval", awaiting, steps: [step("verify_manifest", "done"), step("probe", "done"), step("stage", "done"), step("apply", "done"), step("render", "done")], ...o});
    it("m11 the alert region never outlives its state: awaiting -> succeeded and awaiting -> running clear it, the status region still announces", async () => {
        const done = [step("verify_manifest", "done"), step("probe", "done"), step("stage", "done"), step("apply", "done"), step("render", "done")];
        h.get.mockResolvedValueOnce(ok(aw())).mockResolvedValueOnce(ok(view({state: "succeeded", verification: "started", finishedAt: now.toISOString(), steps: done})));
        ui(view());
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(screen.getByTestId("run-alert").textContent).toContain(HEADLINE.awaiting_approval.text);
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(screen.queryByTestId("run-alert")).toBeNull();
        expect(screen.getByTestId("job-status").textContent).toContain(HEADLINE.started.text);
        cleanup();
        h.get.mockReset(); h.get.mockResolvedValueOnce(ok(aw())).mockResolvedValue(ok(view({state: "running"})));
        ui(view());
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(screen.getByTestId("run-alert")).toBeTruthy();
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(screen.queryByTestId("run-alert")).toBeNull();
    });
    it("lists the rules in words per service with a labelled input; sends exactly what was typed; clears the input after submit; ok ⇒ refreshes the view", async () => {
        h.allow.mockResolvedValue({data: {ok: true}});
        h.get.mockResolvedValue(ok(view({state: "running"})));
        const {container} = ui(aw());
        expect(screen.getByTestId("allow-panel").textContent).toContain(RULE_TEXT.docker_sock("traefik"));
        expect(screen.getByTestId("allow-panel").textContent).toContain("Allow only if you trust this app to do that on clean-host.");
        const input = screen.getByLabelText("Type ALLOW traefik to allow") as HTMLInputElement;
        expect(input.getAttribute("spellcheck")).toBe("false"); expect(input.getAttribute("autocomplete")).toBe("off"); expect(input.getAttribute("data-gramm")).toBe("false"); expect(input.hasAttribute("data-1p-ignore")).toBe(true);
        input.value = "ALLOW traefik";
        await act(async () => { fireEvent.click(screen.getByRole("button", {name: RECOVERY.run.allowButton})); });
        expect(h.allow).toHaveBeenCalledWith({runId: RUN, confirmations: {traefik: "ALLOW traefik"}});
        expect(input.value).toBe("");
        expect(h.get).toHaveBeenCalled();
        vi.useRealTimers(); expect(await axeViolations(container)).toEqual([]);
    });
    it("a wrong phrase shows table A (not the raw code); a hard refusal removes the Allow button (only Cancel remains)", async () => {
        h.allow.mockResolvedValueOnce({data: {ok: false, code: "confirmation_mismatch"}}).mockResolvedValueOnce({data: {ok: false, code: "hard_refusal"}});
        const {container} = ui(aw());
        (screen.getByLabelText("Type ALLOW traefik to allow") as HTMLInputElement).value = "allow";
        await act(async () => { fireEvent.click(screen.getByRole("button", {name: RECOVERY.run.allowButton})); });
        expect(screen.getByTestId("allow-error").textContent).toBe(POLICY_REFUSAL_TEXT.confirmation_mismatch);
        await act(async () => { fireEvent.click(screen.getByRole("button", {name: RECOVERY.run.allowButton})); });
        expect(screen.getByTestId("allow-error").textContent).toBe(POLICY_REFUSAL_TEXT.hard_refusal);
        expect(screen.queryByRole("button", {name: RECOVERY.run.allowButton})).toBeNull();
        expect(screen.getByRole("button", {name: RECOVERY.run.cancel})).toBeTruthy();
        expect(container.textContent).not.toContain("hard_refusal");
    });
    it("a non-owner sees the inputs and the button aria-disabled with the R-prod reason; nothing is sent", async () => {
        const {container} = ui(aw(), {owner: false});
        const input = screen.getByLabelText("Type ALLOW traefik to allow");
        expect(input.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByRole("button", {name: RECOVERY.run.allowButton}).getAttribute("aria-disabled")).toBe("true");
        expect(container.textContent).toContain(R_PROD);
        await act(async () => { fireEvent.click(screen.getByRole("button", {name: RECOVERY.run.allowButton})); });
        expect(h.allow).not.toHaveBeenCalled();
    });
    it("awaiting_approval without a render yet ⇒ 'being prepared again' and no inputs", () => {
        ui(aw({awaiting: null}));
        expect(screen.getByTestId("awaiting-preparing").textContent).toBe(RECOVERY.run.awaitingPreparing);
        expect(screen.queryByTestId("allow-panel")).toBeNull();
        expect(screen.getByTestId("run-headline").textContent).toBe("Waiting for your approval");
    });
});

describe("W18b run page: cancel and cleanup", () => {
    it("cancel: plain confirm ⇒ cancelRestoreRunAction; refusal shows its sentence; once cancel is requested the chip says so and the button is gone", async () => {
        h.cancel.mockResolvedValueOnce({data: {ok: false, code: "not_active"}});
        ui(view());
        fireEvent.click(screen.getByTestId("cancel-run"));
        expect(screen.getByRole("alertdialog").textContent).toContain("Anything this restore created stays on clean-host until you remove it.");
        await act(async () => { fireEvent.click(screen.getByRole("button", {name: RECOVERY.run.cancelConfirm})); });
        expect(h.cancel).toHaveBeenCalledWith({runId: RUN});
        expect(screen.getByRole("alert").textContent).toBe(CANCEL_REFUSAL_TEXT.not_active);
        cleanup();
        ui(view({cancelRequested: true}));
        expect(screen.getByText(RECOVERY.run.cancelling)).toBeTruthy();
        expect(screen.queryByTestId("cancel-run")).toBeNull();
    });
    it("cleanup: offered for failed / cancelled / incomplete (never succeeded) with the owned-resources-only copy; failure shows a retry button; success shows the removed line", async () => {
        h.cleanup.mockResolvedValue({data: {ok: true}});
        for (const state of ["failed", "cancelled", "incomplete"]) {
            const {unmount} = ui(view({state, reason: state === "cancelled" ? null : "stale", finishedAt: now.toISOString()}));
            expect(screen.getByRole("button", {name: RECOVERY.run.cleanupButton})).toBeTruthy();
            unmount();
        }
        ui(view({state: "succeeded", verification: "started", finishedAt: now.toISOString()}));
        expect(screen.queryByTestId("cleanup-control")).toBeNull();
        cleanup();
        ui(view({state: "incomplete", reason: "service_not_running", finishedAt: now.toISOString()}));
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.run.cleanupButton}));
        expect(screen.getByRole("alertdialog").textContent).toContain("The restored data is removed too.");
        await act(async () => { fireEvent.click(screen.getByRole("button", {name: RECOVERY.run.cleanupConfirm})); });
        expect(h.cleanup).toHaveBeenCalledWith({runId: RUN});
        cleanup();
        const {container} = ui(view({state: "failed", reason: "stale", failedStep: "stage", finishedAt: now.toISOString(), cleanup: {status: "failed", reason: "docker_unavailable", attempts: 1}}));
        expect(screen.getByTestId("cleanup-line").textContent).toContain("Removal failed: Docker with Compose is not available on clean-host.");
        expect(screen.getByRole("button", {name: RECOVERY.run.cleanupRetry})).toBeTruthy();
        expect(container.textContent).not.toContain("docker_unavailable");
    });
    it("a member-level viewer (no restore.execute) gets no cancel / cleanup controls", () => {
        ui(view({state: "failed", reason: "stale", finishedAt: now.toISOString()}), {exec: false});
        expect(screen.queryByTestId("cleanup-control")).toBeNull();
        cleanup();
        ui(view(), {exec: false});
        expect(screen.queryByTestId("cancel-run")).toBeNull();
    });
});

describe("W18b run page: server page gates", () => {
    it("loads the durable view for the first render; not found / foreign / malformed id ⇒ not found; a member (forbidden) ⇒ the R-role notice; load error ⇒ alert", async () => {
        h.view.mockResolvedValue({ok: true, view: view({state: "failed", reason: "stale", failedStep: "stage", finishedAt: now.toISOString()})});
        let r = render(await RunPage({params: Promise.resolve({runId: RUN})}));
        expect(screen.getByTestId("run-headline").textContent).toContain("Restore failed"); r.unmount();
        const {ForkNotFoundError, ForkForbiddenError} = await import("@/fork/acl");
        h.resource.mockRejectedValue(new ForkNotFoundError());
        await expect(RunPage({params: Promise.resolve({runId: RUN})})).rejects.toThrow("NEXT_NOT_FOUND");
        await expect(RunPage({params: Promise.resolve({runId: "x"})})).rejects.toThrow("NEXT_NOT_FOUND");
        h.resource.mockRejectedValue(new ForkForbiddenError("restore.plan"));
        r = render(await RunPage({params: Promise.resolve({runId: RUN})})); expect(screen.getByTestId("unauthorized")).toBeTruthy(); r.unmount();
        h.resource.mockResolvedValue({organizationId: ORG}); h.view.mockRejectedValue(new Error("db"));
        r = render(await RunPage({params: Promise.resolve({runId: RUN})})); expect(screen.getByTestId("load-error").getAttribute("role")).toBe("alert");
    });
});
