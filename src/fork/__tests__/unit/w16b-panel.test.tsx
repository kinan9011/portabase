// @vitest-environment jsdom
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {RestoreOverridesView} from "@/fork/config/view";

const A = {set: vi.fn(), clear: vi.fn()};
vi.mock("@/fork/actions/stack-config.action", () => ({
    setRestoreOverridesAction: (...a: unknown[]) => A.set(...a), clearRestoreOverridesAction: (...a: unknown[]) => A.clear(...a),
    getRestoreOverridesViewAction: vi.fn(),
}));
import {OVERRIDES as L, REFUSAL_COPY} from "@/fork/ui/stacks/config/labels";
import {RestoreOverridesPanel} from "@/fork/ui/stacks/config/restore-overrides-panel.client";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const PLAN = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
const CANARY = `CANARY_W16B_UI_${Math.random().toString(36).slice(2)}`;
const view = (o: Partial<RestoreOverridesView> = {}): RestoreOverridesView => ({
    applicable: true, reason: null, frozen: false, revision: 0, yml: {present: false, bytes: 0}, missingRequired: 1,
    fields: [
        {service: "db", key: "POSTGRES_PASSWORD", origin: "env_file", class: "require_input", isSet: false},
        {service: "web", key: "API_URL", origin: "service_env", class: "restore", isSet: true},
        {service: "", key: "TAG", origin: "env_file", class: "restore", isSet: false},
    ], ...o,
});
let qc: QueryClient;
const mount = (v: RestoreOverridesView, o: {canEdit?: boolean; onChanged?: (v: RestoreOverridesView) => void} = {}) => render(
    <QueryClientProvider client={qc}><StatusAnnouncer><RestoreOverridesPanel planId={PLAN} planHash={HASH} view={v} canEdit={o.canEdit ?? true} onChanged={o.onChanged}/></StatusAnnouncer></QueryClientProvider>);
const secrets = () => [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')];
const yml = () => document.querySelector<HTMLTextAreaElement>("textarea")!;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, {target: {value}});

beforeEach(() => { A.set.mockReset(); A.clear.mockReset(); qc = new QueryClient({defaultOptions: {mutations: {retry: false}}}); window.localStorage.clear(); window.sessionStorage.clear(); });
afterEach(cleanup);

