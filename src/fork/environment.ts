import {eq} from "drizzle-orm";
import {assertForkResource} from "@/fork/resource-scope";
import type {ForkPrincipal} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {HOST_ROLES, type HostRole} from "@/fork/db/enums";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {assertForkConfigAllowed} from "@/fork/mode";

/**
 * SEC-11: `host_role` is set by a SYSTEM ADMIN only (capability `host_role.manage`, server-side, resource-scoped),
 * values `production` | `test` (D44; `runner` arrives in R3/W21), refused while configuration is locked, always audited
 * (denied attempts too). New environments default to `production` (column default + CHECK).
 */
export async function setEnvironmentHostRole(db: ForkDb, principal: ForkPrincipal | null, environmentId: string, role: unknown): Promise<{hostRole: HostRole}> {
    await assertForkConfigAllowed();
    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(db, principal, "host_role.manage", {kind: "environment", id: environmentId}));
    } catch (e) {
        await recordAudit(db, {actorUserId: principal?.userId, action: "fork.host_role.set", resourceType: "environment", resourceId: environmentId, result: "denied"});
        throw e;
    }
    if (typeof role !== "string" || !(HOST_ROLES as readonly string[]).includes(role)) {
        await recordAudit(db, {organizationId, actorUserId: principal?.userId, action: "fork.host_role.set", resourceType: "environment", resourceId: environmentId, result: "failure", details: {reason: "invalid-role"}});
        throw new Error("invalid host_role");
    }
    const [before] = await db.select({hostRole: forkArcaneEnvironment.hostRole}).from(forkArcaneEnvironment).where(eq(forkArcaneEnvironment.id, environmentId));
    await db.update(forkArcaneEnvironment).set({hostRole: role, updatedAt: new Date()}).where(eq(forkArcaneEnvironment.id, environmentId));
    await recordAudit(db, {organizationId, actorUserId: principal?.userId, action: "fork.host_role.set", resourceType: "environment", resourceId: environmentId, result: "success", details: {from: before?.hostRole, to: role}});
    return {hostRole: role as HostRole};
}
