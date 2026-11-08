import {logger} from "@/lib/logger";
import {runForkMigrations} from "@/fork/db/migrate";
import {currentForkMode, invalidateForkModeCache, registerActivePolicyProbe, registerSelfCheck, setLaneStatus, type ForkModeResult} from "@/fork/mode";
import {registerRealChecks} from "@/fork/self-check";
import {registerAuditRetentionTask} from "@/fork/audit-task";
import {registerOverridePurgeTask} from "@/fork/config/purge-task";
import {registerDiscoveryCron} from "@/fork/cron";
import {registerMaterializeDriftJob} from "@/fork/materialize/job";
import {registerNotificationsJob} from "@/fork/notifications/job";
import {registerRestoreRunsJob} from "@/fork/restore-run/job";
import {registerTestRestoreJob} from "@/fork/test-restore/job";
import {registerStackRunsJob} from "@/fork/runs/job";
import {registerKitWatchJob} from "@/fork/kit/watch";
import {registerVerifyJob} from "@/fork/verify/job";
import {startForkRuntime} from "@/fork/runtime";

const log = logger.child({module: "fork/init"});

/**
 * Single boot entry for the fork (hook P02, called right after upstream `makeMigration()`).
 * Never throws: the fork must not be able to stop upstream from booting.
 * With all flags off and no persisted activation this runs the (harmless, fork-owned) lane and
 * starts nothing.
 */
export async function initFork(): Promise<ForkModeResult> {
    try {
        const lane = await runForkMigrations({log});
        setLaneStatus(lane);
        // W04: the real activation probe + D21 self-check replace the W01 seams (before the first mode read).
        await registerRealChecks({registerActivePolicyProbe, registerSelfCheck}, {log});
        registerAuditRetentionTask();
        registerOverridePurgeTask();
        registerDiscoveryCron();
        registerMaterializeDriftJob();
        registerStackRunsJob();
        registerRestoreRunsJob();
        registerTestRestoreJob();
        registerNotificationsJob();
        registerVerifyJob();
        registerKitWatchJob();
        invalidateForkModeCache();
        const mode = await currentForkMode();
        const {started, failed} = await startForkRuntime(mode.mode);
        log.info({mode: mode.mode, lockReason: mode.lockReason, lane: lane.state, started}, "Fork initialised");
        if (failed.length) log.error({failed}, "Some fork runtime tasks failed to start");
        if (mode.mode === "locked") log.warn({lockReason: mode.lockReason}, "Fork configuration locked; activated schedules keep running");
        return mode;
    } catch (error) {
        log.error({error}, "Fork init failed (upstream boot continues)");
        return {mode: "off"};
    }
}
