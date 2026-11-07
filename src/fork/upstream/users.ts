import {eq} from "drizzle-orm";
import type {ForkPrincipal} from "@/fork/acl";
import type {ForkDb} from "@/fork/db/handle";
import {member} from "@/db/schema/04_member";
import {user} from "@/db/schema/02_user";

/**
 * Principal of a user id, read from the database (run-time re-authorization, D31/F7): a scheduled run has no session, the
 * authorization record names the activating user and THEIR CURRENT rights are checked. Same rule as `getForkPrincipal`:
 * pending / banned accounts hold no rights.
 */
export type PrincipalLookup = {kind: "ok"; principal: ForkPrincipal} | {kind: "missing"} | {kind: "blocked"};

export async function readPrincipal(db: ForkDb, userId: string): Promise<PrincipalLookup> {
    const [u] = await db.select({id: user.id, role: user.role, banned: user.banned}).from(user).where(eq(user.id, userId)).limit(1);
    if (!u) return {kind: "missing"};
    if (u.banned || u.role === "pending") return {kind: "blocked"};
    const rows = await db.select({organizationId: member.organizationId, role: member.role}).from(member).where(eq(member.userId, u.id));
    return {kind: "ok", principal: {userId: u.id, systemRole: u.role, memberships: rows}};
}
