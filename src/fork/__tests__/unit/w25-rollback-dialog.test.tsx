// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {extras, NAME, rev, view} from "@/fork/__tests__/w25-fixtures";
import {MIRRORS, retryText} from "@/fork/ui/mirrors/labels";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const h = vi.hoisted(() => ({rollback: vi.fn()}));
vi.mock("@/fork/actions/mirror.action", () => ({rollbackMirrorAction: h.rollback}));

import {RollbackMirrorButton} from "@/fork/ui/mirrors/rollback/rollback-dialog.client";

const B = MIRRORS.rollback;
const now = new Date();
const v2 = () => view(now, {revisions: [rev(now, {id: "r3", seq: 3, rpSequence: 5}), rev(now, {id: "r2", seq: 2, rpSequence: 4}), rev(now, {id: "r1", seq: 1, rpSequence: 3})], active: "r3"});
const mountBtn = (o: {onDone?: () => void; action?: object; v?: ReturnType<typeof view>} = {}) => render(
    <StatusAnnouncer><RollbackMirrorButton view={o.v ?? view(now)} rpDates={extras(now).rpDates} memBytes={1073741824} action={(o.action ?? {enabled: true}) as never} onDone={o.onDone}/></StatusAnnouncer>);
const open = async () => { fireEvent.click(screen.getByTestId("mirror-rollback")); await screen.findByTestId("rollback-dialog"); };
const confirm = () => screen.getByTestId("rollback-confirm");
const type = (v: string) => fireEvent.change(screen.getByLabelText(new RegExp(B.input)), {target: {value: v}});

beforeEach(() => { h.rollback.mockReset(); });
afterEach(() => cleanup());

describe("Rollback dialog", () => {
    it("a blocked action is a visible reason and never opens a dialog", () => {
        mountBtn({action: {reason: MIRRORS.refresh.reasons.noTarget}});
        expect(screen.getByTestId("mirror-rollback").getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(MIRRORS.refresh.reasons.noTarget)).toBeTruthy();
        fireEvent.click(screen.getByTestId("mirror-rollback"));
        expect(screen.queryByTestId("rollback-dialog")).toBeNull();
    });
    it("opens with the newest target pre-selected; rows: impact, capacity, lost, checks; no privacy checkbox; tunnel note", async () => {
        mountBtn({v: v2()});
        await open();
        const radios = within(screen.getByTestId("rollback-rev")).getAllByRole("radio");
        expect(radios.length).toBe(2);
        expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
        const rows = within(screen.getByTestId("rollback-rows"));
        for (const k of ["Impact", "Capacity", "Lost", "Checks"]) expect(rows.getByText(k)).toBeTruthy();
        expect(screen.getByTestId("rollback-rows").textContent).toContain("Revision #3 and every change made in it are deleted");
        expect(screen.queryByRole("checkbox")).toBeNull();
        expect(screen.getByText(B.tunnel)).toBeTruthy();
        expect(screen.getByText(B.current(3))).toBeTruthy();
    });
    it("Arrow keys move the selection and the rows follow", async () => {
        mountBtn({v: v2()});
        await open();
        const first = within(screen.getByTestId("rollback-rev")).getAllByRole("radio")[0]!;
        first.focus();
        const before = screen.getByTestId("rollback-rows").textContent;
        fireEvent.keyDown(first, {key: "ArrowDown"});
        await waitFor(() => expect(within(screen.getByTestId("rollback-rev")).getAllByRole("radio")[1]!.getAttribute("aria-checked")).toBe("true"));
        expect(screen.getByTestId("rollback-rows").textContent).not.toBe(before);
    });
    it("confirm stays aria-disabled with the visible name reason until the exact (trimmed) name", async () => {
        mountBtn();
        await open();
        expect(confirm().getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(B.reasons.name)).toBeTruthy();
        type("nope");
        expect(confirm().getAttribute("aria-disabled")).toBe("true");
        type(` ${NAME} `);
        expect(confirm().getAttribute("aria-disabled")).toBeNull();
    });
    it("submits exactly {mirrorId, revisionId, confirmName} and announces STARTED; closes; onDone", async () => {
        h.rollback.mockResolvedValue({data: {ok: true}});
        const onDone = vi.fn();
        mountBtn({onDone});
        await open();
        type(NAME);
        fireEvent.click(confirm());
        await waitFor(() => expect(h.rollback).toHaveBeenCalledTimes(1));
        expect(h.rollback).toHaveBeenCalledWith({mirrorId: view(now).mirror.id, revisionId: "r1", confirmName: NAME});
        await waitFor(() => expect(screen.queryByTestId("rollback-dialog")).toBeNull());
        expect(screen.getByRole("status").textContent).toBe(B.started(1, 2));
        expect(onDone).toHaveBeenCalledTimes(1);
    });
    it("already:true announces the already-running sentence; a refusal stays open with role=alert", async () => {
        h.rollback.mockResolvedValue({data: {ok: true, already: true}});
        mountBtn();
        await open(); type(NAME); fireEvent.click(confirm());
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe(B.already));
        cleanup();
        h.rollback.mockResolvedValue({data: {ok: false, code: "no_rollback_target"}});
        mountBtn();
        await open(); type(NAME); fireEvent.click(confirm());
        const e = await screen.findByTestId("rollback-error");
        expect(e.getAttribute("role")).toBe("alert");
        expect(e.textContent).toBe(retryText("no_rollback_target", undefined));
        expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });
    it("double click submits once", async () => {
        let done: (v: unknown) => void = () => {};
        h.rollback.mockImplementation(() => new Promise((r) => { done = r; }));
        mountBtn();
        await open(); type(NAME);
        fireEvent.click(confirm()); fireEvent.click(confirm());
        await new Promise((r) => setTimeout(r, 0));
        expect(h.rollback).toHaveBeenCalledTimes(1);
        done({data: {ok: true}});
        await waitFor(() => expect(screen.queryByTestId("rollback-dialog")).toBeNull());
    });
    it("no target (the poll removed it): honest sentence, confirm blocked", async () => {
        mountBtn({v: view(now, {revisions: [rev(now, {id: "r2", seq: 2})]})});
        await open();
        expect(screen.getByTestId("rollback-none").textContent).toBe(B.none);
        expect(confirm().getAttribute("aria-disabled")).toBe("true");
    });
    it("Escape closes, focus returns to the opener, typed text is cleared on reopen", async () => {
        mountBtn();
        const btn = screen.getByTestId("mirror-rollback");
        btn.focus();
        await open(); type(NAME);
        fireEvent.keyDown(screen.getByTestId("rollback-dialog"), {key: "Escape"});
        await waitFor(() => expect(screen.queryByTestId("rollback-dialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(btn));
        await open();
        expect((screen.getByLabelText(new RegExp(B.input)) as HTMLInputElement).value).toBe("");
    });
    it("secret-input attributes on the name field; axe clean with the dialog open", async () => {
        mountBtn();
        await open();
        const i = screen.getByLabelText(new RegExp(B.input));
        expect([i.getAttribute("autocomplete"), i.getAttribute("spellcheck"), i.hasAttribute("data-1p-ignore")]).toEqual(["off", "false", true]);
        expect(await axeViolations(document.body)).toEqual([]);
    });
});
