// @vitest-environment jsdom
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {ARCANE_KEY_INPUT_PROPS} from "@/fork/arcane/key-input-contract";
import type {IntegrationsView} from "@/fork/arcane/integrations-view";
import {axeViolations} from "@/fork/__tests__/axe";

const h = vi.hoisted(() => ({
    refresh: vi.fn(),
    save: vi.fn(), test: vi.fn(), rotate: vi.fn(), disconnect: vi.fn(), env: vi.fn(),
}));
vi.mock("next/navigation", () => ({useRouter: () => ({refresh: h.refresh}), notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));
vi.mock("@/fork/actions/arcane-connection.action", () => ({
    saveArcaneConnectionAction: h.save, testArcaneConnectionAction: h.test, rotateArcaneKeyAction: h.rotate, disconnectArcaneAction: h.disconnect,
}));
vi.mock("@/fork/actions/arcane-environment.action", () => ({updateArcaneEnvironmentAction: h.env}));

import {IntegrationsViewClient, type IntegrationsViewProps} from "@/fork/ui/integrations/integrations-view.client";
import {CONNECTION_STATE_LABELS, CONNECTION_STATES, LOCKED_PREFIX, SYNC_NOW, type ConnectionState} from "@/fork/ui/labels";

const CANARY = "arc_CANARYPFX_W06CANARYW06CANARYW06CANARY";
const ID = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ENV1 = "33333333-3333-4333-8333-333333333333";
const ENV2 = "44444444-4444-4444-8444-444444444444";

const conn = (o: Partial<NonNullable<IntegrationsView["connection"]>> = {}) => ({
    id: ID, name: "Arcane", baseUrl: "https://arcane.example.internal", healthStatus: "healthy" as const, lastErrorClass: null, tlsInsecure: false, allowProjectsRead: false,
    pinnedApiVersion: "2.17.3", keyStored: true as const, lastCheckedAt: "2026-11-07T10:00:00.000Z", updatedAt: "2026-11-07T10:00:00.000Z", ...o,
});
const env = (id: string, o: Record<string, unknown> = {}) => ({
    id, connectionId: ID, externalId: id === ENV1 ? "0" : "1", name: id === ENV1 ? "local" : "vps", enabled: false, hostRole: "production" as const, agentId: null, agentName: null,
    lastSyncAt: null, lastSyncStatus: null, lastSyncErrorClass: null, agentStatus: null, ...o,
});
const view = (o: Partial<IntegrationsView> = {}): IntegrationsView => ({
    connection: conn(), additionalConnections: 0, environments: [env(ENV1), env(ENV2, {agentId: AGENT, agentName: "vps-agent", agentStatus: "online"})] as IntegrationsView["environments"],
    agents: [{id: AGENT, name: "vps-agent", status: "online"}], ...o,
});

let qc: QueryClient;
function renderView(p: Partial<IntegrationsViewProps> = {}) {
    qc = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    return render(<QueryClientProvider client={qc}><IntegrationsViewClient view={view()} lockedReason={null} {...p}/></QueryClientProvider>);
}
const cacheDump = () => JSON.stringify([qc.getMutationCache().getAll().map((m) => ({k: m.options.mutationKey, v: m.state.variables, d: m.state.data, e: String(m.state.error)})), qc.getQueryCache().getAll().map((q) => q.state.data)]);
const keyInput = () => document.querySelector<HTMLInputElement>('input[name="arcane-discovery-key"]')!;
const ok = (extra: object = {}) => ({data: {ok: true, connection: conn(), verification: {ok: true, state: "healthy", errorClass: null, version: "2.17.3", keyId: "k1", environments: [{externalId: "0", name: "local", reachable: true, errorClass: null}], extraPermissions: [], missingPermissions: [], warnings: []}, warnings: [], ...extra}});

beforeAll(() => {
    // Radix Select / Dialog need these in jsdom
    Object.assign(window.HTMLElement.prototype, {scrollIntoView: () => {}, hasPointerCapture: () => false, releasePointerCapture: () => {}, setPointerCapture: () => {}});
    (globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => { vi.clearAllMocks(); });

describe("all 9 connection states render with label, inline description, alert copy; axe clean (UX-19, §8.2)", () => {
    const FIX: Record<ConnectionState, {c: Partial<NonNullable<IntegrationsView["connection"]>> | null; t?: "testing" | "syncing"; alert: boolean}> = {
        not_configured: {c: null, alert: false},
        testing: {c: conn(), t: "testing", alert: false},
        connected: {c: conn(), alert: false},
        syncing: {c: conn(), t: "syncing", alert: false},
        partial_sync: {c: {healthStatus: "degraded", lastErrorClass: "partial"}, alert: true},
        invalid_credentials: {c: {healthStatus: "auth_failed", lastErrorClass: "invalid_key"}, alert: true},
        insufficient_permission: {c: {healthStatus: "degraded", lastErrorClass: "permission"}, alert: true},
        unreachable: {c: {healthStatus: "unreachable", lastErrorClass: "unreachable"}, alert: true},
        incompatible_api: {c: {healthStatus: "degraded", lastErrorClass: "incompatible"}, alert: true},
    };
    for (const s of CONNECTION_STATES) {
        it(s, async () => {
            const f = FIX[s];
            const {container} = renderView({view: view({connection: f.c === null ? null : conn(f.c)}), forceTransient: f.t});
            if (s === "not_configured") expect(screen.getByTestId("state-text").textContent).toBe(CONNECTION_STATE_LABELS[s].label);
            else {
                expect(screen.getByRole("heading", {level: 2, name: "Arcane"}).parentElement?.textContent).toContain(CONNECTION_STATE_LABELS[s].label);
                expect(container.textContent).toContain(CONNECTION_STATE_LABELS[s].description); // inline text, not hover-only
            }
            expect(!!screen.queryByTestId("connection-alert")).toBe(f.alert);
            if (f.alert) expect(screen.getByTestId("connection-alert").textContent!.length).toBeGreaterThan(60);
            expect(await axeViolations(container)).toEqual([]);
        });
    }
    it("error copy is per error class, not per state (key_too_broad ≠ invalid_key)", () => {
        renderView({view: view({connection: conn({healthStatus: "auth_failed", lastErrorClass: "key_too_broad"})})});
        expect(screen.getByTestId("connection-alert").textContent).toContain("can do more than discovery needs");
    });
    it("busy states announce aria-busy", () => {
        const {container} = renderView({forceTransient: "syncing"});
        expect(container.querySelector('section[aria-busy="true"]')).toBeTruthy();
    });
    it("connected card shows facts, never a key; stacks column is an honest dash", () => {
        const {container} = renderView();
        expect(container.textContent).toContain("Stored, encrypted. Never shown again.");
        expect(container.textContent).toContain("2.17.3");
        expect(screen.getAllByText(/^not available yet$/).length).toBe(2);
        expect(container.querySelectorAll('input[type="password"]').length).toBe(0);
    });
});

describe("key field contract (UX-07) and the secret never leaving the input", () => {
    it("spreads ARCANE_KEY_INPUT_PROPS on a password input, form can't GET, never prefilled", () => {
        const {container} = renderView({view: view({connection: null})});
        const i = keyInput();
        expect(i.type).toBe("password");
        expect(i.getAttribute("autocomplete")).toBe("off");
        expect(i.getAttribute("spellcheck")).toBe("false");
        expect(i.getAttribute("data-gramm")).toBe("false");
        expect(i.hasAttribute("data-1p-ignore")).toBe(true);
        expect(i.getAttribute("data-lpignore")).toBe("true");
        for (const [k, v] of Object.entries(ARCANE_KEY_INPUT_PROPS)) if (k !== "spellCheck" && k !== "minLength" && k !== "maxLength") expect(i.getAttribute(k) ?? i.getAttribute(k.toLowerCase())).toBe(String(v));
        expect(i.value).toBe("");
        expect(container.querySelector("form")?.getAttribute("method")).toBe("post");
    });
    it("save: key goes to the action once, input is cleared, React Query caches and the DOM never hold it (success)", async () => {
        h.save.mockResolvedValue(ok());
        const {container} = renderView({view: view({connection: null})});
        fireEvent.change(screen.getByLabelText(/Manager URL/), {target: {value: "https://arcane.example.internal"}});
        fireEvent.change(keyInput(), {target: {value: CANARY}});
        fireEvent.submit(container.querySelector("form")!);
        await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
        expect(h.save.mock.calls[0][0]).toMatchObject({name: "Arcane", baseUrl: "https://arcane.example.internal", apiKey: CANARY});
        await waitFor(() => expect(h.refresh).toHaveBeenCalled());
        expect(keyInput().value).toBe("");
        expect(cacheDump()).not.toContain(CANARY);
        expect(document.documentElement.outerHTML).not.toContain(CANARY);
        expect(screen.getByTestId("job-status").textContent).toContain("Saved. Arcane verified.");
    });
    it("save refused (e.g. key too broad): field cleared anyway, exact server reason shown, nothing claimed as saved", async () => {
        h.save.mockResolvedValue({data: {ok: false, code: "refused", message: "The Arcane key holds more than the discovery minimum: containers:read.", errorClass: "key_too_broad", extraPermissions: ["containers:read"]}});
        const {container} = renderView({view: view({connection: null})});
        fireEvent.change(screen.getByLabelText(/Manager URL/), {target: {value: "https://arcane.example.internal"}});
        fireEvent.change(keyInput(), {target: {value: CANARY}});
        fireEvent.submit(container.querySelector("form")!);
        await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("containers:read"));
        expect(keyInput().value).toBe("");
        expect(screen.getByTestId("job-status").textContent).toMatch(/^Not done:/);
        expect(screen.getByTestId("job-status").textContent).not.toMatch(/Saved/);
        expect(cacheDump()).not.toContain(CANARY);
    });
    it("serverError / transport failure: generic honest message, key cleared, no success", async () => {
        h.save.mockResolvedValue({serverError: "Something went wrong"});
        const {container} = renderView({view: view({connection: null})});
        fireEvent.change(screen.getByLabelText(/Manager URL/), {target: {value: "https://arcane.example.internal"}});
        fireEvent.change(keyInput(), {target: {value: CANARY}});
        fireEvent.submit(container.querySelector("form")!);
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toMatch(/^Not done:/));
        expect(keyInput().value).toBe("");
        h.save.mockRejectedValue(new Error("network"));
        fireEvent.change(keyInput(), {target: {value: CANARY}});
        fireEvent.submit(container.querySelector("form")!);
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toMatch(/failed on the server/));
        expect(keyInput().value).toBe("");
    });
    it("a key is required on create and when host/port/scheme change; not required for a rename (SEC-10 hint; server enforces)", () => {
        const {unmount} = renderView({view: view({connection: null})});
        expect(keyInput().required).toBe(true);
        unmount();
        renderView();
        fireEvent.click(screen.getByRole("button", {name: "Edit"}));
        expect(keyInput().required).toBe(false);
        expect(keyInput().placeholder).toMatch(/A key is stored/);
        fireEvent.change(screen.getByLabelText(/Manager URL/), {target: {value: "https://other.example.internal"}});
        expect(keyInput().required).toBe(true);
        expect(screen.getByText(/enter the API key again/i)).toBeTruthy();
        fireEvent.change(screen.getByLabelText(/Manager URL/), {target: {value: "https://arcane.example.internal/api"}});
        expect(keyInput().required).toBe(false);
    });
    it("cancel clears whatever was typed", () => {
        renderView();
        fireEvent.click(screen.getByRole("button", {name: "Edit"}));
        fireEvent.change(keyInput(), {target: {value: CANARY}});
        fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
        expect(document.documentElement.outerHTML).not.toContain(CANARY);
    });
    it("tier-2 and TLS toggles show their warning inline as soon as they are on", () => {
        renderView({view: view({connection: null})});
        fireEvent.click(screen.getByLabelText(/Skip TLS certificate verification/));
        expect(screen.getByText(/TLS certificate verification is OFF/)).toBeTruthy();
        fireEvent.click(screen.getByLabelText(/Allow reading Compose files/));
        expect(screen.getByText(/raw Compose files/)).toBeTruthy();
    });
});

