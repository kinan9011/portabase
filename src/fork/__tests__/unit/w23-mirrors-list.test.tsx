// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {MirrorListRow} from "@/fork/mirror/list-view";
import {MIRROR_REFUSAL_TEXT, MIRRORS} from "@/fork/ui/mirrors/labels";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const h = vi.hoisted(() => ({del: vi.fn(), refresh: vi.fn()}));
vi.mock("@/fork/actions/mirror.action", () => ({deleteMirrorAction: h.del}));
vi.mock("next/navigation", () => ({useRouter: () => ({refresh: h.refresh, push: vi.fn()}), usePathname: () => "/dashboard/mirrors"}));

import {MirrorList, type MirrorListProps} from "@/fork/ui/mirrors/list/list.client";

const SID = "0b7e1c1e-7f3a-4b6e-9a40-333333333333";
const row = (o: Partial<MirrorListRow> = {}): MirrorListRow => ({
    id: "0b7e1c1e-7f3a-4b6e-9a40-111111111111", name: "shop-3", status: "ready", stack: {id: SID, name: "Shop"}, runnerName: "lab-runner", activeSeq: 1, rpSequence: 3, rpCreatedAt: "2026-11-01T10:00:00.000Z",
    health: "healthy", checkedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), hostPort: 41000, latest: {seq: 1, state: "ready", reason: null}, alert: false, updatedAt: new Date().toISOString(), ...o,
});
const props = (rows: MirrorListRow[], o: Partial<MirrorListProps> = {}): MirrorListProps => ({rows, canManage: true, locked: false, flagOn: true, now: new Date().toISOString(), ...o});
const mount = (p: MirrorListProps) => render(<StatusAnnouncer><MirrorList {...p}/></StatusAnnouncer>);
beforeEach(() => { h.del.mockReset(); h.refresh.mockReset(); });
afterEach(() => cleanup());

describe("empty / member / banner", () => {
    it("manager sees the next step and a link; member sees only a plain sentence; both see the privacy banner; axe clean", async () => {
        const m = mount(props([]));
        expect(screen.getByTestId("mirrors-empty").textContent).toContain(MIRRORS.list.empty.title);
        expect(screen.getByRole("link", {name: MIRRORS.list.empty.link}).getAttribute("href")).toBe("/dashboard/stacks");
        expect(screen.getByTestId("privacy-banner").textContent).toBe(MIRRORS.list.banner);
        expect(await axeViolations(m.container)).toEqual([]);
        cleanup();
        const mem = mount(props([], {canManage: false}));
        expect(screen.queryByRole("link", {name: MIRRORS.list.empty.link})).toBeNull();
        expect(screen.getByTestId("mirrors-empty").textContent).not.toContain(MIRRORS.list.empty.manager);
        expect(await axeViolations(mem.container)).toEqual([]);
    });
    it("exactly one role=status region", () => {
        mount(props([row()]));
        expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    });
});

