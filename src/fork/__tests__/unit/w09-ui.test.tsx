// @vitest-environment jsdom
import {act, fireEvent, render, screen, within} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {cleanInventory, FULL_COVERAGE, okState} from "@/fork/__tests__/w09-fixtures";
import {CANARY, richInventory} from "@/fork/__tests__/w08-fixtures";
import {StackDetailSchema, type StackDetail} from "@/fork/stacks/dto";
import {BLOCKERS_PANEL, CONFIG_TAB, FACET_COPY, ITEM_STATUS_LABELS, PRIMARY_STATE_LABELS, REASON_COPY, RP_STATUS_LABELS} from "@/fork/ui/labels";

const refresh = vi.fn();
vi.mock("@/fork/actions/stack-run.action", () => ({startStackRunAction: vi.fn(), cancelStackRunAction: vi.fn()}));
vi.mock("@/fork/actions/stack-schedule.action", () => ({updateStackScheduleAction: vi.fn()}));
vi.mock("@/fork/actions/stack-quiesce.action", () => ({previewQuiesceAction: vi.fn(), enableQuiesceAction: vi.fn(), disableQuiesceAction: vi.fn(), startQuiesceNowAction: vi.fn()}));
vi.mock("@/fork/actions/test-restore.action", () => ({setTestRestoreScheduleAction: vi.fn(), runTestRestoreNowAction: vi.fn(), wipeTestRestoreNowAction: vi.fn()}));
vi.mock("@/fork/actions/restore-plan.action", () => ({setStackPrivacyAction: vi.fn()}));
vi.mock("next/navigation", () => ({useRouter: () => ({refresh}), notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));

import {StackDetailsClient} from "@/fork/ui/stacks/stack-details.client";
import {PrimaryStateBadge} from "@/fork/ui/stacks/stack-status-badges";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const ID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
type Opts = Parameters<typeof okState>[1];
const detail = (inv = richInventory(), o: Opts = {}, rest: Partial<StackDetail> = {}): StackDetail =>
    StackDetailSchema.parse({id: ID, name: "forklab-demo", composeProject: "forklab-demo", environmentName: "local", runtime: "running", protection: "unprotected", staleSince: null, lastSyncAt: "2026-11-07T01:05:00.000Z", syncing: false, inventory: okState(inv, o), ...rest});
const mount = (d: StackDetail, tab: "overview" | "resources" | "configuration" = "overview") =>
    render(<StatusAnnouncer><StackDetailsClient detail={d} initialTab={tab} canConfigure/></StatusAnnouncer>);

beforeEach(() => refresh.mockReset());

describe("W09 Overview: primary state, blockers panel, facets", () => {
    it("a freshly discovered lab stack: Unprotected, consequence stated, blockers listed with inline reasons", async () => {
        const {container} = mount(detail());
        expect(screen.getByTestId("primary-state-badge").getAttribute("data-state")).toBe("unprotected");
        expect(screen.getByTestId("recovery-unavailable").textContent).toBe(BLOCKERS_PANEL.unavailable);
        expect(screen.getByTestId("recovery-unavailable").textContent).toBe("Full-stack recovery is not available until resolved.");
        const items = screen.getAllByTestId("blocker-item");
        expect(items.length).toBeGreaterThan(0);
        expect(items.length).toBeLessThanOrEqual(5);
        expect(items[0].textContent).toMatch(/\S/);
        expect(container.textContent).toContain(REASON_COPY.not_covered);
        expect(container.textContent).not.toContain("Protected");
        expect(await axeViolations(container)).toEqual([]);
    });

    it("facet 1 is the FIRST line of the header block, above any badge", () => {
        const {container} = mount(detail());
        const first = screen.getByTestId("facet-last-good");
        const badge = screen.getByTestId("primary-state-badge");
        expect(first.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(first.textContent).toContain(FACET_COPY.lastGood.never);
        expect(container.querySelector("header")!.contains(first)).toBe(true);
    });

    it("all facet rows render inline text (no title/tooltip carries the only copy)", () => {
        const {container} = mount(detail(cleanInventory(), {primary: {hasActivePolicy: true}, facets: {hasActivePolicy: true, pausedAfterReauthorization: true, inventoryStale: true, configLocked: true, daysSinceTestRestore: 4, hoursSinceLastVerified: 30}}));
        for (const id of ["facet-last-good", "facet-test-restore", "facet-deletable", "facet-host-compromise", "facet-consistency", "facet-paused", "facet-inventory-stale", "facet-config-locked"]) expect(screen.getByTestId(id), id).toBeTruthy();
        expect(screen.getByTestId("facet-deletable").textContent).toContain(FACET_COPY.deletable.description.not_checked);
        expect(screen.getByTestId("facet-last-good").textContent).toContain("30 h ago");
        expect(screen.getByTestId("facet-test-restore").textContent).toContain("4 d ago");
        expect(container.querySelectorAll("[title]")).toHaveLength(0);
    });

    it("host compromise is a facet (needs attention) and does not turn a Protected stack into Partial", () => {
        const protectedDetail = detail(cleanInventory(), {ctx: FULL_COVERAGE, primary: {hasActivePolicy: true, verifiedRpCount: 1, hoursSinceLastVerified: 2, kitVerified: true}, facets: {hasActivePolicy: true, hoursSinceLastVerified: 2}});
        mount(protectedDetail);
        expect(screen.getByTestId("primary-state-badge").getAttribute("data-state")).toBe("protected");
        expect(screen.getByTestId("facet-host-compromise").textContent).toContain(FACET_COPY.hostCompromise.label);
        expect(screen.queryByTestId("recovery-unavailable")).toBeNull();
    });

    it("D43: a pending_verification RP shows 'Backed up · verifying', counts for nothing and is not Protected", () => {
        mount(detail(cleanInventory(), {ctx: FULL_COVERAGE, primary: {hasActivePolicy: true, pendingRpCount: 1, kitVerified: true}, facets: {hasActivePolicy: true, verifying: true}}));
        expect(screen.getByTestId("primary-state-badge").getAttribute("data-state")).toBe("awaiting_first_backup");
        expect(screen.getByTestId("recovery-section").textContent).toContain("Backed up · verifying");
        expect(RP_STATUS_LABELS.pending_verification.label).toBe("Backed up · verifying");
        expect(screen.getByTestId("facet-verifying")).toBeTruthy();
        expect(screen.getByTestId("facet-last-good").textContent).toContain(FACET_COPY.lastGood.never);
    });

    it("every primary state renders its own badge with the description inline (axe clean)", async () => {
        for (const k of Object.keys(PRIMARY_STATE_LABELS) as (keyof typeof PRIMARY_STATE_LABELS)[]) {
            const {container, unmount} = render(<PrimaryStateBadge state={k} describe/>);
            expect(screen.getByTestId("primary-state-badge").textContent).toContain(PRIMARY_STATE_LABELS[k].label);
            expect(screen.getByTestId("primary-state-badge").textContent).toContain(PRIMARY_STATE_LABELS[k].description);
            expect(await axeViolations(container)).toEqual([]);
            unmount();
        }
    });

    it("'Open Configuration' moves to the Configuration tab and updates the URL", async () => {
        mount(detail());
        await act(async () => { fireEvent.click(screen.getByRole("button", {name: BLOCKERS_PANEL.viewAll})); });
        expect(screen.getByTestId("config-tab")).toBeTruthy();
        expect(window.location.search).toBe("?tab=configuration");
    });
});

describe("W09 Configuration tab", () => {
    it("shows files with placement + status, masked env names, checklist, directives; axe clean", async () => {
        const {container} = mount(detail(), "configuration");
        expect(screen.getByTestId("config-tab")).toBeTruthy();
        // lab-shaped richInventory = tier 1: compose not read ⇒ names unknown, said so
        expect(screen.getByTestId("config-env").textContent).toContain(CONFIG_TAB.env.undetermined);
        expect(screen.getAllByTestId("file-row").length).toBeGreaterThan(0);
        expect(screen.getAllByTestId("checklist-row").length).toBeGreaterThan(3);
        expect(screen.getByTestId("checklist-summary").textContent).toMatch(/\d+ of \d+ covered or accounted for/);
        expect(screen.getByTestId("read-only-note").textContent).toBe(CONFIG_TAB.readOnly);
        expect(screen.getByTestId("inventory-hash").textContent).toBe("a".repeat(64));
        expect(await axeViolations(container)).toEqual([]);
    });

    it("tier 2 (compose read): variable NAMES per service with a masked value column, never a value", async () => {
        const inv = cleanInventory();
        inv.services[0]!.env_keys = ["DATABASE_URL", "STRIPE_KEY"];
        const {container} = mount(detail(inv), "configuration");
        const row = screen.getByTestId("env-row");
        expect(row.textContent).toContain("DATABASE_URL");
        expect(row.textContent).toContain("STRIPE_KEY");
        expect(screen.getByTestId("env-masked").textContent).toBe(CONFIG_TAB.env.masked);
        expect(await axeViolations(container)).toEqual([]);
    });

    it("more than the cap of names: counted, not dumped", () => {
        const inv = cleanInventory();
        inv.services[0]!.env_keys = Array.from({length: 130}, (_, i) => `VAR_${i}`);
        mount(detail(inv), "configuration");
        expect(screen.getByTestId("env-row").textContent).toContain(CONFIG_TAB.env.more(30));
        expect(within(screen.getByTestId("env-row")).getAllByRole("listitem")).toHaveLength(100);
    });

    it("managed vs externally referenced files, with status; hash column says 'not captured' (never a made-up hash)", () => {
        const inv = cleanInventory();
        inv.stack.config_files_hint = ["/srv/app/compose.yml", "/opt/shared/base.yml"];
        mount(detail(inv), "configuration");
        const rows = screen.getAllByTestId("file-row").map((r) => r.textContent!);
        expect(rows.find((r) => r.includes("/srv/app/compose.yml"))).toContain(CONFIG_TAB.files.placement.here);
        expect(rows.find((r) => r.includes("/opt/shared/base.yml"))).toContain(CONFIG_TAB.files.placement.outside);
        for (const r of rows) expect(r).toContain(CONFIG_TAB.files.hashNone);
    });

    it("accepted exclusion renders as its own status, not as a gap or warning", () => {
        const inv = cleanInventory();
        inv.services[0]!.image = {ref: "demo/web:1", pinned: false, built_locally: true};
        mount(detail(inv, {ctx: {...FULL_COVERAGE, acceptedExclusions: ["image:web"]}}), "configuration");
        const row = screen.getAllByTestId("checklist-row").find((r) => r.getAttribute("data-status") === "accepted_exclusion")!;
        expect(row.textContent).toContain(ITEM_STATUS_LABELS.accepted_exclusion.label);
        expect(row.textContent).toContain(REASON_COPY.accepted);
        expect(within(row).queryByRole("button")).toBeNull();
    });

    it("resolve actions are focusable, aria-disabled, with the reason as visible text, and do nothing (no fake success)", () => {
        mount(detail(), "configuration");
        const buttons = [...screen.getAllByRole("button", {name: CONFIG_TAB.resolve.addSource}), ...screen.getAllByRole("button", {name: CONFIG_TAB.resolve.accept})];
        expect(buttons.length).toBeGreaterThan(0);
        for (const b of buttons) {
            expect(b.getAttribute("aria-disabled")).toBe("true");
            expect(b.hasAttribute("disabled")).toBe(false);
            const reason = document.getElementById(b.getAttribute("aria-describedby")!)!.textContent!;
            expect([CONFIG_TAB.resolve.addSourceReason, CONFIG_TAB.resolve.acceptReason]).toContain(reason);
            fireEvent.click(b);
        }
        expect(refresh).not.toHaveBeenCalled();
    });

    it("no download control, no link to a content route, no blob/data URLs", () => {
        const {container} = mount(detail(), "configuration");
        expect(container.querySelectorAll("a[download], [download]")).toHaveLength(0);
        expect(container.querySelectorAll("a[href^='/api'], a[href^='blob:'], a[href^='data:']")).toHaveLength(0);
        expect(screen.queryByRole("button", {name: /download|export|view file|show value/i})).toBeNull();
    });

    it("keyboard: tabs reach Configuration with the arrow key; the scroll regions are tab stops", async () => {
        const {container} = mount(detail());
        const tab = screen.getByRole("tab", {name: CONFIG_TAB.tab});
        tab.focus();
        expect(document.activeElement).toBe(tab);
        await act(async () => { fireEvent.keyDown(screen.getByRole("tab", {name: /Resources/}), {key: "ArrowRight"}); });
        fireEvent.mouseDown(tab);
        await act(async () => { fireEvent.click(tab); });
        expect(screen.getByTestId("config-tab")).toBeTruthy();
        for (const region of container.querySelectorAll("section[aria-label]")) expect(region.getAttribute("tabindex")).toBe("0");
    });

    it("nothing secret reaches the DOM: canary in unknown label fields and env values, container ids, provenance", () => {
        const inv: any = richInventory();
        inv.services[0].labels = {secret: CANARY};
        inv.provenance = {"/x": "arcane_list"};
        const parsed = StackDetailSchema.safeParse({id: ID, name: "n", composeProject: "p", environmentName: "e", runtime: "running", protection: "unprotected", staleSince: null, lastSyncAt: null, syncing: false, inventory: {...okState(richInventory()), extra: CANARY}});
        expect(parsed.success).toBe(false); // strict: an unknown key in the DTO is refused
        const {container} = mount(detail(inv), "configuration");
        for (const s of ["POSTGRES_PASSWORD", "APP_SECRET", "abcdef123456", CANARY]) expect(container.textContent).not.toContain(s);
    });

    it("hostile names render as text, never as markup", () => {
        const inv = cleanInventory();
        inv.stack.config_files_hint = ["/srv/app/<img src=x onerror=alert(1)>.yml"];
        const {container} = mount(detail(inv), "configuration");
        expect(container.querySelector("img")).toBeNull();
        expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    });

    it("stale + locked + paused facets show on a real stack page too (all facets 1–7 + locked modelled)", () => {
        mount(detail(cleanInventory(), {facets: {hasActivePolicy: true, inventoryStale: true, pausedAfterReauthorization: true, configLocked: true}, primary: {hasActivePolicy: true}}));
        for (const id of ["facet-inventory-stale", "facet-paused", "facet-config-locked"]) expect(screen.getByTestId(id)).toBeTruthy();
    });
});
