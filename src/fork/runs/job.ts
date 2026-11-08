import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {retentionTick, type RetentionResult} from "@/fork/recovery-point/prune";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {logger} from "@/lib/logger";
import {cfgOf, type RunDeps} from "./deps";
import {schedulerTick, type SchedulerResult} from "./scheduler";
import {tickAllRuns} from "./service";

const log = logger.child({module: "fork/runs-job"});
const KEY = Symbol.for("portabase.fork.stack-runs.v1");
export const FIRST_TICK_MS = 15_000;
export const RETENTION_EVERY_MS = 60 * 60_000;
export const FIRST_RETENTION_MS = 5 * 60_000;

export type RunsTickResult = {scheduler: SchedulerResult; runs: Awaited<ReturnType<typeof tickAllRuns>>; retention?: RetentionResult};

/** One pass: due slots → start/skip, advance every active run (tracker, finaliser), optionally retention. Each part is isolated: a failure in one never stops the next. */
export async function runsTick(d: RunDeps, o: {retention?: boolean} = {}): Promise<RunsTickResult> {
    const empty: SchedulerResult = {considered: 0, started: 0, skipped: 0, waiting: 0, refused: 0, failed: 0};
    let scheduler = empty;
    try { scheduler = await schedulerTick(d); } catch (error) { log.error({error: error instanceof Error ? error.name : "unknown"}, "Stack schedule tick failed"); }
    let runs = {advanced: 0, done: 0, failed: 0, busy: 0};
    try { runs = await tickAllRuns(d); } catch (error) { log.error({error: error instanceof Error ? error.name : "unknown"}, "Stack run tick failed"); }
    let retention: RetentionResult | undefined;
    if (o.retention) {
        try { retention = await retentionTick(d); } catch (error) { log.error({error: error instanceof Error ? error.name : "unknown"}, "Stack retention tick failed"); }
    }
    return {scheduler, runs, retention};
}

/**
 * Stack-runs job (W12). Plane `runtime` (ADR-010): started in `on` AND `locked` — scheduled runs, RP finalisation and retention are protective
 * work and must keep going while the self-check fails or flags are off at boot with an active policy; every tick re-reads the (cached) mode
 * and does nothing in `off`. No upstream hook (same mechanism as the discovery cron and the drift job).
 */
export function registerStackRunsJob(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-stack-runs",
            plane: "runtime",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return; // dev HMR / second init: one timer pair per process
                g[KEY] = true;
                let running = false;
                let lastRetention = Date.now() - RETENTION_EVERY_MS + FIRST_RETENTION_MS;
                const run = async () => {
                    if (running) return;
                    running = true;
                    try {
                        if ((await currentForkMode()).mode === "off") return;
                        const {getServerUrl} = await import("@/utils/get-server-url"); // lazy: the env-validating module must not load when tests import `runsTick`
                        const d: RunDeps = {db: await appDb(), channel: {keys: fileKeyProvider, serverUrl: getServerUrl}}; // W17b: quiesce signs + enqueues its task
                        const retention = Date.now() - lastRetention >= RETENTION_EVERY_MS;
                        if (retention) lastRetention = Date.now();
                        const r = await runsTick(d, {retention});
                        if (r.scheduler.started + r.scheduler.skipped + r.runs.advanced + r.runs.done + r.runs.failed + (r.retention?.purged ?? 0) > 0) log.info({scheduler: r.scheduler, runs: r.runs, retention: r.retention}, "Stack runs tick");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Stack runs tick failed");
                    } finally {
                        running = false;
                    }
                };
                setTimeout(run, FIRST_TICK_MS).unref();
                setInterval(run, cfgOf({}).tickMs).unref();
            },
        });
    } catch {
        // already registered
    }
}