describe("rows", () => {
    const rows = [
        row({id: "a0000000-0000-4000-8000-000000000001", name: "ready-one"}),
        row({id: "a0000000-0000-4000-8000-000000000002", name: "stopped-one", status: "stopped", health: "not_running"}),
        row({id: "a0000000-0000-4000-8000-000000000003", name: "failed-one", status: "failed", health: "failed", activeSeq: null, latest: {seq: 1, state: "failed", reason: "smoke_failed"}, hostPort: null, checkedAt: null}),
        row({id: "a0000000-0000-4000-8000-000000000004", name: "creating-one", status: "creating", health: "pending", activeSeq: null, latest: {seq: 1, state: "staging", reason: null}, checkedAt: null}),
        row({id: "a0000000-0000-4000-8000-000000000005", name: "degraded-one", health: "degraded", alert: true, latest: {seq: 2, state: "failed", reason: "smoke_failed"}}),
    ];
    it("every status and health text is visible, health says 'at last check', counts add up, the failed newer revision is inline text", async () => {
        const {container} = mount(props(rows));
        const table = within(screen.getByTestId("mirror-table"));
        for (const t of ["Ready", "Needs attention", "Creating"]) expect(table.getAllByText(t).length).toBeGreaterThan(0);
        for (const t of ["Healthy", "Not running", "Failed", "Checks pending", "Degraded"]) expect(table.getAllByText(t).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/at last check 3 h ago/).length).toBeGreaterThan(0);
        expect(screen.getAllByTestId("mirror-last-failed")).toHaveLength(1); // only the row with a failed newer revision
        const counts = screen.getAllByTestId("mirror-count").map((n) => n.textContent);
        expect(counts).toEqual(["1", "1", "2"]); // healthy 1 · stopped 1 · attention = the failed row + the degraded row (which also has the failed newer revision)
        expect(await axeViolations(container)).toEqual([]);
    });
    it("names link to the detail page, the stack to the stack page; the table sits in a labelled, focusable scroll region", () => {
        mount(props([row()]));
        expect(screen.getByRole("link", {name: "shop-3"}).getAttribute("href")).toBe("/dashboard/mirrors/0b7e1c1e-7f3a-4b6e-9a40-111111111111");
        expect(screen.getByRole("link", {name: "Shop"}).getAttribute("href")).toBe(`/dashboard/stacks/${SID}`);
        const region = screen.getByRole("region", {name: MIRRORS.list.region});
        expect(region.getAttribute("tabindex")).toBe("0");
    });
    it("private access: loopback hint + link for READY rows only, never a tunnel command or ssh string", () => {
        const {container} = mount(props(rows));
        expect(screen.getAllByText(/Loopback only · on lab-runner/).length).toBe(2); // ready-one + degraded-one (status ready)
        expect(container.textContent).not.toMatch(/ssh|127\.0\.0\.1|-L /);
        expect(screen.getAllByRole("link", {name: MIRRORS.list.connect}).length).toBe(2);
    });
    it("no hover-only information: no title attributes anywhere", () => {
        const {container} = mount(props(rows));
        expect(container.querySelector("[title]")).toBeNull();
    });
    it("a member sees the list but no Delete button", () => {
        mount(props(rows, {canManage: false}));
        expect(screen.queryAllByTestId("mirror-delete")).toHaveLength(0);
        expect(screen.getAllByRole("link", {name: /^Open/}).length).toBe(rows.length);
    });
    it("a creating mirror shows Delete blocked with a visible reason (aria-disabled)", () => {
        mount(props([rows[3]!]));
        const b = screen.getByTestId("mirror-delete");
        expect(b.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(MIRRORS.lifecycle.reasons.cancelFirst)).toBeTruthy();
        fireEvent.click(b);
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    it("reload refreshes the server state", () => {
        mount(props([row()]));
        fireEvent.click(screen.getByTestId("mirrors-reload"));
        expect(h.refresh).toHaveBeenCalledTimes(1);
    });
});

describe("Delete by keyboard (typed confirmation = the mirror name)", () => {
    const r = row();
    const open = () => { mount(props([r])); const b = screen.getByTestId("mirror-delete"); b.focus(); fireEvent.click(b); return b; }; // Enter on a focused button fires click
    it("opens, keeps the confirm blocked for a wrong name, calls the action once with the exact name, announces and refreshes", async () => {
        h.del.mockResolvedValue({data: {ok: true}});
        open();
        const dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getByText(MIRRORS.lifecycle.deleteTitle("shop-3"))).toBeTruthy();
        const confirm = within(dialog).getByRole("button", {name: MIRRORS.lifecycle.deleteConfirm});
        const input = within(dialog).getByLabelText(MIRRORS.lifecycle.deleteInput);
        fireEvent.change(input, {target: {value: "shop"}});
        expect(confirm.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(confirm);
        expect(h.del).not.toHaveBeenCalled();
        fireEvent.change(input, {target: {value: "shop-3"}});
        expect(confirm.getAttribute("aria-disabled")).toBe("false");
        fireEvent.click(confirm);
        await waitFor(() => expect(h.del).toHaveBeenCalledTimes(1));
        expect(h.del).toHaveBeenCalledWith({mirrorId: r.id, confirmName: "shop-3"});
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe(MIRRORS.lifecycle.deleted));
        expect(h.refresh).toHaveBeenCalled();
    });
    it("Escape closes without calling the action and returns focus to the Delete button", async () => {
        const b = open();
        await screen.findByRole("alertdialog");
        fireEvent.keyDown(screen.getByRole("alertdialog"), {key: "Escape"});
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(h.del).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(b);
    });
    it.each(Object.keys(MIRROR_REFUSAL_TEXT) as (keyof typeof MIRROR_REFUSAL_TEXT)[])("refusal %s is shown in role=alert", async (code) => {
        h.del.mockResolvedValue({data: {ok: false, code}});
        open();
        const dialog = await screen.findByRole("alertdialog");
        fireEvent.change(within(dialog).getByLabelText(MIRRORS.lifecycle.deleteInput), {target: {value: "shop-3"}});
        fireEvent.click(within(dialog).getByRole("button", {name: MIRRORS.lifecycle.deleteConfirm}));
        const alert = await screen.findByTestId("delete-error");
        expect(alert.getAttribute("role")).toBe("alert");
        expect(alert.textContent).toBe(MIRROR_REFUSAL_TEXT[code]);
        expect(h.refresh).not.toHaveBeenCalled();
    });
    it("a thrown action shows the generic failure; the dialog axe check is clean", async () => {
        h.del.mockRejectedValue(new Error("boom"));
        open();
        const dialog = await screen.findByRole("alertdialog");
        expect(await axeViolations(dialog)).toEqual([]);
        fireEvent.change(within(dialog).getByLabelText(MIRRORS.lifecycle.deleteInput), {target: {value: "shop-3"}});
        fireEvent.click(within(dialog).getByRole("button", {name: MIRRORS.lifecycle.deleteConfirm}));
        expect((await screen.findByTestId("delete-error")).textContent).toBe(MIRRORS.lifecycle.failed);
    });
});
