import {logger} from "@/lib/logger";
import {purgeAuditEvents} from "@/fork/audit";
import {appDb} from "@/fork/db/handle";
import {registerForkRuntimeTask} from "@/fork/runtime";

const log = logger.child({module: "fork/audit-task"});
const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * SEC-07 retention runner. Plane `runtime`: keeps running in "locked" mode (it never changes configuration). Idempotent
 * registration (init can run twice in dev). The timer is unref'd so it never keeps the process alive.
 */
export function registerAuditRetentionTask(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-audit-retention",
            plane: "runtime",
            start: () => {
                const run = async () => {
                    try {
                        const {purged} = await purgeAuditEvents(await appDb());
                        if (purged > 0) log.info({purged}, "Fork audit retention purge");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Fork audit retention purge failed");
                    }
                };
                setTimeout(run, 60_000).unref();
                setInterval(run, EVERY_MS).unref();
            },
        });
    } catch {
        // already registered
    }
}
