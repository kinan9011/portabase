import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {RULES_SHA256} from "@/fork/policy/rules";

/**
 * Shared compose-policy corpus → agent (W17-ii E15, D27, OD-W17-10). The agent keeps BYTE-IDENTICAL copies of the three files in
 * `src/fork/policy/corpus/` plus `SOURCE.json` (dashboard commit, per-file sha256, TS rules hash).
 *  - `W17_CORPUS_OUT=<agent>/src/fork/policy/corpus`  → generator: copies the files and writes SOURCE.json
 *  - `W17_AGENT_CLONE=<agent clone>`                  → drift check: compares bytes + SOURCE.json (run by the implementer, the coordinator and every W-SYNC)
 *  - neither set                                      → skipped with a visible reason (the agent repo is not available in dashboard CI)
 */
const ROOT = process.cwd();
const FILES = [
    ["compose-deny.json", "src/fork/policy/compose-deny.json"],
    ["compose-policy-vectors.json", "src/fork/policy/compose-policy-vectors.json"],
    ["compose-policy-approval-vectors.json", "src/fork/__tests__/fixtures/compose-policy-approval-vectors.json"],
] as const;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const src = (rel: string) => readFileSync(path.join(ROOT, rel));
const out = process.env.W17_CORPUS_OUT;
const clone = process.env.W17_AGENT_CLONE;

describe("W17 agent corpus", () => {
    it("the corpus source files are what the plan counted (27 raw / 64 rendered / 12 approval cases, rule file v2)", () => {
        const v = JSON.parse(src(FILES[1][1]).toString());
        expect([v.raw.length, v.rendered.length, JSON.parse(src(FILES[2][1]).toString()).cases.length, JSON.parse(src(FILES[0][1]).toString()).version]).toEqual([27, 64, 12, 2]);
    });
    if (out) {
        it("writes the corpus into the agent clone (generator mode)", () => {
            mkdirSync(out, {recursive: true});
            let commit = "unknown";
            try { commit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: ROOT}).toString().trim(); } catch { /* not a git checkout */ }
            const files: Record<string, string> = {};
            for (const [name, rel] of FILES) { const b = src(rel); writeFileSync(path.join(out, name), b); files[name] = sha(b); }
            writeFileSync(path.join(out, "SOURCE.json"), `${JSON.stringify({dashboard_commit: commit, files, rules_sha256_ts: RULES_SHA256}, null, 2)}\n`);
        });
    }
    if (clone) {
        it("no drift: the agent's copies are byte-identical and SOURCE.json matches", () => {
            const dir = path.join(clone, "src/fork/policy/corpus");
            const meta = JSON.parse(readFileSync(path.join(dir, "SOURCE.json"), "utf8")) as {files: Record<string, string>; rules_sha256_ts: string};
            for (const [name, rel] of FILES) {
                const copy = readFileSync(path.join(dir, name));
                expect(sha(copy), name).toBe(sha(src(rel)));
                expect(meta.files[name], name).toBe(sha(copy));
            }
            expect(meta.rules_sha256_ts).toBe(RULES_SHA256);
        });
    }
    it.skipIf(!!out || !!clone)("drift check skipped: set W17_AGENT_CLONE=<portabase-agent clone> (the agent repo is not part of dashboard CI)", () => { expect(true).toBe(true); });
});
