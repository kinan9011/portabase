import type {MirrorView} from "@/fork/mirror/view";
import {ACTIVE_REVISION_STATES} from "@/fork/mirror/vocab";
import {MIRRORS} from "@/fork/ui/mirrors/labels";

/**
 * Pure model of the W23 Test Mirrors list + detail (plan-W23 Step 1). No React, no server import (values only from `@/fork/mirror/vocab` and fork UI labels): client components and tests share it.
 * The services re-check every rule; this only drives what is shown and which buttons are blocked (disabled-with-reason).
 */
export const HEALTHS = ["healthy", "degraded", "not_running", "pending", "failed", "unknown"] as const;
export type Health = (typeof HEALTHS)[number];
export type ServiceState = {state: string; health: string | null};
const DAY_MS = 86_400_000;

/** Health at the LAST CHECK (there is no periodic re-check, OD-W23-10): never claims a live state. */
export function mirrorHealth(status: string, services: readonly ServiceState[]): Health {
    switch (status) {
        case "creating": case "starting": case "stopping": case "deleting": case "refreshing": return "pending";
        case "stopped": return "not_running";
        case "failed": case "cancelled": return "failed";
        case "ready": {
            if (services.length === 0) return "degraded";
            const ok = services.every((s) => s.state === "running" && (s.health === null || s.health === "none" || s.health === "healthy"));
            return ok ? "healthy" : "degraded";
        }
        default: return "unknown";
    }
}

export type Action = {hidden: true} | {enabled: true} | {reason: string};
export type ActionKey = "stop" | "start" | "delete" | "cancel" | "retryWipe";
export type MirrorFacts = {status: string; hasActiveRevision: boolean; activeCreation: boolean; wipeFailed: boolean};
export type CanFacts = {manage: boolean; locked: boolean; flagOn: boolean; stopStart: boolean};
const L = MIRRORS.lifecycle;
const BUSY = new Set(["stopping", "starting", "deleting", "refreshing"]);

/** DD-7. Members get nothing (read-only page). `hidden` = the action does not apply; `reason` = applies but is blocked now (visible reason, `aria-disabled`). */
export function mirrorActions(m: MirrorFacts, can: CanFacts): Record<ActionKey, Action> {
    const hidden: Action = {hidden: true};
    const none: Record<ActionKey, Action> = {stop: hidden, start: hidden, delete: hidden, cancel: hidden, retryWipe: hidden};
    if (!can.manage) return none;
    const out = {...none};
    if (m.activeCreation) out.cancel = {enabled: true};
    if (m.wipeFailed) out.retryWipe = can.locked ? {reason: L.reasons.locked} : {enabled: true};
    if (m.status === "deleted") return {...none};
    if (m.status === "creating") { out.delete = {reason: L.reasons.cancelFirst}; return out; }
    if (BUSY.has(m.status)) {
        const wait = {reason: L.reasons.busy};
        out.delete = m.status === "deleting" ? {hidden: true} : wait;
        if (can.stopStart && m.status !== "deleting") { out.stop = wait; out.start = wait; }
        return out;
    }
    out.delete = {enabled: true};
    if (can.stopStart) {
        if (m.status === "ready" || (m.status === "failed" && m.hasActiveRevision)) out.stop = {enabled: true};
        if (m.status === "stopped") out.start = !can.flagOn ? {reason: MIRRORS.list.flagOff} : can.locked ? {reason: L.reasons.startLocked} : {enabled: true};
    }
    return out;
}

const WORSE: Record<string, number> = {failed: 3, running: 2, pending: 1, done: 0};
/** Consecutive steps with the same sentence merge into one line (render / compile / finalize); the worst status wins (failed > running > pending > done). */
export function groupSteps(steps: readonly {name: string; status: string}[], text: (name: string) => string): {text: string; status: string}[] {
    const out: {text: string; status: string}[] = [];
    for (const s of steps) {
        const t = text(s.name);
        const last = out[out.length - 1];
        if (last && last.text === t) { if ((WORSE[s.status] ?? 1) > (WORSE[last.status] ?? 1)) last.status = s.status; } else out.push({text: t, status: s.status});
    }
    return out;
}

/** ADR-016: fresh ⇒ "App start-tested · N d ago", stale (age > window) ⇒ "Out of date". Same age rule as the test-restore facet (whole days, future ⇒ 0). Never says verified / restore-tested. */
export function startTestedLabel(f: {readiedAt: string | null; now: Date; staleAfterDays: number}): {text: string; tone: "success" | "warning"} | null {
    if (!f.readiedAt) return null;
    const age = f.now.getTime() - new Date(f.readiedAt).getTime();
    const days = Math.max(0, Math.floor(age / DAY_MS));
    const stale = age > f.staleAfterDays * DAY_MS;
    return stale ? {text: MIRRORS.facet.stale(days), tone: "warning"} : {text: MIRRORS.facet.fresh(days), tone: "success"};
}

/** The prototype's "failed refresh" shape: the newest revision failed / was blocked while an older one is the active one. */
export function failedNewerRevision(view: MirrorView): {seq: number; reason: string | null; failedStep: string | null; activeSeq: number} | null {
    const active = view.revisions.find((r) => r.id === view.mirror.activeRevisionId);
    const latest = view.revisions[0];
    if (!active || !latest || latest.id === active.id) return null;
    if (latest.state !== "failed" && latest.state !== "blocked") return null;
    return {seq: latest.seq, reason: latest.reason, failedStep: latest.failedStep, activeSeq: active.seq};
}

export const isActiveRevision = (state: string): boolean => (ACTIVE_REVISION_STATES as readonly string[]).includes(state);

/** "3 h ago" style age for "at last check …" (calendar-free, `now` from the caller). */
export function ago(iso: string | null, now: Date): string {
    if (!iso) return "";
    const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86_400)} d ago`;
}
