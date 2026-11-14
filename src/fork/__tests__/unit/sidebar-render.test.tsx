// @vitest-environment jsdom
import {render} from "@testing-library/react";
import {renderToStaticMarkup} from "react-dom/server";
import {axeViolations} from "@/fork/__tests__/axe";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {SidebarProvider} from "@/components/ui/sidebar";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const user = vi.hoisted(() => ({current: null as null | {systemRole: string; orgRole: string | null}}));
vi.mock("@/fork/principal", () => ({getForkPrincipal: async () => (user.current ? {userId: "u", systemRole: user.current.systemRole, memberships: user.current.orgRole ? [{organizationId: ORG, role: user.current.orgRole}] : []} : null)}));
vi.mock("@/fork/db/handle", () => ({appDb: async () => ({})}));
vi.mock("@/fork/arcane/connection-service", () => ({soleOrganization: async () => ORG}));
vi.mock("next/navigation", () => ({usePathname: () => "/dashboard/home", notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));

import {ForkSidebarGroups} from "@/fork/ui/fork-sidebar-groups";

const ON = () => { process.env.FORK_STACKS_ENABLED = "true"; };

describe("<ForkSidebarGroups/> rendered output (flags-off parity, P05)", () => {
    beforeEach(() => { user.current = {systemRole: "superadmin", orgRole: null}; });

    it("flags off: renders NOTHING (empty markup), without even reading the session", async () => {
        const el = await ForkSidebarGroups();
        expect(el).toBeNull();
        expect(renderToStaticMarkup(<>{el}</>)).toBe("");
    });

    it("flags on + system admin: Stack Recovery group with the Integrations and Agent channel links, no badge", async () => {
        ON();
        const el = await ForkSidebarGroups();
        const {container} = render(<SidebarProvider>{el}</SidebarProvider>);
        const links = [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
        expect(links).toEqual([["Integrations", "/dashboard/integrations"], ["Agent channel", "/dashboard/integrations/agent-channel"]]);
        expect(container.textContent).toContain("Stack Recovery");
        expect(container.textContent).not.toMatch(/\bNew\b|beta/i);
        expect(container.textContent).not.toMatch(/Docker Stacks|Recovery$/m); // no org membership ⇒ no stacks link
        // `list`/`listitem`: markup inherited from upstream SidebarMenuCustomBase (<li> inside <div>); same on
        // upstream's own groups. Everything else must be clean (new violations fail this test).
        expect(await axeViolations(container, ["list", "listitem"])).toEqual([]);
    });

    it("W08: an org MEMBER (non system admin) sees exactly Docker Stacks; a system admin who is also a member sees both", async () => {
        ON();
        user.current = {systemRole: "user", orgRole: "member"};
        let {container, unmount} = render(<SidebarProvider>{await ForkSidebarGroups()}</SidebarProvider>);
        expect([...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Docker Stacks", "/dashboard/stacks"], ["Recovery", "/dashboard/recovery"]]); // W18b (D13): Recovery is member+ and shipped
        expect(await axeViolations(container, ["list", "listitem"])).toEqual([]);
        unmount();
        user.current = {systemRole: "admin", orgRole: "owner"};
        ({container, unmount} = render(<SidebarProvider>{await ForkSidebarGroups()}</SidebarProvider>));
        expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/dashboard/integrations", "/dashboard/integrations/agent-channel", "/dashboard/stacks", "/dashboard/recovery"]);
        unmount();
    });

    it("W23: with FORK_MIRRORS_ENABLED an org member also sees the Test Mirrors link (no badge); without it the link is absent", async () => {
        ON();
        user.current = {systemRole: "user", orgRole: "member"};
        const hrefs = async () => { const {container, unmount} = render(<SidebarProvider>{await ForkSidebarGroups()}</SidebarProvider>); const out = [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]); const text = container.textContent ?? ""; unmount(); return {out, text}; };
        expect((await hrefs()).out).not.toContainEqual(["Test Mirrors", "/dashboard/mirrors"]);
        process.env.FORK_MIRRORS_ENABLED = "true";
        try {
            const r = await hrefs();
            expect(r.out).toEqual([["Docker Stacks", "/dashboard/stacks"], ["Recovery", "/dashboard/recovery"], ["Test Mirrors", "/dashboard/mirrors"]]);
            expect(r.text).not.toMatch(/\bNew\b|beta/i);
        } finally { delete process.env.FORK_MIRRORS_ENABLED; }
    });

    it("flags on + non-member user / pending / anonymous: renders nothing", async () => {
        ON();
        for (const u of [{systemRole: "user", orgRole: null}, null]) {
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
