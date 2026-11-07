import {eq, isNull, sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkKit} from "@/fork/db/schema/kit";
import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {fileKeyProvider, type KeyProvider} from "@/fork/keys";
import {withForkLock} from "@/fork/locks";
import {currentForkMode} from "@/fork/mode";
import {enqueueForkNotification} from "@/fork/notify";
import {registerForkRuntimeTask} from "@/fork/runtime";
import {logger} from "@/lib/logger";
import {codesEqual} from "./fingerprint";
import {KIT_VERIFY_MAX_AGE_DAYS} from "./service";
import {liveKitCode} from "./sources";

const log = logger.child({module: "fork/kit-watch"});
const KEY = Symbol.for("portabase.fork.kitwatch.v1");

/**
 * Kit watch (D41, §4.2 "re-prompt on any key rotation and every 12 months", §4.7). Runtime plane. Each tick:
 *  1. recompute the LIVE verification code (master + whole KEK keyring + current signing key). A code that differs from the issued kit means a key rotated
 *     (KEK rotation, signing-key rotation): the kit becomes `stale` (fail closed: stacks show "Kit not verified" again) and ONE `kit.key_rotated` row per
 *     active-policy stack is queued (dedupe per kit epoch). A signing-key change registered by the anchor registry counts too.
 *  2. a verified kit older than 12 months ⇒ `stale` (expired) + the same notification.
 *  3. no kit / unverified kit for longer than `FORK_KIT_UNVERIFIED_HOURS` after a policy was activated ⇒ ONE `kit.unverified` row per such stack per epoch.
 * Payload = stack id + link only (§4.7). Never touches key material beyond computing the hash, never logs it.
 */
export type WatchDeps = {db: ForkDb; keys: KeyProvider; kekDir?: string; now?: () => Date; unverifiedHours: number};
export type WatchResult = {state: "none" | "issued" | "verified" | "stale"; staleNow: boolean; queued: number};

const activeStacks = async (db: ForkDb, olderThan?: Date) =>
    ((await db.execute(sql`select p.stack_id, s.organization_id from fork_stack_policy p join fork_stack s on s.id = p.stack_id
                            where p.activated_at is not null and p.deactivated_at is null ${olderThan ? sql`and p.activated_at <= ${olderThan}` : sql``}`)).rows as {stack_id: string; organization_id: string}[]);

export async function watchKit(d: WatchDeps): Promise<WatchResult> {
    const now = d.now?.() ?? new Date();
    let queued = 0;
    const notify = async (kind: "kit.unverified" | "kit.key_rotated", epoch: number, olderThan?: Date) => {
        for (const s of await activeStacks(d.db, olderThan)) {
            if (await enqueueForkNotification(d.db, {kind, dedupeKey: `${kind}:${s.stack_id}:${epoch}`, payload: {stackId: s.stack_id, link: `/dashboard/stacks/${s.stack_id}`}})) queued++;
        }
    };
    let live: Awaited<ReturnType<typeof liveKitCode>> | null = null;
    try { live = await liveKitCode({db: d.db, keys: d.keys, kekDir: d.kekDir, now: () => now}); } catch { live = null; } // keys unreadable: do not invent a verdict
    return withForkLock(d.db, "fork-kit", async (tx): Promise<WatchResult> => {
        const t = tx as ForkDb;
        const [cur] = await t.select().from(forkKit).where(isNull(forkKit.supersededAt));
        if (!cur) {
            await notify("kit.unverified", 0, new Date(now.getTime() - d.unverifiedHours * 3600_000));
            return {state: "none", staleNow: false, queued};
        }
        await t.update(forkKit).set({lastCheckedAt: now}).where(eq(forkKit.id, cur.id));
        let status = cur.status;
        let staleNow = false;
        const expired = status === "verified" && cur.verifiedAt !== null && cur.verifiedAt.getTime() + KIT_VERIFY_MAX_AGE_DAYS * 86_400_000 <= now.getTime();
        const changed = live !== null && !codesEqual(live.code, cur.fingerprint);
        if (status !== "stale" && (changed || expired)) {
            const epoch = cur.epoch + 1;
            await t.update(forkKit).set({status: "stale", staleReason: changed ? "keys_changed" : "expired", epoch}).where(eq(forkKit.id, cur.id));
            await recordAudit(t, {actorKind: "system", action: "fork.kit.stale", resourceType: "recovery_kit", result: "success", details: {reason: changed ? "keys_changed" : "expired"}, now});
            status = "stale"; staleNow = true;
            await notify("kit.key_rotated", epoch);
        } else if (status !== "verified") {
            await notify("kit.unverified", cur.epoch, new Date(now.getTime() - d.unverifiedHours * 3600_000));
        }
        return {state: status as WatchResult["state"], staleNow, queued};
    });
}

export function registerKitWatchJob(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-kit-watch", plane: "runtime",
            start: () => {
                const g = globalThis as unknown as Record<symbol, boolean | undefined>;
                if (g[KEY]) return;
                g[KEY] = true;
                const env = forkEnv();
                let running = false;
                const tick = async () => {
                    if (running) return;
                    running = true;
                    try {
                        if ((await currentForkMode()).mode === "off") return;
                        const r = await watchKit({db: await appDb(), keys: fileKeyProvider, unverifiedHours: env.FORK_KIT_UNVERIFIED_HOURS});
                        if (r.staleNow || r.queued) log.info({state: r.state, queued: r.queued}, "Kit watch");
                    } catch (error) { log.error({error: error instanceof Error ? error.name : "unknown"}, "Kit watch failed"); }
                    finally { running = false; }
                };
                const period = env.FORK_KIT_WATCH_MINUTES * 60_000;
                setTimeout(tick, Math.max(45_000, period)).unref();
                setInterval(tick, period).unref();
            },
        });
    } catch { /* already registered */ }
}
