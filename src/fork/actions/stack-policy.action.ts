"use server";

import {appDb} from "@/fork/db/handle";
import type {MaterializeDeps} from "@/fork/materialize/apply";
import {getForkPrincipal} from "@/fork/principal";
import {activateStackPolicy} from "@/fork/stack-policy/activate";
import {userAction} from "@/lib/safe-actions/actions";
import {z} from "zod";

/**
 * Activate-policy server action (W11): the ONLY mutation of the Configure Backup form. Thin wrapper like the W05/W06/W10 actions: signed-in
 * user → `stack-policy/activate.ts` (system admin, resource-scoped, D39, §4.5, D21, D31, rate limit, audit). Next's server-action origin check
 * is the CSRF guard (no `/api/fork` route exists for it). Input is validated INSIDE the service with strict schemas; the action only forwards
 * `unknown`, and never logs it (it may carry a database password).
 */
const deps = async (): Promise<MaterializeDeps> => ({db: await appDb(), principal: await getForkPrincipal()});

export const activateStackPolicyAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => activateStackPolicy(await deps(), parsedInput));
