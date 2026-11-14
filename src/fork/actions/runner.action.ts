"use server";

import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {getForkPrincipal} from "@/fork/principal";
import {designateRunner, requestRunnerProbe, setRunnerTargets, undesignateRunner} from "@/fork/runner/service";
import {userAction} from "@/lib/safe-actions/actions";
import {getServerUrl} from "@/utils/get-server-url";
import {z} from "zod";

/**
 * Mirror-runner actions (W21, ADR-008). Thin wrappers like `agent-channel.action.ts`: signed-in user → service (flag `FORK_MIRRORS_ENABLED`, system admin, fork not locked, rate limit,
 * password step-up for designation, audit). Input is validated INSIDE the services. Next's server-action origin check is the CSRF guard.
 */
const deps = async (): Promise<ChannelDeps> => ({db: await appDb(), principal: await getForkPrincipal(), keys: fileKeyProvider, serverUrl: getServerUrl});

export const designateRunnerAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => designateRunner(await deps(), parsedInput));
export const undesignateRunnerAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => undesignateRunner(await deps(), parsedInput));
export const setRunnerTargetsAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => setRunnerTargets(await deps(), parsedInput));
export const requestRunnerProbeAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => requestRunnerProbe(await deps(), parsedInput));
