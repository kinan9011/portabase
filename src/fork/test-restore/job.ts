import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {logger} from "@/lib/logger";
import {getServerUrl} from "@/utils/get-server-url";
import type {TestRestoreDeps} from "./deps";
import {testRestoreSchedulerTick} from "./scheduler";
import {advanceTestRestoreWipes} from "./wipe";

const log = logger.child({module: "fork/test-restore-job"});
const KEY = Symbol.for("portabase.fork.test-restore.v1");
export const FIRST_TICK_MS = 30_000;

/**
 * W-TR job: the scheduler (what is due) and the verified-wipe advance. Plane `runtime` (ADR-010): wipes keep trying while configuration is locked (the enqueue answers `locked`
 * and the wipe waits, bounded by its 24 h deadline); STARTING a test restore is refused by the existing gates. Does nothing in mode `off`.
 * `FORK_TEST_RESTORE_TICK_SECONDS=0` means "this process never ticks": for the live-lab child dashboard ONLY. Logs counts, never messages.
 */
export function registerTestRestoreJob(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-test-restore",
            plane: "runtime",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return;
                g[KEY] = true;
                const seconds = forkEnv().FORK_TEST_RESTORE_TICK_SECONDS;
                if (seconds === 0) {
                    log.warn("FORK_TEST_RESTORE_TICK_SECONDS=0: test restores do not tick in this process (lab only)");
                    return;
                }
                let running = false;
                const run = async () => {
                    if (running) return;
                    running = true;
                    try {
                        if ((await currentForkMode()).mode === "off") return;
                        const d: TestRestoreDeps = {db: await appDb(), keys: fileKeyProvider, serverUrl: getServerUrl};
                        const s = await testRestoreSchedulerTick(d);
                        const w = await advanceTestRestoreWipes(d);
                        if (s.started + s.skipped + s.waiting + w.advanced + w.verified + w.failed > 0) log.info({scheduler: s, wipes: w}, "Test restore tick");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Test restore tick failed");
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
