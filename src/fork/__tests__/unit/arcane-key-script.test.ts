import {spawnSync} from "node:child_process";
import {accessSync, constants, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {ENV_MINIMUM, GLOBAL_MINIMUM} from "@/fork/arcane/endpoints";

/** Drift guard for scripts/fork/arcane/create-discovery-key.sh: the grants it creates must equal the adapter's list-only minimum. */
const SCRIPT = path.join(process.cwd(), "scripts/fork/arcane/create-discovery-key.sh");
const text = readFileSync(SCRIPT, "utf8");

describe("create-discovery-key.sh", () => {
    it("is executable and valid bash", () => {
        accessSync(SCRIPT, constants.X_OK);
        expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    });

    it("grants exactly the global + per-environment minimum, scoped by environmentId", () => {
        for (const p of GLOBAL_MINIMUM) expect(text).toContain(`{permission: "${p}"}`);
        const list = /\[("[a-z]+:list"(?:,"[a-z]+:list")*)\]\s*\n\s*\| map\(\{permission: \., environmentId: \$env\}\)/.exec(text);
        expect(list, "env-scoped permission list not found").not.toBeNull();
        expect(list![1].replaceAll('"', "").split(",").sort()).toEqual([...ENV_MINIMUM].sort());
    });

    it("never grants a read/write permission and never stores a secret", () => {
        expect(text).not.toMatch(/"[a-z]+:(read|edit|create|delete|exec|write)"/);
        expect(text).toMatch(/read -rsp/); // admin key read hidden
        expect(text).not.toMatch(/arc_[A-Za-z0-9]{10,}/);
    });
});
