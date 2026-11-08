import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {logger} from "@/lib/logger";
import {getServerUrl} from "@/utils/get-server-url";
import type {RestoreRunDeps} from "./deps";
import {tickAllRestoreRuns} from "./tick";

const log = logger.child({module: "fork/restore-runs-job"});
const KEY = Symbol.for("portabase.fork.restore-runs.v1");
export const FIRST_TICK_MS = 10_000;

/**
 * Restore-runs job (W18a D-17). Plane `runtime` (ADR-010): an ACTIVE run keeps polling its task results and times out honestly while configuration is locked
 * (enqueue itself answers `locked` ⇒ the step just waits); every tick re-reads the (cached) mode and does nothing in `off`. No upstream hook.
 * `FORK_RESTORE_TICK_SECONDS=0` means "this process never ticks": for the live-lab child dashboard ONLY (the lab drives the same tick from the test process with
 * its own manifest / artifact seams). A warning is logged once when it is set.
 */
export function registerRestoreRunsJob(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-restore-runs",
            plane: "runtime",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return; // dev HMR / second init: one timer pair per process
                g[KEY] = true;
                const seconds = forkEnv().FORK_RESTORE_TICK_SECONDS;
                if (seconds === 0) {
                    log.warn("FORK_RESTORE_TICK_SECONDS=0: the restore orchestrator does not tick in this process (lab only)");
                    return;
                }
                let running = false;
                const run = async () => {
                    if (running) return;
                    running = true;
                    try {
                        if ((await currentForkMode()).mode === "off") return;
                        const d: RestoreRunDeps = {db: await appDb(), keys: fileKeyProvider, serverUrl: getServerUrl};
                        const r = await tickAllRestoreRuns(d);
                        if (r.advanced + r.done + r.failed > 0) log.info({runs: r}, "Restore runs tick");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Restore runs tick failed");
                    } finally {
                        running = false;
                    }
                };
                setTimeout(run, FIRST_TICK_MS).unref();
                setInterval(run, seconds * 1000).unref();
            },
        });
    } catch {
        // already registered
    }
}
