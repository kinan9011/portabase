import {eq} from "drizzle-orm";
import {currentUser} from "@/lib/auth/current-user";
import {member} from "@/db/schema/04_member";
import type {ForkPrincipal} from "@/fork/acl";
import {appDb} from "@/fork/db/handle";

/** The signed-in user as a ForkPrincipal (system role + all memberships), or null. Pending/banned accounts hold no rights (same rule as `userAction`). */
export async function getForkPrincipal(): Promise<ForkPrincipal | null> {
    const user = await currentUser();
    if (!user || user.banned || user.role === "pending") return null;
    const rows = await (await appDb()).select({organizationId: member.organizationId, role: member.role}).from(member).where(eq(member.userId, user.id));
    return {userId: user.id, systemRole: user.role, memberships: rows};
}
