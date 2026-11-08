import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {assertForkResource} from "@/fork/resource-scope";
import type {TestRestoreDeps} from "./deps";

export type {TestRestoreDeps};
/** `stacks.view` on the stack (members); unknown and foreign stack ids are indistinguishable (SEC-12). */
export async function assertViewable(d: TestRestoreDeps, stackId: string): Promise<{ok: true; organizationId: string} | {ok: false; code: "forbidden" | "not_found"}> {
    try {
        return {ok: true, organizationId: (await assertForkResource(d.db, d.principal ?? null, "stacks.view", {kind: "stack", id: stackId})).organizationId};
    } catch (e) {
        if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found"};
        if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden"};
        throw e;
    }
}
