"use server";

import {appDb} from "@/fork/db/handle";
import type {MaterializeDeps} from "@/fork/materialize/apply";
import {getForkPrincipal} from "@/fork/principal";
import {updateStackSchedule} from "@/fork/stack-policy/update-schedule";
import {userAction} from "@/lib/safe-actions/actions";
import {z} from "zod";

/**
 * Edit-schedule server action (W13): thin wrapper like the W11/W12 ones (signed-in user → `stack-policy/update-schedule.ts`: system admin, resource-scoped,
 * D21 gate, rate limit, audit). Next's server-action origin check is the CSRF guard. Input is validated INSIDE the service; the action only forwards `unknown`.
 */
const deps = async (): Promise<MaterializeDeps> => ({db: await appDb(), principal: await getForkPrincipal()});

export const updateStackScheduleAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => updateStackSchedule(await deps(), parsedInput));
