// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {hoursAgo, NAME, preview, RP_A, RP_B, rev, view} from "@/fork/__tests__/w25-fixtures";
import {MIRRORS, retryText} from "@/fork/ui/mirrors/labels";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const h = vi.hoisted(() => ({preview: vi.fn(), refresh: vi.fn()}));
vi.mock("@/fork/actions/mirror.action", () => ({previewMirrorRefreshAction: h.preview, refreshMirrorAction: h.refresh}));

import {RefreshMirrorButton} from "@/fork/ui/mirrors/refresh/refresh-dialog.client";

const R = MIRRORS.refresh;
const now = new Date();
const ok = (p: unknown) => Promise.resolve({data: {ok: true, preview: p}});
const previewFor = (id: string | null) => preview(now, {selected: id === null ? null : {...preview(now).selected!, rpId: id, sequence: id === RP_A ? 5 : 6}});
const mountBtn = (o: {onDone?: () => void; action?: object; personal?: boolean | null} = {}) => render(
    <StatusAnnouncer><RefreshMirrorButton view={view(now, {personal: o.personal === undefined ? true : o.personal})} action={(o.action ?? {enabled: true}) as never} onDone={o.onDone}/></StatusAnnouncer>);
const open = async () => { fireEvent.click(screen.getByTestId("mirror-refresh")); await screen.findByTestId("refresh-dialog"); await screen.findByTestId("refresh-rows"); };
const confirm = () => screen.getByTestId("refresh-confirm");
const type = (v: string) => fireEvent.change(screen.getByLabelText(new RegExp(R.input)), {target: {value: v}});
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    h.preview.mockReset(); h.refresh.mockReset();
    h.preview.mockImplementation(async (i: {rpId: string | null}) => ({data: {ok: true, preview: previewFor(i.rpId)}}));
});
afterEach(() => cleanup());

