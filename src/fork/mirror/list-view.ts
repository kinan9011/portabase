import {and, asc, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {z} from "zod";
import type {ForkDb} from "@/fork/db/handle";
import {forkMirror, forkMirrorEvent, forkMirrorRevision, forkMirrorTask} from "@/fork/db/schema/mirror";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkRecoveryPoint} from "@/fork/db/schema/recovery";
import {forkStack} from "@/fork/db/schema/stack";
import {runnerIsolation} from "@/fork/runner/service";
import {mirrorHealth, HEALTHS} from "@/fork/ui/mirrors/model";
import {eventTitle, taskTitle} from "@/fork/ui/mirrors/labels";
import {startTestedFact} from "./facet";
import {LIMIT_DEFAULTS, RUNNER_PRECHECK_MAX_AGE_MS} from "./vocab";

/**
 * W23 read models (plan-W23 Step 2). Strict DTOs: ids, names, states, codes, counts, timestamps. Every query selects EXPLICIT columns: no task `result` / `payload_enc` / `lease_id` / event
 * `details` ever leaves this module (the failed-task reason is extracted in SQL as a code and re-validated here). `now` / `serverUrl` come from the caller.
 */
const CODE_RE = /^[a-z_]{1,64}$/;
const codeOrNull = (v: unknown): string | null => (typeof v === "string" && CODE_RE.test(v) ? v : null);

export const MirrorListRow = z.strictObject({
    id: z.uuid(), name: z.string(), status: z.string(), stack: z.strictObject({id: z.uuid(), name: z.string()}), runnerName: z.string(),
    activeSeq: z.number().int().nullable(), rpSequence: z.number().int().nullable(), rpCreatedAt: z.string().nullable(),
    health: z.enum(HEALTHS), checkedAt: z.string().nullable(), hostPort: z.number().int().nullable(),
    latest: z.strictObject({seq: z.number().int(), state: z.string(), reason: z.string().nullable()}).nullable(),
    alert: z.boolean(), updatedAt: z.string(),
});
export type MirrorListRow = z.infer<typeof MirrorListRow>;

const svcOf = (v: unknown): {state: string; health: string | null}[] =>
    (Array.isArray(v) ? v : []).map((s) => ({state: String((s as {state?: unknown}).state ?? ""), health: typeof (s as {health?: unknown}).health === "string" ? String((s as {health: string}).health) : null}));

/** Org-scoped, `deleted_at` hidden, ordered by name. ponytail: three small queries joined in JS (tens of mirrors, D21 single operator). */
export async function loadMirrorList(db: ForkDb, organizationId: string): Promise<MirrorListRow[]> {
    const mirrors = await db.select({
        id: forkMirror.id, name: forkMirror.name, status: forkMirror.status, runnerName: forkMirror.runnerAgentName, activeRevisionId: forkMirror.activeRevisionId, updatedAt: forkMirror.updatedAt,
        stackId: forkStack.id, stackName: forkStack.displayName,
    }).from(forkMirror).innerJoin(forkStack, eq(forkStack.id, forkMirror.stackId)).where(and(eq(forkMirror.organizationId, organizationId), isNull(forkMirror.deletedAt))).orderBy(asc(forkMirror.name));
    if (mirrors.length === 0) return [];
    const revs = await db.select({id: forkMirrorRevision.id, mirrorId: forkMirrorRevision.mirrorId, seq: forkMirrorRevision.seq, state: forkMirrorRevision.state, reason: forkMirrorRevision.reason,
        services: forkMirrorRevision.services, readiedAt: forkMirrorRevision.readiedAt, hostPort: forkMirrorRevision.hostPort, rpId: forkMirrorRevision.rpId, rpSequence: forkMirrorRevision.rpSequence})
        .from(forkMirrorRevision).where(inArray(forkMirrorRevision.mirrorId, mirrors.map((m) => m.id))).orderBy(desc(forkMirrorRevision.seq));
    const rpIds = [...new Set(revs.map((r) => r.rpId).filter((x): x is string => x !== null))];
    const rps = rpIds.length ? await db.select({id: forkRecoveryPoint.id, createdAt: forkRecoveryPoint.createdAt}).from(forkRecoveryPoint).where(inArray(forkRecoveryPoint.id, rpIds)) : [];
    const rpDate = new Map(rps.map((r) => [r.id, r.createdAt.toISOString()]));
    return mirrors.map((m) => {
        const mine = revs.filter((r) => r.mirrorId === m.id); // newest first
        const latest = mine[0] ?? null;
        const active = mine.find((r) => r.id === m.activeRevisionId) ?? null;
        const shown = active ?? latest;
        const failedNewer = latest !== null && active !== null && latest.id !== active.id && (latest.state === "failed" || latest.state === "blocked");
        return MirrorListRow.parse({
            id: m.id, name: m.name, status: m.status, stack: {id: m.stackId, name: m.stackName}, runnerName: m.runnerName,
            activeSeq: active?.seq ?? null, rpSequence: shown?.rpSequence ?? null, rpCreatedAt: shown?.rpId ? rpDate.get(shown.rpId) ?? null : null,
            health: mirrorHealth(m.status, active ? svcOf(active.services) : []), checkedAt: active?.readiedAt?.toISOString() ?? null,
            hostPort: shown?.hostPort ?? null, latest: latest ? {seq: latest.seq, state: latest.state, reason: codeOrNull(latest.reason)} : null,
            alert: failedNewer, updatedAt: m.updatedAt.toISOString(),
        });
    });
}

