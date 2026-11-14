import type {MirrorDetailExtras} from "@/fork/mirror/list-view";
import type {RefreshPreview} from "@/fork/mirror/refresh-preview";
import {MIRROR_STEPS} from "@/fork/mirror/vocab";
import type {MirrorView} from "@/fork/mirror/view";

/** W25 UI fixtures. Ages are always derived from the real clock (`now = new Date()`), never from a fixed past date. */
export const MID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
export const SID = "0b7e1c1e-7f3a-4b6e-9a40-333333333333";
export const RP_A = "0b7e1c1e-7f3a-4b6e-9a40-aaaaaaaaaaa1";
export const RP_B = "0b7e1c1e-7f3a-4b6e-9a40-aaaaaaaaaaa2";
export const NAME = "shop-3";
const okGate = {ok: true, code: null};
export const hoursAgo = (now: Date, h: number): string => new Date(now.getTime() - h * 3600e3).toISOString();
export type Rev = MirrorView["revisions"][number];

export const rev = (now: Date, o: Partial<Rev> = {}): Rev => ({
    id: "r1", seq: 1, state: "ready", reason: null, failedStep: null, steps: MIRROR_STEPS.map((name) => ({name, status: "done"})),
    gates: {expected_data: okGate, db_health: okGate, app_smoke: okGate, isolation: okGate, side_effects: okGate}, refusals: [],
    services: [{service: "web", state: "running", health: "none"}, {service: "db", state: "running", health: "healthy"}], hostPort: 41000, rpSequence: 3,
    readiedAt: hoursAgo(now, 3), activatedAt: hoursAgo(now, 3), retiredAt: null, wipeState: null, deadlineAt: now.toISOString(), createdAt: hoursAgo(now, 3.1), ...o,
});

/** Newest first. Default: active #2 (backup 4) with kept rollback target #1 (backup 3). */
export const view = (now: Date, o: {status?: string; revisions?: Rev[]; active?: string | null; op?: string | null; retentionDue?: boolean; personal?: boolean | null} = {}): MirrorView => ({
    mirror: {id: MID, name: NAME, status: o.status ?? "ready", runnerName: "lab-runner", stackId: SID, activeRevisionId: o.active === undefined ? "r2" : o.active, opRevisionId: o.op ?? null, retentionDue: o.retentionDue ?? false, createdAt: now.toISOString()},
    revisions: o.revisions ?? [rev(now, {id: "r2", seq: 2, rpSequence: 4, readiedAt: hoursAgo(now, 1), activatedAt: hoursAgo(now, 1)}), rev(now, {id: "r1", seq: 1, rpSequence: 3, retiredAt: null})],
    privacy: {containsPersonalData: o.personal === undefined ? true : o.personal, optIn: true},
});

export const extras = (now: Date, o: Partial<MirrorDetailExtras> = {}): MirrorDetailExtras => ({
    stack: {id: SID, name: "Shop"}, rpDates: {"3": hoursAgo(now, 72), "4": hoursAgo(now, 24), "5": hoursAgo(now, 2)},
    config: {access: {service: "web", target: 8080, hostPort: 41000}, httpPath: "/health", limits: {memBytes: 1073741824, pids: 512, nanoCpus: 1_000_000_000}, overrides: [], overrideCount: 0, keptCount: 0},
    runnerIsolation: {state: "isolated", probedAt: hoursAgo(now, 1), reason: null}, facet: null, lastOp: null, ...o,
});

export const preview = (now: Date, o: Partial<RefreshPreview> = {}): RefreshPreview => ({
    mirror: {name: NAME, status: "ready", activeSeq: 2, activeRpSequence: 4, activeRpAt: hoursAgo(now, 24), activeSince: hoursAgo(now, 1)},
    candidates: [{id: RP_B, sequence: 6, createdAt: hoursAgo(now, 1), verifiedAt: hoursAgo(now, 0.5)}, {id: RP_A, sequence: 5, createdAt: hoursAgo(now, 2), verifiedAt: hoursAgo(now, 1.5)}],
    selected: {rpId: RP_B, sequence: 6, outcome: "ready", blockers: [], requiredDiskBytes: 2 * 1024 ** 3, sizeUnknown: false, memNeedBytes: 2 * 1024 ** 3, appChanged: false},
    lastCapacity: {freeDiskBytes: 50 * 1024 ** 3, memAvailableBytes: 16 * 1024 ** 3, at: hoursAgo(now, 1)}, containsPersonalData: true, ...o,
});
