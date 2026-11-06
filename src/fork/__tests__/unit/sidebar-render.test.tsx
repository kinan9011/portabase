// @vitest-environment jsdom
import {render} from "@testing-library/react";
import {renderToStaticMarkup} from "react-dom/server";
import {axeViolations} from "@/fork/__tests__/axe";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {SidebarProvider} from "@/components/ui/sidebar";

const user = vi.hoisted(() => ({current: null as null | { role: string }}));
vi.mock("@/lib/auth/current-user", () => ({currentUser: async () => user.current}));
vi.mock("next/navigation", () => ({usePathname: () => "/dashboard/home", notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));

import {ForkSidebarGroups} from "@/fork/ui/fork-sidebar-groups";

const ON = () => { process.env.FORK_STACKS_ENABLED = "true"; };

describe("<ForkSidebarGroups/> rendered output (flags-off parity, P05)", () => {
    beforeEach(() => { user.current = {role: "superadmin"}; });

    it("flags off: renders NOTHING (empty markup), without even reading the session", async () => {
        const el = await ForkSidebarGroups();
        expect(el).toBeNull();
        expect(renderToStaticMarkup(<>{el}</>)).toBe("");
    });

    it("flags on + system admin: Stack Recovery group with exactly the Integrations link, no badge", async () => {
        ON();
        const el = await ForkSidebarGroups();
        const {container} = render(<SidebarProvider>{el}</SidebarProvider>);
        const links = [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
        expect(links).toEqual([["Integrations", "/dashboard/integrations"]]);
        expect(container.textContent).toContain("Stack Recovery");
        expect(container.textContent).not.toMatch(/\bNew\b|beta/i);
        expect(container.textContent).not.toMatch(/Docker Stacks|Recovery$/m);
        // `list`/`listitem`: markup inherited from upstream SidebarMenuCustomBase (<li> inside <div>); same on
        // upstream's own groups. Everything else must be clean (new violations fail this test).
        expect(await axeViolations(container, ["list", "listitem"])).toEqual([]);
    });

    it("flags on + non-admin / pending / anonymous: renders nothing", async () => {
        ON();
        for (const u of [{role: "user"}, {role: "pending"}, null]) {
            user.current = u;
            expect(await ForkSidebarGroups()).toBeNull();
        }
    });

    it("locked mode renders no navigation in W01", async () => {
        const {registerActivePolicyProbe} = await import("@/fork/mode");
        registerActivePolicyProbe(async () => 1); // flags off + active policy
        expect(await ForkSidebarGroups()).toBeNull();
    });
});
