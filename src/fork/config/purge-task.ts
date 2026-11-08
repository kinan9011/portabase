import {logger} from "@/lib/logger";
import {appDb} from "@/fork/db/handle";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {purgeExpiredOverrides} from "./service";

const log = logger.child({module: "fork/restore-override-purge"});
// ponytail: fixed 15 min; make it env only if someone asks
const EVERY_MS = 15 * 60 * 1000;

/** W16b: deletes override sets whose plan has expired (DD5). Plane `runtime` (never changes configuration), unref'd timers, counts only in the log. */
export function registerOverridePurgeTask(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-restore-override-purge",
            plane: "runtime",
            start: () => {
                const run = async () => {
                    try {
                        const {purged} = await purgeExpiredOverrides(await appDb(), new Date());
                        if (purged > 0) log.info({purged}, "Fork restore override purge");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Fork restore override purge failed");
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