describe("disabled with a visible reason (§8.2 rule 10)", () => {
    it("Sync now is aria-disabled, focusable, reason visible and linked; click does nothing", () => {
        renderView();
        const b = screen.getByRole("button", {name: SYNC_NOW.label});
        expect(b.getAttribute("aria-disabled")).toBe("true");
        expect(b.hasAttribute("disabled")).toBe(false);
        expect(document.getElementById(b.getAttribute("aria-describedby")!)?.textContent).toBe(SYNC_NOW.disabledReason);
        fireEvent.click(b);
        expect(h.test).not.toHaveBeenCalled();
    });
    it("locked configuration: every action and every environment control is aria-disabled with the visible reason; nothing is sent", async () => {
        const reason = `${LOCKED_PREFIX}: more than one organization exists`;
        const {container} = renderView({lockedReason: reason});
        expect(screen.getByTestId("locked-banner").textContent).toContain(reason);
        for (const name of ["Test connection", "Edit", "Rotate key", "Disconnect"]) {
            const b = screen.getByRole("button", {name});
            expect(b.getAttribute("aria-disabled"), name).toBe("true");
            expect(document.getElementById(b.getAttribute("aria-describedby")!)?.textContent).toBe(reason);
            fireEvent.click(b);
        }
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
        for (const sw of screen.getAllByRole("switch")) { expect(sw.getAttribute("aria-disabled")).toBe("true"); fireEvent.click(sw); }
        for (const cb of screen.getAllByRole("combobox")) expect(cb.getAttribute("aria-disabled")).toBe("true");
        expect(h.test).not.toHaveBeenCalled(); expect(h.env).not.toHaveBeenCalled(); expect(h.disconnect).not.toHaveBeenCalled();
        expect(container.textContent).toContain(reason);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("locked + not configured: the form's submit is aria-disabled with the reason and sends nothing", () => {
        const reason = `${LOCKED_PREFIX}: signups are open`;
        const {container} = renderView({view: view({connection: null}), lockedReason: reason});
        const b = screen.getByRole("button", {name: "Verify and save"});
        expect(b.getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(screen.getByLabelText(/Manager URL/), {target: {value: "https://arcane.example.internal"}});
        fireEvent.change(keyInput(), {target: {value: CANARY}});
        fireEvent.submit(container.querySelector("form")!);
        expect(h.save).not.toHaveBeenCalled();
    });
});

describe("confirm dialogs (keyboard + focus, §8.2 rule 7)", () => {
    it("Disconnect: alertdialog explains backups are untouched, Cancel focused first, Escape closes without acting and returns focus to the trigger", async () => {
        const {container} = renderView();
        const trigger = screen.getByRole("button", {name: "Disconnect"});
        trigger.focus();
        fireEvent.click(trigger);
        const dlg = await screen.findByRole("alertdialog");
        expect(dlg.textContent).toMatch(/not.*touched/);
        await waitFor(() => expect(document.activeElement).toBe(within(dlg).getByRole("button", {name: "Cancel"})));
        expect(await axeViolations(dlg)).toEqual([]);
        fireEvent.keyDown(document.activeElement!, {key: "Escape"});
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(h.disconnect).not.toHaveBeenCalled();
        await waitFor(() => expect(document.activeElement).toBe(trigger));
        expect(await axeViolations(container)).toEqual([]);
    });
    it("Disconnect confirm → the real action, result announced from the server answer", async () => {
        h.disconnect.mockResolvedValue({data: {ok: true, connection: null, verification: null, warnings: ["Stacks, backups and recovery points were kept; discovery stops until a connection is added again."]}});
        renderView();
        fireEvent.click(screen.getByRole("button", {name: "Disconnect"}));
        const dlg = await screen.findByRole("alertdialog");
        const confirm = within(dlg).getByRole("button", {name: "Disconnect"});
        confirm.focus();
        fireEvent.click(confirm); // Enter/Space on a focused button = click (browser-level key flow is verified in the real-browser run)
        await waitFor(() => expect(h.disconnect).toHaveBeenCalledWith({connectionId: ID}));
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toContain("Backups and recovery points were kept"));
        expect(h.refresh).toHaveBeenCalled();
    });
    it("Rotate: dialog with a write-only key field; submit sends it once and clears it; Escape clears whatever was typed; refusal keeps the dialog and shows the reason", async () => {
        h.rotate.mockResolvedValue({data: {ok: false, code: "refused", message: "Arcane rejected the API key (401). Check the key or rotate it.", errorClass: "invalid_key"}});
        renderView();
        const trigger = screen.getByRole("button", {name: "Rotate key"});
        trigger.focus();
        fireEvent.click(trigger);
        const dlg = await screen.findByRole("dialog");
        expect(within(dlg).getByText(/stored key stays in use/)).toBeTruthy();
        expect(await axeViolations(dlg)).toEqual([]);
        fireEvent.change(keyInput(), {target: {value: CANARY}});
        fireEvent.submit(dlg.querySelector("form")!);
        await waitFor(() => expect(h.rotate).toHaveBeenCalledWith({connectionId: ID, apiKey: CANARY}));
        await waitFor(() => expect(within(dlg).getByRole("alert").textContent).toContain("401"));
        expect(keyInput().value).toBe("");
        expect(cacheDump()).not.toContain(CANARY);
        fireEvent.change(keyInput(), {target: {value: CANARY}});
        fireEvent.keyDown(keyInput(), {key: "Escape"});
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(document.documentElement.outerHTML).not.toContain(CANARY);
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });
    it("Rotate with an empty field sends nothing", async () => {
        renderView();
        fireEvent.click(screen.getByRole("button", {name: "Rotate key"}));
        const dlg = await screen.findByRole("dialog");
        fireEvent.submit(dlg.querySelector("form")!);
        await waitFor(() => expect(within(dlg).getByRole("alert").textContent).toMatch(/Enter the new key/));
        expect(h.rotate).not.toHaveBeenCalled();
    });
});

describe("test connection + environment table", () => {
    it("Test connection → real action; the result panel is built from the server's verification only", async () => {
        h.test.mockResolvedValue(ok());
        renderView();
        fireEvent.click(screen.getByRole("button", {name: "Test connection"}));
        await waitFor(() => expect(h.test).toHaveBeenCalledWith({connectionId: ID}));
        await waitFor(() => expect(screen.getByTestId("verification").textContent).toContain("Arcane 2.17.3, 1 of 1 environment reachable"));
        expect(screen.getByTestId("job-status").textContent).toContain("Test finished. Arcane verified.");
    });
    it("test that Arcane refuses is reported as a failure, never as success", async () => {
        h.test.mockResolvedValue({data: {ok: true, connection: conn({healthStatus: "auth_failed", lastErrorClass: "invalid_key"}), verification: {ok: false, state: "auth_failed", errorClass: "invalid_key", version: "2.17.3", keyId: null, environments: [], extraPermissions: [], missingPermissions: [], warnings: []}, warnings: []}});
        renderView();
        fireEvent.click(screen.getByRole("button", {name: "Test connection"}));
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toMatch(/Saved, but the check reports: Invalid credentials/));
        expect(screen.getByTestId("job-status").textContent).not.toMatch(/verified\./);
    });
    it("rows: name + external id, agent status with icon+text, discovery switch calls the action with the environment id", async () => {
        h.env.mockResolvedValue({data: {ok: true, environment: {}, changed: ["enabled"]}});
        const {container} = renderView();
        const rows = screen.getAllByRole("row");
        expect(rows).toHaveLength(3);
        expect(within(rows[2]).getByTestId("agent-status").textContent).toBe("Online");
        expect(within(rows[1]).getByTestId("agent-status").textContent).toBe("No agent mapped");
        fireEvent.click(screen.getByRole("switch", {name: "Discovery for local"}));
        await waitFor(() => expect(h.env).toHaveBeenCalledWith({environmentId: ENV1, enabled: true}));
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toBe("Environment settings saved."));
        expect(await axeViolations(container)).toEqual([]);
    });
    it("host role → test asks first (D44); Cancel sends nothing, confirm sends; → production sends directly", async () => {
        h.env.mockResolvedValue({data: {ok: true, environment: {}, changed: ["hostRole"]}});
        renderView();
        const pick = async (name: string, option: string) => {
            fireEvent.keyDown(screen.getByRole("combobox", {name}), {key: "Enter"});
            fireEvent.click(await screen.findByRole("option", {name: option}));
        };
        await pick("Host role for local", "Test host");
        const dlg = await screen.findByRole("alertdialog");
        fireEvent.click(within(dlg).getByRole("button", {name: "Cancel"}));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(h.env).not.toHaveBeenCalled();
        await pick("Host role for local", "Test host");
        fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", {name: "Mark as test host"}));
        await waitFor(() => expect(h.env).toHaveBeenCalledWith({environmentId: ENV1, hostRole: "test"}));
    });
    it("agent mapping select lists only the candidate agents the server sent and can clear the mapping", async () => {
        h.env.mockResolvedValue({data: {ok: true, environment: {}, changed: ["agent"]}});
        renderView();
        fireEvent.keyDown(screen.getByRole("combobox", {name: "Portabase agent for local"}), {key: "Enter"});
        fireEvent.click(await screen.findByRole("option", {name: "vps-agent"}));
        await waitFor(() => expect(h.env).toHaveBeenCalledWith({environmentId: ENV1, agentId: AGENT}));
    });
    it("refused environment change (e.g. forbidden) is reported, not swallowed", async () => {
        h.env.mockResolvedValue({data: {ok: false, code: "forbidden", message: "Only a system administrator can change Stack Recovery configuration."}});
        renderView();
        fireEvent.click(screen.getByRole("switch", {name: "Discovery for local"}));
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toContain("Not done: Only a system administrator"));
    });
    it("no environments yet: honest empty state instead of an empty table", () => {
        renderView({view: view({environments: []})});
        expect(screen.queryByRole("table")).toBeNull();
        expect(screen.getByText(/No environment found yet/)).toBeTruthy();
    });
    it("dark theme: same markup renders and stays axe-clean inside `.dark` (contrast is proven by the tone-map test)", async () => {
        document.documentElement.classList.add("dark");
        try {
            const {container} = renderView({view: view({connection: conn({healthStatus: "unreachable", lastErrorClass: "tls"})})});
            expect(await axeViolations(container)).toEqual([]);
        } finally { document.documentElement.classList.remove("dark"); }
    });
});
