"use server";

import {appDb} from "@/fork/db/handle";
import {getForkPrincipal} from "@/fork/principal";
import {cancelStackRun, startStackRun, type RunDepsWithPrincipal} from "@/fork/runs/run-service";
import {userAction} from "@/lib/safe-actions/actions";
import {z} from "zod";

/**
 * Run server actions (W12): thin wrappers like the W05/W06/W10/W11 ones (signed-in user → `runs/run-service.ts`: `backup.run`, resource-scoped,
 * rate limit, F7 re-authorization, audit). Next's server-action origin check is the CSRF guard. Input is validated INSIDE the service with
 * strict schemas; the action only forwards `unknown`.
 */
const deps = async (): Promise<RunDepsWithPrincipal> => ({db: await appDb(), principal: await getForkPrincipal()});

export const startStackRunAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => startStackRun(await deps(), parsedInput));
export const cancelStackRunAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => cancelStackRun(await deps(), parsedInput));
