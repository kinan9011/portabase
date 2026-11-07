import {describe, expect, it} from "vitest";
import {DEFAULT_RETENTION, RetentionPolicySchema} from "@/fork/recovery/retention-policy";
import {expandField, isValidCron, isValidCronPart} from "@/fork/schedule/cron-expr";
import {DEFAULT_SCHEDULE, intervalHours, isValidTimezone, nextRuns, ScheduleSchema, toCron, zonedToUtc, type Schedule} from "@/fork/schedule/schedule";

const S = (o: Partial<Schedule>): Schedule => ScheduleSchema.parse({...DEFAULT_SCHEDULE, ...o});
const iso = (d: Date[]) => d.map((x) => x.toISOString());

describe("W11 schedule — presets → effective cron (EU-16)", () => {
    it("maps every preset", () => {
        expect(toCron(S({preset: "hourly", minute: 15}))).toBe("15 * * * *");
        expect(toCron(S({preset: "every_6h", minute: 5}))).toBe("5 */6 * * *");
        expect(toCron(S({preset: "every_12h"}))).toBe("0 */12 * * *");
        expect(toCron(S({preset: "daily", hour: 3, minute: 30}))).toBe("30 3 * * *");
        expect(toCron(S({preset: "weekly", hour: 4, weekday: 1}))).toBe("0 4 * * 1");
        expect(toCron(S({preset: "monthly", hour: 1, monthday: 28}))).toBe("0 1 28 * *");
        expect(toCron(S({preset: "cron", cron: " 0  2 * *  1-5 "}))).toBe("0 2 * * 1-5");
    });
    it("raw cron only with preset=cron, and it must be valid", () => {
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, cron: "0 0 * * *"}).success).toBe(false);
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, preset: "cron"}).success).toBe(false);
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, preset: "cron", cron: "61 0 * * *"}).success).toBe(false);
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, preset: "cron", cron: "x".repeat(101)}).success).toBe(false);
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, preset: "cron", cron: "0 0 * * *"}).success).toBe(true);
    });
    it("rejects unknown keys, bad timezone, out-of-range numbers", () => {
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, extra: 1}).success).toBe(false);
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, timezone: "Mars/Olympus"}).success).toBe(false);
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, hour: 24}).success).toBe(false);
        expect(ScheduleSchema.safeParse({...DEFAULT_SCHEDULE, monthday: 31}).success).toBe(false);
        expect(isValidTimezone("Europe/Berlin")).toBe(true);
        expect(isValidTimezone("")).toBe(false);
    });
});

describe("W11 schedule — cron grammar", () => {
    it("validates parts like upstream", () => {
        expect(isValidCronPart("minute", "*/15")).toBe(true);
        expect(isValidCronPart("minute", "60")).toBe(false);
        expect(isValidCronPart("day-of-week", "7")).toBe(false);
        expect(isValidCron("0 0 * * *")).toBe(true);
        expect(isValidCron("0 0 * *")).toBe(false);
    });
    it("expands fields", () => {
        expect(expandField("hour", "*/6")).toEqual([0, 6, 12, 18]);
        expect(expandField("minute", "5,10-12")).toEqual([5, 10, 11, 12]);
        expect(expandField("minute", "5/20")).toEqual([5, 25, 45]);
        expect(expandField("day-of-week", "1-5")).toEqual([1, 2, 3, 4, 5]);
    });
});

describe("W11 schedule — next runs in a timezone", () => {
    const from = new Date("2026-11-07T10:00:00Z");
    it("daily in UTC", () => {
        expect(iso(nextRuns(S({preset: "daily", hour: 2}), from))).toEqual(["2026-11-08T02:00:00.000Z", "2026-11-09T02:00:00.000Z", "2026-11-10T02:00:00.000Z"]);
    });
    it("daily in Europe/Berlin (CET, UTC+1 in November)", () => {
        expect(iso(nextRuns(S({preset: "daily", hour: 2, timezone: "Europe/Berlin"}), from, 1))).toEqual(["2026-11-08T01:00:00.000Z"]);
    });
    it("hourly strictly after `from`", () => {
        expect(iso(nextRuns(S({preset: "hourly", minute: 0}), new Date("2026-11-07T10:00:00Z"), 2))).toEqual(["2026-11-07T11:00:00.000Z", "2026-11-07T12:00:00.000Z"]);
    });
    it("weekly on Monday; monthly on the 1st", () => {
        const w = nextRuns(S({preset: "weekly", weekday: 1, hour: 4}), from, 2); // 2026-11-07 is a Saturday
        expect(iso(w)).toEqual(["2026-11-09T04:00:00.000Z", "2026-11-16T04:00:00.000Z"]);
        expect(iso(nextRuns(S({preset: "monthly", monthday: 1, hour: 1}), from, 2))).toEqual(["2026-12-01T01:00:00.000Z", "2027-01-01T01:00:00.000Z"]);
    });
    it("DST: a skipped local time runs just after the gap; a repeated one runs once", () => {
        // America/New_York 2026-03-08 02:30 does not exist (spring forward at 07:00Z)
        const gap = zonedToUtc({y: 2026, mo: 3, d: 8, h: 2, mi: 30}, "America/New_York");
        expect(new Date(gap).toISOString()).toBe("2026-03-08T07:30:00.000Z");
        // 2026-11-01 01:30 happens twice (fall back at 06:00Z): first occurrence only
        const rep = nextRuns(S({preset: "daily", hour: 1, minute: 30, timezone: "America/New_York"}), new Date("2026-10-31T12:00:00Z"), 3);
        expect(iso(rep)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z", "2026-11-03T06:30:00.000Z"]);
    });
    it("interval for the dead-man threshold", () => {
        expect(intervalHours(S({preset: "daily"}), from)).toBe(24);
        expect(intervalHours(S({preset: "every_6h"}), from)).toBe(6);
        expect(intervalHours(S({preset: "weekly"}), from)).toBe(168);
    });
});

describe("W11 retention policy (D33 v1)", () => {
    it("defaults parse; strict; bounds", () => {
        expect(RetentionPolicySchema.parse(DEFAULT_RETENTION)).toEqual(DEFAULT_RETENTION);
        expect(RetentionPolicySchema.safeParse({...DEFAULT_RETENTION, keep_last: 0}).success).toBe(false);
        expect(RetentionPolicySchema.safeParse({...DEFAULT_RETENTION, daily: -1}).success).toBe(false);
        expect(RetentionPolicySchema.safeParse({...DEFAULT_RETENTION, hourly: 1}).success).toBe(false);
        expect(RetentionPolicySchema.safeParse({...DEFAULT_RETENTION, yearly: 51}).success).toBe(false);
    });
});
