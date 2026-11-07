import {forkEnv} from "@/fork/env";

/** Runtime limits of the run engine, derived from the (validated, operator-only) env. Every value has a safe default. */
export type RunConfig = {
    tickMs: number;
    waitTimeoutMs: number;
    stallTimeoutMs: number;
    maxRunMs: number;
    captureWindowMs: number;
    maxPerAgent: number;
    maxPerOrg: number;
    hashMaxBytes: number;
    hashTimeoutMs: number;
};

export function runConfig(source: Record<string, string | undefined> = process.env): RunConfig {
    const e = forkEnv(source);
    return {
        tickMs: e.FORK_RUN_TICK_SECONDS * 1000,
        waitTimeoutMs: e.FORK_RUN_WAIT_TIMEOUT_SECONDS * 1000,
        stallTimeoutMs: e.FORK_RUN_STALL_TIMEOUT_SECONDS * 1000,
        maxRunMs: e.FORK_RUN_MAX_SECONDS * 1000,
        captureWindowMs: e.FORK_RUN_CAPTURE_WINDOW_MINUTES * 60_000,
        maxPerAgent: e.FORK_RUN_MAX_PER_AGENT,
        maxPerOrg: e.FORK_RUN_MAX_PER_ORG,
        hashMaxBytes: e.FORK_RUN_HASH_MAX_MIB * 1024 * 1024,
        hashTimeoutMs: e.FORK_RUN_HASH_TIMEOUT_SECONDS * 1000,
    };
}
