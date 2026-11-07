"use server";

import {appDb} from "@/fork/db/handle";
import {declareDashboardDbSource} from "@/fork/dashboard-db/service";
import {getForkPrincipal} from "@/fork/principal";
import {userAction} from "@/lib/safe-actions/actions";
import {z} from "zod";

/** D40: declare which existing source backs up the dashboard database (system admin, audited). Thin wrapper; the service validates with a strict schema. */
export const declareDashboardDbSourceAction = userAction.inputSchema(z.unknown()).action(async ({parsedInput}) => declareDashboardDbSource({db: await appDb(), principal: await getForkPrincipal()}, parsedInput));
