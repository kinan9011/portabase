import {describe, expect, it} from "vitest";
import {anyForkFlagOn, FORK_AGENT_HEARTBEAT_SECONDS, forkEnv} from "@/fork/env";

describe("fork env flags", () => {
    it("defaults everything off", () => {
        const e = forkEnv({});
        expect([e.FORK_STACKS_ENABLED, e.FORK_ARCANE_ENABLED, e.FORK_MIRRORS_ENABLED]).toEqual([false, false, false]);
        expect(anyForkFlagOn({})).toBe(false);
        expect(e.FORK_MIGRATE_DUMP).toBe("auto");
        expect(e.FORK_PG_DUMP_BIN).toBe("pg_dump");
    });
    it("only the literal 'true' turns a flag on (fail closed)", () => {
        for (const v of ["1", "yes", "on", "TRUEE", "", " ", "false", undefined]) {
            expect(forkEnv({FORK_STACKS_ENABLED: v}).FORK_STACKS_ENABLED, String(v)).toBe(false);
        }
        for (const v of ["true", "TRUE", " True "]) expect(forkEnv({FORK_ARCANE_ENABLED: v}).FORK_ARCANE_ENABLED).toBe(true);
    });
    it("any single flag makes anyForkFlagOn true", () => {
        expect(anyForkFlagOn({FORK_MIRRORS_ENABLED: "true"})).toBe(true);
    });
    it("unknown dump policy falls back to auto", () => {
        expect(forkEnv({FORK_MIGRATE_DUMP: "whatever"}).FORK_MIGRATE_DUMP).toBe("auto");
        expect(forkEnv({FORK_MIGRATE_DUMP: "REQUIRED"}).FORK_MIGRATE_DUMP).toBe("required");
        expect(forkEnv({FORK_MIGRATE_DUMP: "off"}).FORK_MIGRATE_DUMP).toBe("off");
    });
    it("W16: restore plan TTL defaults to 24 h, accepts 1..168, anything else falls back", () => {
        expect(forkEnv({}).FORK_RESTORE_PLAN_TTL_HOURS).toBe(24);
        for (const [v, want] of [["1", 1], ["168", 168], ["0", 24], ["169", 24], ["x", 24], ["", 24]] as const) expect(forkEnv({FORK_RESTORE_PLAN_TTL_HOURS: v}).FORK_RESTORE_PLAN_TTL_HOURS, v).toBe(want);
    });
    it("W18a: restore run cap defaults to 12 h (1..48); tick defaults to 10 s (0..300, blank is never 0)", () => {
        expect(forkEnv({}).FORK_RESTORE_RUN_MAX_HOURS).toBe(12);
        for (const [v, want] of [["1", 1], ["48", 48], ["0", 12], ["49", 12], ["x", 12], ["", 12]] as const) expect(forkEnv({FORK_RESTORE_RUN_MAX_HOURS: v}).FORK_RESTORE_RUN_MAX_HOURS, v).toBe(want);
        expect(forkEnv({}).FORK_RESTORE_TICK_SECONDS).toBe(10);
        for (const [v, want] of [["0", 0], ["1", 1], ["300", 300], ["301", 10], ["-1", 10], ["x", 10], ["", 10], ["  ", 10]] as const) expect(forkEnv({FORK_RESTORE_TICK_SECONDS: v}).FORK_RESTORE_TICK_SECONDS, v).toBe(want);
    });

    it("W27a F-03: the lease floor is 45 s (>= 2 x the 20 s agent heartbeat + 5 s); anything below falls back to the default 60", () => {
        expect(FORK_AGENT_HEARTBEAT_SECONDS).toBe(20);
        expect(forkEnv({}).FORK_AGENT_LEASE_SECONDS).toBe(60);
        for (const [v, want] of [["15", 60], ["30", 60], ["44", 60], ["45", 45], ["60", 60], ["600", 600], ["601", 60], ["x", 60], ["", 60]] as const) expect(forkEnv({FORK_AGENT_LEASE_SECONDS: v}).FORK_AGENT_LEASE_SECONDS, v).toBe(want);
        expect(Math.min(...[45, 46, 600].filter((n) => forkEnv({FORK_AGENT_LEASE_SECONDS: String(n)}).FORK_AGENT_LEASE_SECONDS === n))).toBeGreaterThanOrEqual(2 * FORK_AGENT_HEARTBEAT_SECONDS + 5);
        expect(forkEnv({FORK_AGENT_LEASE_SECONDS: "44"}).FORK_AGENT_LEASE_SECONDS).toBeGreaterThanOrEqual(2 * FORK_AGENT_HEARTBEAT_SECONDS + 5); // the fallback itself honours the rule
    });
});
