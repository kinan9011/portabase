import {and, eq, inArray, sql} from "drizzle-orm";
import {EMPTY_CONTEXT} from "@/fork/completeness/types";
import {validateCompleteness} from "@/fork/completeness/validate";
import {forkStackRun, forkStackRunItem} from "@/fork/db/schema/runs";
import {forkStackSource} from "@/fork/db/schema/stack";
import {loadStackContext} from "@/fork/materialize/apply";
import {loadMaterializedContext} from "@/fork/materialize/context";
import {acquireLease, withForkLock} from "@/fork/locks";
import {cancelWaitingBackups, queueWaitingBackups, readBackupFacts} from "@/fork/upstream";
import {cfgOf, defaultRefresh, hasherOf, modeOf, nowOf, ownerOf, type RunDeps} from "./deps";
import {done, wait, type Handlers} from "./engine";
import type {StackFacts} from "./reauth";
import {TERMINAL_ITEM_STATES, type AnyRunStep, type ItemState, type RefreshOutcome, type RunReason} from "./vocab";
import {isWindowDbms} from "@/fork/quiesce/vocab";
import {quiesceRelease, quiesceStop} from "@/fork/quiesce/steps";

/**
 * The run's step handlers (ARCH-13). Every handler is IDEMPOTENT: after a crash between "work done" and "state persisted" the step runs
 * again and must not duplicate anything (trigger checks for existing items under a lock, hash never recomputes a stored checksum,
 * refresh/validate overwrite a scalar). Domain outcomes (nothing queued, a member failed, a timeout) are NOT step failures: they are
 * facts the finaliser turns into an honest RecoveryPoint; `fail` is reserved for the engine's own errors.
 */
export type StepCtx = {d: RunDeps; runId: string; facts: StackFacts};
export const HASH_ATTEMPTS = 3;
export const TIMEOUT_REASONS: readonly RunReason[] = ["agent_did_not_start", "agent_made_no_progress", "run_timeout"];
const HASH_LEASE_MS = 15 * 60_000;

const loadRun = async (c: StepCtx) => (await c.d.db.select().from(forkStackRun).where(eq(forkStackRun.id, c.runId)))[0];
const items = async (c: StepCtx) => c.d.db.select().from(forkStackRunItem).where(eq(forkStackRunItem.runId, c.runId));

async function refreshInventory(c: StepCtx) {
    const run = await loadRun(c);
    if (run.inventoryRefresh !== null) return done(); // already decided before a crash
    let outcome: RefreshOutcome;
    if ((await modeOf(c.d)) !== "on") outcome = "skipped_locked"; // discovery is configuration-plane: not running while locked (ADR-010)
    else if (!c.facts.connectionId) outcome = "not_attempted";
    else {
        try {
            outcome = await (c.d.refresh ? c.d.refresh({id: c.facts.stackId, connectionId: c.facts.connectionId}) : defaultRefresh(c.d.db, c.d.now, {connectionId: c.facts.connectionId}));
        } catch {
            outcome = "failed"; // UX-09: Arcane unreachable ⇒ the run proceeds on the last inventory (discovery sets `stale_since`)
        }
    }
    const v = await c.d.db.execute(sql`select max(version)::int as v from fork_stack_inventory where stack_id = ${c.facts.stackId}`);
    await c.d.db.update(forkStackRun).set({inventoryRefresh: outcome, inventoryVersion: (v.rows[0] as {v: number | null}).v ?? null, updatedAt: nowOf(c.d)}).where(eq(forkStackRun.id, c.runId));
    return done();
}

/** EU-04: a blocked validator does NOT stop the run; it only decides that the RecoveryPoint is INCOMPLETE. */
async function validate(c: StepCtx) {
    const ctx = await loadStackContext(c.d.db, c.facts.stackId);
    let blocked = true;
    if (ctx?.inventory) {
        const mat = await loadMaterializedContext(c.d.db, {id: c.facts.stackId, environmentId: ctx.environmentId}, nowOf(c.d));
        const report = validateCompleteness(ctx.inventory, {...EMPTY_CONTEXT, allowedRoots: ctx.allowedRoots, coverage: mat.coverage, probes: mat.probes, sourceIssues: mat.sourceIssues, acceptedExclusions: mat.acceptedExclusions});
        blocked = !report.complete;
    }
    await c.d.db.update(forkStackRun).set({validatorBlocked: blocked, updatedAt: nowOf(c.d)}).where(eq(forkStackRun.id, c.runId));
    return done();
}

