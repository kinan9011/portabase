import {anyForkFlagOn} from "@/fork/env";

/**
 * Flag-off-at-boot mechanism (ADR-010, plan v2.2 §4.1 / §5.1.7, C-PO-1).
 *
 * ONE mechanism: the fork *mode* is derived from persisted activation state, and flags only
 * gate the configuration plane.
 *
 *   flags healthy (on + self-check ok + lane ok)        → "on"
 *   not healthy AND >=1 activated stack policy persisted → "locked"  (config/mutations denied,
 *                                                          runtime plane keeps running)
 *   not healthy AND no activated policy                  → "off"     (fork invisible, upstream parity)
 *
 * A flag can therefore never decide whether an already-activated schedule runs.
 */
export type ForkMode = "off" | "on" | "locked";
export type ForkLockReason = "flags-off" | "self-check-failed" | "lane-failed";

export type ForkModeInput = {
    flagsOn: boolean;
    activePolicyCount: number;
    selfCheckOk: boolean;
    laneOk: boolean;
};

export type ForkModeResult = { mode: ForkMode; lockReason?: ForkLockReason; detail?: string };

export function resolveForkMode(i: ForkModeInput): ForkModeResult {
    if (i.flagsOn && i.selfCheckOk && i.laneOk) return {mode: "on"};
    if (i.activePolicyCount > 0) {
        const lockReason: ForkLockReason = !i.flagsOn ? "flags-off" : !i.selfCheckOk ? "self-check-failed" : "lane-failed";
        return {mode: "locked", lockReason};
    }
    return {mode: "off"};
}

// ---- process-wide state ---------------------------------------------------------------------
// Next.js evaluates instrumentation and route handlers in separate module graphs inside one
// process; plain module variables would not be shared. globalThis (Symbol.for) is.

export type LaneState =
    | "not-run"
    | "applied"
    | "skipped-upstream-incomplete"
    | "blocked-no-dump"
    | "failed";

export type LaneStatus = { state: LaneState; appliedNow?: number; total?: number; detail?: string };

export type SelfCheckResult = { ok: boolean; failed?: string };

type ForkGlobal = {
    lane: LaneStatus;
    probe: () => Promise<number>;
    selfCheck: () => Promise<SelfCheckResult>;
    cache?: { at: number; result: ForkModeResult };
};

const KEY = Symbol.for("portabase.fork.state.v1");
function store(): ForkGlobal {
    const g = globalThis as unknown as Record<symbol, ForkGlobal | undefined>;
    g[KEY] ??= {
        lane: {state: "not-run"},
        // Seams (no stack tables exist in W01): W04 registers the real probe over the persisted
        // activation state and the D21 single-tenant self-check.
        probe: async () => 0,
        selfCheck: async () => ({ok: true}),
    };
    return g[KEY] as ForkGlobal;
}

export const setLaneStatus = (s: LaneStatus) => {
    store().lane = s;
    invalidateForkModeCache();
};
export const getLaneStatus = (): LaneStatus => store().lane;
export const registerActivePolicyProbe = (fn: () => Promise<number>) => {
    store().probe = fn;
    invalidateForkModeCache();
};
export const registerSelfCheck = (fn: () => Promise<SelfCheckResult>) => {
    store().selfCheck = fn;
    invalidateForkModeCache();
};
export const invalidateForkModeCache = () => {
    store().cache = undefined;
};
/** Test helper: reset the process-wide state. */
export const resetForkState = () => {
    (globalThis as unknown as Record<symbol, unknown>)[KEY] = undefined;
};

const CACHE_MS = 60_000; // §4.1: cached 60 s

/**
 * Current mode. Cheap and DB-free while all flags are off and no probe is registered.
 * Probe failure is treated conservatively as "an activated policy may exist" (⇒ locked, never off),
 * so a transient DB error can not make the fork look absent.
 */
export async function currentForkMode(opts: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<ForkModeResult> {
    const s = store();
    const now = opts.now ?? Date.now();
    if (s.cache && now - s.cache.at < CACHE_MS) return s.cache.result;

    const flagsOn = anyForkFlagOn(opts.env ?? process.env);
    let activePolicyCount = 0;
    try {
        activePolicyCount = await s.probe();
    } catch {
        activePolicyCount = 1;
    }
    let selfCheck: SelfCheckResult = {ok: true};
    try {
        selfCheck = await s.selfCheck();
    } catch {
        selfCheck = {ok: false, failed: "self-check threw"};
    }
    const lane = s.lane.state;
    const laneOk = lane === "applied" || lane === "not-run";
    const result = resolveForkMode({flagsOn, activePolicyCount, selfCheckOk: selfCheck.ok, laneOk});
    if (result.mode === "locked") {
        result.detail =
            result.lockReason === "self-check-failed" ? selfCheck.failed : result.lockReason === "lane-failed" ? s.lane.detail ?? lane : undefined;
    }
    s.cache = {at: now, result};
    return result;
}

export class ForkLockedError extends Error {
    constructor(public readonly mode: ForkMode, public readonly lockReason?: ForkLockReason) {
        super(mode === "locked" ? `Fork configuration locked: ${lockReason}` : "Fork feature is not enabled");
        this.name = "ForkLockedError";
    }
}

/** Guard for every fork mutation/configuration entry point (actions, API routes). Throws unless mode is "on". */
export async function assertForkConfigAllowed(opts?: Parameters<typeof currentForkMode>[0]): Promise<void> {
    const m = await currentForkMode(opts);
    if (m.mode !== "on") throw new ForkLockedError(m.mode, m.lockReason);
}
