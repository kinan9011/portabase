import type {RefreshPreview} from "@/fork/mirror/refresh-preview";
import type {MirrorView} from "@/fork/mirror/view";
import {RUNNER_PRECHECK_MAX_AGE_MS} from "@/fork/mirror/vocab";
import {MIRRORS} from "@/fork/ui/mirrors/labels";
import {ago} from "@/fork/ui/mirrors/model";
import {fmtBytes} from "@/fork/ui/stacks/format";

/**
 * Pure model of the W25 Refresh / Rollback dialogs (plan-W25 A3). No React, no server import (types only): client components and tests share it. The services re-check every rule;
 * this only drives what the dialogs show. Every sentence comes from `MIRRORS.refresh` / `MIRRORS.rollback`.
 */
type Rev = MirrorView["revisions"][number];
const R = MIRRORS.refresh;
const B = MIRRORS.rollback;
const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "unknown");

/** Revisions `rollbackMirror` accepts, newest first. MUST equal the server predicate (a unit test reads `service.ts` and pins the five clauses). */
export function rollbackTargets(view: MirrorView): Rev[] {
    return view.revisions.filter((t) => t.id !== view.mirror.activeRevisionId && t.state === "ready" && t.activatedAt !== null && t.retiredAt === null && t.wipeState === null);
}

/** "What will be lost" (b): kept non-active READY revisions are deleted and checked after a refresh commit (KEEP_REVISIONS = 2, ADR-017). */
export function revisionsWipedByRefresh(view: MirrorView): Rev[] {
    return view.revisions.filter((r) => r.id !== view.mirror.activeRevisionId && r.state === "ready" && r.retiredAt === null && r.wipeState === null);
}

export type Row = {key: string; text: string; tone?: "warning"};

/** Last reported free disk / memory: warn when below what is needed, when nothing was reported, or when the report is older than the runner pre-check window (24 h). Never blocks (OD-W25-1). */
export function capacityWarning(p: RefreshPreview, now: Date): string | null {
    if (!p.selected) return null;
    const c = p.lastCapacity;
    if (!c) return R.capacityWarn;
    const stale = now.getTime() - new Date(c.at).getTime() > RUNNER_PRECHECK_MAX_AGE_MS;
    const lowDisk = c.freeDiskBytes !== null && !p.selected.sizeUnknown && c.freeDiskBytes < p.selected.requiredDiskBytes;
    const lowMem = c.memAvailableBytes !== null && c.memAvailableBytes < p.selected.memNeedBytes;
    return stale || lowDisk || lowMem ? R.capacityWarn : null;
}

/** Rows of the Refresh dialog's "What changes" list (selected backup required). */
export function refreshRows(p: RefreshPreview, view: MirrorView, now: Date): Row[] {
    const s = p.selected;
    if (!s) return [];
    const cand = p.candidates.find((c) => c.id === s.rpId);
    const cur = p.mirror.activeSeq;
    const rows: Row[] = [{key: "age", text: R.age(day(cand?.createdAt), day(p.mirror.activeRpAt))}];
    const need = fmtBytes(s.requiredDiskBytes) ?? "0 B";
    const cap = p.lastCapacity;
    const seen = cap && cap.freeDiskBytes !== null ? ` ${R.lastSeen(fmtBytes(cap.freeDiskBytes) ?? "", ago(cap.at, now))}` : ` ${R.notReported}`;
    rows.push({key: "space", text: s.sizeUnknown ? R.spaceUnknown : `${R.space(need)}${seen}`, ...(capacityWarning(p, now) ? {tone: "warning" as const} : {})});
    rows.push({key: "memory", text: R.memory(fmtBytes(s.memNeedBytes) ?? "0 B")});
    rows.push({key: "app", text: s.appChanged === null ? R.app.unknown : s.appChanged ? R.app.changed : R.app.same});
    rows.push({key: "lost", text: R.lost(cur, day(p.mirror.activeSince))});
    const wiped = revisionsWipedByRefresh(view);
    rows.push({key: "wiped", text: wiped.length === 0 ? R.wipedNone : wiped.map((r) => R.wiped(r.seq, r.rpSequence, cur)).join(" ")});
    return rows;
}

/** Rows of the Rollback dialog for the chosen target. `rpDates` is keyed by backup sequence (detail extras); `memBytes` is the per-service limit from the mirror policy. */
export function rollbackRows(view: MirrorView, target: Rev, rpDates: Record<string, string>, memBytes: number): Row[] {
    const active = view.revisions.find((r) => r.id === view.mirror.activeRevisionId);
    const cur = active?.seq ?? 0;
    return [
        {key: "impact", text: B.impact(cur, day(active ? rpDates[String(active.rpSequence)] : null), target.seq, day(rpDates[String(target.rpSequence)]))},
        {key: "capacity", text: B.capacity(fmtBytes(memBytes * Math.max(1, target.services.length)) ?? "0 B")},
        {key: "lost", text: B.lost(cur)},
        {key: "checks", text: B.checks},
    ];
}
