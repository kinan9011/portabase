"use server";

import {EnvironmentUpdateSchema, updateEnvironment} from "@/fork/arcane/environment-service";
import type {ServiceDeps} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";

/**
 * Environment settings server action (W06): enable toggle, agent mapping, host role. Thin wrapper like the connection actions
 * (`arcane-connection.action.ts`): signed-in user → `environment-service.ts` (ACL, D21 gate, SEC-11, audit).
 */
const deps = async (): Promise<ServiceDeps> => ({db: await appDb(), principal: await getForkPrincipal()});

export const updateArcaneEnvironmentAction = userAction.inputSchema(EnvironmentUpdateSchema).action(async ({parsedInput}) => updateEnvironment(await deps(), parsedInput));
