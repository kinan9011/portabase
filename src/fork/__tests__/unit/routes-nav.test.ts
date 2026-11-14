import {describe, expect, it} from "vitest";
import {forkPageHidden, forkRoutePatterns} from "@/fork/routes";
import {buildForkNav, FORK_NAV_DEFS} from "@/fork/nav";

const matches = (src: Record<string, string | undefined>, p: string) => forkRoutePatterns(src).some((r) => r.test(p));

describe("proxy allowlist hook (P04)", () => {
    it("flags off: no /api/fork/* is allowlisted", () => {
        expect(forkRoutePatterns({})).toEqual([]);
        expect(matches({}, "/api/fork/status")).toBe(false);
    });
    it("flag on: /api/fork/ prefix passes the allowlist, nothing else", () => {
        const on = {FORK_ARCANE_ENABLED: "true"};
        expect(matches(on, "/api/fork/status")).toBe(true);
        expect(matches(on, "/api/fork/x/y")).toBe(true);
        expect(matches(on, "/api/forkx")).toBe(false);
        expect(matches(on, "/api/v1/forkish")).toBe(false);
        expect(matches(on, "/api/agent/1/fork")).toBe(false);
    });
});

describe("proxy page gate (P04, real 404 status)", () => {
    const on = {FORK_ARCANE_ENABLED: "true"};
    it("integrations page hidden unless flag on AND system admin", () => {
        expect(forkPageHidden("/dashboard/integrations", "admin", {})).toBe(true);
        expect(forkPageHidden("/dashboard/integrations", "superadmin", {})).toBe(true);
        expect(forkPageHidden("/dashboard/integrations", "user", on)).toBe(true);
        expect(forkPageHidden("/dashboard/integrations/x", "pending", on)).toBe(true);
        expect(forkPageHidden("/dashboard/integrations", undefined, on)).toBe(true);
        expect(forkPageHidden("/dashboard/integrations", "admin", on)).toBe(false);
        expect(forkPageHidden("/dashboard/integrations", "superadmin", on)).toBe(false);
    });
    it("W08: /dashboard/stacks[/id] is a member page: real 404 with every flag off, reachable (the page decides who) with any flag on, for any role", () => {
        const on = {FORK_STACKS_ENABLED: "true"};
        for (const p of ["/dashboard/stacks", "/dashboard/stacks/", "/dashboard/stacks/0b7e1c1e-7f3a-4b6e-9a40-111111111111"]) {
            for (const role of ["user", "admin", "superadmin", "pending", undefined]) {
                expect(forkPageHidden(p, role, {}), `${p} ${role} off`).toBe(true);
                expect(forkPageHidden(p, role, on), `${p} ${role} on`).toBe(false);
            }
        }
        expect(forkPageHidden("/dashboard/stacksx", "user", {})).toBe(false); // not ours
        for (const p of ["/dashboard/recovery", "/dashboard/recovery/new", "/dashboard/recovery/plans/x", "/dashboard/recovery/runs/x"]) {
            expect(forkPageHidden(p, "user", {}), p).toBe(true); // W18b: flags off ⇒ real 404
            expect(forkPageHidden(p, "user", {FORK_STACKS_ENABLED: "true"}), p).toBe(false);
        }
        expect(forkPageHidden("/dashboard/recoveryx", "user", {})).toBe(false); // not ours
        for (const p of ["/dashboard/mirrors", "/dashboard/mirrors/new", "/dashboard/mirrors/0b7e1c1e-7f3a-4b6e-9a40-111111111111"]) {
            expect(forkPageHidden(p, "user", {}), p).toBe(true); // W22b: flags off ⇒ real 404
            expect(forkPageHidden(p, "user", {FORK_MIRRORS_ENABLED: "true"}), p).toBe(false);
        }
        expect(forkPageHidden("/dashboard/mirrorsx", "user", {})).toBe(false);
    });
    it("never touches upstream pages", () => {
        for (const p of ["/dashboard/home", "/dashboard/agents", "/dashboard/integrationsx", "/dashboard"]) expect(forkPageHidden(p, "user", {})).toBe(false);
    });
});

describe("sidebar nav model", () => {
    const sys = {systemRole: "admin"};
    it("off and locked render no navigation", () => {
        expect(buildForkNav("off", sys)).toEqual([]);
        expect(buildForkNav("locked", sys)).toEqual([]);
    });
    it("on + system admin WITHOUT an org membership sees Integrations and Agent channel (stacks.view needs membership)", () => {
        const g = buildForkNav("on", sys);
        expect(g).toEqual([{label: "Stack Recovery", items: [
            {title: "Integrations", url: "/integrations", iconKey: "plug"},
            {title: "Agent channel", url: "/integrations/agent-channel", iconKey: "radio"},
        ]}]);
    });
    it("W08: any org member sees Docker Stacks; a system admin who is also a member sees both", () => {
        const stacks = {title: "Docker Stacks", url: "/stacks", iconKey: "layers"};
        const recovery = {title: "Recovery", url: "/recovery", iconKey: "life-buoy"}; // W18b (D13): `recovery.view` is member+
        for (const orgRole of ["member", "admin", "owner"]) expect(buildForkNav("on", {systemRole: "user", orgRole})).toEqual([{label: "Stack Recovery", items: [stacks, recovery]}]);
        expect(buildForkNav("on", {systemRole: "admin", orgRole: "owner"})[0].items.map((i) => i.title)).toEqual(["Integrations", "Agent channel", "Docker Stacks", "Recovery"]);
    });
    it("pending, non-member users and anonymous see nothing", () => {
        expect(buildForkNav("on", {systemRole: "user"})).toEqual([]);
        expect(buildForkNav("on", {systemRole: "pending"})).toEqual([]);
        expect(buildForkNav("on", null)).toEqual([]);
    });
    it("W18b: Recovery is shipped and shown behind the flag + permission; items of unshipped waves would never render", () => {
        const hidden = FORK_NAV_DEFS.filter((d) => !d.shipped).map((d) => d.title);
        expect(hidden).toEqual([]);
        const titles = buildForkNav("on", {systemRole: "superadmin", orgRole: "owner"}).flatMap((g) => g.items.map((i) => i.title));
        expect(titles).toEqual(["Integrations", "Agent channel", "Docker Stacks", "Recovery"]);
        expect(buildForkNav("on", {systemRole: "admin"}).flatMap((g) => g.items.map((i) => i.title))).not.toContain("Recovery"); // no org membership ⇒ no recovery.view
        expect(buildForkNav("locked", {systemRole: "superadmin", orgRole: "owner"})).toEqual([]); // OD-W18b-4: no Recovery nav while locked
        expect(buildForkNav("off", {systemRole: "superadmin", orgRole: "owner"})).toEqual([]);
    });
    it("model is serialisable (no component functions cross the server/client boundary)", () => {
        expect(JSON.parse(JSON.stringify(buildForkNav("on", sys)))).toEqual(buildForkNav("on", sys));
    });
});
