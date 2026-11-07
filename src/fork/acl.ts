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

// ---- W04: principals, org-scoped capability assertion, resource-scoped (IDOR-safe) access --------------------------------

/** Who is calling: the user's system role plus EVERY organization membership (single tenant in v1, but never assumed). */
export type ForkPrincipal = {
    userId: string;
    systemRole?: string | null;
    memberships: {organizationId: string; role: string}[];
};

/** Same error for "does not exist" and "exists in another organization": no existence oracle (SEC-12). */
export class ForkNotFoundError extends Error {
    constructor() {
        super("not found");
        this.name = "ForkNotFoundError";
    }
}

export class ForkForbiddenError extends Error {
    constructor(public readonly capability: string) {
        super("forbidden");
        this.name = "ForkForbiddenError";
    }
}

/** The actor as seen inside ONE organization (orgRole is the membership role in that org, null if none). */
export function actorIn(principal: ForkPrincipal | null | undefined, organizationId: string): ForkActor | null {
    if (!principal) return null;
    const m = principal.memberships.find((x) => x.organizationId === organizationId);
    return {systemRole: principal.systemRole ?? null, orgRole: m?.role ?? null};
}

/** Throws ForkForbiddenError unless `principal` holds `capability` for `organizationId` (deny by default). */
export function assertForkCapability(principal: ForkPrincipal | null | undefined, organizationId: string, capability: string): void {
    if (!forkCan(actorIn(principal, organizationId), capability)) throw new ForkForbiddenError(capability);
}

/**
 * Resource kinds that carry an ID from the client. The owning organization is ALWAYS loaded from the row (never
 * trusted from the request) and the capability is checked against THAT organization.
 */
export const FORK_RESOURCE_KINDS = ["connection", "environment", "stack", "stack_inventory", "recovery_point", "recovery_point_artifact", "stack_run"] as const;
export type ForkResourceKind = (typeof FORK_RESOURCE_KINDS)[number];
