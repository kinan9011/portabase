import {randomUUID} from "node:crypto";
import {and, eq} from "drizzle-orm";
import {z} from "zod";
import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {ArcaneClient} from "@/fork/arcane/client";
import type {RefusalCode, ServiceDeps} from "@/fork/arcane/connection-service";
import {ARCANE_PINNED_VERSION} from "@/fork/arcane/endpoints";
import {ArcaneError, HEALTH_FOR_CLASS, type ArcaneErrorClass} from "@/fork/arcane/errors";
import {evaluateKeyPermissions} from "@/fork/arcane/key-policy";
import {recordAudit} from "@/fork/audit";
import {CONNECTION_PUBLIC_COLUMNS, readConnectionApiKey, toConnectionDto, type ConnectionDto} from "@/fork/db/dto";
import type {ForkDb} from "@/fork/db/handle";
import {forkArcaneConnection, forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {BREAKER, circuitOpenMs, ENVIRONMENT_BUDGET_MS, leaseName, recordEnvironmentOutcome, reconcileEnvironments, setConnectionSyncState, SYNC_LEASE_TTL_MS, toErrorCode, writeEnvironmentSync} from "@/fork/discovery/sync-state";
import type {SyncSummary} from "@/fork/discovery/sync-summary";
import {forkEnv} from "@/fork/env";
import {parseComposeYaml, type ParsedCompose} from "@/fork/inventory/compose-yaml";
import {PROJECT_NAME} from "@/fork/inventory/labels";
import {normalizeEnvironment} from "@/fork/inventory/normalize";
import {assertForkConfigAllowed, ForkLockedError} from "@/fork/mode";
import {parseAllowlist, UrlGuardError} from "@/fork/net/guard";
import {checkRate} from "@/fork/net/rate-limit";
import {enqueueForkNotification} from "@/fork/notify";
import {assertForkResource} from "@/fork/resource-scope";
import {acquireLease, releaseLease} from "@/fork/locks";

/**
 * Discovery sync orchestrator (W07): per connection → covered, ENABLED environments → five list calls each (read-only, GET) → normaliser →
 * one transaction per environment. READ-ONLY against Arcane; the inventory carries no secret (the client drops env values at the boundary,
 * the normaliser is an allow-list, tier-2 YAML is reduced to names). NO logging here (W05 static guard); outcomes are returned + audited.
 *
 * Gating: `syncNow` = principal → `arcane.manage` (system admin, resource-scoped, no existence oracle) → D21 gate → rate limit → run.
 * The cron (`src/fork/cron.ts`) calls `syncConnection` directly after its own mode gate (ADR-010: config plane = `on` only).
 */
export type SyncTrigger = "manual" | "cron";
export type SyncDeps = Pick<ServiceDeps, "db" | "kekDir" | "allowlist" | "resolve" | "transport" | "sleep" | "now"> & {
    random?: () => number;
    /** lease owner token (default: unique per run). */
    owner?: string;
    /** test seam: per-environment budget (default 60 s). */
    environmentBudgetMs?: number;
};

export type SyncEnvStatus = "ok" | "partial" | "error";
export type SyncRun = {
    status: "ok" | "partial" | "failed";
    trigger: SyncTrigger;
    startedAt: string;
    durationMs: number;
    /** class of a connection-level failure (preflight, or every environment failed), else null. */
    connectionError: string | null;
    environments: {environmentId: string; status: SyncEnvStatus; errorCode: string | null}[];
    totals: {found: number; created: number; changed: number; unchanged: number; absent: number; rejected: number; services: number; mounts: number; warnings: number};
    reconcile: {gone: number; added: number};
    circuit: {open: boolean; opened: boolean; closed: boolean; until: string | null; streak: number};
};
export type SyncSkipReason = "already_running" | "circuit_open" | "no_connection" | "no_enabled_environment";
export type SyncResult = {kind: "skipped"; reason: SyncSkipReason} | {kind: "ran"; run: SyncRun};

class SyncDeadline extends Error {}

const SELF = (e: unknown): ArcaneErrorClass | "internal" | "deadline" =>
    e instanceof ArcaneError ? e.errorClass : e instanceof UrlGuardError ? "blocked_url" : e instanceof SyncDeadline ? "deadline" : "internal";

const emptyTotals = (): SyncRun["totals"] => ({found: 0, created: 0, changed: 0, unchanged: 0, absent: 0, rejected: 0, services: 0, mounts: 0, warnings: 0});

// ---- one environment ----------------------------------------------------------------------------------------------------------
async function syncEnvironment(d: SyncDeps, c: {client: ArcaneClient; conn: ConnectionDto; arcaneVersion: string; trigger: SyncTrigger}, env: {id: string; externalId: string; name: string}, now: Date) {
    const t0 = Date.now();
    const deadline = t0 + (d.environmentBudgetMs ?? ENVIRONMENT_BUDGET_MS);
    const check = () => { if (Date.now() > deadline) throw new SyncDeadline(); };
    const base = {trigger: c.trigger, started_at: now.toISOString()};
    try {
        const containers = await c.client.listContainers(env.externalId); check();
        const volumes = await c.client.listVolumes(env.externalId); check();
        const networks = await c.client.listNetworks(env.externalId); check();
        const images = await c.client.listImages(env.externalId); check();
        const projects = await c.client.listProjects(env.externalId); check();

        // tier 2 (opt-in `projects:read`): compose text → names/paths only (SEC-17). A failure never fails the environment: that stack just stays unread.
        const compose = new Map<string, ParsedCompose>();
        const composeRejected = new Map<string, string>();
        const errors = new Map<string, number>();
        const bump = (code: string) => errors.set(code, (errors.get(code) ?? 0) + 1);
        if (c.conn.allowProjectsRead) {
            for (const p of projects.slice(0, 50)) {
                if (!PROJECT_NAME.test(p.name)) continue;
                check();
                try {
                    const files = await c.client.readProjectFiles(env.externalId, p.id);
                    const r = parseComposeYaml(files.composeContent, files.overrideContent);
                    if (!r.ok) { composeRejected.set(p.name, r.reason); bump("inventory_invalid"); continue; }
                    for (const s of files.services) {
                        const t = s.name ? r.compose.services.find((x) => x.name === s.name) : undefined;
                        if (t) t.envNames = [...new Set([...t.envNames, ...s.environmentNames])].sort();
                    }
                    compose.set(p.name, r.compose);
                } catch (e) {
                    bump(toErrorCode(SELF(e)));
                }
            }
        }

        const result = normalizeEnvironment({
            connectionId: c.conn.id, environmentId: env.externalId, arcaneVersion: c.arcaneVersion, capturedAt: now, containers, volumes, networks, images, projects, compose, composeRejected,
        });
        for (const r of result.rejected) bump(r.code);
        const counts = await d.db.transaction(async (tx0) => {
            const tx = tx0 as unknown as ForkDb;
            const counts = await writeEnvironmentSync(tx, {organizationId: c.conn.organizationId, environmentId: env.id, environmentName: env.name, result, now});
            const partial = errors.size > 0;
            const summary: SyncSummary = {
                ...base, duration_ms: Date.now() - t0, stacks_found: counts.found, stacks_new: counts.created, stacks_changed: counts.changed, stacks_unchanged: counts.unchanged,
                stacks_absent: counts.absent, stacks_rejected: counts.rejected, services: counts.services, mounts: counts.mounts, unmanaged_containers: result.unmanagedContainers,
                warnings: counts.warnings, errors: [...errors].map(([code, count]) => ({code: toErrorCode(code), count})), partial,
            };
            await recordEnvironmentOutcome(tx, {environmentId: env.id, now, status: partial ? "partial" : "ok", errorClass: partial ? toErrorCode([...errors.keys()][0]) : null, summary});
            return {counts, partial, code: partial ? toErrorCode([...errors.keys()][0]) : null};
        });
        return {environmentId: env.id, status: (counts.partial ? "partial" : "ok") as SyncEnvStatus, errorCode: counts.code as string | null, counts: counts.counts};
    } catch (e) {
        const code = toErrorCode(SELF(e));
        await failEnvironment(d.db, env.id, now, code, base, Date.now() - t0);
        return {environmentId: env.id, status: "error" as SyncEnvStatus, errorCode: code as string | null, counts: undefined};
    }
}

async function failEnvironment(db: ForkDb, environmentId: string, now: Date, code: string, base: {trigger: SyncTrigger; started_at: string}, durationMs: number) {
    const summary: SyncSummary = {...base, duration_ms: durationMs, stacks_found: 0, stacks_new: 0, stacks_changed: 0, stacks_unchanged: 0, stacks_absent: 0, stacks_rejected: 0, services: 0, mounts: 0, unmanaged_containers: 0, warnings: 0, errors: [{code: toErrorCode(code), count: 1}], partial: false};
    await db.transaction(async (tx) => recordEnvironmentOutcome(tx as unknown as ForkDb, {environmentId, now, status: "error", errorClass: code, summary}));
}

// ---- one connection -------------------------------------------------------------------------------------------------------------
export async function syncConnection(d: SyncDeps, connectionId: string, trigger: SyncTrigger, actor: {userId: string | null} = {userId: null}): Promise<SyncResult> {
    const clock = () => d.now?.() ?? new Date();
    const owner = d.owner ?? randomUUID();
    const lease = leaseName(connectionId);
    if (!(await acquireLease(d.db, lease, owner, SYNC_LEASE_TTL_MS, clock()))) return {kind: "skipped", reason: "already_running"};
    try {
        const [row] = await d.db.select(CONNECTION_PUBLIC_COLUMNS).from(forkArcaneConnection).where(eq(forkArcaneConnection.id, connectionId));
        if (!row) return {kind: "skipped", reason: "no_connection"};
        const conn = toConnectionDto(row);
        if (trigger === "cron" && conn.circuitOpenUntil && conn.circuitOpenUntil > clock()) return {kind: "skipped", reason: "circuit_open"};
        const enabledNow = await listEnabled(d.db, connectionId);
        if (!enabledNow.length) return {kind: "skipped", reason: "no_enabled_environment"};
        return {kind: "ran", run: await runLocked(d, conn, enabledNow, trigger, actor, owner, lease)};
    } finally {
        await releaseLease(d.db, lease, owner);
    }
}

async function listEnabled(db: ForkDb, connectionId: string) {
    return db.select({id: forkArcaneEnvironment.id, externalId: forkArcaneEnvironment.externalId, name: forkArcaneEnvironment.name}).from(forkArcaneEnvironment)
        .where(and(eq(forkArcaneEnvironment.connectionId, connectionId), eq(forkArcaneEnvironment.enabled, true))).orderBy(forkArcaneEnvironment.name, forkArcaneEnvironment.externalId);
}

async function runLocked(d: SyncDeps, conn: ConnectionDto, enabledEnvs: {id: string; externalId: string; name: string}[], trigger: SyncTrigger, actor: {userId: string | null}, owner: string, lease: string): Promise<SyncRun> {
    const now = d.now?.() ?? new Date();
    const t0 = Date.now();
    await setConnectionSyncState(d.db, conn.id, {lastSyncAttemptAt: now}); // due-ness advances even if this process dies mid-run
    const base = {trigger, started_at: now.toISOString()};
    const envResults: SyncRun["environments"] = [];
    const totals = emptyTotals();
    let reconcile = {gone: 0, added: 0};
    let connectionError: string | null = null;
    let partialKey = false;

    try {
        const apiKey = await readConnectionApiKey(d.db, conn.organizationId, conn.id, d.kekDir);
        const client = await ArcaneClient.create({
            baseUrl: conn.baseUrl, apiKey, tlsInsecure: conn.tlsInsecure, allowProjectsRead: conn.allowProjectsRead,
            allowlist: d.allowlist ?? parseAllowlist(forkEnv().FORK_ARCANE_NET_ALLOWLIST), resolve: d.resolve, transport: d.transport, sleep: d.sleep,
        });
        const version = await client.getVersion();
        if (version !== ARCANE_PINNED_VERSION) throw new ArcaneError("incompatible");
        const ev = evaluateKeyPermissions(await client.listOwnerKeys(), apiKey, {allowProjectsRead: conn.allowProjectsRead});
        if (!ev.ok) throw new ArcaneError(ev.errorClass);
        partialKey = ev.partial;
        const visible = await client.listEnvironments();
        const covered = visible.filter((e) => ev.environmentIds.includes(e.id)).map((e) => ({id: e.id, name: e.name}));
        reconcile = await d.db.transaction(async (tx) => reconcileEnvironments(tx as unknown as ForkDb, conn.id, covered, now));
        const live = new Set(covered.map((c) => c.id));
        for (const env of enabledEnvs) {
            if (!live.has(env.externalId)) { envResults.push({environmentId: env.id, status: "error", errorCode: "not_found"}); continue; } // reconcile already marked it + its stacks
            if (!(await acquireLease(d.db, lease, owner, SYNC_LEASE_TTL_MS, d.now?.() ?? new Date()))) { connectionError = "internal"; break; } // lease lost (stolen after expiry): stop, never write on without it
            const r = await syncEnvironment(d, {client, conn, arcaneVersion: version, trigger}, env, now);
            envResults.push({environmentId: r.environmentId, status: r.status, errorCode: r.errorCode});
            if (r.counts) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += k === "created" ? r.counts.created : (r.counts as Record<string, number>)[k] ?? 0;
        }
    } catch (e) {
        connectionError = SELF(e);
        for (const env of enabledEnvs) {
            if (envResults.some((r) => r.environmentId === env.id)) continue;
            await failEnvironment(d.db, env.id, now, toErrorCode(connectionError), base, Date.now() - t0);
            envResults.push({environmentId: env.id, status: "error", errorCode: toErrorCode(connectionError)});
        }
    }

    const attempted = envResults.length;
    const failedEnvs = envResults.filter((r) => r.status === "error").length;
    if (!connectionError && attempted > 0 && failedEnvs === attempted && reconcile.gone < attempted) connectionError = envResults[0].errorCode; // every environment failed ⇒ the connection is the problem
    const status: SyncRun["status"] = connectionError ? "failed" : failedEnvs > 0 || envResults.some((r) => r.status === "partial") || partialKey || reconcile.gone > 0 ? "partial" : "ok";

    const prevStreak = conn.syncFailureStreak;
    const streak = status === "failed" ? prevStreak + 1 : 0;
    const openMs = status === "failed" ? circuitOpenMs(streak) : 0;
    const until = openMs ? new Date(now.getTime() + openMs) : null;
    const opened = status === "failed" && prevStreak < BREAKER.threshold && streak >= BREAKER.threshold;
    const closed = status !== "failed" && (prevStreak >= BREAKER.threshold || conn.circuitOpenUntil !== null);
    const changed = totals.created + totals.changed + totals.absent > 0;
    const durationMs = Date.now() - t0;

    const health =
        status === "failed" ? (connectionError && connectionError in HEALTH_FOR_CLASS ? {healthStatus: HEALTH_FOR_CLASS[connectionError as ArcaneErrorClass], lastErrorClass: connectionError} : {healthStatus: "degraded" as const, lastErrorClass: null})
        : status === "partial" ? {healthStatus: "degraded" as const, lastErrorClass: "partial"} : {healthStatus: "healthy" as const, lastErrorClass: null};

    await d.db.transaction(async (tx0) => {
        const tx = tx0 as unknown as ForkDb;
        await setConnectionSyncState(tx, conn.id, {syncFailureStreak: streak, circuitOpenUntil: until, ...health, lastCheckedAt: now, updatedAt: now});
        if (opened) await enqueueForkNotification(tx, {kind: "discovery.circuit_open", dedupeKey: `discovery.circuit_open:${conn.id}:${now.toISOString()}`, payload: {state: "circuit_open", link: "/dashboard/integrations"}});
        if (trigger === "manual" || status !== "ok" || changed || opened || closed || prevStreak > 0) {
            await recordAudit(tx, {
                organizationId: conn.organizationId, actorUserId: actor.userId, actorKind: trigger === "cron" ? "system" : "user", action: "fork.discovery.sync", resourceType: "arcane_connection",
                resourceId: conn.id, result: status === "failed" ? "failure" : "success", now,
                details: {
                    trigger, status, durationMs, connectionError, environments: envResults.map((r) => ({status: r.status, code: r.errorCode})), totals, reconcile,
                    circuit: opened ? "opened" : closed ? "closed" : until ? "open" : "closed_unchanged", streak,
                },
            });
        }
    });
    return {status, trigger, startedAt: now.toISOString(), durationMs, connectionError, environments: envResults, totals, reconcile, circuit: {open: !!until, opened, closed, until: until?.toISOString() ?? null, streak}};
}

// ---- manual "Sync now" (server action target) -------------------------------------------------------------------------------------
export const SyncInputSchema = z.strictObject({connectionId: z.uuid()});
export const SYNC_RATE_LIMIT = {limit: 6, windowMs: 60_000} as const;
export type SyncNowRefusalCode = RefusalCode | "already_running" | "circuit_open" | "no_enabled_environment";
export type SyncNowOutcome = {ok: true; run: SyncRun} | {ok: false; code: SyncNowRefusalCode; message: string; retryAfterSeconds?: number};
const refuse = (code: SyncNowRefusalCode, message: string, extra: {retryAfterSeconds?: number} = {}): SyncNowOutcome => ({ok: false, code, message, ...extra});

export async function syncNow(d: ServiceDeps & Pick<SyncDeps, "random" | "owner" | "environmentBudgetMs">, raw: unknown): Promise<SyncNowOutcome> {
    const parsed = SyncInputSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Invalid connection id.");
    const {connectionId} = parsed.data;
    const p = d.principal;
    const audit = (result: "denied" | "failure", organizationId: string | null, details: Record<string, unknown>) =>
        recordAudit(d.db, {organizationId, actorUserId: p?.userId ?? null, action: "fork.discovery.sync", resourceType: "arcane_connection", resourceId: connectionId, result, details, now: d.now?.()});
    if (!p) return refuse("forbidden", "You must be signed in.");
    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(d.db, p, "arcane.manage", {kind: "connection", id: connectionId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) { await audit("denied", null, {trigger: "manual", reason: "not-found"}); return refuse("not_found", "Connection not found."); }
        if (e instanceof ForkForbiddenError) { await audit("denied", null, {trigger: "manual", reason: "forbidden", capability: "arcane.manage"}); return refuse("forbidden", "Only a system administrator can sync."); }
        throw e;
    }
    try {
        await (d.assertConfigAllowed ?? assertForkConfigAllowed)();
    } catch (e) {
        if (e instanceof ForkLockedError) {
            await audit("denied", organizationId, {trigger: "manual", reason: e.mode === "locked" ? `locked:${e.lockReason ?? "unknown"}` : "mode-off"});
            return refuse("locked", e.mode === "locked" ? `Fork configuration is locked (${e.lockReason ?? "see status"}); fix the cause first.` : "Stack Recovery is not enabled.");
        }
        throw e;
    }
    const rate = (d.rate ?? checkRate)(`${p.userId}:arcane:sync`, SYNC_RATE_LIMIT.limit, SYNC_RATE_LIMIT.windowMs, d.now?.().getTime());
    if (!rate.ok) {
        await audit("denied", organizationId, {trigger: "manual", reason: "rate-limited"});
        return refuse("rate_limited", `Too many sync requests. Try again in ${rate.retryAfterSeconds} s.`, {retryAfterSeconds: rate.retryAfterSeconds});
    }
    const r = await syncConnection(d, connectionId, "manual", {userId: p.userId});
    if (r.kind === "ran") return {ok: true, run: r.run};
    if (r.reason === "already_running") return refuse("already_running", "A sync is already running. It reads the same data; reload to see its result.");
    if (r.reason === "no_enabled_environment") return refuse("no_enabled_environment", "Enable discovery for at least one environment first.");
    return refuse("not_found", "Connection not found.");
}
