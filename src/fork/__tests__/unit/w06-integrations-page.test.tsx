// @vitest-environment jsdom
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {render} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {FORK_NAV_DEFS} from "@/fork/nav";

const h = vi.hoisted(() => ({user: null as null | {role: string}, org: "00000000-0000-4000-8000-0000000000aa" as string | null, load: vi.fn()}));
vi.mock("@/lib/auth/current-user", () => ({currentUser: async () => h.user}));
vi.mock("next/navigation", () => ({notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({refresh: () => {}})}));
vi.mock("@/fork/db/handle", () => ({appDb: async () => ({})}));
vi.mock("@/fork/arcane/connection-service", () => ({soleOrganization: async () => h.org}));
vi.mock("@/fork/arcane/integrations-view", () => ({loadIntegrationsView: h.load}));
vi.mock("@/fork/actions/arcane-connection.action", () => ({saveArcaneConnectionAction: vi.fn(), testArcaneConnectionAction: vi.fn(), rotateArcaneKeyAction: vi.fn(), disconnectArcaneAction: vi.fn()}));
vi.mock("@/fork/actions/arcane-environment.action", () => ({updateArcaneEnvironmentAction: vi.fn()}));

import IntegrationsPage from "../../../../app/(customer)/dashboard/(admin)/integrations/page";

const VIEW = {connection: null, additionalConnections: 0, environments: [], agents: []};
const mount = async () => {
    const el = await IntegrationsPage();
    return render(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);
};
const on = () => { process.env.FORK_ARCANE_ENABLED = "true"; };

describe("Integrations page (D35): mode × role matrix", () => {
    beforeEach(() => { h.user = {role: "admin"}; h.org = "00000000-0000-4000-8000-0000000000aa"; h.load.mockReset(); h.load.mockResolvedValue(VIEW); });

    it("flags off → 404 even for a system admin; nothing is loaded", async () => {
        await expect(IntegrationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
        expect(h.load).not.toHaveBeenCalled();
    });
    it("no session → 404", async () => {
        on(); h.user = null;
        await expect(IntegrationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    });
    it("role-aware empty state: user / pending (reaching the page at all) get a plain explanation, NO data is loaded, no connect form", async () => {
        on();
        for (const role of ["user", "pending"]) {
            h.user = {role};
            const {container, unmount} = await mount();
            expect(container.textContent).toContain("Integrations are managed by a system administrator");
            expect(container.querySelector("form")).toBeNull();
            expect(container.querySelector('input[type="password"]')).toBeNull();
            expect(h.load).not.toHaveBeenCalled();
            expect(await axeViolations(container)).toEqual([]);
            unmount();
        }
    });
    it("system admin and superadmin (mode on): setup path + connect form with the key field; axe clean", async () => {
        on();
        for (const role of ["admin", "superadmin"]) {
            h.user = {role};
            const {container, unmount} = await mount();
            expect(container.textContent).toContain("Connect your Arcane Manager");
            expect(container.querySelector('input[name="arcane-discovery-key"]')?.getAttribute("type")).toBe("password");
            expect(container.textContent).not.toContain("Fork configuration locked");
            expect(await axeViolations(container)).toEqual([]);
            unmount();
        }
        expect(h.load).toHaveBeenCalledWith({}, "00000000-0000-4000-8000-0000000000aa");
    });
    it("locked mode (flags on, self-check failing, an activated policy exists) → page renders, locked banner with the failed check, Verify and save aria-disabled", async () => {
        on();
        const {registerActivePolicyProbe, registerSelfCheck} = await import("@/fork/mode");
        registerActivePolicyProbe(async () => 1);
        registerSelfCheck(async () => ({ok: false, failed: "signup-open"}));
        const {container} = await mount();
        expect(container.querySelector('[data-testid="locked-banner"]')?.textContent).toMatch(/^Fork configuration locked: /);
        expect(container.querySelector('[data-testid="locked-banner"]')?.textContent).toMatch(/sign/i);
        expect(container.querySelector('button[type="submit"]')?.getAttribute("aria-disabled")).toBe("true");
        expect(await axeViolations(container)).toEqual([]);
    });
    it("flags on but mode off (self-check failing, nothing activated) → fork stays invisible (ADR-010): 404", async () => {
        on();
        const {registerSelfCheck} = await import("@/fork/mode");
        registerSelfCheck(async () => ({ok: false, failed: "org-count"}));
        await expect(IntegrationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    });
    it("no single organization → explicit locked text, no data loaded", async () => {
        on(); h.org = null;
        const {container} = await mount();
        expect(container.textContent).toContain("exactly one organization");
        expect(h.load).not.toHaveBeenCalled();
    });
});

describe("navigation (P05) — Integrations visible, Recovery still hidden until W18b (D13/I14)", () => {
    it("nav defs", () => {
        expect(FORK_NAV_DEFS.find((d) => d.title === "Integrations")).toMatchObject({shipped: true, url: "/integrations"});
        expect(FORK_NAV_DEFS.find((d) => d.title === "Recovery")).toMatchObject({shipped: false, wave: "W18b"});
    });
});