describe("Refresh dialog", () => {
    it("a blocked action is a reason-only button that never opens a dialog", () => {
        mountBtn({action: {reason: R.reasons.noNewer}});
        expect(screen.getByTestId("mirror-refresh").getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(R.reasons.noNewer)).toBeTruthy();
        fireEvent.click(screen.getByTestId("mirror-refresh"));
        expect(screen.queryByTestId("refresh-dialog")).toBeNull();
        expect(h.preview).not.toHaveBeenCalled();
    });
    it("a hidden action renders nothing", () => {
        const {container} = mountBtn({action: {hidden: true}});
        expect(container.querySelector("[data-testid=mirror-refresh]")).toBeNull();
    });
    it("opens, loads candidates, pre-selects the newest, shows the rows and the tunnel note", async () => {
        mountBtn();
        await open();
        const radios = within(screen.getByTestId("refresh-rp")).getAllByRole("radio");
        expect(radios.length).toBe(2);
        expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
        expect(h.preview.mock.calls.map((c) => c[0])).toEqual([{mirrorId: view(now).mirror.id, rpId: null}, {mirrorId: view(now).mirror.id, rpId: RP_B}]);
        const rows = within(screen.getByTestId("refresh-rows"));
        for (const k of ["Data age", "Required space", "Memory", "App definition", "Lost on switch", "Deleted after the switch"]) expect(rows.getByText(k)).toBeTruthy();
        expect(screen.getByText(R.tunnel)).toBeTruthy();
        expect(screen.getByText(R.preserved)).toBeTruthy();
        expect(screen.getByText(R.intro(3, 2))).toBeTruthy();
    });
    it("Arrow keys move the radio selection and the preview is re-read for it", async () => {
        mountBtn();
        await open();
        const first = within(screen.getByTestId("refresh-rp")).getAllByRole("radio")[0]!;
        first.focus();
        fireEvent.keyDown(first, {key: "ArrowDown"});
        await waitFor(() => expect(h.preview.mock.calls.at(-1)?.[0]).toEqual({mirrorId: view(now).mirror.id, rpId: RP_A}));
        await waitFor(() => expect(within(screen.getByTestId("refresh-rp")).getAllByRole("radio")[1]!.getAttribute("aria-checked")).toBe("true"));
    });
    it("confirm stays aria-disabled with a VISIBLE reason: ack first, then the exact name", async () => {
        mountBtn();
        await open();
        expect(confirm().getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(R.reasons.ack)).toBeTruthy();
        fireEvent.click(screen.getByRole("checkbox"));
        expect(screen.getByText(R.reasons.name)).toBeTruthy();
        type(`${NAME}x`);
        expect(confirm().getAttribute("aria-disabled")).toBe("true");
        type(` ${NAME} `); // trimmed
        expect(confirm().getAttribute("aria-disabled")).toBeNull();
    });
    it("the reason order is pick → plan → planBlocked → ack → name", async () => {
        let release: (v: unknown) => void = () => {};
        h.preview.mockImplementation((i: {rpId: string | null}) => (i.rpId === RP_B ? new Promise((r) => { release = r; }) : ok(previewFor(null))));
        mountBtn();
        fireEvent.click(screen.getByTestId("mirror-refresh"));
        await screen.findByTestId("refresh-dialog");
        await screen.findByTestId("refresh-rp");
        expect(screen.getByText(R.reasons.plan)).toBeTruthy(); // selection exists, plan still loading
        release({data: {ok: true, preview: preview(now, {selected: {...preview(now).selected!, outcome: "blocked", blockers: ["plan_blocked"]}})}});
        await screen.findByTestId("refresh-blocked");
        expect(screen.getByText(R.reasons.planBlocked)).toBeTruthy();
        expect(within(screen.getByTestId("refresh-blocked")).getByText(R.blocked)).toBeTruthy();
        expect(confirm().getAttribute("aria-disabled")).toBe("true");
    });
    it("no candidates: honest empty state and the pick reason", async () => {
        h.preview.mockImplementation(() => ok(preview(now, {candidates: [], selected: null})));
        mountBtn();
        fireEvent.click(screen.getByTestId("mirror-refresh"));
        expect(await screen.findByTestId("refresh-none")).toBeTruthy();
        expect(screen.getByText(R.reasons.pick)).toBeTruthy();
        expect(confirm().getAttribute("aria-disabled")).toBe("true");
    });
    it("preview failure: role=alert text, retry text for rate limits", async () => {
        h.preview.mockImplementation(async () => ({data: {ok: false, code: "rate_limited", retryAfterSeconds: 7}}));
        mountBtn();
        fireEvent.click(screen.getByTestId("mirror-refresh"));
        const a = await screen.findByTestId("refresh-preview-error");
        expect(a.getAttribute("role")).toBe("alert");
        expect(a.textContent).toBe(retryText("rate_limited", 7));
        h.preview.mockImplementation(async () => { throw new Error("x"); });
        cleanup(); mountBtn();
        fireEvent.click(screen.getByTestId("mirror-refresh"));
        expect((await screen.findByTestId("refresh-preview-error")).textContent).toBe(R.previewFailed);
    });
    it("privacy checkbox: present for personal data true and unknown (null), absent for false", async () => {
        for (const [personal, present] of [[true, true], [null, true], [false, false]] as const) {
            h.preview.mockImplementation(async (i: {rpId: string | null}) => ({data: {ok: true, preview: {...previewFor(i.rpId), containsPersonalData: personal}}}));
            mountBtn({personal});
            await open();
            expect(screen.queryByRole("checkbox") !== null, String(personal)).toBe(present);
            if (!present) { type(NAME); expect(confirm().getAttribute("aria-disabled")).toBeNull(); }
            cleanup();
        }
    });
    it("submits exactly the server contract and announces STARTED (never 'refreshed'); closes and calls onDone", async () => {
        h.refresh.mockResolvedValue({data: {ok: true, revisionId: "r3"}});
        const onDone = vi.fn();
        mountBtn({onDone});
        await open();
        fireEvent.click(screen.getByRole("checkbox"));
        type(NAME);
        fireEvent.click(confirm());
        await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
        expect(h.refresh).toHaveBeenCalledWith({mirrorId: view(now).mirror.id, rpId: RP_B, confirmName: NAME, acknowledgePrivacy: true});
        await waitFor(() => expect(screen.queryByTestId("refresh-dialog")).toBeNull());
        const status = screen.getAllByRole("status");
        expect(status.length).toBe(1);
        expect(status[0]!.textContent).toBe(R.started(3, 2));
        expect(status[0]!.textContent).not.toMatch(/refreshed/i);
        expect(onDone).toHaveBeenCalledTimes(1);
    });
    it("already:true announces the already-running sentence", async () => {
        h.refresh.mockResolvedValue({data: {ok: true, revisionId: "r3", already: true}});
        mountBtn();
        await open();
        fireEvent.click(screen.getByRole("checkbox")); type(NAME);
        fireEvent.click(confirm());
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe(R.already));
    });
    it("a refusal shows role=alert with the retry text (+ blockers) and the dialog stays open", async () => {
        h.refresh.mockResolvedValue({data: {ok: false, code: "plan_blocked", blockers: ["plan_blocked", "plan_blocked"]}});
        mountBtn();
        await open();
        fireEvent.click(screen.getByRole("checkbox")); type(NAME);
        fireEvent.click(confirm());
        const err = await screen.findByTestId("refresh-error");
        expect(err.getAttribute("role")).toBe("alert");
        expect(err.textContent).toContain(retryText("plan_blocked", undefined));
        expect(within(err).getAllByRole("listitem").length).toBe(1); // de-duplicated
        expect(screen.getByTestId("refresh-dialog")).toBeTruthy();
        h.refresh.mockRejectedValue(new Error("boom"));
        fireEvent.click(confirm());
        await waitFor(() => expect(screen.getByTestId("refresh-error").textContent).toBe(MIRRORS.lifecycle.failed));
    });
    it("double click submits once while busy", async () => {
        let done: (v: unknown) => void = () => {};
        h.refresh.mockImplementation(() => new Promise((r) => { done = r; }));
        mountBtn();
        await open();
        fireEvent.click(screen.getByRole("checkbox")); type(NAME);
        fireEvent.click(confirm()); fireEvent.click(confirm());
        await tick();
        expect(h.refresh).toHaveBeenCalledTimes(1);
        expect(confirm().getAttribute("aria-disabled")).toBe("true");
        done({data: {ok: true, revisionId: "r3"}});
        await waitFor(() => expect(screen.queryByTestId("refresh-dialog")).toBeNull());
    });
    it("stale preview responses are ignored (the older request resolves last)", async () => {
        const waiters: Record<string, (v: unknown) => void> = {};
        h.preview.mockImplementation((i: {rpId: string | null}) => (i.rpId === null ? ok(preview(now, {selected: null})) : new Promise((r) => { waiters[i.rpId as string] = r; })));
        mountBtn();
        fireEvent.click(screen.getByTestId("mirror-refresh"));
        await screen.findByTestId("refresh-rp");
        await waitFor(() => expect(waiters[RP_B]).toBeTruthy());
        const second = within(screen.getByTestId("refresh-rp")).getAllByRole("radio")[1]!;
        second.focus(); fireEvent.click(second);
        await waitFor(() => expect(waiters[RP_A]).toBeTruthy());
        waiters[RP_A]!({data: {ok: true, preview: previewFor(RP_A)}}); // newest request first
        await screen.findByTestId("refresh-rows");
        waiters[RP_B]!({data: {ok: true, preview: previewFor(RP_B)}}); // stale answer arrives late
        await tick(); await tick();
        expect(within(screen.getByTestId("refresh-rp")).getAllByRole("radio")[1]!.getAttribute("aria-checked")).toBe("true");
        expect(screen.getByTestId("refresh-rows").textContent).toContain("Data from");
    });
    it("the capacity warning is a visible note (icon + text) and never disables confirm", async () => {
        h.preview.mockImplementation(async (i: {rpId: string | null}) => ({data: {ok: true, preview: {...previewFor(i.rpId), lastCapacity: {freeDiskBytes: 1, memAvailableBytes: 1, at: hoursAgo(now, 1)}}}}));
        mountBtn();
        await open();
        const w = screen.getByTestId("refresh-capacity-warning");
        expect(w.getAttribute("role")).toBe("note");
        expect(w.textContent).toContain(R.capacityWarn);
        fireEvent.click(screen.getByRole("checkbox")); type(NAME);
        expect(confirm().getAttribute("aria-disabled")).toBeNull();
    });
    it("Escape closes, focus returns to the opener, typed text and ack are cleared on reopen", async () => {
        mountBtn();
        const btn = screen.getByTestId("mirror-refresh");
        btn.focus();
        await open();
        fireEvent.click(screen.getByRole("checkbox")); type(NAME);
        fireEvent.keyDown(screen.getByTestId("refresh-dialog"), {key: "Escape"});
        await waitFor(() => expect(screen.queryByTestId("refresh-dialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(btn));
        await open();
        expect((screen.getByLabelText(new RegExp(R.input)) as HTMLInputElement).value).toBe("");
        expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    });
    it("the name field carries the secret-input attributes", async () => {
        mountBtn();
        await open();
        const i = screen.getByLabelText(new RegExp(R.input));
        expect(i.getAttribute("autocomplete")).toBe("off");
        expect(i.getAttribute("spellcheck")).toBe("false");
        expect(i.hasAttribute("data-1p-ignore")).toBe(true);
        expect(i.getAttribute("data-gramm")).toBe("false");
    });
    it("axe is clean with the dialog open (Radix portal)", async () => {
        mountBtn();
        await open();
        expect(await axeViolations(document.body)).toEqual([]);
    });
});

describe("fixture sanity", () => { it("view has a rollback target", () => expect(rev(now).seq).toBe(1)); });
