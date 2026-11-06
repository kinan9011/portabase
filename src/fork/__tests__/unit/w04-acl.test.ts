import {describe, expect, it} from "vitest";
import {actorIn, assertForkCapability, FORK_CAPABILITIES, ForkForbiddenError, forkCan, type ForkPrincipal} from "@/fork/acl";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P = (systemRole: string | null, ...m: [string, string][]): ForkPrincipal => ({userId: "u1", systemRole, memberships: m.map(([organizationId, role]) => ({organizationId, role}))});

const CONFIG_CAPS = ["arcane.manage", "stacks.backup.manage", "recovery.kit.manage", "host_role.manage"];

describe("W04 ACL matrix — org-scoped assertForkCapability", () => {
    it("fork configuration (incl. host_role, SEC-11) is system-admin only, whatever the org role", () => {
        for (const cap of CONFIG_CAPS) {
            for (const role of ["owner", "admin", "member"]) expect(() => assertForkCapability(P("user", [A, role]), A, cap), `${cap}/${role}`).toThrow(ForkForbiddenError);
            expect(() => assertForkCapability(P("admin"), A, cap)).not.toThrow();
            expect(() => assertForkCapability(P("superadmin"), A, cap)).not.toThrow();
        }
    });
    it("org roles in org A grant nothing in org B (membership is per organization)", () => {
        const p = P("user", [A, "owner"]);
        expect(() => assertForkCapability(p, A, "restore.production.approve")).not.toThrow();
        expect(() => assertForkCapability(p, B, "restore.production.approve")).toThrow(ForkForbiddenError);
        expect(() => assertForkCapability(p, B, "stacks.view")).toThrow(ForkForbiddenError);
        expect(actorIn(p, B)).toEqual({systemRole: "user", orgRole: null});
    });
    it("view = member+, run/plan/execute = admin+, prune/production-approve = owner or system admin", () => {
        expect(forkCan(actorIn(P("user", [A, "member"]), A), "stacks.view")).toBe(true);
        expect(forkCan(actorIn(P("user", [A, "member"]), A), "backup.run")).toBe(false);
        expect(forkCan(actorIn(P("user", [A, "admin"]), A), "backup.run")).toBe(true);
        expect(forkCan(actorIn(P("user", [A, "admin"]), A), "repository.prune")).toBe(false);
        expect(forkCan(actorIn(P("user", [A, "owner"]), A), "repository.prune")).toBe(true);
    });
    it("deny by default: null principal, pending role, unknown capability, member of nobody", () => {
        expect(() => assertForkCapability(null, A, "stacks.view")).toThrow(ForkForbiddenError);
        expect(() => assertForkCapability(P("pending"), A, "stacks.view")).toThrow(ForkForbiddenError);
        expect(() => assertForkCapability(P("admin"), A, "made.up")).toThrow(ForkForbiddenError);
        expect(() => assertForkCapability(P("admin"), A, "__proto__")).toThrow(ForkForbiddenError);
    });
    it("every declared capability has an explicit rule (nobody-by-accident)", () => {
        for (const cap of FORK_CAPABILITIES) expect(forkCan({systemRole: "superadmin", orgRole: "owner"}, cap), cap).toBe(true);
    });
});
