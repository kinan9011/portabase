import {describe, expect, it} from "vitest";
import {actorIn, FORK_CAPABILITIES, forkCan, type ForkCapability, type ForkPrincipal} from "@/fork/acl";
import {ROLES, R, type Role} from "../../security/roles";

/**
 * Pins today's ACL (RULES in src/fork/acl.ts) against the hand-written oracle the matrix uses: changing a rule must be a deliberate diff here.
 * A system admin WITHOUT a membership does not hold the org-scoped capabilities (pinned current behaviour, not a bug).
 */
const ORG = "00000000-0000-4000-8000-0000000000aa";
const principal = (role: Role): ForkPrincipal | null => {
    switch (role) {
        case "anon": case "pending": case "banned": return null; // getForkPrincipal() returns null for all three
        case "member": return {userId: "u", systemRole: "user", memberships: [{organizationId: ORG, role: "member"}]};
        case "orgAdmin": return {userId: "u", systemRole: "user", memberships: [{organizationId: ORG, role: "admin"}]};
        case "owner": return {userId: "u", systemRole: "user", memberships: [{organizationId: ORG, role: "owner"}]};
        case "sysAdmin": return {userId: "u", systemRole: "admin", memberships: []};
        case "superOwner": return {userId: "u", systemRole: "superadmin", memberships: [{organizationId: ORG, role: "owner"}]};
    }
};
const rolesFor = (cap: string): Role[] => ROLES.filter((r) => forkCan(actorIn(principal(r), ORG), cap));

const EXPECTED: Record<ForkCapability, readonly Role[]> = {
    "stacks.view": R.memberPlus, "recovery.view": R.memberPlus, "mirrors.view": R.memberPlus,
    "arcane.manage": R.sysAdminOnly, "stacks.backup.manage": R.sysAdminOnly, "recovery.kit.manage": R.sysAdminOnly, "host_role.manage": R.sysAdminOnly, "agents.channel.manage": R.sysAdminOnly,
    "backup.run": R.adminPlus, "restore.plan": R.adminPlus, "restore.execute": R.adminPlus, "mirrors.manage": R.adminPlus,
    "restore.production.approve": R.ownerOrSysAdmin, "repository.prune": R.ownerOrSysAdmin,
};

describe("SEC-09 ACL oracle", () => {
    it("every capability is pinned (a new capability must be added to the oracle)", () => {
        expect(Object.keys(EXPECTED).sort()).toEqual([...FORK_CAPABILITIES].sort());
    });
    it.each(FORK_CAPABILITIES)("%s is held by exactly the pinned roles", (cap) => {
        expect(rolesFor(cap)).toEqual(ROLES.filter((r) => EXPECTED[cap].includes(r)));
    });
    it("deny by default: unknown capability, null actor, prototype-key capability", () => {
        for (const cap of ["", "nope", "toString", "__proto__", "constructor"]) for (const r of ROLES) expect(forkCan(actorIn(principal(r), ORG), cap), `${r}/${cap}`).toBe(false);
        expect(forkCan(null, "stacks.view")).toBe(false);
        expect(forkCan(undefined, "stacks.view")).toBe(false);
    });
    it("a member of ANOTHER organization holds nothing here", () => {
        const foreign: ForkPrincipal = {userId: "u", systemRole: "user", memberships: [{organizationId: "00000000-0000-4000-8000-0000000000bb", role: "owner"}]};
        for (const cap of FORK_CAPABILITIES) expect(forkCan(actorIn(foreign, ORG), cap), cap).toBe(false);
    });
});
