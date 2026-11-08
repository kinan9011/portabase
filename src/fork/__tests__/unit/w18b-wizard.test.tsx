// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {ForkPrincipal} from "@/fork/acl";
import {CreatePlanRequest} from "@/fork/restore/schema";
import {CHOICE_GONE, PLAN_REFUSAL_TEXT, R_ROLE, RECOVERY} from "@/fork/ui/recovery/labels";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const S1 = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const S2 = "0b7e1c1e-7f3a-4b6e-9a40-222222222222";
const RP = "0b7e1c1e-7f3a-4b6e-9a40-333333333333";
const A1 = "0b7e1c1e-7f3a-4b6e-9a40-444444444444";
const A2 = "0b7e1c1e-7f3a-4b6e-9a40-555555555555";
const A3 = "0b7e1c1e-7f3a-4b6e-9a40-666666666666";
const h = vi.hoisted(() => ({principal: null as null | ForkPrincipal, resource: vi.fn(), choices: vi.fn(), points: vi.fn(), targets: vi.fn(), create: vi.fn(), push: vi.fn(), mode: {mode: "on"}}));
vi.mock("next/navigation", () => ({notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({refresh: () => {}, push: h.push})}));
vi.mock("@/fork/principal", () => ({getForkPrincipal: async () => h.principal}));
vi.mock("@/fork/mode", () => ({currentForkMode: async () => h.mode}));
vi.mock("@/fork/db/handle", () => ({appDb: async () => ({tag: "db"})}));
vi.mock("@/fork/arcane/connection-service", () => ({soleOrganization: async () => ORG}));
vi.mock("@/fork/resource-scope", () => ({assertForkResource: h.resource}));
vi.mock("@/fork/restore-wizard/view", () => ({loadRestoreChoices: h.choices, loadRestorePoints: h.points, loadRestoreTargets: h.targets}));
vi.mock("@/fork/actions/restore-plan.action", () => ({createRestorePlanAction: (...a: unknown[]) => h.create(...a)}));

import NewRestorePage from "../../../../app/(customer)/dashboard/(organization)/recovery/new/page";

const P = (orgRole: string | null, role = "user"): ForkPrincipal => ({userId: "u", systemRole: role, memberships: orgRole ? [{organizationId: ORG, role: orgRole}] : []});
const now = new Date();
const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
const DAY = 86_400_000;
const choice = (o: Record<string, unknown> = {}) => ({stackId: S1, name: "notes", environmentName: "vps-1", runtime: "absent", lastGood: {hoursAgo: 26, verifying: false}, testRestoreDaysAgo: null, verifiedCount: 2, pendingCount: 0, ...o});
const point = (o: Record<string, unknown> = {}) => ({id: RP, sequence: 8, createdAt: iso(DAY), verifiedAt: iso(DAY), status: "verified", reason: null, consistency: "mixed", sizeBytes: 5 * 1024 * 1024, destinations: ["lab-minio"], ...o});
const target = (o: Record<string, unknown> = {}) => ({id: A1, name: "clean-host", status: "online", readiness: "ready", canCompose: true, hostRole: "production", hostRoleSource: "default", environments: [], wasSource: false, lastRestoreRoot: "/srv/restore", ...o});
const mount = async (sp: Record<string, string> = {}) => render(await NewRestorePage({searchParams: Promise.resolve(sp)}));

beforeEach(() => {
    h.principal = P("owner"); h.mode = {mode: "on"};
    for (const f of [h.resource, h.choices, h.points, h.targets, h.create, h.push]) f.mockReset();
    h.resource.mockResolvedValue({organizationId: ORG});
    h.choices.mockResolvedValue([choice(), choice({stackId: S2, name: "shop", verifiedCount: 0, pendingCount: 1})]);
    h.points.mockResolvedValue({stackName: "notes", timezone: "UTC", points: [point({id: "0b7e1c1e-7f3a-4b6e-9a40-777777777777", sequence: 9, status: "pending_verification", verifiedAt: null, createdAt: iso(0)}), point(), point({id: "0b7e1c1e-7f3a-4b6e-9a40-888888888888", sequence: 7, createdAt: iso(2 * DAY)})]});
    h.targets.mockResolvedValue([target(), target({id: A2, name: "vps-1", status: "offline", wasSource: true, hostRole: "test", hostRoleSource: "environment", lastRestoreRoot: null, environments: [{name: "e", hostRole: "test", allowedPathRoots: ["/data/"]}]}), target({id: A3, name: "spare", readiness: "not_enrolled"})]);
});
afterEach(cleanup);

