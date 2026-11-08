// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {ForkPrincipal} from "@/fork/acl";
import type {RestorePlanView} from "@/fork/restore/service";
import {PLAN_REASON_TEXT, R_PROD, R_ROLE, RECOVERY, RULE_TEXT} from "@/fork/ui/recovery/labels";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const PLAN = "0b7e1c1e-7f3a-4b6e-9a40-aaaaaaaaaaaa";
const STACK = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const AGENT = "0b7e1c1e-7f3a-4b6e-9a40-444444444444";
const RUN = "0b7e1c1e-7f3a-4b6e-9a40-bbbbbbbbbbbb";
const CANARY_PATH = "/srv/CANARY_PATH_ABC/data";
const h = vi.hoisted(() => ({principal: null as null | ForkPrincipal, mode: {mode: "on"} as {mode: string; lockReason?: string}, resource: vi.fn(), view: vi.fn(), ov: vi.fn(), runs: vi.fn(), pts: vi.fn(),
    approve: vi.fn(), create: vi.fn(), start: vi.fn(), list: vi.fn(), push: vi.fn(), refresh: vi.fn(), calls: [] as string[]}));
vi.mock("next/navigation", () => ({notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({refresh: h.refresh, push: h.push})}));
vi.mock("@/fork/principal", () => ({getForkPrincipal: async () => h.principal}));
vi.mock("@/fork/mode", () => ({currentForkMode: async () => h.mode}));
vi.mock("@/fork/db/handle", () => ({appDb: async () => ({tag: "db"})}));
vi.mock("@/fork/keys", () => ({fileKeyProvider: {}}));
vi.mock("@/utils/get-server-url", () => ({getServerUrl: () => "http://x"}));
vi.mock("@/fork/resource-scope", () => ({assertForkResource: h.resource}));
vi.mock("@/fork/restore/service", () => ({getRestorePlanView: h.view}));
vi.mock("@/fork/config/service", () => ({getRestoreOverridesView: h.ov}));
vi.mock("@/fork/restore-run/view", () => ({listRestoreRuns: h.runs}));
vi.mock("@/fork/restore-wizard/view", () => ({loadRestorePoints: h.pts}));
vi.mock("@/fork/actions/restore-plan.action", () => ({approveRestorePlanAction: (...a: unknown[]) => { h.calls.push("approve"); return h.approve(...a); }, createRestorePlanAction: (...a: unknown[]) => h.create(...a)}));
vi.mock("@/fork/actions/restore-run.action", () => ({startRestoreRunAction: (...a: unknown[]) => { h.calls.push("start"); return h.start(...a); }, listRestoreRunsAction: (...a: unknown[]) => h.list(...a)}));
vi.mock("@/fork/actions/stack-config.action", () => ({setRestoreOverridesAction: vi.fn(), clearRestoreOverridesAction: vi.fn()}));
vi.mock("@tanstack/react-query", () => ({useMutation: () => ({mutateAsync: vi.fn(), isPending: false, mutate: vi.fn()})}));

import PlanPage from "../../../../app/(customer)/dashboard/(organization)/recovery/plans/[planId]/page";

const P = (orgRole: string | null, role = "user"): ForkPrincipal => ({userId: "u", systemRole: role, memberships: orgRole ? [{organizationId: ORG, role: orgRole}] : []});
const now = new Date();
const DAY = 86_400_000;
const planView = (over: Partial<RestorePlanView> = {}): RestorePlanView => ({
    id: PLAN, planHash: "h".repeat(64), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + DAY).toISOString(), freshness: "fresh", outcome: "ready", purpose: "restore", mode: "new_stack",
    stackId: STACK, targetAgentId: AGENT, totals: {artifacts: 3, actions: 2, plaintextBytes: 2 * 1024 * 1024},
    rp: {id: "0b7e1c1e-7f3a-4b6e-9a40-333333333333", sequence: 8, verifiedAt: now.toISOString()},
    target: {agentName: "clean-host", hostRole: "production", hostRoleSource: "default", project: "notes", restoreRoot: "/srv/restore"},
    actions: [
        {id: "a0123456789ab", order: 1, phase: "data", kind: "restore_volume", op: "create", risk: "safe", destructive: false, resource_key: "volume:data", artifact_ids: [], expect: {plaintext_sha256: null, plaintext_size: null},
            source: {role: "volume", dbms: "docker-volume", member: "volume_data", original_path: CANARY_PATH, service: null}, destination: {kind: "volume", name: "notes_data", path: `${CANARY_PATH}/d`, relative_path: "notes/data"}, reasons: []},
        {id: "a0123456789ac", order: 2, phase: "start", kind: "compose_up", op: "create", risk: "safe", destructive: false, resource_key: null, artifact_ids: [], expect: {plaintext_sha256: null, plaintext_size: null},
            source: {role: null, dbms: null, member: null, original_path: null, service: null}, destination: {kind: "project", name: "notes", path: null, relative_path: null}, reasons: []},
    ],
    preconditions: [{code: "free_disk", state: "deferred", checked_by: "agent", reason: null}], approvalsRequired: [{kind: "production_target", capability: "restore.production.approve"}], approvalsGiven: [],
    secrets: [], decisions: [], composeFindings: [{rule_id: "docker_sock", service: "traefik", informational: true}], composeFindingsBasis: "inventory", blockers: [], ...over,
} as RestorePlanView);
const ovView = (missing = 1) => ({applicable: true, reason: null, frozen: false, revision: 0, fields: [{service: "web", key: "SMTP_PASSWORD", origin: "env_file", class: "require_input", isSet: false}], yml: {present: false, bytes: 0}, missingRequired: missing});
const mount = async () => render(await PlanPage({params: Promise.resolve({planId: PLAN})}));
const go = () => screen.getByTestId("go-button");
const typed = (v: string) => fireEvent.change(screen.getByLabelText("Confirmation"), {target: {value: v}});

