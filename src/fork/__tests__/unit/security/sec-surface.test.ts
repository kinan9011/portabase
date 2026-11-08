import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {FORK_CAPABILITIES} from "@/fork/acl";
import {ACTION_MATRIX, PAGE_MATRIX, ROUTE_MATRIX} from "../../security/matrix";
import {ROLES} from "../../security/roles";
import {actionKey, diffKeys, listForkActions, listForkPages, listForkRoutes, listStrayServerFiles, listUnguardedExports, REPO_ROOT, routeKey} from "../../security/surface";

const src = (f: string) => readFileSync(join(REPO_ROOT, f), "utf8");

describe("SEC-09 matrix completeness: every fork action / route / page has exactly one row", () => {
    it("server actions ≡ ACTION_MATRIX (both directions)", () => {
        expect(diffKeys("action", listForkActions().map(actionKey), Object.keys(ACTION_MATRIX))).toEqual([]);
    });
    it("route handlers ≡ ROUTE_MATRIX (both directions)", () => {
        expect(diffKeys("route", listForkRoutes().map(routeKey), Object.keys(ROUTE_MATRIX))).toEqual([]);
    });
    it("pages that import fork code ≡ PAGE_MATRIX (both directions)", () => {
        expect(diffKeys("page", listForkPages().map((p) => p.file), Object.keys(PAGE_MATRIX))).toEqual([]);
    });
    it("no 'use server' module outside src/fork/actions/ imports fork code (it would escape the matrix)", () => {
        expect(listStrayServerFiles()).toEqual([]);
    });
    it("mutant: a new action without a row is reported by name; a deleted action leaves a stale row", () => {
        const real = listForkActions().map(actionKey);
        expect(diffKeys("action", [...real, "new.action.ts#sneakyAction"], Object.keys(ACTION_MATRIX))).toEqual(["action new.action.ts#sneakyAction has NO matrix row (add one to src/fork/__tests__/security/matrix.ts)"]);
        expect(diffKeys("action", real.slice(1), Object.keys(ACTION_MATRIX))).toEqual([`action row ${real[0]} is STALE (no such action in the code)`]);
    });
});

describe("SEC-09 structural guarantees of the action layer", () => {
    it("every export of every action file is built from `userAction` (no session-less server action)", () => {
        expect(listUnguardedExports()).toEqual([]);
    });
    it("every action file derives its principal from getForkPrincipal() (no principal taken from the request)", () => {
        for (const f of new Set(listForkActions().map((a) => a.file))) {
            const s = src(f);
            expect(s, f).toContain("getForkPrincipal()");
            expect(s, f).not.toMatch(/userId\s*:\s*parsedInput|principal\s*:\s*parsedInput/);
        }
    });
    it("rows are well formed: roles ⊆ ROLES, a locked-allowed row cites its decision, mutating rows are refused while locked unless cited", () => {
        for (const [k, r] of Object.entries(ACTION_MATRIX)) {
            for (const role of r.allow) expect(ROLES, k).toContain(role);
            expect(FORK_CAPABILITIES, k).toContain(r.capability);
            if (r.whileLocked === "allowed") expect(r.lockedWhy?.length ?? 0, `${k} must cite why it is allowed while locked`).toBeGreaterThan(10);
            for (const bad of ["anon", "pending", "banned"] as const) expect(r.allow, k).not.toContain(bad);
        }
    });
});

describe("SEC-09 page rows are asserted from the page source (D-8)", () => {
    it.each(Object.entries(PAGE_MATRIX))("%s", (file, row) => {
        const s = src(file);
        expect(s, "real 404 for a missing/forbidden caller").toMatch(/notFound\(\)/);
        if (row.capability === "mode-only") { expect(s).toMatch(/currentForkMode\(\)/); expect(s).toMatch(/getForkPrincipal\(\)/); return; }
        expect(s, `must gate on ${row.capability}`).toMatch(new RegExp(`(forkCan|assertForkResource)\\([^)]*"${row.capability.replace(/\./g, "\\.")}"`));
    });
});
