import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {MIGRATION_LEDGER} from "@/fork/db/migration-ledger";

const dir = path.join(process.cwd(), "src/fork/db/migrations");
const journal = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string; when: number }[] };

describe("central fork-migration numbering (ARCH-14)", () => {
    it("ledger tags equal journal tags, in order (no unregistered, duplicate or missing migration)", () => {
        expect(MIGRATION_LEDGER.map((e) => e.tag)).toEqual(journal.entries.map((e) => e.tag));
    });
    it("journal is gapless and numbered NNNN_ by position", () => {
        journal.entries.forEach((e, i) => {
            expect(e.idx).toBe(i);
            expect(e.tag.startsWith(String(i).padStart(4, "0") + "_")).toBe(true);
        });
    });
    it("`when` is strictly ascending (drizzle applies by timestamp)", () => {
        const w = journal.entries.map((e) => e.when);
        expect(w).toEqual([...w].sort((a, b) => a - b));
        expect(new Set(w).size).toBe(w.length);
    });
    it("every ledger entry names an owning wave and every .sql file is in the ledger", () => {
        for (const e of MIGRATION_LEDGER) expect(e.wave).toMatch(/^W/);
        const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();
        expect(files).toEqual(MIGRATION_LEDGER.map((e) => e.tag).sort());
    });
    it("no DDL/DML on upstream objects: every statement targets a fork_-prefixed object", () => {
        const stmt = /\b(?:create\s+(?:unique\s+)?(?:table|index|type|sequence)(?:\s+if\s+not\s+exists)?|alter\s+table(?:\s+if\s+exists)?|drop\s+(?:table|index|type)(?:\s+if\s+exists)?|insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:"?public"?\.)?("?)([a-z0-9_]+)\1/gi;
        for (const e of MIGRATION_LEDGER) {
            const sql = readFileSync(path.join(dir, `${e.tag}.sql`), "utf8");
            const targets = [...sql.matchAll(stmt)].map((m) => m[2]);
            expect(targets.length, `${e.tag} has statements`).toBeGreaterThan(0);
            for (const t of targets) expect(t.startsWith("fork_") || /^idx_fork_|^fork_/.test(t), `${e.tag}: ${t}`).toBe(true);
        }
    });
});
