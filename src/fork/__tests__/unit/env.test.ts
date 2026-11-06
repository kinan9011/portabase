import {describe, expect, it} from "vitest";
import {anyForkFlagOn, forkEnv} from "@/fork/env";

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
});
