import {appDb, type ForkDb} from "@/fork/db/handle";
import {type SyncDeps, type SyncResult, syncConnection } from "@/fork/discovery/sync";
import {listDueConnections} from "@/fork/discovery/sync-state";
import {forkEnv} from "@/fork/env";
import {currentForkMode, type ForkModeResult} from "@/fork/mode";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {logger} from "@/lib/logger";

const log = logger.child({module: "fork/cron"});
export const CRON_TICK_MS = 60_000;
export const CRON_FIRST_TICK_MS = 30_000;

/**
 * Discovery cron (W07). Plane `config` (ADR-010): started at boot only in mode `on`, and EVERY tick re-reads the (60 s cached) mode and does
 * nothing unless it is still `on` — so `on → locked` mid-process pauses discovery while the runtime plane keeps running. A process that boots
 * `locked`/`off` does not start it (documented limit: it resumes after the next restart). No upstream hook: this replaces the wave file's
 * P03 (`registerForkCron()` in upstream `cron.ts`), made unnecessary by the W01 runtime plane.
 * Missed runs / overlap / replicas: due-ness comes from the DB (`listDueConnections`), the run itself takes a DB lease — see `discovery/sync-state.ts`.
 */
export type TickDeps = {
    mode: () => Promise<ForkModeResult>;
    db: () => Promise<ForkDb>;
    sync: (d: SyncDeps, connectionId: string, trigger: "cron") => Promise<SyncResult>;
    intervalMs: () => number;
    now?: () => Date;
    random?: () => number;
};
export type TickResult = {mode: ForkModeResult["mode"]; due: number; ran: number; skipped: number; failed: number};

export async function discoveryTick(d: TickDeps): Promise<TickResult> {
    const m = await d.mode();
    if (m.mode !== "on") return {mode: m.mode, due: 0, ran: 0, skipped: 0, failed: 0};
    const db = await d.db();
    const due = await listDueConnections(db, {now: d.now?.() ?? new Date(), intervalMs: d.intervalMs(), random: d.random});
    const out: TickResult = {mode: "on", due: due.length, ran: 0, skipped: 0, failed: 0};
    for (const id of due) {
        try {
            const r = await d.sync({db, now: d.now, random: d.random}, id, "cron");
            if (r.kind === "ran") { out.ran++; if (r.run.status === "failed") out.failed++; } else out.skipped++;
        } catch {
            out.failed++; // never aborts the other connections; the message is not logged (it could come from anywhere)
        }
    }
    return out;
}

const KEY = Symbol.for("portabase.fork.discovery-cron.v1");

export function registerDiscoveryCron(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-discovery-sync",
            plane: "config",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return; // dev HMR / second init: one timer pair per process
                g[KEY] = true;
                let running = false;
                const run = async () => {
                    if (running) return;
                    running = true;
                    try {
                        const r = await discoveryTick({mode: currentForkMode, db: appDb, sync: syncConnection, intervalMs: () => forkEnv().FORK_DISCOVERY_INTERVAL_MINUTES * 60_000});
                        if (r.due > 0) log.info({due: r.due, ran: r.ran, skipped: r.skipped, failed: r.failed}, "Discovery tick");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Discovery tick failed");
                    } finally {
                        running = false;
                    }
                };
                setTimeout(run, CRON_FIRST_TICK_MS).unref();
                setInterval(run, CRON_TICK_MS).unref();
            },
        });
    } catch {
        // already registered
    }
}
