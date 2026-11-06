// @vitest-environment jsdom
import {render} from "@testing-library/react";
import {axeViolations} from "@/fork/__tests__/axe";
import {beforeEach, describe, expect, it, vi} from "vitest";

const user = vi.hoisted(() => ({current: null as null | { role: string }}));
vi.mock("@/lib/auth/current-user", () => ({currentUser: async () => user.current}));
vi.mock("next/navigation", () => ({notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));

import IntegrationsPage from "../../../../app/(customer)/dashboard/(admin)/integrations/page";

describe("Integrations placeholder page", () => {
    beforeEach(() => { user.current = {role: "admin"}; });

    it("flags off → 404 even for a system admin", async () => {
        await expect(IntegrationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    });
    it("flag on, non-admin roles → 404 (page does not rely on the (admin) layout)", async () => {
        process.env.FORK_ARCANE_ENABLED = "true";
        for (const u of [{role: "user"}, {role: "pending"}, null]) {
            user.current = u;
            await expect(IntegrationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
        }
    });
    it("flag on, admin and superadmin → placeholder, honest copy, axe clean", async () => {
        process.env.FORK_ARCANE_ENABLED = "true";
        for (const role of ["admin", "superadmin"]) {
            user.current = {role};
            const {container, unmount} = render(await IntegrationsPage());
            expect(container.textContent).toContain("Arcane (coming)");
            expect(container.textContent).toContain("Nothing is connected");
            expect(await axeViolations(container)).toEqual([]);
            unmount();
        }
    });
    it("locked mode (flags off + active policy) → 404: configuration is locked", async () => {
        const {registerActivePolicyProbe} = await import("@/fork/mode");
        registerActivePolicyProbe(async () => 1);
        await expect(IntegrationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    });
});
