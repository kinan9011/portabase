import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {logger} from "@/lib/logger";
import {getServerUrl} from "@/utils/get-server-url";
import type {MirrorDeps} from "./deps";
import {tickAllMirrors} from "./tick";

const log = logger.child({module: "fork/mirror-job"});
const KEY = Symbol.for("portabase.fork.mirror.v1");
export const FIRST_TICK_MS = 10_000;

/**
 * Mirror job (W22a, plan A7). Plane `runtime` (ADR-010): an ACTIVE creation keeps polling its task results and times out honestly while configuration is locked (enqueue itself answers
 * `locked` ⇒ the step just waits); the wipe phase of failed creations runs on the same tick. Every tick re-reads the (cached) mode and does nothing in `off`. No upstream hook.
 * `FORK_MIRROR_TICK_SECONDS=0` means "this process never ticks": for the live-lab child dashboard ONLY (the lab drives the same tick from the test process). A warning is logged once.
 */
export function registerMirrorJob(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-mirrors",
            plane: "runtime",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return; // dev HMR / second init: one timer pair per process
                g[KEY] = true;
                const seconds = forkEnv().FORK_MIRROR_TICK_SECONDS;
                if (seconds === 0) {
                    log.warn("FORK_MIRROR_TICK_SECONDS=0: the mirror orchestrator does not tick in this process (lab only)");
                    return;
                }
                let running = false;
                const run = async () => {
                    if (running) return;
                    running = true;
                    try {
                        if ((await currentForkMode()).mode === "off") return;
                        const d: MirrorDeps = {db: await appDb(), keys: fileKeyProvider, serverUrl: getServerUrl};
                        const r = await tickAllMirrors(d);
                        if (r.advanced + r.done + r.failed + r.wipes.advanced + r.wipes.verified + r.wipes.failed + r.deletes.advanced + r.deletes.deleted + r.deletes.failed > 0) log.info({mirrors: r}, "Mirror tick");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Mirror tick failed");
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
