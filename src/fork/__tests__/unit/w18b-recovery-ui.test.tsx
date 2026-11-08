// @vitest-environment jsdom
import {cleanup, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {ForkPrincipal} from "@/fork/acl";
import {FACET_COPY} from "@/fork/ui/labels";
import {R_ROLE, RECOVERY} from "@/fork/ui/recovery/labels";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const S1 = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const S2 = "0b7e1c1e-7f3a-4b6e-9a40-222222222222";
const h = vi.hoisted(() => ({principal: null as null | ForkPrincipal, org: "x" as string | null, mode: {mode: "on"} as {mode: string; lockReason?: string}, choices: vi.fn(), runs: vi.fn()}));
vi.mock("next/navigation", () => ({notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({refresh: () => {}, push: () => {}})}));
vi.mock("@/fork/principal", () => ({getForkPrincipal: async () => h.principal}));
vi.mock("@/fork/mode", () => ({currentForkMode: async () => h.mode}));
vi.mock("@/fork/db/handle", () => ({appDb: async () => ({tag: "db"})}));
vi.mock("@/fork/keys", () => ({fileKeyProvider: {}}));
vi.mock("@/utils/get-server-url", () => ({getServerUrl: () => "http://x"}));
vi.mock("@/fork/arcane/connection-service", () => ({soleOrganization: async () => h.org}));
vi.mock("@/fork/restore-wizard/view", () => ({loadRestoreChoices: h.choices}));
vi.mock("@/fork/restore-run/view", () => ({listRestoreRuns: h.runs}));

import RecoveryPage from "../../../../app/(customer)/dashboard/(organization)/recovery/page";

const P = (orgRole: string | null, role = "user"): ForkPrincipal => ({userId: "u", systemRole: role, memberships: orgRole ? [{organizationId: ORG, role: orgRole}] : []});
const now = new Date();
const choice = (o: Record<string, unknown> = {}) => ({stackId: S1, name: "notes", environmentName: "vps-1", runtime: "absent", lastGood: {hoursAgo: 26, verifying: false}, testRestoreDaysAgo: null, verifiedCount: 2, pendingCount: 0, ...o});
const run = (o: Record<string, unknown> = {}) => ({id: "11111111-2222-4333-8444-555555555555", stackId: S1, state: "running", createdAt: new Date(now.getTime() - 3600_000).toISOString(), finishedAt: null, targetAgentName: "clean-host", rpSequence: 3, verification: null, ...o});
const mount = async () => render(await RecoveryPage());

beforeEach(() => {
    h.principal = P("owner"); h.org = ORG; h.mode = {mode: "on"};
    h.choices.mockReset(); h.choices.mockResolvedValue([choice(), choice({stackId: S2, name: "shop", verifiedCount: 0, pendingCount: 1, lastGood: {hoursAgo: null, verifying: true}})]);
    h.runs.mockReset(); h.runs.mockResolvedValue({ok: true, runs: []});
});
afterEach(cleanup);

describe("W18b Screen R (Stack Recovery page)", () => {
    it("admin: title, start link, empty Restores, apps with shared facet labels; restorable first; not-restorable has an aria-disabled action with a visible reason; axe clean", async () => {
        const {container} = await mount();
        expect(screen.getByRole("heading", {level: 1}).textContent).toBe("Stack Recovery");
        expect(screen.getByTestId("recovery-start").getAttribute("href")).toBe("/dashboard/recovery/new");
        expect(screen.getByTestId("restores").textContent).toContain(RECOVERY.page.noRestores);
        const rows = screen.getAllByTestId("app-row");
        expect(rows[0]!.textContent).toContain("notes");
        expect(rows[0]!.textContent).toContain(FACET_COPY.testRestore.never); // "Not tested" comes from the shared labels
        expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe(`/dashboard/recovery/new?stack=${S1}`);
        const shop = rows[1]!.querySelector("button")!;
        expect(shop.getAttribute("aria-disabled")).toBe("true");
        expect(rows[1]!.textContent).toContain("Backed up · verifying");
        expect(container.querySelectorAll("[role=status]").length).toBe(1);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("restores list: active first with a state chip, app name, machine and an Open link", async () => {
        h.runs.mockResolvedValue({ok: true, runs: [run({id: "a".repeat(8) + "-2222-4333-8444-555555555555", state: "succeeded", finishedAt: now.toISOString()}), run({state: "running"})]});
        await mount();
        const rows = screen.getAllByTestId("restore-row");
        expect(rows[0]!.textContent).toContain("Restore in progress");
        expect(rows[1]!.textContent).toContain("Finished");
        expect(rows[0]!.textContent).toContain("notes");
        expect(rows[0]!.textContent).toContain("clean-host");
        expect(rows[0]!.querySelector("a")?.getAttribute("href")).toMatch(/^\/dashboard\/recovery\/runs\//);
    });
    it("member: no Restores section at all and the start control is aria-disabled with the R-role reason", async () => {
        h.principal = P("member");
        const {container} = await mount();
        expect(screen.queryByTestId("restores")).toBeNull();
        expect(h.runs).not.toHaveBeenCalled();
        const start = screen.getByTestId("recovery-start");
        expect(start.getAttribute("aria-disabled")).toBe("true");
        expect(container.textContent).toContain(R_ROLE);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("locked: banner + disabled start with the locked reason; no stacks / nothing verified / load error states are honest", async () => {
        h.mode = {mode: "locked", lockReason: "lane-failed"};
        const {container, unmount} = await mount();
        expect(screen.getByTestId("locked-note").textContent).toContain("Fork configuration locked");
        expect(screen.getByTestId("recovery-start").getAttribute("aria-disabled")).toBe("true");
        expect(container.textContent).toContain(RECOVERY.page.lockedBanner);
        unmount();
        h.mode = {mode: "on"};
        h.choices.mockResolvedValue([]);
        const a = await mount(); expect(a.container.textContent).toContain(RECOVERY.page.noStacks); a.unmount();
        h.choices.mockResolvedValue([choice({verifiedCount: 0, pendingCount: 0})]);
        const b = await mount(); expect(screen.getByTestId("nothing-verified").textContent).toBe(RECOVERY.page.nothingVerified); b.unmount();
        h.choices.mockRejectedValue(new Error("db down"));
        const c = await mount();
        expect(screen.getByTestId("load-error").getAttribute("role")).toBe("alert");
        expect(c.container.textContent).toContain("Nothing was changed");
    });
    it("gates: flag off, no principal, no organization, a non-member ⇒ not found (nothing is loaded)", async () => {
        h.mode = {mode: "off"}; await expect(RecoveryPage()).rejects.toThrow("NEXT_NOT_FOUND");
        h.mode = {mode: "on"}; h.principal = null; await expect(RecoveryPage()).rejects.toThrow("NEXT_NOT_FOUND");
        h.principal = P(null, "user"); await expect(RecoveryPage()).rejects.toThrow("NEXT_NOT_FOUND");
        h.principal = P("owner"); h.org = null; await expect(RecoveryPage()).rejects.toThrow("NEXT_NOT_FOUND");
        expect(h.choices).not.toHaveBeenCalled();
    });
});

import {BackupsTab} from "@/fork/ui/stacks/backups/backups-tab";
describe("W18b entry points", () => {
    const row = (status: string) => ({sequence: 8, createdAt: now.toISOString(), status, reason: null, consistency: "mixed", destinations: [], sizeBytes: null, durationSeconds: null, required: 1, present: 1, inventoryVersion: 1, trigger: null, verifiedAt: null});
    it("Backups tab Restore: a link into the wizard (machine step for a verified selected point, backup step otherwise); a disabled button with the R-role reason for members", () => {
        const view = (st: string) => ({total: 1, shown: 1, timezone: "UTC", rows: [row(st)], detail: {row: row(st), artifacts: []}}) as never;
        const a = render(<BackupsTab stackId={S1} view={view("verified")} runReason={null} canRestore restoreReason={null}/>);
        expect(screen.getByTestId("backups-restore").getAttribute("href")).toBe(`/dashboard/recovery/new?stack=${S1}&point=8&step=machine`); a.unmount();
        const b = render(<BackupsTab stackId={S1} view={view("pending_verification")} runReason={null} canRestore restoreReason={null}/>);
        expect(screen.getByTestId("backups-restore").getAttribute("href")).toBe(`/dashboard/recovery/new?stack=${S1}`); b.unmount();
        const c = render(<BackupsTab stackId={S1} view={view("verified")} runReason={null} canRestore={false} restoreReason={R_ROLE}/>);
        const btn = screen.getByTestId("backups-restore");
        expect(btn.getAttribute("aria-disabled")).toBe("true"); expect(c.container.textContent).toContain(R_ROLE);
    });
});
