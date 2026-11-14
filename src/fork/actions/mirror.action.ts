"use server";

import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import type {MirrorDeps} from "@/fork/mirror/deps";
import {cancelMirrorRevision, createMirror, getMirrorAccess, getMirrorView, previewMirrorPlan, retryMirrorWipe, setStackMirrorOptIn} from "@/fork/mirror/service";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";
import {getServerUrl} from "@/utils/get-server-url";
import {z} from "zod";

/**
 * Mirror actions (W22a, consumed by the W22b wizard and the W23 pages). Thin wrappers like `runner.action.ts`: signed-in user → service (resource-scoped `mirrors.manage` / `mirrors.view`, flag
 * `FORK_MIRRORS_ENABLED`, fork not locked, rate limit, audit). Input is validated INSIDE the services. Next's server-action origin check is the CSRF guard.
 */
const deps = async (): Promise<MirrorDeps> => ({db: await appDb(), principal: await getForkPrincipal(), keys: fileKeyProvider, serverUrl: getServerUrl});

export const setStackMirrorOptInAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => setStackMirrorOptIn(await deps(), parsedInput));
export const previewMirrorPlanAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => previewMirrorPlan(await deps(), parsedInput));
export const createMirrorAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => createMirror(await deps(), parsedInput));
export const cancelMirrorRevisionAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => cancelMirrorRevision(await deps(), parsedInput));
export const retryMirrorWipeAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => retryMirrorWipe(await deps(), parsedInput));
export const getMirrorViewAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => getMirrorView(await deps(), parsedInput));
export const getMirrorAccessAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => getMirrorAccess(await deps(), parsedInput));
