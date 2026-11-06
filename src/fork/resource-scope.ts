import {eq} from "drizzle-orm";
import {z} from "zod";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError, type ForkPrincipal, type ForkResourceKind} from "@/fork/acl";
import type {ForkDb} from "@/fork/db/handle";
import {forkArcaneConnection, forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {forkRecoveryPoint, forkRecoveryPointArtifact} from "@/fork/db/schema/recovery";
import {forkStack, forkStackInventory} from "@/fork/db/schema/stack";

/**
 * SEC-12 resource-scoped authorisation. Every fork route/action that receives a resource ID calls this BEFORE touching
 * the resource. Order matters for the no-oracle property:
 *   1. malformed id            → NotFound
 *   2. row missing             → NotFound
 *   3. row in an org where the caller has neither the capability nor (for system-admin-only capabilities) the system role → NotFound
 *   4. capability missing in the row's own org (caller is a member there) → Forbidden
 * A caller with no relation to the owning organization therefore can not tell "exists elsewhere" from "does not exist".
 */
const uuid = z.uuid();

async function owningOrg(db: ForkDb, kind: ForkResourceKind, id: string): Promise<string | null> {
    switch (kind) {
        case "connection": {
            const [r] = await db.select({o: forkArcaneConnection.organizationId}).from(forkArcaneConnection).where(eq(forkArcaneConnection.id, id));
            return r?.o ?? null;
        }
        case "environment": {
            const [r] = await db.select({o: forkArcaneConnection.organizationId}).from(forkArcaneEnvironment)
                .innerJoin(forkArcaneConnection, eq(forkArcaneConnection.id, forkArcaneEnvironment.connectionId)).where(eq(forkArcaneEnvironment.id, id));
            return r?.o ?? null;
        }
        case "stack": {
            const [r] = await db.select({o: forkStack.organizationId}).from(forkStack).where(eq(forkStack.id, id));
            return r?.o ?? null;
        }
        case "stack_inventory": {
            const [r] = await db.select({o: forkStack.organizationId}).from(forkStackInventory)
                .innerJoin(forkStack, eq(forkStack.id, forkStackInventory.stackId)).where(eq(forkStackInventory.id, id));
            return r?.o ?? null;
        }
        case "recovery_point": {
            const [r] = await db.select({o: forkStack.organizationId}).from(forkRecoveryPoint)
                .innerJoin(forkStack, eq(forkStack.id, forkRecoveryPoint.stackId)).where(eq(forkRecoveryPoint.id, id));
            return r?.o ?? null;
        }
        case "recovery_point_artifact": {
            const [r] = await db.select({o: forkStack.organizationId}).from(forkRecoveryPointArtifact)
                .innerJoin(forkRecoveryPoint, eq(forkRecoveryPoint.id, forkRecoveryPointArtifact.rpId))
                .innerJoin(forkStack, eq(forkStack.id, forkRecoveryPoint.stackId)).where(eq(forkRecoveryPointArtifact.id, id));
            return r?.o ?? null;
        }
    }
}

/** Resolves the resource's organization and authorises `capability` against it. Returns the organization id. */
export async function assertForkResource(
    db: ForkDb,
    principal: ForkPrincipal | null | undefined,
    capability: string,
    resource: {kind: ForkResourceKind; id: string},
): Promise<{organizationId: string}> {
    if (!principal || !uuid.safeParse(resource.id).success) throw new ForkNotFoundError();
    const organizationId = await owningOrg(db, resource.kind, resource.id);
    if (!organizationId) throw new ForkNotFoundError();
    const actor = actorIn(principal, organizationId);
    if (forkCan(actor, capability)) return {organizationId};
    // Not allowed. Member of that org → honest 403; otherwise indistinguishable from "missing".
    if (actor?.orgRole) throw new ForkForbiddenError(capability);
    throw new ForkNotFoundError();
}
