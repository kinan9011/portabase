import {describe, expect, it, vi} from "vitest";
import {currentForkMode, registerActivePolicyProbe, registerSelfCheck} from "@/fork/mode";
import {forkBannerText, selfCheckHumanText} from "@/fork/self-check";

const ON = {FORK_ARCANE_ENABLED: "true"};

describe("W04 mode wiring (ADR-010/011)", () => {
    it("inert fork (flags off, no activation): the self-check is NOT evaluated (no queries, no audit ⇒ flags-off parity)", async () => {
        const check = vi.fn(async () => ({ok: false, failed: "org-count"}));
        registerSelfCheck(check);
        registerActivePolicyProbe(async () => 0);
        expect((await currentForkMode({env: {}})).mode).toBe("off");
        expect(check).not.toHaveBeenCalled();
    });
    it("flags on + failing check + no activation ⇒ off (fork invisible); with activation ⇒ locked with the codes as detail", async () => {
        registerSelfCheck(async () => ({ok: false, failed: "org-count,signup-open"}));
        registerActivePolicyProbe(async () => 0);
        expect((await currentForkMode({env: ON, now: 1})).mode).toBe("off");
        registerActivePolicyProbe(async () => 2);
        const m = await currentForkMode({env: ON, now: 2});
        expect(m).toMatchObject({mode: "locked", lockReason: "self-check-failed", detail: "org-count,signup-open"});
    });
    it("activation + flags OFF still evaluates (locked: flags-off) and a throwing check is fail-closed `check-error`", async () => {
        registerActivePolicyProbe(async () => 1);
        registerSelfCheck(async () => { throw new Error("db down"); });
        const m = await currentForkMode({env: ON});
        expect(m).toMatchObject({mode: "locked", lockReason: "self-check-failed", detail: "check-error"});
    });
    it("advisory warnings (C5) pass through without locking", async () => {
        registerActivePolicyProbe(async () => 0);
        registerSelfCheck(async () => ({ok: true, warnings: ["mcp-enabled"]}));
        expect(await currentForkMode({env: ON})).toEqual({mode: "on", warnings: ["mcp-enabled"]});
    });
    it("60 s cache: the check runs once inside the window", async () => {
        const check = vi.fn(async () => ({ok: true}));
        registerSelfCheck(check);
        await currentForkMode({env: ON, now: 1_000});
        await currentForkMode({env: ON, now: 30_000});
        expect(check).toHaveBeenCalledTimes(1);
        await currentForkMode({env: ON, now: 62_000});
        expect(check).toHaveBeenCalledTimes(2);
    });
    it("banner/facet text is built from codes only (fixed strings, no names/ids)", () => {
        expect(selfCheckHumanText("org-count,signup-open")).toBe("Fork configuration locked: this instance does not have exactly one organization; public sign-up is enabled (AUTH_SIGNUP_ENABLED must be false)");
        expect(selfCheckHumanText("Acme Corp <script>")).toBe("Fork configuration locked: a single-tenant check failed");
        expect(forkBannerText({mode: "on"})).toBeNull();
        expect(forkBannerText({mode: "locked", lockReason: "self-check-failed", detail: "agent-foreign-org"})).toContain("agent used by Stack Recovery belongs to another organization");
        expect(forkBannerText({mode: "locked", lockReason: "flags-off"})).toContain("feature flags are off");
    });
});
