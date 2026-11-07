import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {currentForkMode} from "@/fork/mode";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {defaultNotificationChannel} from "@/fork/upstream/notification-channel";
import {logger} from "@/lib/logger";
import {deliverPending, type DeliverResult} from "./deliver";
import {evaluateAlerts, type EvaluateResult} from "./evaluate";

const log = logger.child({module: "fork/notifications-job"});
const KEY = Symbol.for("portabase.fork.notifications.v1");
export const FIRST_TICK_MS = 20_000;

/**
 * Notification job (W13). Plane `runtime` (ADR-010): started in `on` AND `locked`, so failure/paused/dead-man alerts and the "configuration locked"
 * notification keep flowing in degraded mode; every tick re-reads the (cached) mode and does nothing in `off`. Evaluation (heavier: a protection view per
 * active stack) runs every `FORK_NOTIFY_EVAL_MINUTES`, delivery every `FORK_NOTIFY_TICK_SECONDS`. No upstream hook.
 */
export function registerNotificationsJob(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-notifications",
            plane: "runtime",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return;
                g[KEY] = true;
                const env = forkEnv();
                let running = false;
                let lastEval = 0;
                const tick = async () => {
                    if (running) return;
                    running = true;
                    try {
                        const mode = await currentForkMode();
                        if (mode.mode === "off") return;
                        const db = await appDb();
                        let evaluated: EvaluateResult | undefined;
                        if (Date.now() - lastEval >= env.FORK_NOTIFY_EVAL_MINUTES * 60_000) {
                            lastEval = Date.now();
                            try { evaluated = await evaluateAlerts({db, configLocked: mode.mode === "locked", minHours: env.FORK_DEADMAN_MIN_HOURS}); }
                            catch (error) { log.error({error: error instanceof Error ? error.name : "unknown"}, "Alert evaluation failed"); }
                        }
                        // lazy: the upstream dispatcher pulls the dashboard env (validated at server boot), so it is not part of this module's static graph
                        const {sendViaUpstreamChannel} = await import("@/fork/upstream/notification-send");
                        const delivered: DeliverResult = await deliverPending({db, baseUrl: process.env.PROJECT_URL ?? null, resolveChannel: defaultNotificationChannel, send: sendViaUpstreamChannel});
                        if (delivered.claimed > 0 || (evaluated?.fired ?? 0) > 0) log.info({delivered, evaluated}, "Notifications tick");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Notifications tick failed");
                    } finally {
                        running = false;
                    }
                };
                setTimeout(tick, FIRST_TICK_MS).unref();
                setInterval(tick, env.FORK_NOTIFY_TICK_SECONDS * 1000).unref();
            },
        });
    } catch {
        // already registered
    }
}