describe("W16b overrides panel (UX-07, no value ever leaves the DOM nodes)", () => {
    it("every secret input and the YAML box carry the UX-07 attributes, are empty and allow 4096 chars; axe clean", async () => {
        const {container} = mount(view());
        expect(secrets()).toHaveLength(3);
        for (const el of [...secrets(), yml()]) {
            expect(el.getAttribute("autocomplete")).toBe("off");
            expect(el.getAttribute("spellcheck")).toBe("false");
            expect(el.getAttribute("data-gramm")).toBe("false");
            expect(el.hasAttribute("data-1p-ignore")).toBe(true);
            expect(el.value).toBe("");
        }
        for (const el of secrets()) { expect(el.getAttribute("maxlength")).toBe("4096"); expect(el.getAttribute("type")).toBe("password"); }
        expect(await axeViolations(container)).toEqual([]);
    });

    it("renders state text + icon per field, never a value or its length; the missing-required count is visible", () => {
        mount(view());
        expect(screen.getByText(L.state.needsValue)).toBeTruthy();
        expect(screen.getByText(L.state.set)).toBeTruthy();
        expect(screen.getByText(L.state.notSet)).toBeTruthy();
        expect(screen.getByTestId("overrides-missing-required").textContent).toBe(L.missingRequired(1));
        expect(screen.getByText(L.fieldLabel("TAG", ""))).toBeTruthy();
        expect(screen.getByText(L.fieldLabel("POSTGRES_PASSWORD", "db"))).toBeTruthy();
    });

    it("keyboard: every control is natively focusable in DOM order (no positive tabindex), all inside ONE form with a submit button, so Enter in a field submits", async () => {
        const {container} = mount(view({revision: 1, yml: {present: true, bytes: 10}}));
        const form = container.querySelector("form")!;
        const focusable = [...form.querySelectorAll<HTMLElement>("input, textarea, button, select, a[href]")].filter((e) => !(e as HTMLInputElement).disabled);
        expect(focusable.every((e) => !(Number(e.getAttribute("tabindex") ?? 0) > 0))).toBe(true);
        const names = focusable.map((e) => e.getAttribute("name") ?? e.textContent);
        for (const n of ["override-0", "override-1", "override-2", "override-yml", "override-file", L.save, L.clearAll]) expect(names, String(n)).toContain(n);
        expect(names.indexOf("override-0")).toBeLessThan(names.indexOf("override-yml"));
        expect(names.indexOf("override-yml")).toBeLessThan(names.indexOf("override-file"));
        expect(names.indexOf("override-file")).toBeLessThan(names.indexOf(L.save));
        expect(screen.getByRole("button", {name: L.save}).getAttribute("type")).toBe("submit");
        A.set.mockResolvedValue({data: {ok: true, view: view({revision: 2})}});
        type(secrets()[0], CANARY);
        fireEvent.submit(form); // what the browser does for Enter in a field
        await waitFor(() => expect(A.set).toHaveBeenCalledTimes(1));
    });

    it("submit: the action receives the value, then EVERY field and the box are empty — on ok and on refusal; the value is nowhere else", async () => {
        const changed = vi.fn();
        A.set.mockResolvedValueOnce({data: {ok: true, view: view({revision: 3, missingRequired: 0})}});
        mount(view(), {onChanged: changed});
        type(secrets()[0], CANARY); type(secrets()[2], `${CANARY}-2`); type(yml(), `services:\n  web:\n    restart: ${CANARY}\n`);
        fireEvent.click(screen.getByRole("button", {name: L.save}));
        await waitFor(() => expect(A.set).toHaveBeenCalledTimes(1));
        const sent = A.set.mock.calls[0][0] as {set: {key: string; value: string}[]; overrideYml?: string};
        expect(sent.set).toEqual([{service: "db", key: "POSTGRES_PASSWORD", value: CANARY}, {service: "", key: "TAG", value: `${CANARY}-2`}]);
        expect(sent.overrideYml).toContain(CANARY);
        await waitFor(() => expect(changed).toHaveBeenCalled());
        for (const el of [...secrets(), yml()]) expect(el.value).toBe("");
        expect(JSON.stringify(changed.mock.calls)).not.toContain(CANARY);
        // refusal path: also cleared, honest copy shown
        A.set.mockResolvedValueOnce({data: {ok: false, code: "override_raw_refused", violations: [{kind: "env_file", service: "web"}]}});
        type(secrets()[1], CANARY);
        fireEvent.click(screen.getByRole("button", {name: L.save}));
        await waitFor(() => expect(screen.getByTestId("override-result").textContent).toContain(REFUSAL_COPY.override_raw_refused));
        expect(screen.getByTestId("override-result").textContent).toContain("env_file · web");
        for (const el of [...secrets(), yml()]) expect(el.value).toBe("");
        // nothing leaked into mutation cache, URL, storage or the DOM
        expect(JSON.stringify(qc.getMutationCache().getAll().map((m) => ({v: m.state.variables, d: m.state.data, s: m.state.status})))).not.toContain(CANARY);
        expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(CANARY);
        expect(window.location.href).not.toContain(CANARY);
        expect(JSON.stringify({...window.localStorage}) + JSON.stringify({...window.sessionStorage})).not.toContain(CANARY);
        expect(document.documentElement.outerHTML).not.toContain(CANARY);
    });

    it("a transport failure clears the fields too and says so, without claiming success", async () => {
        A.set.mockRejectedValueOnce(new Error("boom"));
        mount(view());
        type(secrets()[0], CANARY);
        fireEvent.click(screen.getByRole("button", {name: L.save}));
        await waitFor(() => expect(screen.getByTestId("override-result")).toBeTruthy());
        expect(secrets()[0].value).toBe("");
        expect(screen.queryByText(L.saved(1))).toBeNull();
        expect(document.documentElement.outerHTML).not.toContain(CANARY);
    });

    it("the file path: a chosen file is read at submit and sent as overrideYml; file + text together is refused locally", async () => {
        A.set.mockResolvedValue({data: {ok: true, view: view({revision: 1})}});
        mount(view());
        const file = new File([`services:\n  web:\n    restart: always # ${CANARY}\n`], "o.yml", {type: "text/yaml"});
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
        await act(async () => { fireEvent.change(input, {target: {files: [file]}}); });
        fireEvent.click(screen.getByRole("button", {name: L.save}));
        await waitFor(() => expect(A.set).toHaveBeenCalledTimes(1));
        expect((A.set.mock.calls[0][0] as {overrideYml: string}).overrideYml).toContain("restart: always");
        await act(async () => { fireEvent.change(input, {target: {files: [file]}}); });
        type(yml(), "a: b");
        fireEvent.click(screen.getByRole("button", {name: L.save}));
        await waitFor(() => expect(screen.getByTestId("override-result").textContent).toBe(L.ymlBoth));
        expect(A.set).toHaveBeenCalledTimes(1);
    });

    it("nothing entered ⇒ no call, a plain instruction", async () => {
        mount(view());
        fireEvent.click(screen.getByRole("button", {name: L.save}));
        await waitFor(() => expect(screen.getByTestId("override-result").textContent).toBe(L.nothingToSave));
        expect(A.set).not.toHaveBeenCalled();
    });

    it("Remove my value sends only the names (unset); the YAML 'remove' sends overrideYml null", async () => {
        A.set.mockResolvedValue({data: {ok: true, view: view({revision: 2, yml: {present: true, bytes: 12}})}});
        mount(view({yml: {present: true, bytes: 12}, revision: 1}));
        fireEvent.click(screen.getByRole("button", {name: new RegExp(L.removeValue)}));
        await waitFor(() => expect(A.set).toHaveBeenCalledTimes(1));
        expect(A.set.mock.calls[0][0]).toEqual({planId: PLAN, planHash: HASH, unset: [{service: "web", key: "API_URL"}]});
        fireEvent.click(screen.getByRole("button", {name: L.removeYml}));
        await waitFor(() => expect(A.set).toHaveBeenCalledTimes(2));
        expect(A.set.mock.calls[1][0]).toEqual({planId: PLAN, planHash: HASH, overrideYml: null});
    });

    it("frozen, not applicable and read-only views: the form is aria-disabled with a visible reason, nothing can be sent", () => {
        const cases: [RestoreOverridesView, boolean, string][] = [
            [view({frozen: true, revision: 2}), true, L.frozen],
            [view({applicable: false, reason: "purpose"}), true, "Overrides apply to restores of a stack, not to data-only test restores."],
            [view(), false, L.readOnly],
        ];
        for (const [v, canEdit, reason] of cases) {
            const {unmount} = mount(v, {canEdit});
            expect(screen.getByTestId("overrides-lock-reason").textContent).toBe(reason);
            expect(document.querySelector("fieldset")?.getAttribute("aria-disabled")).toBe("true");
            expect(secrets().every((e) => e.matches(":disabled"))).toBe(true);
            unmount();
        }
        expect(A.set).not.toHaveBeenCalled();
    });

    it("announces the saved revision in the ONE status region, and says nothing before the server answered", async () => {
        let resolve!: (v: unknown) => void;
        A.set.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
        mount(view());
        type(secrets()[0], CANARY);
        fireEvent.click(screen.getByRole("button", {name: L.save}));
        await waitFor(() => expect(A.set).toHaveBeenCalled());
        expect(screen.getByRole("status").textContent).toBe("");
        await act(async () => { resolve({data: {ok: true, view: view({revision: 4})}}); });
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe(L.saved(4)));
        expect(screen.getAllByRole("status")).toHaveLength(1);
    });
});
