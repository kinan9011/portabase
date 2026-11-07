import {describe, expect, it} from "vitest";
import {FORK_CAPABILITIES, forkCan, type ForkActor, type ForkCapability} from "@/fork/acl";

const ACTORS: Record<string, ForkActor> = {
    nobody: {},
    pendingUser: {systemRole: "pending", orgRole: "member"},
    plainUser: {systemRole: "user"},
    orgMember: {systemRole: "user", orgRole: "member"},
    orgAdmin: {systemRole: "user", orgRole: "admin"},
    orgOwner: {systemRole: "user", orgRole: "owner"},
    sysAdmin: {systemRole: "admin"},
    superAdmin: {systemRole: "superadmin"},
    ownerAndSysAdmin: {systemRole: "admin", orgRole: "owner"},
};

// expected allowed capabilities per actor (the 01-Fork-Strategy table, D21)
const VIEW: ForkCapability[] = ["stacks.view", "recovery.view", "mirrors.view"];
const SYS_ONLY: ForkCapability[] = ["arcane.manage", "stacks.backup.manage", "recovery.kit.manage", "host_role.manage", "agents.channel.manage"];
const ADMIN_PLUS: ForkCapability[] = ["backup.run", "restore.plan", "restore.execute", "mirrors.manage"];
const OWNER_PLUS: ForkCapability[] = ["restore.production.approve", "repository.prune"];

const EXPECTED: Record<string, ForkCapability[]> = {
    nobody: [],
    pendingUser: VIEW, // role in org only; a pending system user without org role is covered by plainUser
    plainUser: [],
    orgMember: VIEW,
    orgAdmin: [...VIEW, ...ADMIN_PLUS],
    orgOwner: [...VIEW, ...ADMIN_PLUS, ...OWNER_PLUS],
    sysAdmin: [...SYS_ONLY, ...OWNER_PLUS],
    superAdmin: [...SYS_ONLY, ...OWNER_PLUS],
    ownerAndSysAdmin: [...VIEW, ...ADMIN_PLUS, ...OWNER_PLUS, ...SYS_ONLY],
};

describe("fork ACL (deny by default)", () => {
    for (const [name, actor] of Object.entries(ACTORS)) {
        it(`${name}: exactly the expected capabilities`, () => {
            const got = FORK_CAPABILITIES.filter((c) => forkCan(actor, c)).sort();
            expect(got).toEqual([...new Set(EXPECTED[name])].sort());
        });
    }
    it("fork configuration is system-admin only: no org role grants it (D21)", () => {
        for (const orgRole of ["member", "admin", "owner"]) {
            for (const c of SYS_ONLY) expect(forkCan({systemRole: "user", orgRole}, c)).toBe(false);
        }
    });
    it("denies null/undefined actor, unknown capability and prototype keys", () => {
        expect(forkCan(null, "arcane.manage")).toBe(false);
        expect(forkCan(undefined, "stacks.view")).toBe(false);
        expect(forkCan(ACTORS.superAdmin, "does.not.exist")).toBe(false);
        expect(forkCan(ACTORS.superAdmin, "toString")).toBe(false);
        expect(forkCan(ACTORS.superAdmin, "__proto__")).toBe(false);
    });
    it("every capability has a rule (table is complete)", () => {
        for (const c of FORK_CAPABILITIES) expect(() => forkCan(ACTORS.sysAdmin, c)).not.toThrow();
    });
});
