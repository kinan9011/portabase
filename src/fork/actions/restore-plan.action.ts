"use server";

import {appDb} from "@/fork/db/handle";
import {getForkPrincipal} from "@/fork/principal";
import {approveRestorePlan, createRestorePlan, getRestorePlanView, setStackPrivacy, type RestoreDeps} from "@/fork/restore/service";
import {userAction} from "@/lib/safe-actions/actions";
import {z} from "zod";

/**
 * Restore plan server actions (W16): thin wrappers like the W12 run actions (signed-in user → `restore/service.ts`: resource-scoped capability,
 * rate limit, locked-mode gate, audit). Dry-run only: nothing here changes a host, a storage or an agent. Next's server-action origin check is
 * the CSRF guard (no API route exists for plans). Input is validated INSIDE the service with strict schemas; the action only forwards `unknown`.
 */
const deps = async (): Promise<RestoreDeps> => ({db: await appDb(), principal: await getForkPrincipal()});

export const createRestorePlanAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => createRestorePlan(await deps(), parsedInput));
export const approveRestorePlanAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => approveRestorePlan(await deps(), parsedInput));
export const getRestorePlanViewAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => getRestorePlanView(await deps(), parsedInput));
export const setStackPrivacyAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => setStackPrivacy(await deps(), parsedInput));
