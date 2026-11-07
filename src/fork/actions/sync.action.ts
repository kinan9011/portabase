"use server";

import type {ServiceDeps} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {SyncInputSchema, syncNow} from "@/fork/discovery/sync";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";

/**
 * "Sync now" server action (W07). Thin wrapper like the connection actions: signed-in user → `discovery/sync.ts#syncNow`
 * (system admin, resource-scoped, D21 gate, rate limit, DB lease, audit). The result is code-only (no Arcane text).
 */
const deps = async (): Promise<ServiceDeps> => ({db: await appDb(), principal: await getForkPrincipal()});

export const syncArcaneNowAction = userAction.inputSchema(SyncInputSchema).action(async ({parsedInput}) => syncNow(await deps(), parsedInput));
