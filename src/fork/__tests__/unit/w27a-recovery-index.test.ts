import {beforeEach, describe, expect, it, vi} from "vitest";

const h = vi.hoisted(() => ({mode: "on" as "on" | "off", principal: null as null | {userId: string}}));
vi.mock("next/navigation", () => ({
    notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
    redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
}));
vi.mock("@/fork/mode", () => ({currentForkMode: async () => ({mode: h.mode})}));
vi.mock("@/fork/principal", () => ({getForkPrincipal: async () => h.principal}));

import RecoveryPlansIndexPage from "../../../../app/(customer)/dashboard/(organization)/recovery/plans/page";
import RecoveryRunsIndexPage from "../../../../app/(customer)/dashboard/(organization)/recovery/runs/page";

const PAGES = {plans: RecoveryPlansIndexPage, runs: RecoveryRunsIndexPage};

beforeEach(() => { h.mode = "on"; h.principal = {userId: "u"}; });

describe.each(Object.entries(PAGES))("breadcrumb index /dashboard/recovery/%s (W27a P0, from the W18b console 404s)", (_name, Page) => {
    it("flags off → real 404 (the route stays invisible), even with a session", async () => {
        h.mode = "off";
        await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    });
    it("no usable principal (anonymous / pending / banned) → 404, not a redirect", async () => {
        h.principal = null;
        await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    });
    it("a usable principal is sent to the recovery home, which applies the role gate", async () => {
        await expect(Page()).rejects.toThrow("NEXT_REDIRECT:/dashboard/recovery");
    });
});
