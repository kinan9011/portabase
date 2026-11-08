import {describe, expect, it} from "vitest";
import {testRestoreFacet, testRestoreStaleHolds} from "@/fork/test-restore/facet";
import {testRestoreProject, DEFAULT_TR_SCHEDULE} from "@/fork/test-restore/vocab";
import {ScheduleSchema} from "@/fork/schedule/schedule";
import {decideSlot} from "@/fork/runs/schedule-due";
import {CAPTURE_WINDOW_MS} from "@/fork/test-restore/vocab";

// every date derives from ONE `now` captured here (never a fixed past date against the real clock: decisions.md 2026-11-07, PR #20)
const now = new Date();
const DAY = 86_400_000;
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("W-TR facet decay (plan D-7)", () => {
    it("never tested ⇒ null, not stale", () => expect(testRestoreFacet({lastVerifiedAt: null, now, staleAfterDays: 14})).toEqual({daysAgo: null, stale: false}));
    it("fresh, boundary and stale", () => {
        expect(testRestoreFacet({lastVerifiedAt: ago(0), now, staleAfterDays: 14})).toEqual({daysAgo: 0, stale: false});
        expect(testRestoreFacet({lastVerifiedAt: ago(14 * DAY), now, staleAfterDays: 14})).toEqual({daysAgo: 14, stale: false}); // exactly 14 d is still fine
        expect(testRestoreFacet({lastVerifiedAt: ago(14 * DAY + 1), now, staleAfterDays: 14})).toMatchObject({stale: true});
        expect(testRestoreFacet({lastVerifiedAt: ago(15 * DAY), now, staleAfterDays: 14})).toEqual({daysAgo: 15, stale: true});
        expect(testRestoreFacet({lastVerifiedAt: ago(15 * DAY), now, staleAfterDays: 30}).stale).toBe(false);
    });
    it("a future timestamp (clock skew) never yields a negative age", () => expect(testRestoreFacet({lastVerifiedAt: new Date(now.getTime() + DAY), now, staleAfterDays: 14}).daysAgo).toBe(0));
});

describe("W-TR stale alert condition (plan D-8)", () => {
    const base = {enabled: true, enabledAt: ago(20 * DAY), lastVerifiedAt: null as Date | null, now, staleAfterDays: 14};
    it("disabled schedule never alerts", () => expect(testRestoreStaleHolds({...base, enabled: false})).toBe(false));
    it("never tested: one decay window of grace after enabling", () => {
        expect(testRestoreStaleHolds({...base, enabledAt: ago(13 * DAY)})).toBe(false);
        expect(testRestoreStaleHolds({...base, enabledAt: ago(14 * DAY + 1)})).toBe(true);
    });
    it("tested: holds only once the facet is stale", () => {
        expect(testRestoreStaleHolds({...base, lastVerifiedAt: ago(14 * DAY)})).toBe(false);
        expect(testRestoreStaleHolds({...base, lastVerifiedAt: ago(14 * DAY + 1)})).toBe(true);
    });
});

describe("W-TR vocabulary + schedule due-ness", () => {
    it("scratch project name: lowercase, no dot, ≤ 64, distinct from the wizard's", () => {
        expect(testRestoreProject("app")).toBe("app-test-restore");
        const long = testRestoreProject("a".repeat(128));
        expect(long.length).toBeLessThanOrEqual(64);
        expect(long).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    });
    it("default schedule is weekly Sunday 03:30 UTC", () => expect(ScheduleSchema.safeParse(DEFAULT_TR_SCHEDULE).success).toBe(true));
    it("a due slot inside the 6 h capture window starts; later it is missed; an active run / pending wipe skips it", () => {
        const s = ScheduleSchema.parse({preset: "hourly", timezone: "UTC", minute: (now.getUTCMinutes() + 59) % 60, hour: 0, weekday: 0, monthday: 1});
        const from = ago(2 * 3_600_000);
        expect(decideSlot({schedule: s, from, now, windowMs: CAPTURE_WINDOW_MS, activeRun: false}).kind).toBe("start");
        expect(decideSlot({schedule: s, from, now, windowMs: CAPTURE_WINDOW_MS, activeRun: true})).toMatchObject({kind: "skip", reason: "overlap"});
        expect(decideSlot({schedule: s, from, now, windowMs: 30_000, activeRun: false})).toMatchObject({kind: "skip", reason: "missed"});
    });
});
