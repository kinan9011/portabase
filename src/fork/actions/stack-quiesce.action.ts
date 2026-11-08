"use server";

import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {getForkPrincipal} from "@/fork/principal";
import {disableQuiesce, enableQuiesce, previewQuiesce, startNow, type QuiesceAdminDeps} from "@/fork/quiesce/service";
import {userAction} from "@/lib/safe-actions/actions";
import {getServerUrl} from "@/utils/get-server-url";
import {z} from "zod";

/**
 * W17b server actions (stop-during-backup): thin wrappers like the W11–W13 ones. Signed-in user → `quiesce/service.ts` (system admin, resource-scoped, D21 gate,
 * rate limit, typed stack name on a production host, audit). Next's server-action origin check is the CSRF guard. Input is validated INSIDE the service.
 */
const deps = async (): Promise<QuiesceAdminDeps> => ({db: await appDb(), principal: await getForkPrincipal(), channel: {keys: fileKeyProvider, serverUrl: getServerUrl}});

export const previewQuiesceAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => previewQuiesce(await deps(), parsedInput));
export const enableQuiesceAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => enableQuiesce(await deps(), parsedInput));
export const disableQuiesceAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => disableQuiesce(await deps(), parsedInput));
export const startQuiesceNowAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => startNow(await deps(), parsedInput));
