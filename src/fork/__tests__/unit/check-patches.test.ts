import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";

const script = path.join(process.cwd(), "scripts/fork/check-patches.sh");

function fixture(files: Record<string, string>, registry: string) {
    const root = mkdtempSync(path.join(os.tmpdir(), "w01-patches-"));
    for (const [f, c] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
        writeFileSync(path.join(root, f), c);
    }
    writeFileSync(path.join(root, "registry.txt"), registry);
    const r = spawnSync("bash", [script], {env: {...process.env, PATCH_ROOT: root, PATCH_REGISTRY: path.join(root, "registry.txt")}, encoding: "utf8"});
    return {code: r.status, out: r.stdout + r.stderr};
}

const GOOD_FILE = "export const schemas = {\n  ...forkSchema, // FORK(stack-recovery): P01 spread\n};\n// FORK(stack-recovery): P01 import\n";
const REG = "# comment\nP01|src/db/index.ts|schemas|2\n";

describe("scripts/fork/check-patches.sh (markers ⇄ registry, anchored by symbol)", () => {
    it("passes when markers, registry and anchor agree (fork-only paths are ignored)", () => {
        const r = fixture({"src/db/index.ts": GOOD_FILE, "src/fork/a.ts": "// FORK(stack-recovery): free text allowed in fork paths\n"}, REG);
        expect(r.out).toContain("check-patches: OK (1 registered patches, 2 markers)");
        expect(r.code).toBe(0);
    });
    it("fails: marker present but not registered", () => {
        const r = fixture({"src/db/index.ts": GOOD_FILE, "src/other.ts": "// FORK(stack-recovery): P99 hook\n"}, REG);
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/marker P99 in src\/other.ts is not in the registry/);
    });
    it("fails: registry row without its marker", () => {
        const r = fixture({"src/db/index.ts": "export const schemas = {};\n"}, REG);
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/P01: expected 2 marker\(s\) in src\/db\/index.ts, found 0/);
    });
    it("fails: anchor symbol renamed upstream (symbol anchoring, not line numbers)", () => {
        const r = fixture({"src/db/index.ts": GOOD_FILE.replaceAll("schemas", "tables")}, REG);
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/P01: anchor symbol 'schemas' not found/);
    });
    it("fails: marker without id, marker in the wrong file, registered file missing", () => {
        expect(fixture({"src/db/index.ts": GOOD_FILE, "src/x.ts": "// FORK(stack-recovery): no id here\n"}, REG).out).toMatch(/marker without a registry id/);
        expect(fixture({"src/db/index.ts": GOOD_FILE, "src/x.ts": "// FORK(stack-recovery): P01 elsewhere\n"}, REG).out).toMatch(/marker P01 found in src\/x.ts but registered for src\/db\/index.ts/);
        expect(fixture({}, REG).out).toMatch(/P01: registered file missing/);
    });
    it("`-` rows (JSON files) only need their anchor", () => {
        expect(fixture({"package.json": '{"scripts":{"test:fork":"vitest run"}}'}, "P14|package.json|test:fork|-\n").code).toBe(0);
        expect(fixture({"package.json": "{}"}, "P14|package.json|test:fork|-\n").code).toBe(1);
    });
    it("the real repo registry is consistent", () => {
        const r = spawnSync("bash", [script], {cwd: process.cwd(), encoding: "utf8"});
        expect(r.stdout + r.stderr).toContain("check-patches: OK");
        expect(r.status).toBe(0);
    });
});