/**
 * `part` (W17b D2): a plain run triggers ALL members at once (`"all"`, unchanged). A quiesce run triggers the engine dumps BEFORE the stop (`"pre"`) and the
 * file / volume members INSIDE the stop window (`"window"`); idempotency = "an item of THIS partition exists".
 */
type Part = "all" | "pre" | "window";
const inPart = (part: Part, dbms: string): boolean => part === "all" || (part === "window") === isWindowDbms(dbms);

async function triggerPart(c: StepCtx, part: Part) {
    const now = nowOf(c.d);
    await withForkLock(c.d.db, `run-trigger:${c.runId}`, async (tx) => {
        const existing = (await tx.select({id: forkStackRunItem.id, dbms: forkStackRunItem.dbms}).from(forkStackRunItem).where(eq(forkStackRunItem.runId, c.runId))).filter((i) => inPart(part, i.dbms));
        if (existing.length > 0) return; // idempotent: a crash after this transaction committed
        const links = (await tx.select().from(forkStackSource).where(eq(forkStackSource.stackId, c.facts.stackId))).filter((l) => l.status !== "orphaned" && inPart(part, l.dbms));
        const runnable = links.filter((l) => l.status === "active" && l.databaseId !== null);
        const q = await queueWaitingBackups(tx, runnable.map((l) => l.databaseId as string));
        const queued = new Map(q.queued.map((x) => [x.databaseId, x.backupId]));
        const skipped = new Map(q.skipped.map((x) => [x.databaseId, x.reason]));
        const rows = links.map((l) => {
            const backupId = l.databaseId ? queued.get(l.databaseId) ?? null : null;
            const why = backupId ? null : l.status !== "active" ? "member_not_active" : !l.databaseId ? "member_vanished"
                : ({busy: "member_busy", method_conflict: "member_method_conflict", gone: "member_vanished"} as const)[skipped.get(l.databaseId) ?? "gone"];
            return {
                runId: c.runId, stackSourceId: l.id, backupId, sourceName: l.memberName, dbms: l.dbms, required: l.required,
                state: (backupId ? "queued" : "skipped") as ItemState, reason: why, queuedAt: backupId ? now : null, lastProgressAt: backupId ? now : null,
                finishedAt: backupId ? null : now,
            };
        });
        if (rows.length > 0) await tx.insert(forkStackRunItem).values(rows);
        await tx.update(forkStackRun).set({state: "running", updatedAt: now}).where(and(eq(forkStackRun.id, c.runId), eq(forkStackRun.state, "starting")));
    });
    return done();
}

/** Polls upstream statuses (no upstream hook) and applies the MANDATORY timeouts. Waits until every item is terminal. */
async function track(c: StepCtx) {
    const now = nowOf(c.d);
    const cfg = cfgOf(c.d);
    const run = await loadRun(c);
    const open = (await items(c)).filter((i) => !TERMINAL_ITEM_STATES.includes(i.state as ItemState));
    if (open.length === 0) return done();
    const facts = await readBackupFacts(c.d.db, open.flatMap((i) => (i.backupId ? [i.backupId] : [])));
    const past = run.deadlineAt !== null && now.getTime() > run.deadlineAt.getTime();
    const toCancel: string[] = [];
    for (const it of open) {
        const patch: Partial<typeof forkStackRunItem.$inferInsert> = {};
        let end: {state: ItemState; reason: RunReason | null} | null = null;
        const b = it.backupId ? facts.get(it.backupId) : undefined;
        const lastProgress = it.lastProgressAt ?? it.queuedAt ?? now;
        if (!b) end = {state: "failed", reason: "member_vanished"};
        else {
            const evidence = [b.updatedAt, ...b.storages.map((s) => s.updatedAt)].filter((x): x is Date => x !== null).reduce((m, x) => (x > m ? x : m), lastProgress);
            const progress = evidence > now ? now : evidence;
            if (progress > lastProgress) patch.lastProgressAt = progress;
            const sinceProgress = now.getTime() - progress.getTime();
            const storages = b.storages.filter((s) => s.deletedAt === null);
            if (b.status === "failed" || (b.deletedAt !== null && b.status !== "success")) end = {state: "failed", reason: "member_failed"};
            else if (b.status === "success") {
                const pending = storages.some((s) => s.status === "pending");
                if (storages.length > 0 && !pending) end = {state: "succeeded", reason: null};
                else if (sinceProgress > cfg.stallTimeoutMs) end = {state: "succeeded", reason: null}; // a channel that never reported: its artifact slot will read `unknown`, never present
            } else if (b.status === "ongoing") {
                if (it.state === "queued") { patch.state = "running"; patch.startedAt = it.startedAt ?? now; }
                if (sinceProgress > cfg.stallTimeoutMs) end = {state: "failed", reason: "agent_made_no_progress"};
            } else if (sinceProgress > cfg.waitTimeoutMs) {
                toCancel.push(b.id); // never leave a waiting row behind: a late start would create data no RP knows about
                end = {state: "failed", reason: "agent_did_not_start"};
            }
            if (!end && past) {
                if (b.status === "waiting") toCancel.push(b.id);
                end = {state: "failed", reason: "run_timeout"};
            }
        }
        if (end) { patch.state = end.state; patch.reason = end.reason; patch.finishedAt = now; }
        if (Object.keys(patch).length > 0) await c.d.db.update(forkStackRunItem).set(patch).where(eq(forkStackRunItem.id, it.id));
    }
    if (toCancel.length > 0) await cancelWaitingBackups(c.d.db, toCancel, now);
    const left = await c.d.db.select({id: forkStackRunItem.id}).from(forkStackRunItem).where(and(eq(forkStackRunItem.runId, c.runId), inArray(forkStackRunItem.state, ["queued", "running"])));
    return left.length === 0 ? done() : wait();
}

