"use server";

import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {getForkPrincipal} from "@/fork/principal";
import type {TestRestoreDeps} from "@/fork/test-restore/deps";
import {runTestRestoreNow, setTestRestoreSchedule, wipeTestRestoreNow} from "@/fork/test-restore/service";
import {getTestRestoreView} from "@/fork/test-restore/view";
import {userAction} from "@/lib/safe-actions/actions";
import {getServerUrl} from "@/utils/get-server-url";
import {z} from "zod";

/**
 * W-TR server actions: thin wrappers (signed-in user → service: resource-scoped capability, rate limit, locked-mode gate, audit). Next's server-action origin check is the CSRF
 * guard; there is NO API route for test restores. Input is validated INSIDE the services with strict schemas.
 */
const deps = async (): Promise<TestRestoreDeps> => ({db: await appDb(), principal: await getForkPrincipal(), keys: fileKeyProvider, serverUrl: getServerUrl});

export const setTestRestoreScheduleAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => setTestRestoreSchedule(await deps(), parsedInput));
export const runTestRestoreNowAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => runTestRestoreNow(await deps(), parsedInput));
export const wipeTestRestoreNowAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => wipeTestRestoreNow(await deps(), parsedInput));
export const getTestRestoreViewAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => getTestRestoreView(await deps(), parsedInput));
