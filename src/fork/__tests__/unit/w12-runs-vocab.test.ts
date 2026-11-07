import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {ITEM_STATES, PAUSE_REASONS, REFRESH_OUTCOMES, RUN_REASONS, RUN_STATES, RUN_TRIGGERS, SKIP_REASONS} from "@/fork/runs/vocab";

// Keeps the run vocabularies and the SQL CHECK constraints of migration 0006 from drifting apart.
describe("runs: TS vocabularies == SQL CHECK constraints", () => {
    const dir = path.join(process.cwd(), "src/fork/db/migrations");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    const values = (name: string) => {
        const m = [...sql.matchAll(new RegExp(`CONSTRAINT "${name}" CHECK \\([^)]*IN \\(([^)]*)\\)`, "g"))].at(-1);
        if (!m) throw new Error(`no CHECK ${name}`);
        return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    };
    it.each([
        ["fork_stack_run_trigger_ck", RUN_TRIGGERS],
        ["fork_stack_run_state_ck", RUN_STATES],
        ["fork_stack_run_skip_reason_ck", SKIP_REASONS],
        ["fork_stack_run_reason_ck", RUN_REASONS],
        ["fork_stack_run_refresh_ck", REFRESH_OUTCOMES],
        ["fork_stack_run_item_state_ck", ITEM_STATES],
        ["fork_stack_run_item_reason_ck", RUN_REASONS],
        ["fork_stack_policy_pause_reason_ck", PAUSE_REASONS],
    ] as [string, readonly string[]][])("%s", (name, v) => expect(values(name)).toEqual([...v]));
});
