"use server";

import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {beginKitGeneration, confirmKitFingerprint, type KitDeps} from "@/fork/kit/service";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";
import {z} from "zod";

/**
 * Kit server actions (W14). Thin wrappers (like W05–W13): signed-in user → `kit/service.ts` (system admin, D21 gate, rate limit, audit). Input is validated INSIDE the
 * service with strict schemas; the action forwards `unknown` and never logs it (it carries the account password / the verification code). The kit itself is NOT
 * returned by an action (that would put it in an RSC payload): it is delivered by `app/api/fork/kit/[kind]/route.ts`.
 */
const deps = async (): Promise<KitDeps> => ({db: await appDb(), principal: await getForkPrincipal(), keys: fileKeyProvider});

export const beginKitGenerationAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => beginKitGeneration(await deps(), parsedInput));
export const confirmKitFingerprintAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => confirmKitFingerprint(await deps(), parsedInput));
