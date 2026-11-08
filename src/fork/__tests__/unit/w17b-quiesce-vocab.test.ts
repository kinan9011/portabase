import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {KNOWN_CAPABILITIES, PUBLIC_TASK_TYPES, TARGETED_TASK_TYPES, TASK_REQUIRES} from "@/fork/agent-channel/vocab";
import {CONSISTENCY_LEVELS} from "@/fork/db/enums";
import {MIGRATION_LEDGER as LEDGER} from "@/fork/db/migration-ledger";
import {RP_DOWNGRADE_REASONS} from "@/fork/recovery/status";
import {RESTORE_REASONS} from "@/fork/restore-tasks/codes";
import {PLAN_BLOCKERS, QUIESCE_AGENT_CODES, QUIESCE_REASONS, QUIESCE_RUN_STEPS, QUIESCE_STATES, RELEASE_REASONS} from "@/fork/quiesce/vocab";
import {RUN_STEPS} from "@/fork/runs/vocab";
import {QUIESCE, ACTIVITY} from "@/fork/ui/labels";

const sql = readFileSync(path.join(process.cwd(), "src/fork/db/migrations/0015_quiesce.sql"), "utf8");
const list = (c: string): string[] => {
    const m = sql.match(new RegExp(`CONSTRAINT "${c}" CHECK \\([^;]*? IN \\(([^)]*)\\)`));
    if (!m) throw new Error(`no ${c}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

describe("W17b vocabulary mirrors", () => {
    it("every CHECK list in migration 0015 equals its TS vocabulary", () => {
        expect(list("fork_stack_run_quiesce_state_ck")).toEqual([...QUIESCE_STATES]);
        expect(list("fork_stack_run_quiesce_reason_ck")).toEqual([...QUIESCE_REASONS]);
        expect(list("fork_stack_run_quiesce_release_ck")).toEqual([...RELEASE_REASONS]);
        expect(list("fork_recovery_point_consistency_ck")).toEqual([...CONSISTENCY_LEVELS]);
        expect(list("fork_recovery_point_reason_ck")).toEqual([...RP_DOWNGRADE_REASONS]);
        expect(CONSISTENCY_LEVELS).toContain("stopped");
        expect(RP_DOWNGRADE_REASONS).toContain("quiesce_unconfirmed");
    });
    it("the migration is the next in the ledger and defaults to OFF", () => {
        expect(LEDGER.at(-1)?.tag).toBe("0015_quiesce");
        expect(sql).toMatch(/"quiesce_enabled" boolean DEFAULT false NOT NULL/);
    });
    it("RESTORE_REASONS ends with the quiesce agent codes, in the agent's order; no duplicates", () => {
        expect([...RESTORE_REASONS].slice(-QUIESCE_AGENT_CODES.length)).toEqual([...QUIESCE_AGENT_CODES]);
        expect(new Set(RESTORE_REASONS).size).toBe(RESTORE_REASONS.length);
        expect(new Set(QUIESCE_REASONS).size).toBe(QUIESCE_REASONS.length);
    });
    it("channel vocabulary: targeted, capability-gated, never public; quiesce.v1 is a known capability", () => {
        for (const t of ["quiesce", "quiesce_start"] as const) {
            expect(TASK_REQUIRES[t]).toEqual(["quiesce.v1"]);
            expect(TARGETED_TASK_TYPES).toContain(t);
            expect(PUBLIC_TASK_TYPES as readonly string[]).not.toContain(t);
        }
        expect([...PUBLIC_TASK_TYPES]).toEqual(["noop"]);
        expect(KNOWN_CAPABILITIES).toContain("quiesce.v1");
    });
    it("plain runs keep RUN_STEPS byte-identical; the quiesce list extends it in order", () => {
        expect([...RUN_STEPS]).toEqual(["refresh_inventory", "validate", "trigger", "track", "hash", "finalize"]);
        expect([...QUIESCE_RUN_STEPS]).toEqual(["refresh_inventory", "validate", "trigger", "track", "quiesce_stop", "trigger_window", "track_window", "quiesce_release", "hash", "finalize"]);
    });
    it("every closed code has product copy (labels.ts)", () => {
        for (const s of QUIESCE_STATES) expect(QUIESCE.states[s], s).toBeTruthy();
        for (const b of PLAN_BLOCKERS) expect(QUIESCE.blockers[b], b).toBeTruthy();
        for (const r of QUIESCE_REASONS) expect((QUIESCE.skip as Record<string, string>)[r] ?? QUIESCE.agentCodes[r], r).toBeTruthy();
        for (const s of QUIESCE_RUN_STEPS) expect(ACTIVITY.stage[s], s).toBeTruthy();
    });
});