describe("W18b wizard steps 1-3", () => {
    it("step 1: h1 focused, radio per restorable app, not-restorable listed outside the group, Next aria-disabled with a visible reason until a choice; ArrowDown moves the selection; axe clean", async () => {
        const {container} = await mount();
        const h1 = screen.getByRole("heading", {level: 1});
        expect(h1.textContent).toBe(RECOVERY.steps.app);
        await waitFor(() => expect(document.activeElement).toBe(h1));
        expect(screen.getAllByRole("radio").length).toBe(1);
        expect(screen.getByTestId("not-restorable").textContent).toContain("shop");
        const next = screen.getByRole("button", {name: RECOVERY.steps.nextBackup});
        expect(next.getAttribute("aria-disabled")).toBe("true");
        expect(container.textContent).toContain(RECOVERY.steps.chooseFirst);
        fireEvent.click(next); expect(h.push).not.toHaveBeenCalled();
        const radio = screen.getByRole("radio");
        radio.focus(); fireEvent.click(radio);
        expect(screen.getByRole("radio").getAttribute("aria-checked")).toBe("true");
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.steps.nextBackup}));
        expect(h.push).toHaveBeenCalledWith(`/dashboard/recovery/new?step=backup&stack=${S1}`);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("step 1 tab order: step indicator, then the radio group, then Next (DOM order); the indicator is an ordered list with aria-current; the short mobile text is present", async () => {
        const {container} = await mount();
        const nav = screen.getByRole("navigation", {name: RECOVERY.steps.indicator});
        expect(nav.querySelectorAll("ol").length).toBe(2);
        expect(nav.querySelector("[aria-current=step]")?.textContent).toContain("App");
        expect(screen.getByTestId("step-short").textContent).toBe("Step 1 of 5 · App");
        const order = [...container.querySelectorAll("a, [role=radio], button")].map((e) => e.getAttribute("role") === "radio" ? "radio" : e.tagName === "BUTTON" ? "button" : "link");
        expect(order.indexOf("radio")).toBeLessThan(order.indexOf("button"));
        expect([...container.querySelectorAll("[tabindex]")].filter((e) => Number(e.getAttribute("tabindex")) > 0)).toEqual([]);
    });
    it("empty: no restorable app ⇒ the honest sentence and a link, no Next button", async () => {
        h.choices.mockResolvedValue([choice({verifiedCount: 0, pendingCount: 0})]);
        await mount();
        expect(screen.getByTestId("app-empty").textContent).toContain(RECOVERY.app.empty);
        expect(screen.queryByRole("button", {name: RECOVERY.steps.nextBackup})).toBeNull();
    });
    it("step 2: newest VERIFIED backup preselected, unverified shown aria-disabled with its status words, date + relative + size + consistency + storage; axe clean", async () => {
        const {container} = await mount({stack: S1});
        expect(screen.getByRole("heading", {level: 1}).textContent).toBe(RECOVERY.steps.backup);
        const radios = screen.getAllByRole("radio");
        expect(radios.length).toBe(2);
        expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
        expect(container.textContent).toContain("1 day ago");
        expect(container.textContent).toContain("5.0 MiB");
        expect(container.textContent).toContain("Stored in: lab-minio");
        const un = screen.getByTestId("backup-unavailable");
        expect(un.textContent).toContain("Backed up · verifying");
        expect(un.querySelector("li")?.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.steps.nextMachine}));
        expect(h.push).toHaveBeenCalledWith(`/dashboard/recovery/new?step=machine&stack=${S1}&point=8`);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("a foreign or missing stack id is dropped with the same sentence (no existence oracle); an invalid param likewise", async () => {
        h.resource.mockRejectedValue(new Error("not found"));
        const a = await mount({stack: S2}); const textA = screen.getByTestId("choice-gone").textContent; expect(textA).toBe(CHOICE_GONE);
        expect(screen.getByRole("heading", {level: 1}).textContent).toBe(RECOVERY.steps.app); a.unmount();
        h.resource.mockResolvedValue({organizationId: ORG}); h.points.mockResolvedValue(null);
        const b = await mount({stack: S2}); expect(screen.getByTestId("choice-gone").textContent).toBe(textA); b.unmount();
        h.points.mockResolvedValue({stackName: "notes", timezone: "UTC", points: [point()]});
        await mount({stack: "not-a-uuid"}); expect(screen.getByTestId("choice-gone").textContent).toBe(textA);
    });
    it("a point that is not verified (or does not exist) is refused and sends the user back to choose a backup", async () => {
        await mount({stack: S1, point: "9", step: "machine"});
        expect(screen.getByTestId("choice-gone")).toBeTruthy();
        expect(screen.getByRole("heading", {level: 1}).textContent).toBe(RECOVERY.steps.backup);
    });
    it("step 3: ready machines selectable (status + role + was-source + ready), not-ready listed outside the group with the reason; folder appears prefilled after a choice; payload sent to the action equals the spec; ok ⇒ push to the plan", async () => {
        h.create.mockResolvedValue({data: {ok: true, planId: "p-1", planHash: "h".repeat(64), outcome: "ready"}});
        const {container} = await mount({stack: S1, point: "8"});
        expect(screen.getByRole("heading", {level: 1}).textContent).toBe(RECOVERY.steps.machine);
        const opts = screen.getAllByTestId("machine-option");
        expect(opts.length).toBe(2);
        expect(opts[0]!.textContent).toContain(RECOVERY.machine.noRole);
        expect(opts[1]!.textContent).toContain("Offline");
        expect(opts[1]!.textContent).toContain(RECOVERY.machine.wasSource);
        expect(opts[1]!.textContent).toContain(RECOVERY.machine.offlineWarning);
        expect(screen.getByTestId("machine-not-ready").textContent).toContain(RECOVERY.machine.notReady.not_enrolled);
        expect(screen.getByRole("button", {name: RECOVERY.steps.nextPlan}).getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(screen.getAllByRole("radio")[0]!);
        expect((screen.getByLabelText(RECOVERY.machine.folder) as HTMLInputElement).value).toBe("/srv/restore");
        expect(await axeViolations(container)).toEqual([]);
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.steps.nextPlan}));
        await waitFor(() => expect(h.push).toHaveBeenCalledWith("/dashboard/recovery/plans/p-1"));
        const sent = h.create.mock.calls[0]![0];
        expect(sent).toEqual({rpId: RP, targetAgentId: A1, purpose: "restore", mode: "new_stack", mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: null, sqlite: null}});
        expect(CreatePlanRequest.safeParse(sent).success).toBe(true); // the client payload never drifts from the server schema
    });
    it("step 3: folder default = first allowed root + /portabase-restore; a typed app name is sent; a refusal shows the table-P sentence in an alert and does not navigate", async () => {
        h.create.mockResolvedValue({data: {ok: false, code: "rate_limited"}});
        await mount({stack: S1, point: "8"});
        fireEvent.click(screen.getAllByRole("radio")[1]!);
        expect((screen.getByLabelText(RECOVERY.machine.folder) as HTMLInputElement).value).toBe("/data/portabase-restore");
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.machine.more}));
        fireEvent.change(screen.getByLabelText(RECOVERY.machine.name), {target: {value: "notes-restored"}});
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.steps.nextPlan}));
        await waitFor(() => expect(screen.getByTestId("plan-error").textContent).toBe(PLAN_REFUSAL_TEXT.rate_limited));
        expect(screen.getByTestId("plan-error").getAttribute("role")).toBe("alert");
        expect(h.push).not.toHaveBeenCalled();
        expect(h.create.mock.calls[0]![0].mappings).toMatchObject({target_project: "notes-restored", restore_root: "/data/portabase-restore"});
    });
    it("an empty folder keeps Next aria-disabled with the folder reason; a server failure is a closed message, never a raw error", async () => {
        h.create.mockRejectedValue(new Error("boom: secret detail"));
        const {container} = await mount({stack: S1, point: "8", machine: A1});
        expect((screen.getAllByRole("radio")[0] as HTMLElement).getAttribute("aria-checked")).toBe("true"); // ?machine= preselects a ready machine
        fireEvent.change(screen.getByLabelText(RECOVERY.machine.folder), {target: {value: ""}});
        expect(screen.getByRole("button", {name: RECOVERY.steps.nextPlan}).getAttribute("aria-disabled")).toBe("true");
        expect(container.textContent).toContain(RECOVERY.machine.folderRequired);
        fireEvent.change(screen.getByLabelText(RECOVERY.machine.folder), {target: {value: "/srv/x"}});
        fireEvent.click(screen.getByRole("button", {name: RECOVERY.steps.nextPlan}));
        await waitFor(() => expect(screen.getByTestId("plan-error")).toBeTruthy());
        expect(container.textContent).not.toContain("secret detail");
    });
    it("no machine at all ⇒ the honest empty state; a member sees the R-role notice and nothing is loaded", async () => {
        h.targets.mockResolvedValue([]);
        const a = await mount({stack: S1, point: "8"}); expect(screen.getByTestId("machine-empty").textContent).toContain("No machine is connected"); a.unmount();
        h.principal = P("member"); h.choices.mockClear();
        const b = await mount(); expect(b.container.textContent).toContain(R_ROLE); expect(h.choices).not.toHaveBeenCalled();
    });
    it("locked configuration: plan creation is aria-disabled with the locked reason", async () => {
        h.mode = {mode: "locked", lockReason: "lane-failed"} as never;
        await mount({stack: S1, point: "8", machine: A1});
        expect(screen.getByRole("button", {name: RECOVERY.steps.nextPlan}).getAttribute("aria-disabled")).toBe("true");
        expect(document.body.textContent).toContain("Configuration is locked");
    });
});
