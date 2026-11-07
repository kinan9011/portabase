import type {ForkPrincipal} from "@/fork/acl";
import type {ForkDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import type {KeyProvider} from "@/fork/keys";
import type {StepUpResult} from "@/fork/kit/stepup";
import type {checkRate} from "@/fork/net/rate-limit";

/** Everything the channel services need, injectable so tests use a throw-away DB, throw-away keys and a fixed clock. */
export type ChannelEnv = Pick<ReturnType<typeof forkEnv>, "FORK_ALLOW_INSECURE_LOOPBACK" | "FORK_AGENT_TASK_TTL_MINUTES" | "FORK_AGENT_LEASE_SECONDS">;
export type ChannelDeps = {
    db: ForkDb;
    principal: ForkPrincipal | null;
    keys: KeyProvider;
    /** The dashboard base URL the agent will call (PROJECT_URL). */
    serverUrl: () => string;
    env?: () => ChannelEnv;
    now?: () => Date;
    stepUp?: (db: ForkDb, userId: string, password: string) => Promise<StepUpResult>;
    /** Fork KEK directory override (tests). */
    kekDir?: string;
    rate?: typeof checkRate;
    /** `true` when fork configuration may change (mode `on`). Default: the real mode (`assertForkConfigAllowed`). */
    configAllowed?: () => Promise<boolean>;
};

export const chEnv = (d: ChannelDeps): ChannelEnv => (d.env ? d.env() : forkEnv());
export const chNow = (d: Pick<ChannelDeps, "now">) => d.now?.() ?? new Date();
