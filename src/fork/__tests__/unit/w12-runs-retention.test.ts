import {describe, expect, it} from "vitest";
import {selectRetention, type RpFacts} from "@/fork/recovery-point/retention";
import {DEFAULT_RETENTION, type RetentionPolicy} from "@/fork/recovery/retention-policy";

const NOW = new Date("2026-11-07T12:00:00Z");
const DAY = 86_400_000;
let seq = 0;
const rp = (daysAgo: number, o: Partial<RpFacts> = {}): RpFacts => {
    const at = new Date(NOW.getTime() - daysAgo * DAY);
    return {id: `rp${++seq}`, status: "verified", sequence: 1_000_000 - Math.round(daysAgo * 10_000) + seq / 1000, finalizedAt: at, createdAt: at, purgedAt: null, channelIds: ["c1"], inUse: false, ...o};
};
const sel = (rps: RpFacts[], p: Partial<RetentionPolicy> = {}, tz = "UTC") => selectRetention(rps, {...DEFAULT_RETENTION, ...p}, {now: NOW, timezone: tz});

describe("runs: D33 retention selection over RPs (pure invariants)", () => {
    it("(a)(b) newest verified and keep_last verified RPs are never pruned", () => {
        const rps = Array.from({length: 10}, (_, i) => rp(i * 0.01));
        const r = sel(rps, {keep_last: 3, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        const kept = rps.filter((x) => !r.prune.includes(x.id)).map((x) => x.id);
        expect(kept).toEqual([rps[0].id, rps[1].id, rps[2].id]);
        expect(r.prune).toHaveLength(7);
    });
    it("GFS: one RP per day / week / month; the newest of each bucket", () => {
        const rps = [0, 0.1, 1, 1.1, 2, 9, 10, 40, 41, 100, 400].map((d) => rp(d));
        const r = sel(rps, {keep_last: 1, daily: 3, weekly: 2, monthly: 3, yearly: 1});
        const kept = new Set(rps.filter((x) => !r.prune.includes(x.id)).map((x) => x.id));
        expect(kept.has(rps[0].id)).toBe(true); // newest
        expect(kept.has(rps[1].id)).toBe(false); // same day as the newest, older
        expect(kept.has(rps[2].id)).toBe(true); // yesterday (daily)
        expect(kept.has(rps[3].id)).toBe(false); // same day as rps[2]
        expect(kept.has(rps[4].id)).toBe(true); // 2 days ago (daily bucket 3)
    });
    it("(c) pending / incomplete / failed RPs never fill GFS slots and are pruned by age only (30 d)", () => {
        const young = [rp(1, {status: "pending_verification"}), rp(5, {status: "incomplete"}), rp(29, {status: "failed"})];
        const old = [rp(31, {status: "pending_verification"}), rp(90, {status: "incomplete"}), rp(60, {status: "failed"})];
        const v = [rp(0.5), rp(0.6)];
        const r = sel([...young, ...old, ...v], {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        for (const y of young) expect(r.prune).not.toContain(y.id);
        for (const o of old) expect(r.prune).toContain(o.id);
        expect(r.prune).toContain(v[1].id);
    });
    it("(d) the last verified RP of a channel is kept even outside the GFS window", () => {
        const a = rp(0, {channelIds: ["c1"]}); const b = rp(200, {channelIds: ["c2"]});
        const r = sel([a, b], {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        expect(r.prune).not.toContain(b.id);
        expect(r.keep.get(b.id)).toBe("last_for_channel");
    });
    it("(e) buckets follow the schedule timezone: 23:30Z and 00:30Z are two UTC days but one local day in Pacific/Kiritimati (UTC+14)", () => {
        const at = (iso: string) => ({finalizedAt: new Date(iso), createdAt: new Date(iso)});
        const x = rp(0, {...at("2026-11-06T23:30:00Z"), sequence: 2}); const y = rp(0, {...at("2026-11-07T00:30:00Z"), sequence: 3});
        const utc = sel([x, y], {keep_last: 1, daily: 2, weekly: 0, monthly: 0, yearly: 0}, "UTC");
        expect(utc.prune).not.toContain(x.id); // two UTC days: both kept
        const kiri = sel([x, y], {keep_last: 1, daily: 2, weekly: 0, monthly: 0, yearly: 0}, "Pacific/Kiritimati"); // UTC+14: 13:30 and 14:30 on 2026-11-07
        expect(kiri.prune).toContain(x.id); // same local day: only the newest survives (keep_last 1)
    });
    it("(f) no verified RP yet (W14 not shipped): the newest RP of any status is never pruned", () => {
        const only = rp(100, {status: "pending_verification"});
        const r = sel([only], {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        expect(r.prune).toEqual([]);
        expect(r.keep.get(only.id)).toBe("only_backup");
        const two = [only, rp(200, {status: "pending_verification"})];
        expect(sel(two).prune).toEqual([two[1].id]);
    });
    it("(g) an RP in use is never selected", () => {
        const used = rp(200, {inUse: true, channelIds: []});
        const r = sel([rp(0), rp(1), rp(2), rp(3), used], {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        expect(r.prune).not.toContain(used.id);
    });
    it("(h) tombstones are ignored; an expiring RP is selected again (retry)", () => {
        const tomb = rp(300, {purgedAt: NOW});
        const r = sel([rp(0), rp(1), rp(2), rp(3), rp(500), tomb], {keep_last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0});
        expect(r.prune).not.toContain(tomb.id);
        expect(r.keep.has(tomb.id)).toBe(false);
        expect(r.prune.length).toBeGreaterThan(0);
    });
    it("is deterministic and never returns an id twice", () => {
        const rps = Array.from({length: 60}, (_, i) => rp(i * 3));
        const a = sel(rps); const b = sel([...rps].reverse());
        expect(new Set(a.prune).size).toBe(a.prune.length);
        expect([...a.prune].sort()).toEqual([...b.prune].sort());
    });
    it("defaults keep a sensible spread (3 last + 7 daily + 4 weekly + 6 monthly)", () => {
        const rps = Array.from({length: 400}, (_, i) => rp(i));
        const r = sel(rps);
        const kept = rps.length - r.prune.length;
        expect(kept).toBeGreaterThanOrEqual(10);
        expect(kept).toBeLessThanOrEqual(20);
        expect(r.prune).not.toContain(rps[0].id);
    });
});
