/**
 * Fork capabilities (01-Fork-Strategy "Permissions", plan v2.2 D21).
 * Deny by default: unknown capability, unknown role, null actor ⇒ false.
 * Must be evaluated server-side (server components, actions, route handlers), never client-only.
 */
export const FORK_CAPABILITIES = [
    "stacks.view",
    "recovery.view",
    "mirrors.view",
    "arcane.manage",
    "stacks.backup.manage",
    "recovery.kit.manage",
    "host_role.manage",
    "backup.run",
    "restore.plan",
    "restore.execute",
    "mirrors.manage",
    "restore.production.approve",
    "repository.prune",
] as const;

export type ForkCapability = (typeof FORK_CAPABILITIES)[number];

export type ForkActor = {
    /** `user.role` (system role: superadmin | admin | user | pending). */
    systemRole?: string | null;
    /** Member role in the (single) organization: owner | admin | member. */
    orgRole?: string | null;
};

const isSystemAdmin = (a: ForkActor) => a.systemRole === "admin" || a.systemRole === "superadmin";
const isOrgMemberPlus = (a: ForkActor) => a.orgRole === "member" || a.orgRole === "admin" || a.orgRole === "owner";
const isOrgAdminPlus = (a: ForkActor) => a.orgRole === "admin" || a.orgRole === "owner";
const isOrgOwner = (a: ForkActor) => a.orgRole === "owner";

const RULES: Record<ForkCapability, (a: ForkActor) => boolean> = {
    "stacks.view": isOrgMemberPlus,
    "recovery.view": isOrgMemberPlus,
    "mirrors.view": isOrgMemberPlus,
    // Fork configuration = system admin ONLY (D21), regardless of org role.
    "arcane.manage": isSystemAdmin,
    "stacks.backup.manage": isSystemAdmin,
    "recovery.kit.manage": isSystemAdmin,
    "host_role.manage": isSystemAdmin,
    "backup.run": isOrgAdminPlus,
    "restore.plan": isOrgAdminPlus,
    "restore.execute": isOrgAdminPlus,
    "mirrors.manage": isOrgAdminPlus,
    "restore.production.approve": (a) => isOrgOwner(a) || isSystemAdmin(a),
    "repository.prune": (a) => isOrgOwner(a) || isSystemAdmin(a),
};

export function forkCan(actor: ForkActor | null | undefined, capability: string): boolean {
    if (!actor) return false;
    if (!Object.hasOwn(RULES, capability)) return false;
    return RULES[capability as ForkCapability](actor) === true;
}
