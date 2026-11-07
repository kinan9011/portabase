import {sql} from "drizzle-orm";
import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {runRetentionCoherence} from "@/fork/recovery/coherence";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {openArtifactRepo, openManifestRepo} from "@/fork/upstream/restic";
import {logger} from "@/lib/logger";
import {openArchiveViaUpstream} from "./artifact";
import {sweepManifestForgets} from "./forget";
import {verifyRecoveryPoint, type VerifyDeps} from "./service";

const log = logger.child({module: "fork/verify-job"});
const KEY = Symbol.for("portabase.fork.verify.v1");
export const FIRST_TICK_MS = 30_000;
const MIB = 1024 * 1024;
const BACKOFF_MINUTES = [2, 10, 30, 120, 480] as const;

export async function defaultVerifyDeps(): Promise<VerifyDeps> {
    const env = forkEnv();
    const db = await appDb();
    return {
        db, keys: fileKeyProvider, openArchive: openArchiveViaUpstream,
        checkResticSnapshot: async ({channelId, generatedId, snapshotId}) => {
            const master = await fileKeyProvider.master();
            const h = await openArtifactRepo(db, channelId, generatedId, master);
            try {
                if (!/^[0-9a-f]{64}$/.test(snapshotId)) return false;
                const cat = await h.run(["cat", "snapshot", snapshotId]);
                if (cat.code === 10 || (cat.code !== 0 && /no such file|not found|does not exist/i.test(cat.stderr))) return "missing";
                if (cat.code !== 0) return false;
                const ls = await h.run(["ls", "--json", snapshotId], {maxStdoutBytes: 1 * MIB});
                return ls.code === 0 && ls.stdout.toString("utf8").split("\n").filter((l) => l.includes('"struct_type":"node"') || l.includes('"type":"file"')).length > 0;
            } finally { await h.cleanup().catch(() => undefined); }
        },
        manifestRunner: (channelId, stackId, master) => openManifestRepo(db, channelId, stackId, master),
        limits: {maxPlaintextBytes: env.FORK_VERIFY_MAX_MIB * MIB, maxInflatedBytes: env.FORK_VERIFY_MAX_MIB * MIB * 4, downloadTimeoutMs: env.FORK_VERIFY_DOWNLOAD_TIMEOUT_MINUTES * 60_000},
        maxAttempts: env.FORK_VERIFY_MAX_ATTEMPTS, backoffMinutes: BACKOFF_MINUTES, crossCheckAgentSize: true,
    };
}

/** Next RP the job should verify: oldest pending whose retry time has come. */
export async function nextPendingRp(db: Awaited<ReturnType<typeof appDb>>): Promise<string | null> {
    const r = await db.execute(sql`
        select id from fork_recovery_point
         where status = 'pending_verification' and purged_at is null
           and coalesce((verify_report->>'nextAttemptAt')::timestamptz, '-infinity'::timestamptz) <= now()
         order by created_at limit 1`);
    return (r.rows[0] as {id: string} | undefined)?.id ?? null;
}

/**
 * Verify job (W14). Plane `runtime` (ADR-010): verification, coherence and manifest forgets must continue while the fork configuration is locked (they
 * change no configuration), and stop only in mode `off`. Concurrency 1: one tick verifies at most ONE RP (downloads scale with stack size, ADR-004 §7).
 */
export function registerVerifyJob(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-verify", plane: "runtime",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return;
                g[KEY] = true;
                let running = false;
                const tick = async () => {
                    if (running) return;
                    running = true;
                    try {
                        if ((await currentForkMode()).mode === "off") return;
                        const deps = await defaultVerifyDeps();
                        const coherence = await runRetentionCoherence(deps.db);
                        const forgets = await sweepManifestForgets({db: deps.db, master: () => fileKeyProvider.master(), manifestRunner: deps.manifestRunner});
                        const id = await nextPendingRp(deps.db);
                        const verdict = id ? await verifyRecoveryPoint(deps, id) : null;
                        if (verdict || coherence.downgraded.length || forgets.forgotten) log.info({verdict: verdict?.outcome, code: (verdict as {code?: string} | null)?.code, downgraded: coherence.downgraded.length, forgotten: forgets.forgotten}, "Verify tick");
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Verify tick failed");
                    } finally { running = false; }
                };
                const period = forkEnv().FORK_VERIFY_TICK_SECONDS * 1000;
                setTimeout(tick, Math.max(FIRST_TICK_MS, period)).unref(); // never earlier than one period
                setInterval(tick, period).unref();
            },
        });
    } catch { /* already registered */ }
}
