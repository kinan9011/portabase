"use server";

import {clearRestoreOverrides, getRestoreOverridesView, setRestoreOverrides, type OverrideDeps} from "@/fork/config/service";
import {appDb} from "@/fork/db/handle";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";
import {z} from "zod";

/**
 * Restore-time override server actions (W16b, D28): thin wrappers like `restore-plan.action.ts` (signed-in user → `config/service.ts`: resource-scoped
 * `restore.plan`, rate limit, locked-mode gate, audit). The request body carries the secret values INTO the service; no outcome ever carries one back
 * (names, booleans and counts only). Next's server-action origin check is the CSRF guard — there is no API route and no GET that mutates.
 */
const deps = async (): Promise<OverrideDeps> => ({db: await appDb(), principal: await getForkPrincipal()});

export const setRestoreOverridesAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => setRestoreOverrides(await deps(), parsedInput));
export const clearRestoreOverridesAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => clearRestoreOverrides(await deps(), parsedInput));
export const getRestoreOverridesViewAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => getRestoreOverridesView(await deps(), parsedInput));
