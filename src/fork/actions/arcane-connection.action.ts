"use server";

import {
    disconnect, DisconnectInputSchema, rotateKey, RotateInputSchema, saveConnection, SaveInputSchema, testConnection, TestInputSchema, type ServiceDeps,
} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";

/**
 * Arcane connection server actions (W05; UI = W06). Thin wrappers: signed-in user (`userAction`: pending/banned excluded) →
 * `src/fork/arcane/connection-service.ts`, which enforces the fork ACL (`arcane.manage` = system admin only, resource-scoped,
 * no existence oracle), the D21 self-check gate, the rate limit, the SEC-10 rules and writes the audit rows.
 *
 * Results are `Outcome` unions (ConnectionDto — never the key — + verification summary or a refusal with a stable `code`);
 * unexpected errors surface as next-safe-action's generic `serverError`. The API key travels ONLY in the input of
 * save/rotate: it is never echoed, stored in a DTO, audit row, log line or error message.
 * Next.js applies its built-in same-origin (Origin/Host) check to server actions, so `forkCsrfGuard` (route handlers) is not used here.
 */
const deps = async (): Promise<ServiceDeps> => ({db: await appDb(), principal: await getForkPrincipal()});

export const saveArcaneConnectionAction = userAction.inputSchema(SaveInputSchema).action(async ({parsedInput}) => saveConnection(await deps(), parsedInput));
export const testArcaneConnectionAction = userAction.inputSchema(TestInputSchema).action(async ({parsedInput}) => testConnection(await deps(), parsedInput));
export const rotateArcaneKeyAction = userAction.inputSchema(RotateInputSchema).action(async ({parsedInput}) => rotateKey(await deps(), parsedInput));
export const disconnectArcaneAction = userAction.inputSchema(DisconnectInputSchema).action(async ({parsedInput}) => disconnect(await deps(), parsedInput));