const PolicyRead = z.object({
    access: z.object({service: z.string(), target: z.number().int()}).nullish(), http_path: z.string().nullish(),
    env: z.record(z.string(), z.record(z.string(), z.enum(["keep", "keep_exact", "rotate", "disable", "drop"]))).nullish(),
    limits: z.object({mem_bytes: z.number(), pids: z.number(), nano_cpus: z.number()}).nullish(),
});
export const MirrorDetailExtras = z.strictObject({
    stack: z.strictObject({id: z.uuid(), name: z.string()}),
    rpDates: z.record(z.string(), z.string()),
    config: z.strictObject({
        access: z.strictObject({service: z.string(), target: z.number().int(), hostPort: z.number().int().nullable()}).nullable(), httpPath: z.string().nullable(),
        limits: z.strictObject({memBytes: z.number(), pids: z.number(), nanoCpus: z.number()}),
        overrides: z.array(z.strictObject({service: z.string(), key: z.string(), action: z.enum(["keep", "keep_exact", "rotate", "disable", "drop"])})).nullable(),
        overrideCount: z.number().int(), keptCount: z.number().int(),
    }),
    runnerIsolation: z.strictObject({state: z.enum(["isolated", "not_isolated", "unknown"]), probedAt: z.string().nullable(), reason: z.string().nullable()}),
    facet: z.strictObject({readiedAt: z.string(), rpSequence: z.number().int()}).nullable(),
});
export type MirrorDetailExtras = z.infer<typeof MirrorDetailExtras>;

/** The caller has already passed `assertForkResource(…, "mirrors.view", {kind: "mirror"})`. Key NAMES of overridden settings only for managers; values never exist on the dashboard. */
export async function loadMirrorDetailExtras(db: ForkDb, mirrorId: string, o: {now: Date; serverUrl: string; canManage: boolean}): Promise<MirrorDetailExtras> {
    const [m] = await db.select({stackId: forkMirror.stackId, stackName: forkStack.displayName, policy: forkMirror.policy, runnerAgentId: forkMirror.runnerAgentId, activeRevisionId: forkMirror.activeRevisionId})
        .from(forkMirror).innerJoin(forkStack, eq(forkStack.id, forkMirror.stackId)).where(eq(forkMirror.id, mirrorId));
    if (!m) throw new Error("mirror_not_found");
    const revs = await db.select({id: forkMirrorRevision.id, rpId: forkMirrorRevision.rpId, rpSequence: forkMirrorRevision.rpSequence, hostPort: forkMirrorRevision.hostPort}).from(forkMirrorRevision).where(eq(forkMirrorRevision.mirrorId, mirrorId));
    const rpIds = revs.map((r) => r.rpId).filter((x): x is string => x !== null);
    const rps = rpIds.length ? await db.select({id: forkRecoveryPoint.id, createdAt: forkRecoveryPoint.createdAt}).from(forkRecoveryPoint).where(inArray(forkRecoveryPoint.id, rpIds)) : [];
    const date = new Map(rps.map((r) => [r.id, r.createdAt.toISOString()]));
    const rpDates: Record<string, string> = {};
    for (const r of revs) { const d = r.rpId ? date.get(r.rpId) : undefined; if (d) rpDates[String(r.rpSequence)] = d; }
    const pol = PolicyRead.safeParse(m.policy);
    const p = pol.success ? pol.data : {};
    const all = Object.entries(p.env ?? {}).flatMap(([service, keys]) => Object.entries(keys).map(([key, action]) => ({service, key, action})));
    const active = revs.find((r) => r.id === m.activeRevisionId) ?? revs[0];
    const iso = m.runnerAgentId ? await runnerIsolation(db, m.runnerAgentId, {now: o.now, maxAgeMs: RUNNER_PRECHECK_MAX_AGE_MS, serverUrl: o.serverUrl}) : null;
    const fact = await startTestedFact(db, m.stackId);
    return MirrorDetailExtras.parse({
        stack: {id: m.stackId, name: m.stackName}, rpDates,
        config: {
            access: p.access ? {service: p.access.service, target: p.access.target, hostPort: active?.hostPort ?? null} : null, httpPath: p.http_path ?? null,
            limits: {memBytes: p.limits?.mem_bytes ?? LIMIT_DEFAULTS.mem_bytes, pids: p.limits?.pids ?? LIMIT_DEFAULTS.pids, nanoCpus: p.limits?.nano_cpus ?? LIMIT_DEFAULTS.nano_cpus},
            overrides: o.canManage ? all : null, overrideCount: all.length, keptCount: all.filter((x) => x.action === "keep_exact").length,
        },
        runnerIsolation: !iso ? {state: "unknown", probedAt: null, reason: "runner_removed"}
            : iso.state === "isolated" ? {state: "isolated", probedAt: iso.probedAt.toISOString(), reason: null}
            : iso.state === "not_isolated" ? {state: "not_isolated", probedAt: iso.probedAt?.toISOString() ?? null, reason: null}
            : {state: "unknown", probedAt: null, reason: codeOrNull(iso.reason)},
        facet: fact ? {readiedAt: fact.readiedAt.toISOString(), rpSequence: fact.rpSequence} : null,
    });
}

