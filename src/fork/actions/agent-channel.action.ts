"use server";

import {enrolAgent, revokeEnrollment, rotateCredential, setChannelEnabled} from "@/fork/agent-channel/admin";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {pinDashboardKey, requestCredentialRotation, unpinDashboardKey} from "@/fork/agent-channel/maint";
import {enqueueTask} from "@/fork/agent-channel/tasks";
import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";
import {getServerUrl} from "@/utils/get-server-url";
import {z} from "zod";

/**
 * Agent task channel admin actions (W15, ADR-007). Thin wrappers like the W11–W14 ones: signed-in user → service (system admin, fork not locked, rate limit,
 * password step-up for enrol/rotate, https-only, audit). Input is validated INSIDE the services; the actions only forward `unknown`. Next's server-action
 * origin check is the CSRF guard. The enrol/rotate results carry the secret bundle ONCE — callers must show it once and never store it.
 */
const deps = async (): Promise<ChannelDeps> => ({db: await appDb(), principal: await getForkPrincipal(), keys: fileKeyProvider, serverUrl: getServerUrl});

export const enrolAgentAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => enrolAgent(await deps(), parsedInput));
export const rotateAgentCredentialAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => rotateCredential(await deps(), parsedInput));
export const revokeAgentEnrollmentAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => revokeEnrollment(await deps(), parsedInput));
export const setAgentChannelEnabledAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => setChannelEnabled(await deps(), parsedInput));
export const enqueueAgentTaskAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => enqueueTask(await deps(), parsedInput));
export const requestAgentCredentialRotationAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => requestCredentialRotation(await deps(), parsedInput));
export const pinDashboardKeyAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => pinDashboardKey(await deps(), parsedInput));
export const unpinDashboardKeyAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => unpinDashboardKey(await deps(), parsedInput));
