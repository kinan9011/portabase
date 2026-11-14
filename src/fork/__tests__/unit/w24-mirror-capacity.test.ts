import {describe, expect, it} from "vitest";
import {planRestore} from "@/fork/restore/plan";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {neededBytes} from "@/fork/restore-run/derive";
import {checkMirrorCapacity} from "@/fork/mirror/derive";
import {planInput} from "@/fork/__tests__/w16-fixtures";

const plan: RestorePlanV1 = planRestore(planInput()).plan;
const need = neededBytes(plan);
const need11 = Math.ceil(need * 1.1);
const GIB = 1024 ** 3;
const res = (free: number | null | undefined, mem: number | null | undefined) => ({roots: [{path: "/srv/restore", shared: true, free_bytes: free}], ...(mem === undefined ? {} : {mem_available_bytes: mem})});
const cap = (r: unknown, refresh: boolean, memNeed = 2 * GIB) => checkMirrorCapacity(r, plan, {refresh, memNeed});

describe("W24 checkMirrorCapacity (pure)", () => {
    it("fixture sanity: the plan needs bytes and the root is /srv/restore", () => {
        expect(need).toBeGreaterThan(0);
        expect(plan.target.restore_root).toBe("/srv/restore");
    });
    it("disk: exactly ceil(need x 1.1) passes, one byte less is insufficient_disk (create and refresh)", () => {
        for (const refresh of [false, true]) {
            expect(cap(res(need11, 64 * GIB), refresh)).toEqual({ok: true});
            expect(cap(res(need11 - 1, 64 * GIB), refresh)).toEqual({ok: false, code: "insufficient_disk"});
        }
    });
    it("the headroom is real: free == need (old rule would pass) now fails", () => {
        expect(cap(res(need, 64 * GIB), false)).toEqual({ok: false, code: "insufficient_disk"});
    });
    it("unreported free disk: a first creation still passes (old behaviour), a refresh is capacity_unknown (fail closed)", () => {
        expect(cap(res(null, undefined), false)).toEqual({ok: true});
        expect(cap(res(null, 64 * GIB), true)).toEqual({ok: false, code: "capacity_unknown"});
    });
    it("memory (refresh only): below fails, exactly the need and above pass; a creation ignores memory", () => {
        expect(cap(res(10 ** 12, 2 * GIB - 1), true)).toEqual({ok: false, code: "insufficient_memory"});
        expect(cap(res(10 ** 12, 2 * GIB), true)).toEqual({ok: true});
        expect(cap(res(10 ** 12, 3 * GIB), true)).toEqual({ok: true});
        expect(cap(res(10 ** 12, 0), false)).toEqual({ok: true});
    });
    it("missing / null / garbage memory fact on a refresh is capacity_unknown, never a pass", () => {
        expect(cap(res(10 ** 12, undefined), true)).toEqual({ok: false, code: "capacity_unknown"});
        expect(cap(res(10 ** 12, null), true)).toEqual({ok: false, code: "capacity_unknown"});
        expect(cap({roots: res(10 ** 12, 1).roots, mem_available_bytes: "9999999999"}, true)).toEqual({ok: false, code: "capacity_unknown"});
        expect(cap({roots: res(10 ** 12, 1).roots, mem_available_bytes: -1}, true)).toEqual({ok: false, code: "capacity_unknown"});
    });
    it("a result without the plan's root is capacity_unknown on refresh and tolerated on creation (checkProbe owns root_missing)", () => {
        expect(cap({roots: [{path: "/other", shared: true, free_bytes: 1}], mem_available_bytes: 64 * GIB}, true)).toEqual({ok: false, code: "capacity_unknown"});
        expect(cap({}, false)).toEqual({ok: true});
        expect(cap(null, true)).toEqual({ok: false, code: "capacity_unknown"});
    });
    it("disk is judged before memory when both are short", () => {
        expect(cap(res(need11 - 1, 0), true)).toEqual({ok: false, code: "insufficient_disk"});
    });
});
