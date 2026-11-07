// @vitest-environment jsdom
import {act, fireEvent, render, screen, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {CANARY, richInventory} from "@/fork/__tests__/w08-fixtures";
import {DEFAULT_PARAMS, parseStackListParams} from "@/fork/stacks/params";
import {StackDetailSchema, StackListSchema, toInventoryView, type StackDetail, type StackList} from "@/fork/stacks/dto";
import {PROTECTION_LABELS, RUNTIME_LABELS, STACK_DETAILS, STACKS_EMPTY, STACKS_PAGE, STALE_BANNER} from "@/fork/ui/labels";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({useRouter: () => ({refresh}), notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));

import {StackDetailsClient} from "@/fork/ui/stacks/stack-details.client";
import {StackListView} from "@/fork/ui/stacks/stack-list";
import {POLL_MS} from "@/fork/ui/stacks/sync-poller";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const ID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const item = (o: Partial<StackList["items"][number]> = {}): StackList["items"][number] => ({
    id: ID, name: "forklab-demo", composeProject: "forklab-demo", environmentName: "local", runtime: "running", protection: "unprotected", staleSince: null, updatedAt: "2026-11-07T01:00:00.000Z",
    inventory: {version: 1, capturedAt: "2026-11-07T01:00:05.000Z", counts: {services: 2, volumes: 2, binds: 1, networks: 2, databases: 1, shared: 1}}, ...o,
});
const list = (o: Partial<StackList> = {}): StackList => StackListSchema.parse({
    items: [item()], total: 1, page: 1, pageSize: 25, summary: {total: 1, unprotected: 1, staleOrGone: 0}, environments: ["local"], syncing: false, circuitOpen: false, setup: {connected: true, enabledEnvironments: 1}, ...o,
});
const mountList = (l: StackList, o: {admin?: boolean; params?: Record<string, string>} = {}) =>
    render(<StatusAnnouncer><StackListView list={l} params={parseStackListParams(o.params ?? {})} isAdmin={o.admin ?? false}/></StatusAnnouncer>);

const detail = (o: Partial<StackDetail> & {inv?: Parameters<typeof richInventory>[0]} = {}): StackDetail => {
    const view = toInventoryView(richInventory(o.inv), {version: 2, capturedAt: new Date("2026-11-07T01:00:05Z")})!;
    const {inv: _i, ...rest} = o;
    return StackDetailSchema.parse({id: ID, name: "forklab-demo", composeProject: "forklab-demo", environmentName: "local", runtime: "running", protection: "unprotected", staleSince: null, lastSyncAt: "2026-11-07T01:05:00.000Z", syncing: false, inventory: {state: "ok", view}, ...rest});
};
const mountDetail = (d: StackDetail, o: {tab?: "overview" | "resources"; canConfigure?: boolean} = {}) =>
    render(<StatusAnnouncer><StackDetailsClient detail={d} initialTab={o.tab ?? "overview"} canConfigure={o.canConfigure ?? true}/></StatusAnnouncer>);

beforeEach(() => refresh.mockReset());
afterEach(() => vi.useRealTimers());

describe("W08 list: rows, badges, honesty", () => {
    it("renders the table from the DTO with runtime and protection as independent badges; copy comes from labels.ts", async () => {
        const {container} = mountList(list());
        const row = screen.getByTestId("stack-row");
        expect(within(row).getByRole("link", {name: /forklab-demo/}).getAttribute("href")).toBe(`/dashboard/stacks/${ID}`);
        expect(within(row).getByTestId("runtime-badge").textContent).toContain(RUNTIME_LABELS.running.label);
        expect(within(row).getByTestId("protection-badge").textContent).toContain(PROTECTION_LABELS.unprotected.label);
        expect(row.textContent).toContain("2 services");
        expect(row.textContent).toContain("1 bind mounts");
        expect(row.textContent).toContain("1 shared");
        expect(row.textContent).toContain(STACKS_PAGE.noRecoveryPoint);
        expect(screen.getByText(STACKS_PAGE.sourceNote)).toBeTruthy();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("never claims protection it does not have: no 'protected', 'backed up', 'verified', 'safe' wording on an unprotected list", () => {
        const {container} = mountList(list());
        expect(container.textContent).not.toMatch(/\b(backed up|verified|restore-tested|safe|healthy)\b/i);
        expect(container.textContent).not.toMatch(/(?<!un)protected\b/i);
    });
    it("a stack that is gone says so (not 'stale'); a stale one carries the stale badge; both raise the banner", async () => {
        const {container} = mountList(list({
            items: [item({id: "1b7e1c1e-7f3a-4b6e-9a40-111111111111", name: "gone", composeProject: "gone", runtime: "absent"}), item({id: "2b7e1c1e-7f3a-4b6e-9a40-111111111111", name: "old", composeProject: "old", runtime: "partial", staleSince: "2026-11-07T00:00:00.000Z"})],
            total: 2, summary: {total: 2, unprotected: 2, staleOrGone: 2},
        }), {admin: true});
        const rows = screen.getAllByTestId("stack-row");
        expect(rows[0].textContent).toContain(RUNTIME_LABELS.absent.label);
        expect(rows[0].textContent).not.toContain("Stale");
        expect(rows[1].textContent).toContain("Stale");
        expect(screen.getByTestId("stale-banner").textContent).toContain(STALE_BANNER.body(2));
        expect(screen.getByRole("link", {name: STALE_BANNER.link}).getAttribute("href")).toBe("/dashboard/integrations");
        expect(await axeViolations(container)).toEqual([]);
    });
    it("a member does not get the integration link in the stale banner", () => {
        mountList(list({items: [item({staleSince: "2026-11-07T00:00:00.000Z"})], summary: {total: 1, unprotected: 1, staleOrGone: 1}}), {admin: false});
        expect(screen.queryByRole("link", {name: STALE_BANNER.link})).toBeNull();
    });
    it("hostile names render as text, never as markup", () => {
        const {container} = mountList(list({items: [item({name: `<img src=x onerror=alert(1)>`, composeProject: "x", environmentName: `<script>alert(1)</script>`})]}));
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("script")).toBeNull();
        expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    });
    it("a stack with no inventory row says so instead of showing zeros", () => {
        mountList(list({items: [item({inventory: null})]}));
        expect(screen.getByTestId("stack-row").textContent).toContain(STACKS_EMPTY.noInventory.title);
    });
});

describe("W08 list: filters, pagination", () => {
    it("filters are a labelled GET form (works without JS), defaults reflect the URL, clear link only when filtered", async () => {
        const {container} = mountList(list(), {params: {q: "demo", runtime: "running", sort: "attention", environment: "local"}});
        const form = container.querySelector("form")!;
        expect(form.getAttribute("method")).toBe("get");
        expect(form.getAttribute("action")).toBe("/dashboard/stacks");
        expect((screen.getByLabelText(STACKS_PAGE.searchLabel) as HTMLInputElement).value).toBe("demo");
        expect((screen.getByLabelText(STACKS_PAGE.runtimeLabel) as HTMLSelectElement).value).toBe("running");
        expect((screen.getByLabelText(STACKS_PAGE.sortLabel) as HTMLSelectElement).value).toBe("attention");
        expect((screen.getByLabelText(STACKS_PAGE.environmentLabel) as HTMLSelectElement).value).toBe("local");
        expect(screen.getByRole("link", {name: STACKS_PAGE.clear}).getAttribute("href")).toBe("/dashboard/stacks");
        expect(await axeViolations(container)).toEqual([]);
        // unfiltered: no clear link
        document.body.innerHTML = "";
        mountList(list());
        expect(screen.queryByRole("link", {name: STACKS_PAGE.clear})).toBeNull();
    });
    it("filters matching nothing show the filtered empty state with a clear link, not the first-run state", async () => {
        const {container} = mountList(list({items: [], total: 0}), {params: {q: "zzz"}});
        expect(screen.getByTestId("stacks-filtered-empty")).toBeTruthy();
        expect(screen.queryByTestId("stacks-empty")).toBeNull();
        expect(screen.getByTestId("results-count").textContent).toBe(STACKS_PAGE.resultsNone);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("pagination keeps the filters in its links and disables the end links with aria-disabled", () => {
        const items = Array.from({length: 25}, (_, i) => item({id: `${String(i).padStart(8, "0")}-7f3a-4b6e-9a40-111111111111`, name: `s${i}`, composeProject: `s${i}`}));
        mountList(list({items, total: 60, page: 2}), {params: {q: "s", page: "2", sort: "updated"}});
        expect(screen.getByRole("link", {name: STACKS_PAGE.previous}).getAttribute("href")).toBe("/dashboard/stacks?q=s&sort=updated");
        expect(screen.getByRole("link", {name: STACKS_PAGE.next}).getAttribute("href")).toBe("/dashboard/stacks?q=s&sort=updated&page=3");
        expect(screen.getByTestId("results-count").textContent).toBe(STACKS_PAGE.results(26, 50, 60));
    });
    it("the table scrolls inside a focusable labelled region (no page-level horizontal scroll)", () => {
        const {container} = mountList(list());
        const region = container.querySelector('section[aria-label^="Stacks table"]')!;
        expect(region.getAttribute("tabindex")).toBe("0");
        expect(region.className).toContain("overflow-x-auto");
        expect(region.getAttribute("aria-label")).toBeTruthy();
    });
});

describe("W08 list: role-aware empty states (D35)", () => {
    const cases = [
        ["noConnection", {connected: false, enabledEnvironments: 0}],
        ["noEnabledEnvironment", {connected: true, enabledEnvironments: 0}],
        ["noStacks", {connected: true, enabledEnvironments: 2}],
    ] as const;
    for (const [kind, setup] of cases) {
        it(`${kind}: administrator gets the next step + link, member gets a plain explanation without any link; axe clean`, async () => {
            const empty = list({items: [], total: 0, summary: {total: 0, unprotected: 0, staleOrGone: 0}, environments: [], setup});
            const a = mountList(empty, {admin: true});
            expect(screen.getByTestId("stacks-empty").getAttribute("data-kind")).toBe(kind);
            expect(a.container.textContent).toContain(STACKS_EMPTY[kind].admin);
            expect(screen.getByRole("link", {name: STACKS_EMPTY[kind].adminAction}).getAttribute("href")).toBe("/dashboard/integrations");
            expect(await axeViolations(a.container)).toEqual([]);
            a.unmount();
            const m = mountList(empty, {admin: false});
            expect(m.container.textContent).toContain(STACKS_EMPTY[kind].member);
            expect(m.container.textContent).not.toContain(STACKS_EMPTY[kind].admin);
            expect(m.container.querySelector("a")).toBeNull();
            expect(await axeViolations(m.container)).toEqual([]);
        });
    }
});

describe("W08 polling-only progress (UX-13): router.refresh while the server says syncing, one shared status region", () => {
    it("polls every 5 s while a sync holds the lease, announces in the shared role=status region, stops and announces when done", () => {
        vi.useFakeTimers();
        const {rerender} = mountList(list({syncing: true}));
        expect(screen.getByTestId("job-status").textContent).toBe(STACKS_PAGE.syncing);
        expect(refresh).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(POLL_MS); });
        expect(refresh).toHaveBeenCalledTimes(1);
        act(() => { vi.advanceTimersByTime(POLL_MS * 2); });
        expect(refresh).toHaveBeenCalledTimes(3);
        rerender(<StatusAnnouncer><StackListView list={list({syncing: false})} params={DEFAULT_PARAMS} isAdmin={false}/></StatusAnnouncer>);
        expect(screen.getByTestId("job-status").textContent).toBe(STACKS_PAGE.syncingDone);
        act(() => { vi.advanceTimersByTime(POLL_MS * 5); });
        expect(refresh).toHaveBeenCalledTimes(3); // timer cleared
        expect(document.querySelectorAll('[role="status"]').length).toBe(1);
    });
    it("no timer at all when nothing is syncing", () => {
        vi.useFakeTimers();
        mountList(list());
        act(() => { vi.advanceTimersByTime(POLL_MS * 10); });
        expect(refresh).not.toHaveBeenCalled();
        expect(screen.getByTestId("job-status").textContent).toBe("");
    });
});

describe("W08 details: header, actions with visible reasons, tabs", () => {
    it("header: name, environment, last sync (UTC), runtime vs protection with descriptions inline", async () => {
        const {container} = mountDetail(detail());
        expect(screen.getByRole("heading", {level: 1}).textContent).toBe("forklab-demo");
        expect(container.textContent).toContain("Environment:local");
        expect(container.textContent).toMatch(/Last sync:Nov 7, 2026, 1:05 AM UTC/);
        expect(screen.getByTestId("runtime-badge").textContent).toContain(RUNTIME_LABELS.running.description);
        expect(screen.getByTestId("protection-badge").textContent).toContain(PROTECTION_LABELS.unprotected.description);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("all four actions are aria-disabled, focusable, do nothing, and show a visible reason linked by aria-describedby", () => {
        mountDetail(detail(), {canConfigure: true});
        const a = STACK_DETAILS.actions;
        const expected: [string, string][] = [[a.configure.label, a.configure.admin], [a.backupNow.label, a.backupNow.reason], [a.restore.label, a.restore.reason], [a.mirror.label, a.mirror.reason]];
        for (const [label, reason] of expected) {
            const b = screen.getByRole("button", {name: label});
            expect(b.getAttribute("aria-disabled")).toBe("true");
            expect(b.hasAttribute("disabled")).toBe(false);
            const reasonEl = document.getElementById(b.getAttribute("aria-describedby")!)!;
            expect(reasonEl.textContent).toBe(reason);
            fireEvent.click(b);
        }
        expect(refresh).not.toHaveBeenCalled();
    });
    it("Configure's reason is role-aware", () => {
        mountDetail(detail(), {canConfigure: false});
        const b = screen.getByRole("button", {name: STACK_DETAILS.actions.configure.label});
        expect(document.getElementById(b.getAttribute("aria-describedby")!)!.textContent).toBe(STACK_DETAILS.actions.configure.member);
    });
    it("Overview: resource summary, last recovery point '—', blockers placeholder, shared resource flagged (lab_proxy), notes mapped to labels (unknown code → fallback)", async () => {
        const {container} = mountDetail(detail());
        expect(screen.getByTestId("resource-summary").textContent).toContain("2 of 2 running");
        expect(container.textContent).toContain(STACK_DETAILS.overview.noRecovery);
        expect(screen.getByTestId("blockers").textContent).toBe(STACK_DETAILS.overview.blockersNote);
        const shared = screen.getAllByTestId("shared-item");
        expect(shared).toHaveLength(1);
        expect(shared[0].textContent).toContain("lab_proxy");
        expect(screen.getByTestId("warnings").textContent).toContain("shared with other stacks");
        expect(screen.getByTestId("warnings").textContent).toContain("no description in this release");
        expect(screen.getByTestId("warnings").textContent).not.toContain("some-future-code");
        expect(await axeViolations(container)).toEqual([]);
    });
    it("Overview of a stack without shared resources / warnings says so", () => {
        const d = detail();
        if (d.inventory.state === "ok") { d.inventory.view.shared = []; d.inventory.view.warnings = []; }
        mountDetail(d);
        expect(screen.getByTestId("shared-section").textContent).toContain(STACK_DETAILS.overview.sharedNone);
        expect(screen.getByText(STACK_DETAILS.overview.noWarnings)).toBeTruthy();
    });
    it("tabs are real ARIA tabs: arrow keys move between them, the URL follows (no refetch), Resources shows the agent-side note", async () => {
        const spy = vi.spyOn(window.history, "replaceState");
        const {container} = mountDetail(detail());
        const overview = screen.getByRole("tab", {name: STACK_DETAILS.tabs.overview});
        expect(overview.getAttribute("aria-selected")).toBe("true");
        overview.focus();
        fireEvent.keyDown(overview, {key: "ArrowRight"});
        const resources = screen.getByRole("tab", {name: STACK_DETAILS.tabs.resources});
        await vi.waitFor(() => expect(resources.getAttribute("aria-selected")).toBe("true"));
        expect(spy).toHaveBeenCalled();
        expect(String(spy.mock.calls.at(-1)?.[2])).toContain("?tab=resources");
        expect(screen.getByTestId("agent-note").textContent).toBe(STACK_DETAILS.resources.agentNote);
        expect(await axeViolations(container)).toEqual([]);
        spy.mockRestore();
    });
    it("honours the initial tab from the URL", () => {
        mountDetail(detail(), {tab: "resources"});
        expect(screen.getByRole("tab", {name: STACK_DETAILS.tabs.resources}).getAttribute("aria-selected")).toBe("true");
    });
});

describe("W08 details: Resources match the lab-shaped stack (sub-tabs, shared/external markers)", () => {
    const open = async (name: RegExp) => { const t = screen.getByRole("tab", {name}); fireEvent.mouseDown(t); fireEvent.focus(t); fireEvent.keyDown(t, {key: "Enter"}); await vi.waitFor(() => expect(t.getAttribute("aria-selected")).toBe("true")); };
    it("services, volumes (+ anonymous warning), bind mounts, databases, networks — each sub-tab is axe clean", async () => {
        const {container} = mountDetail(detail(), {tab: "resources"});
        // services
        expect(screen.getAllByTestId("service-row").map((r) => r.querySelector("td")!.textContent)).toEqual([expect.stringContaining("db"), expect.stringContaining("web")]);
        expect(screen.getAllByTestId("service-row")[1].textContent).toContain("18080→80/tcp");
        expect(screen.getAllByTestId("service-row")[1].textContent).toContain("built locally");
        expect(screen.getAllByTestId("service-row")[0].textContent).toContain("2 environment variable names");
        expect(await axeViolations(container)).toEqual([]);
        await open(/Named volumes/);
        expect(screen.getAllByTestId("volume-row").map((r) => r.querySelector("td")!.textContent)).toEqual(["forklab-demo_appdata", "forklab-demo_pgdata"]);
        expect(screen.getByTestId("anonymous-row").textContent).toContain("/var/cache");
        expect(screen.getByText(STACK_DETAILS.resources.anonymousWarning)).toBeTruthy();
        expect(await axeViolations(container)).toEqual([]);
        await open(/Bind mounts/);
        expect(screen.getByTestId("bind-row").textContent).toContain("/srv/lab/demo/uploads");
        expect(screen.getByTestId("bind-row").textContent).toContain("Read-only");
        expect(await axeViolations(container)).toEqual([]);
        await open(/Databases/);
        expect(screen.getByTestId("database-row").textContent).toContain("postgresql");
        expect(screen.getByText(STACK_DETAILS.resources.dbNote)).toBeTruthy();
        expect(await axeViolations(container)).toEqual([]);
        await open(/Networks/);
        const nets = screen.getAllByTestId("network-row");
        expect(nets.map((r) => r.querySelector("td")!.textContent)).toEqual(["forklab-demo_internal", "lab_proxy"]);
        expect(nets[0].getAttribute("data-shared")).toBeNull();
        expect(nets[1].getAttribute("data-shared")).toBe("true");
        expect(nets[1].textContent).toContain("Shared");
        expect(nets[1].textContent).toContain("External");
        expect(await axeViolations(container)).toEqual([]);
    });
    it("empty sub-tabs say so", async () => {
        const d = detail();
        if (d.inventory.state === "ok") { d.inventory.view.databases = []; d.inventory.view.binds = []; }
        mountDetail(d, {tab: "resources"});
        await open(/Databases/);
        expect(screen.getByText(STACK_DETAILS.resources.empty.databases)).toBeTruthy();
        await open(/Bind mounts/);
        expect(screen.getByText(STACK_DETAILS.resources.empty.binds)).toBeTruthy();
    });
    it("nothing secret reaches the DOM: no env names, container ids, canary", () => {
        const inv: any = richInventory();
        inv.services[0].image.ref = "ci:tok3n@registry.example.com/db:1";
        const d = StackDetailSchema.parse({...detail(), inventory: {state: "ok", view: toInventoryView(inv, {version: 1, capturedAt: new Date()})}});
        const {container} = mountDetail(d, {tab: "resources"});
        for (const s of ["POSTGRES_PASSWORD", "APP_SECRET", "abcdef123456", "tok3n", CANARY]) expect(container.textContent).not.toContain(s);
    });
});

describe("W08 details: states", () => {
    it("gone: banner with the last-known-inventory warning, runtime badge says 'No longer found', inventory still shown", async () => {
        const {container} = mountDetail(detail({runtime: "absent"}));
        expect(screen.getByTestId("gone-banner").textContent).toContain(STACK_DETAILS.goneBanner.title);
        expect(screen.getByTestId("runtime-badge").textContent).toContain(RUNTIME_LABELS.absent.label);
        expect(screen.getByRole("tab", {name: STACK_DETAILS.tabs.overview})).toBeTruthy();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("stale: banner states the capture time; stale badge shown next to the (independent) runtime badge", async () => {
        const {container} = mountDetail(detail({runtime: "partial", staleSince: "2026-11-07T00:30:00.000Z"}));
        expect(screen.getByTestId("stale-banner").textContent).toContain("Nov 7, 2026, 1:00 AM UTC");
        expect(container.textContent).toContain("Stale");
        expect(container.textContent).toContain(RUNTIME_LABELS.partial.label);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("unreadable inventory and no inventory: honest panels, no tabs, no crash", async () => {
        const u = mountDetail(StackDetailSchema.parse({...detail(), inventory: {state: "unreadable"}}));
        expect(screen.getByTestId("unreadable").textContent).toContain(STACKS_EMPTY.notReadable.title);
        expect(screen.queryByRole("tab")).toBeNull();
        expect(await axeViolations(u.container)).toEqual([]);
        u.unmount();
        const n = mountDetail(StackDetailSchema.parse({...detail(), inventory: {state: "none"}}));
        expect(screen.getByTestId("no-inventory").textContent).toContain(STACKS_EMPTY.noInventory.title);
        expect(await axeViolations(n.container)).toEqual([]);
    });
    it("syncing: polls from server state and announces in the one shared status region", () => {
        vi.useFakeTimers();
        mountDetail(detail({syncing: true}));
        expect(screen.getByTestId("job-status").textContent).toBe(STACKS_PAGE.syncing);
        act(() => { vi.advanceTimersByTime(POLL_MS); });
        expect(refresh).toHaveBeenCalledTimes(1);
    });
});
