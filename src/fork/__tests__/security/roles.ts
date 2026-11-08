/** W27a SEC-09 (plan D-3): the eight principals the matrix runs every row against, plus the two IDOR columns for resource-scoped rows. */
export const ROLES = ["anon", "pending", "banned", "member", "orgAdmin", "owner", "sysAdmin", "superOwner"] as const;
export type Role = (typeof ROLES)[number];
export const IDOR = ["foreignOwner", "missingId"] as const;
export type Idor = (typeof IDOR)[number];

/** Who may call a capability today (the ORACLE: written by hand from 05-Security-Model, never computed from `forkCan`). */
export const R = {
    /** system administrators only (D21): `role` admin|superadmin, org role irrelevant */
    sysAdminOnly: ["sysAdmin", "superOwner"],
    /** organization member or above (`*.view`); a system admin WITHOUT a membership is not one (pinned current behaviour) */
    memberPlus: ["member", "orgAdmin", "owner", "superOwner"],
    /** organization admin or above (`backup.run`, `restore.plan`, `restore.execute`) */
    adminPlus: ["orgAdmin", "owner", "superOwner"],
    /** organization owner OR system admin (`restore.production.approve`, `repository.prune`) */
    ownerOrSysAdmin: ["owner", "sysAdmin", "superOwner"],
} as const satisfies Record<string, readonly Role[]>;