/** Dashboard-side ciphertext SHA-256 of every archive artifact (the agent reports none). Resumable, 3 attempts per object, never invented. */
async function hash(c: StepCtx) {
    const cfg = cfgOf(c.d);
    const ok = (await items(c)).filter((i) => i.state === "succeeded" && i.backupId !== null);
    const facts = await readBackupFacts(c.d.db, ok.flatMap((i) => (i.backupId ? [i.backupId] : [])));
    let retry = false;
    for (const it of ok) {
        const b = facts.get(it.backupId as string);
        const sums = {...(it.checksums as Record<string, {sha256?: string; bytes?: number; attempts?: number}>)};
        let changed = false;
        for (const s of (b?.storages ?? []).filter((x) => x.deletedAt === null && x.status === "success" && x.engine === "archive")) {
            const cur = sums[s.id];
            if (cur?.sha256 || (cur?.attempts ?? 0) >= HASH_ATTEMPTS) continue;
            await acquireLease(c.d.db, `run:${c.runId}`, ownerOf(c.d), HASH_LEASE_MS, nowOf(c.d)); // renew between objects
            const r = await hasherOf(c.d)({backupStorageId: s.id, expectedSize: s.size, maxBytes: cfg.hashMaxBytes, timeoutMs: cfg.hashTimeoutMs});
            sums[s.id] = r ? {sha256: r.sha256, bytes: r.bytes, attempts: (cur?.attempts ?? 0) + 1} : {attempts: (cur?.attempts ?? 0) + 1};
            changed = true;
            if (!r && (sums[s.id]?.attempts ?? 0) < HASH_ATTEMPTS) retry = true;
        }
        if (changed) await c.d.db.update(forkStackRunItem).set({checksums: sums}).where(eq(forkStackRunItem.id, it.id));
    }
    return retry ? wait() : done();
}

/** One handler map for BOTH step lists: a plain run never reaches the quiesce steps; a quiesce run's `trigger` is the "pre" partition (decided by its persisted step list). */
export function runHandlers(finalize: (c: StepCtx) => Promise<ReturnType<typeof done>>): Handlers<AnyRunStep, StepCtx> {
    const quiesceRun = async (c: StepCtx): Promise<boolean> => ((await c.d.db.select({steps: forkStackRun.steps}).from(forkStackRun).where(eq(forkStackRun.id, c.runId)))[0]?.steps as {name: string}[] | undefined)?.some((s) => s.name === "quiesce_stop") ?? false;
    return {
        refresh_inventory: refreshInventory, validate, track, hash, finalize,
        trigger: async (c) => triggerPart(c, (await quiesceRun(c)) ? "pre" : "all"),
        trigger_window: (c) => triggerPart(c, "window"),
        track_window: track,
        quiesce_stop: quiesceStop,
        quiesce_release: quiesceRelease,
    };
}