beforeEach(() => {
    h.principal = P("owner"); h.mode = {mode: "on"}; h.calls.length = 0;
    for (const f of [h.resource, h.view, h.ov, h.runs, h.pts, h.approve, h.create, h.start, h.list, h.push, h.refresh]) f.mockReset();
    h.resource.mockResolvedValue({organizationId: ORG});
    h.view.mockResolvedValue({ok: true, view: planView()});
    h.ov.mockResolvedValue({ok: true, view: ovView(1)});
    h.runs.mockResolvedValue({ok: true, runs: []});
    h.pts.mockResolvedValue({stackName: "notes", timezone: "UTC", points: [{id: "x", sequence: 8, createdAt: new Date(now.getTime() - DAY).toISOString(), verifiedAt: null, status: "verified", reason: null, consistency: "mixed", sizeBytes: null, destinations: []}]});
    h.approve.mockResolvedValue({data: {ok: true}});
    h.start.mockResolvedValue({data: {ok: true, runId: RUN}});
});
afterEach(cleanup);

describe("W18b plan page (Screens 4 + 5)", () => {
    it("shows the summary, every DD-5 item kind with its chip + sentence, the grouped actions with relative destinations, the size line and the deferred checks; axe clean; ONE status region", async () => {
        h.view.mockResolvedValue({ok: true, view: planView({blockers: ["project_name_conflict"], decisions: [{code: "project_name_conflict", subject: "notes", suggestion: "notes-restored"}]})});
        const {container} = await mount();
        expect(screen.getByTestId("plan-summary").textContent).toContain("notes");
        expect(screen.getByTestId("plan-summary").textContent).toContain("clean-host");
        const kinds = screen.getAllByTestId("plan-item").map((e) => e.getAttribute("data-kind"));
        expect(kinds).toEqual(["blocked", "needs_confirmation", "will_ask", "values_missing"]);
        const items = screen.getByTestId("plan-items").textContent!;
        expect(items).toContain(PLAN_REASON_TEXT.project_name_conflict({machine: "clean-host", name: "notes"}));
        expect(items).toContain(RECOVERY.item.blocked); expect(items).toContain(RECOVERY.item.needsConfirm); expect(items).toContain(RECOVERY.item.willAsk); expect(items).toContain("1 value missing");
        expect(items).toContain(RULE_TEXT.docker_sock("traefik"));
        expect(screen.getByRole("button", {name: RECOVERY.plan.useName("notes-restored")})).toBeTruthy();
        const what = screen.getByTestId("plan-what").textContent!;
        expect(what).toContain("Volume notes_data"); expect(what).toContain("→ notes/data"); expect(what).toContain("About 2.0 MiB to copy");
        expect(screen.getByTestId("plan-deferred").textContent).toContain("Enough free disk space");
        expect(container.querySelectorAll("[role=status]").length).toBe(1);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("no host path, artifact id or backup internal reaches the rendered HTML (canary path in the plan view)", async () => {
        const {container} = await mount();
        expect(container.innerHTML).not.toContain("CANARY_PATH");
        expect(container.innerHTML).not.toContain("original_path");
        expect(container.innerHTML).not.toContain("h".repeat(64)); // the plan hash is never rendered (OD-W18D-9)
    });
    it("m2 Go disabled reasons: blocked, stale, expired, member, admin on production (R-prod), missing values until ticked; each with a VISIBLE reason", async () => {
        h.view.mockResolvedValue({ok: true, view: planView({outcome: "blocked", blockers: ["insufficient_disk"]})});
        let r = await mount(); expect(go().getAttribute("aria-disabled")).toBe("true"); expect(r.container.textContent).toContain(RECOVERY.plan.blockedGo); r.unmount();
        h.view.mockResolvedValue({ok: true, view: planView({freshness: "stale"})});
        r = await mount(); expect(go().getAttribute("aria-disabled")).toBe("true"); expect(screen.getByTestId("plan-stale").textContent).toContain(RECOVERY.plan.stale); expect(screen.getByRole("link", {name: RECOVERY.plan.makeNew}).getAttribute("href")).toBe(`/dashboard/recovery/new?step=machine&stack=${STACK}&point=8&machine=${AGENT}`); r.unmount();
        h.view.mockResolvedValue({ok: true, view: planView({freshness: "expired"})});
        r = await mount(); expect(screen.getByTestId("plan-stale").textContent).toContain(RECOVERY.plan.expired); r.unmount();
        h.view.mockResolvedValue({ok: true, view: planView()});
        h.principal = P("admin"); r = await mount(); expect(go().getAttribute("aria-disabled")).toBe("true"); expect(r.container.textContent).toContain(R_PROD); r.unmount();
        h.principal = P("member"); r = await mount(); expect(go().getAttribute("aria-disabled")).toBe("true"); expect(r.container.textContent).toContain(R_ROLE); r.unmount();
        h.principal = P("owner"); r = await mount();
        expect(go().getAttribute("aria-disabled")).toBe("true"); expect(r.container.textContent).toContain(RECOVERY.go.acceptMissing);
        fireEvent.click(screen.getByRole("checkbox")); expect(go().getAttribute("aria-disabled")).toBeNull();
    });
    it("m3/m4 production Go: typed confirm gates; approve THEN start; the TYPED text is sent as confirm; acceptMissingInputs only when ticked; ok ⇒ run page", async () => {
        await mount();
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(go());
        const dlg = screen.getByRole("alertdialog");
        expect(dlg.textContent).toContain("RESTORE notes");
        typed("restore notes"); fireEvent.click(screen.getByRole("button", {name: RECOVERY.go.prodConfirm("clean-host")}));
        expect(h.start).not.toHaveBeenCalled(); expect(h.approve).not.toHaveBeenCalled();
        typed("RESTORE notes"); fireEvent.click(screen.getByRole("button", {name: RECOVERY.go.prodConfirm("clean-host")}));
        await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/dashboard/recovery/runs/${RUN}`));
        expect(h.calls).toEqual(["approve", "start"]);
        expect(h.approve).toHaveBeenCalledWith({planId: PLAN, planHash: "h".repeat(64), kind: "production_target"});
        expect(h.start).toHaveBeenCalledWith({planId: PLAN, planHash: "h".repeat(64), confirm: "RESTORE notes", acceptMissingInputs: true});
    });
    it("an already-approved plan is not approved again; acceptMissingInputs is omitted when the box is not ticked (no missing values)", async () => {
        h.view.mockResolvedValue({ok: true, view: planView({approvalsGiven: [{kind: "production_target", approvedAt: now.toISOString()}]})});
        h.ov.mockResolvedValue({ok: true, view: ovView(0)});
        await mount();
        fireEvent.click(go()); typed("RESTORE notes"); fireEvent.click(screen.getByRole("button", {name: RECOVERY.go.prodConfirm("clean-host")}));
        await waitFor(() => expect(h.start).toHaveBeenCalled());
        expect(h.calls).toEqual(["start"]);
        expect(h.start).toHaveBeenCalledWith({planId: PLAN, planHash: "h".repeat(64), confirm: "RESTORE notes"});
    });
    it("a test machine: plain confirm, no confirm text sent", async () => {
        h.view.mockResolvedValue({ok: true, view: planView({approvalsRequired: [], target: {...planView().target, hostRole: "test", hostRoleSource: "environment"}})});
        h.ov.mockResolvedValue({ok: true, view: ovView(0)});
        h.principal = P("admin");
        await mount();
        fireEvent.click(go());
        expect(screen.queryByLabelText("Confirmation")).toBeNull();
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.go.testConfirm}));
        await waitFor(() => expect(h.start).toHaveBeenCalledWith({planId: PLAN, planHash: "h".repeat(64)}));
    });
    it("an approve refusal stops BEFORE start and shows the sentence; a start refusal shows table G; already_running links to the active run", async () => {
        h.ov.mockResolvedValue({ok: true, view: ovView(0)});
        h.approve.mockResolvedValue({data: {ok: false, code: "stale"}});
        await mount();
        fireEvent.click(go()); typed("RESTORE notes"); fireEvent.click(screen.getByRole("button", {name: RECOVERY.go.prodConfirm("clean-host")}));
        await waitFor(() => expect(screen.getByTestId("go-error").textContent).toContain("Something changed since this plan was made"));
        expect(h.start).not.toHaveBeenCalled(); expect(h.refresh).toHaveBeenCalled();
        cleanup(); h.approve.mockResolvedValue({data: {ok: true}}); h.start.mockResolvedValue({data: {ok: false, code: "already_running"}});
        h.list.mockResolvedValue({data: {ok: true, runs: [{id: RUN, state: "running", targetAgentName: "clean-host"}]}});
        await mount();
        fireEvent.click(go()); typed("RESTORE notes"); fireEvent.click(screen.getByRole("button", {name: RECOVERY.go.prodConfirm("clean-host")}));
        await waitFor(() => expect(screen.getByTestId("go-error").textContent).toContain("Another restore is already running on clean-host"));
        expect(screen.getByRole("link", {name: RECOVERY.go.openActive}).getAttribute("href")).toBe(`/dashboard/recovery/runs/${RUN}`);
        expect(h.push).not.toHaveBeenCalled();
    });
    it("a server failure on start is a closed message, never a raw error; the confirmation_mismatch sentence names the phrase", async () => {
        h.ov.mockResolvedValue({ok: true, view: ovView(0)});
        h.start.mockResolvedValue({data: {ok: false, code: "confirmation_mismatch"}});
        const r = await mount();
        fireEvent.click(go()); typed("RESTORE notes"); fireEvent.click(screen.getByRole("button", {name: RECOVERY.go.prodConfirm("clean-host")}));
        await waitFor(() => expect(screen.getByTestId("go-error").textContent).toContain("Type RESTORE notes exactly."));
        expect(r.container.textContent).not.toContain("confirmation_mismatch");
    });
    it("already used: banner + link to the run, Go section is not rendered", async () => {
        h.runs.mockResolvedValue({ok: true, runs: [{id: RUN, stackId: STACK, state: "failed"}]});
        await mount();
        expect(screen.getByTestId("plan-used").textContent).toContain(RECOVERY.plan.used);
        expect(screen.queryByTestId("go")).toBeNull();
    });
    it("overrides view rate-limited: the honest sentence replaces the panel; the view's missing-value count is then unknown (Go stays guarded by the server)", async () => {
        h.ov.mockResolvedValue({ok: false, code: "rate_limited"});
        const {container} = await mount();
        fireEvent.click(screen.getByTestId("values-toggle"));
        expect(container.textContent).toContain(RECOVERY.plan.valuesRateLimited);
    });
    it("keyboard: Continue moves focus to the Go heading; the typed confirm is reachable and Escape returns focus to the Go button", async () => {
        h.ov.mockResolvedValue({ok: true, view: ovView(0)});
        await mount();
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.plan.continue}));
        expect(document.activeElement?.id).toBe("go-h");
        const b = go(); b.focus(); fireEvent.click(b);
        await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
        fireEvent.keyDown(screen.getByRole("alertdialog"), {key: "Escape"});
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(go()));
    });
    it("page states: tampered plan ⇒ alert; foreign / missing / malformed id ⇒ not found; flag off ⇒ not found; member of another org ⇒ R-role notice", async () => {
        h.view.mockResolvedValue({ok: false, code: "plan_tampered"});
        let r = await mount(); expect(screen.getByTestId("plan-tampered").textContent).toContain(RECOVERY.plan.tampered); r.unmount();
        h.resource.mockRejectedValue(Object.assign(new Error("x"), {name: "ForkNotFoundError"}));
        const {ForkNotFoundError, ForkForbiddenError} = await import("@/fork/acl");
        h.resource.mockRejectedValue(new ForkNotFoundError());
        await expect(mount()).rejects.toThrow("NEXT_NOT_FOUND");
        await expect(PlanPage({params: Promise.resolve({planId: "nope"})})).rejects.toThrow("NEXT_NOT_FOUND");
        h.resource.mockRejectedValue(new ForkForbiddenError("restore.plan"));
        r = await mount(); expect(screen.getByTestId("unauthorized").textContent).toContain(R_ROLE); r.unmount();
        h.mode = {mode: "off"}; await expect(mount()).rejects.toThrow("NEXT_NOT_FOUND");
    });
});
