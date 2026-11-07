import {nextRuns, type Schedule} from "@/fork/schedule/schedule";

/**
 * Due-ness of a stack schedule (ARCH-10 semantics reused, ARCH-17 capture window + skip semantics). Pure.
 *
 *  - slots are the cron instants of `schedule` (timezone aware, DST rules of `nextRuns`) strictly after `from`;
 *  - after downtime there is ONE catch-up decision for the LATEST slot ≤ now, never a backlog replay;
 *  - capture window: a due slot may START from the slot until slot + window; later it is a missed slot;
 *  - a due slot while a run of the same stack is active is skipped (overlap), never queued.
 *
 * `from` = max(last scheduled slot, activation time): activating never back-fills history.
 */
const PAGE = 100;
const MAX_PAGES = 120; // 12 000 slots ≈ hourly for > 1 year; beyond that the slot is simply the latest we can prove

export function latestDueSlot(schedule: Schedule, from: Date, now: Date): Date | null {
    let cursor = from;
    let latest: Date | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
        const page = nextRuns(schedule, cursor, PAGE);
        if (page.length === 0) break;
        for (const d of page) {
            if (d.getTime() > now.getTime()) return latest;
            latest = d;
        }
        cursor = page[page.length - 1];
    }
    return latest;
}

export type SlotDecision =
    | {kind: "none"}
    | {kind: "start"; slot: Date}
    | {kind: "skip"; slot: Date; reason: "overlap" | "missed"};

export function decideSlot(i: {schedule: Schedule; from: Date; now: Date; windowMs: number; activeRun: boolean}): SlotDecision {
    const slot = latestDueSlot(i.schedule, i.from, i.now);
    if (!slot) return {kind: "none"};
    if (i.activeRun) return {kind: "skip", slot, reason: "overlap"};
    if (i.now.getTime() - slot.getTime() > i.windowMs) return {kind: "skip", slot, reason: "missed"};
    return {kind: "start", slot};
}
