import {describe, expect, it} from "vitest";
import {decideSlot, latestDueSlot} from "@/fork/runs/schedule-due";
import {DEFAULT_SCHEDULE, type Schedule} from "@/fork/schedule/schedule";

const daily: Schedule = {...DEFAULT_SCHEDULE, preset: "daily", hour: 2, minute: 0, timezone: "UTC"};
const hourly: Schedule = {...DEFAULT_SCHEDULE, preset: "hourly", minute: 15, timezone: "UTC"};
const d = (s: string) => new Date(s);
const HOUR = 3_600_000;

describe("runs: schedule due-ness, capture window and skip semantics (ARCH-17, ARCH-10)", () => {
    it("no slot between activation and the first cron instant", () => {
        expect(latestDueSlot(daily, d("2026-11-07T10:00:00Z"), d("2026-11-08T01:59:00Z"))).toBeNull();
        expect(decideSlot({schedule: daily, from: d("2026-11-07T10:00:00Z"), now: d("2026-11-08T01:59:00Z"), windowMs: HOUR, activeRun: false})).toEqual({kind: "none"});
    });
    it("a due slot inside the window starts", () => {
        const r = decideSlot({schedule: daily, from: d("2026-11-07T10:00:00Z"), now: d("2026-11-08T02:00:30Z"), windowMs: HOUR, activeRun: false});
        expect(r).toEqual({kind: "start", slot: d("2026-11-08T02:00:00Z")});
    });
    it("capacity-wait keeps returning the SAME slot until the window ends, then it is missed", () => {
        const from = d("2026-11-07T10:00:00Z");
        const at = (iso: string) => decideSlot({schedule: daily, from, now: d(iso), windowMs: HOUR, activeRun: false});
        expect(at("2026-11-08T02:30:00Z")).toMatchObject({kind: "start", slot: d("2026-11-08T02:00:00Z")});
        expect(at("2026-11-08T03:00:00Z")).toMatchObject({kind: "start"});
        expect(at("2026-11-08T03:00:01Z")).toEqual({kind: "skip", slot: d("2026-11-08T02:00:00Z"), reason: "missed"});
    });
    it("overlap: a slot while a run is active is skipped, never queued", () => {
        const r = decideSlot({schedule: daily, from: d("2026-11-07T10:00:00Z"), now: d("2026-11-08T02:05:00Z"), windowMs: HOUR, activeRun: true});
        expect(r).toEqual({kind: "skip", slot: d("2026-11-08T02:00:00Z"), reason: "overlap"});
    });
    it("downtime: ONE decision for the latest slot, no backlog replay (3 h outage of an hourly schedule)", () => {
        const from = d("2026-11-07T10:15:00Z"); // last handled slot
        const now = d("2026-11-07T13:20:00Z"); // slots 11:15, 12:15, 13:15 are due
        expect(latestDueSlot(hourly, from, now)).toEqual(d("2026-11-07T13:15:00Z"));
        expect(decideSlot({schedule: hourly, from, now, windowMs: HOUR, activeRun: false})).toMatchObject({kind: "start", slot: d("2026-11-07T13:15:00Z")});
        // after that slot is recorded as handled, the next decision starts from it: nothing is due
        expect(decideSlot({schedule: hourly, from: d("2026-11-07T13:15:00Z"), now, windowMs: HOUR, activeRun: false})).toEqual({kind: "none"});
    });
    it("after a long outage the latest slot is missed when it is older than the window", () => {
        const r = decideSlot({schedule: daily, from: d("2026-11-01T02:00:00Z"), now: d("2026-11-07T12:00:00Z"), windowMs: HOUR, activeRun: false});
        expect(r).toEqual({kind: "skip", slot: d("2026-11-07T02:00:00Z"), reason: "missed"});
    });
    it("is timezone aware (02:00 Europe/Berlin = 01:00Z in winter, 00:00Z in summer)", () => {
        const berlin: Schedule = {...daily, timezone: "Europe/Berlin"};
        expect(latestDueSlot(berlin, d("2026-11-07T10:00:00Z"), d("2026-11-08T05:00:00Z"))).toEqual(d("2026-11-08T01:00:00Z"));
        expect(latestDueSlot(berlin, d("2026-07-07T10:00:00Z"), d("2026-07-08T05:00:00Z"))).toEqual(d("2026-07-08T00:00:00Z"));
    });
    it("a 25 h DST day does not skip or double the slot", () => {
        const ny: Schedule = {...daily, timezone: "America/New_York", hour: 1, minute: 30};
        // 2026-11-01 is the fall-back day: 01:30 happens twice locally, the schedule runs it ONCE
        const slots: number[] = [];
        let from = d("2026-10-31T12:00:00Z");
        for (let i = 0; i < 3; i++) { const s = latestDueSlot(ny, from, new Date(from.getTime() + 26 * HOUR)); if (!s) break; slots.push(s.getTime()); from = s; }
        expect(new Set(slots).size).toBe(slots.length);
    });
});