export const MirrorLogEntry = z.strictObject({
    at: z.string(), kind: z.enum(["event", "task"]), title: z.string(), code: z.string().nullable(), status: z.string().nullable(), actor: z.enum(["user", "system"]).nullable(), durationSeconds: z.number().int().nullable(),
});
export type MirrorLogEntry = z.infer<typeof MirrorLogEntry>;
export const LOG_LIMIT = 200;

/** Per-mirror timeline (events) merged with the step journal (task status only), newest first. Titles are fixed sentences; codes are the closed machine codes. */
export async function loadMirrorLog(db: ForkDb, mirrorId: string): Promise<MirrorLogEntry[]> {
    const events = await db.select({kind: forkMirrorEvent.kind, at: forkMirrorEvent.at, toState: forkMirrorEvent.toState, code: forkMirrorEvent.code, actorKind: forkMirrorEvent.actorKind,
        scope: sql<string | null>`details->>'scope'`}).from(forkMirrorEvent).where(eq(forkMirrorEvent.mirrorId, mirrorId)).orderBy(desc(forkMirrorEvent.at)).limit(LOG_LIMIT);
    const tasks = await db.select({step: forkMirrorTask.step, attempt: forkMirrorTask.attempt, createdAt: forkMirrorTask.createdAt, status: forkAgentTask.status, finishedAt: forkAgentTask.finishedAt,
        reason: sql<string | null>`fork_agent_task.result->>'reason'`})
        .from(forkMirrorTask).innerJoin(forkMirrorRevision, eq(forkMirrorRevision.id, forkMirrorTask.revisionId)).leftJoin(forkAgentTask, eq(forkAgentTask.id, forkMirrorTask.taskId))
        .where(eq(forkMirrorRevision.mirrorId, mirrorId)).orderBy(desc(forkMirrorTask.createdAt)).limit(LOG_LIMIT);
    const out: MirrorLogEntry[] = [
        ...events.map((e) => MirrorLogEntry.parse({at: e.at.toISOString(), kind: "event", title: eventTitle(e.kind, e.toState, e.scope === "mirror"), code: codeOrNull(e.code), status: null, actor: e.actorKind === "user" ? "user" : "system", durationSeconds: null})),
        ...tasks.map((t) => {
            const failed = t.status === "failed" || t.status === "rejected";
            return MirrorLogEntry.parse({at: t.createdAt.toISOString(), kind: "task", title: taskTitle(t.step, t.attempt), code: failed ? (codeOrNull(t.reason) ?? "execution_error") : null, status: t.status ?? "queued", actor: null,
                durationSeconds: t.finishedAt ? Math.max(0, Math.round((t.finishedAt.getTime() - t.createdAt.getTime()) / 1000)) : null});
        }),
    ];
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, LOG_LIMIT);
}
