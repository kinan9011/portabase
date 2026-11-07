import {beforeEach, describe, expect, it, vi} from "vitest";
import {discoveryTick, registerDiscoveryCron, type TickDeps} from "@/fork/cron";
import {forkEnv} from "@/fork/env";
import {clearForkRuntimeTasks, tasksForMode} from "@/fork/runtime";
import * as state from "@/fork/discovery/sync-state";

const db = {} as never;
const base = (over: Partial<TickDeps> = {}): TickDeps => ({mode: async () => ({mode: "on"}), db: async () => db, sync: vi.fn(async () => ({kind: "skipped", reason: "already_running"}) as const), intervalMs: () => 900_000, ...over});

describe("discovery tick: mode gate (ADR-010), per-connection isolation", () => {
    beforeEach(() => vi.restoreAllMocks());
    it("off / locked ⇒ no DB access, no sync", async () => {
        const spy = vi.spyOn(state, "listDueConnections");
        const dbFn = vi.fn(async () => db);
        for (const mode of ["off", "locked"] as const) {
            const sync = vi.fn();
            expect(await discoveryTick(base({mode: async () => ({mode}), db: dbFn, sync}))).toEqual({mode, due: 0, ran: 0, skipped: 0, failed: 0});
            expect(sync).not.toHaveBeenCalled();
        }
        expect(spy).not.toHaveBeenCalled();
        expect(dbFn).not.toHaveBeenCalled();
    });
    it("on ⇒ syncs every due connection as `cron`; a throwing one does not stop the others", async () => {
        vi.spyOn(state, "listDueConnections").mockResolvedValue(["a", "b", "c"]);
        const calls: string[] = [];
        const sync = vi.fn(async (_d: unknown, id: string, trigger: "cron") => {
            calls.push(`${id}:${trigger}`);
            if (id === "a") throw new Error("boom with a secret-looking message");
            return id === "b" ? ({kind: "ran", run: {status: "failed"}} as never) : ({kind: "skipped", reason: "circuit_open"} as const);
        });
        expect(await discoveryTick(base({sync}))).toEqual({mode: "on", due: 3, ran: 1, skipped: 1, failed: 2});
        expect(calls).toEqual(["a:cron", "b:cron", "c:cron"]);
    });
    it("passes the configured interval and the injected clock/random to the due query", async () => {
        const spy = vi.spyOn(state, "listDueConnections").mockResolvedValue([]);
        const now = () => new Date("2026-01-01T00:00:00Z");
        const random = () => 0.1;
        await discoveryTick(base({now, random, intervalMs: () => 300_000}));
        expect(spy).toHaveBeenCalledWith(db, {now: now(), intervalMs: 300_000, random});
    });
});

describe("registration + interval setting", () => {
    it("registers ONE config-plane task: started in `on`, not in `locked`/`off` (ADR-010)", () => {
        clearForkRuntimeTasks();
        registerDiscoveryCron();
        registerDiscoveryCron(); // idempotent
        expect(tasksForMode("on").map((t) => t.name)).toEqual(["fork-discovery-sync"]);
        expect(tasksForMode("locked")).toEqual([]);
        expect(tasksForMode("off")).toEqual([]);
        clearForkRuntimeTasks();
    });
    it("FORK_DISCOVERY_INTERVAL_MINUTES: default 15, clamped to 5–1440, junk ⇒ default", () => {
        const f = (v?: string) => forkEnv({FORK_DISCOVERY_INTERVAL_MINUTES: v}).FORK_DISCOVERY_INTERVAL_MINUTES;
        expect([f(undefined), f("5"), f("1440"), f("60"), f("4"), f("1441"), f("abc"), f("7.5"), f("")]).toEqual([15, 5, 1440, 60, 15, 15, 15, 15, 15]);
    });
});
