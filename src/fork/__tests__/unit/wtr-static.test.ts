import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {SKIP_REASONS, TR_REFUSALS, WIPE_REASONS} from "@/fork/test-restore/vocab";
import {DELIVERABLE_KINDS} from "@/fork/notifications/vocab";
import {NOTIFY, FACET_COPY} from "@/fork/ui/labels";
import {VERIFICATIONS} from "@/fork/restore-run/vocab";

const ROOT = process.cwd();
const dir = path.join(ROOT, "src/fork/test-restore");
const FILES = readdirSync(dir).filter((f) => f.endsWith(".ts"));
const src = (f: string) => readFileSync(path.join(dir, f), "utf8");
const code = (f: string) => src(f).split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

describe("W-TR static guards", () => {
    it("the module has exactly the planned files", () => {
        expect(FILES.sort()).toEqual(["deps.ts", "facet.ts", "job.ts", "load.ts", "scheduler.ts", "service.ts", "start.ts", "view-gate.ts", "view.ts", "vocab.ts", "wipe.ts"]);
    });
    it("never claims 'App start-tested' and never writes recovery point status", () => {
        for (const f of FILES) {
            const c = code(f);
            expect(c, f).not.toMatch(/start-tested|start_tested|RESTORE_TESTED|App start/i);
            expect(c, f).not.toMatch(/forkRecoveryPoint\b[^;]*\.(set|update)|update\(forkRecoveryPoint|fork_recovery_point\s+set/i);
            expect(c, f).not.toMatch(/insert\(forkRecoveryPoint/);
        }
    });
    it("pure modules import no node:/db/env", () => {
        for (const f of ["vocab.ts", "facet.ts"]) for (const m of code(f).matchAll(/from\s+["']([^"']+)["']/g)) expect(["./vocab", "@/fork/schedule/schedule"], `${f} imports ${m[1]}`).toContain(m[1]);
    });
    it("no API route was added for test restores (server actions only: Next's origin check is the CSRF guard)", () => {
        const walk = (p: string): string[] => readdirSync(p, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]));
        expect(walk(path.join(ROOT, "app/api")).filter((f) => /test-restore/.test(f))).toEqual([]);
    });
    it("every refusal / skip / wipe reason and notification kind has copy; new kinds render one fixed sentence", () => {
        for (const k of ["test_restore.failed", "test_restore.wipe_failed", "test_restore.skipped", "stack.test_restore_stale"]) {
            expect(DELIVERABLE_KINDS as readonly string[]).toContain(k);
            const m = (NOTIFY.kinds as Record<string, {title: string; sentence: string}>)[k];
            expect(m.title.length).toBeGreaterThan(3);
            expect(m.sentence).not.toMatch(/[:/]\/|http|reason/i);
        }
        expect(VERIFICATIONS).toContain("data_verified");
        expect(FACET_COPY.testRestore.value(null, false)).toBe("Not tested");
        expect(FACET_COPY.testRestore.value(3, true)).toBe("3 d ago · Out of date");
        expect(new Set([...SKIP_REASONS, ...TR_REFUSALS, ...WIPE_REASONS]).size).toBeGreaterThan(20);
        for (const r of [...SKIP_REASONS, ...TR_REFUSALS, ...WIPE_REASONS]) expect(r).toMatch(/^[a-z_]{1,64}$/);
    });
});

const uiDir = path.join(ROOT, "src/fork/ui/stacks/test-restore");
const UI_FILES = readdirSync(uiDir).sort();
const uiCode = (f: string) => readFileSync(path.join(uiDir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

describe("W-TR-f UI guards", () => {
    it("the panel has exactly the planned files", () => {
        expect(UI_FILES).toEqual(["labels.ts", "test-restore-edit.client.tsx", "test-restore-panel.tsx"]);
    });
    it("honest copy: no 'tested' family, and the shared 'Not tested' facet strings are never used", () => {
        for (const f of UI_FILES) {
            const c = uiCode(f);
            expect(c, f).not.toMatch(/\btested\b|verified restore|restore[- ]tested|start[- ]tested|app start|RESTORE_TESTED/i);
            expect(c, f).not.toMatch(/FACET_COPY\.testRestore\.(value|never)/);
        }
    });
    it("no clock reads in the panel (absolute server times only)", () => {
        for (const f of UI_FILES) expect(uiCode(f), f).not.toMatch(/Date\.now\(|new Date\(\)/);
    });
    it("the client file is a client module; no UI file imports a server module (type-only is fine)", () => {
        expect(uiCode("test-restore-edit.client.tsx").trimStart().startsWith('"use client"')).toBe(true);
        for (const f of UI_FILES) {
            for (const m of uiCode(f).matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
                if (m[1]) continue;
                expect(m[2], `${f} imports ${m[2]}`).not.toMatch(/^@\/fork\/db|^@\/fork\/test-restore\/(service|view|load|start|scheduler|wipe|job)$|^node:|^drizzle-orm|^@\/fork\/env$/);
            }
        }
    });
    it("labels.ts imports only the pure vocab, the shared labels and the formatters", () => {
        for (const m of uiCode("labels.ts").matchAll(/from\s+["']([^"']+)["']/g)) expect(["@/fork/test-restore/vocab", "@/fork/ui/labels", "@/fork/ui/stacks/format"], `labels.ts imports ${m[1]}`).toContain(m[1]);
    });
});
