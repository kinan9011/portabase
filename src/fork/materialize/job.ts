import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {currentForkMode} from "@/fork/mode";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {logger} from "@/lib/logger";
import {materializeTick} from "./drift";

const log = logger.child({module: "fork/materialize-job"});
const KEY = Symbol.for("portabase.fork.materialize-drift.v1");
export const FIRST_TICK_MS = 20_000;

/**
 * Drift/probe job (W10, D30) registration. Plane `runtime` (ADR-010): started in `on` AND `locked`, because a stack's member sources must never
 * carry their own cron/retention and activated stacks keep running when configuration is locked. Every tick re-reads the (cached) mode and does
 * nothing when it is `off`. No upstream hook (same mechanism as the discovery cron).
 */
export function registerMaterializeDriftJob(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-materialize-drift",
            plane: "runtime",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return; // dev HMR / second init: one timer pair per process
                g[KEY] = true;
                let running = false;
                const run = async () => {
                    if (running) return;
                    running = true;
                    try {
                        const mode = (await currentForkMode()).mode;
                        if (mode === "off") return;
                        // `locked` (D21 / flags off with active policies): protective work only, nothing new is created (ADR-010)
                        const r = await materializeTick({db: await appDb(), allowConfig: mode === "on"});
                        if (r.reverted + r.drifted + r.rolledBack + r.promoted + r.failed > 0) log.info(r, "Materialize drift tick");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Materialize drift tick failed");
                    } finally {
                        running = false;
                    }
                };
                setTimeout(run, FIRST_TICK_MS).unref();
                setInterval(run, forkEnv().FORK_MATERIALIZE_TICK_SECONDS * 1000).unref();
            },
        });
    } catch {
        // already registered
    }
}
