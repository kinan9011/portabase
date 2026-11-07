"use server";

import {appDb} from "@/fork/db/handle";
import {materializeStack, type MaterializeDeps} from "@/fork/materialize/apply";
import {removeStackSources} from "@/fork/materialize/remove";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";
import {z} from "zod";

/**
 * Materializer server actions (W10). Thin wrappers like the connection/environment actions: signed-in user → `materialize/apply.ts` /
 * `remove.ts` (system admin, resource-scoped, upstream-equivalent agent ACL, D21 gate, rate limit, audit). The wizard that calls them is W11;
 * until then nothing in the UI invokes them, so no control can claim a success that did not happen. Input is validated INSIDE the services
 * (strict schemas), the action only forwards `unknown`.
 */
const deps = async (): Promise<MaterializeDeps> => ({db: await appDb(), principal: await getForkPrincipal()});

export const materializeStackAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => materializeStack(await deps(), parsedInput));
export const removeStackSourcesAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => removeStackSources(await deps(), parsedInput));
