"use server";

import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {getForkPrincipal} from "@/fork/principal";
import type {RestoreRunDeps} from "@/fork/restore-run/deps";
import {approveRestorePolicy, cancelRestoreRun, cleanupRestoreRun, startRestoreRun} from "@/fork/restore-run/service";
import {getRestoreRunView, listRestoreRuns} from "@/fork/restore-run/view";
import {userAction} from "@/lib/safe-actions/actions";
import {getServerUrl} from "@/utils/get-server-url";
import {z} from "zod";

/**
 * Restore orchestrator server actions (W18a): thin wrappers like the W16 / W15 ones (signed-in user → service: resource-scoped capability, rate limit, locked-mode
 * gate, audit). Next's server-action origin check is the CSRF guard; there is NO API route for runs. Input is validated INSIDE the services with strict schemas;
 * the action only forwards `unknown`. The wizard UI is W18b.
 */
const deps = async (): Promise<RestoreRunDeps> => ({db: await appDb(), principal: await getForkPrincipal(), keys: fileKeyProvider, serverUrl: getServerUrl});

export const startRestoreRunAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => startRestoreRun(await deps(), parsedInput));
export const approveRestorePolicyAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => approveRestorePolicy(await deps(), parsedInput));
export const cancelRestoreRunAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => cancelRestoreRun(await deps(), parsedInput));
export const cleanupRestoreRunAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => cleanupRestoreRun(await deps(), parsedInput));
export const getRestoreRunViewAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => getRestoreRunView(await deps(), parsedInput));
export const listRestoreRunsAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => listRestoreRuns(await deps(), parsedInput));
