import {and, eq, sql} from "drizzle-orm";
import {z} from "zod";
import {assertForkCapability, ForkForbiddenError, ForkNotFoundError, type ForkPrincipal} from "@/fork/acl";
import {ArcaneClient, type ArcaneClientOptions} from "@/fork/arcane/client";
import {ARCANE_PINNED_VERSION} from "@/fork/arcane/endpoints";
import {ArcaneError, HEALTH_FOR_CLASS, type ArcaneErrorClass, type HealthStatus} from "@/fork/arcane/errors";
import {evaluateKeyPermissions} from "@/fork/arcane/key-policy";
import {recordAudit} from "@/fork/audit";
import {getConnectionDto, insertConnectionWithSecret, readConnectionApiKey, replaceConnectionApiKey, toConnectionDto, CONNECTION_PUBLIC_COLUMNS, type ConnectionDto} from "@/fork/db/dto";
import type {ForkDb} from "@/fork/db/handle";
import {forkArcaneConnection, forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {forkEnv} from "@/fork/env";
import {assertForkResource} from "@/fork/resource-scope";
import {assertForkConfigAllowed, ForkLockedError} from "@/fork/mode";
import {endpointIdentity, parseAllowlist, parseBaseUrl, UrlGuardError, type Allowlist, type Resolver} from "@/fork/net/guard";
import {checkRate} from "@/fork/net/rate-limit";

/**
 * Arcane connection use-cases (W05): save / test / rotate key / disconnect. The server actions in
 * `src/fork/actions/arcane-connection.action.ts` are thin wrappers; everything testable lives here.
 *
 * Every use-case, in this order: principal → resource-scoped authorisation (`arcane.manage` = system admin only, D21; no
 * existence oracle, SEC-12) → single-tenant self-check / flag gate (`assertForkConfigAllowed`, D21/§4.1) → rate limit →
 * network verification (version pin, key permission self-test, per-environment reachability; OUTSIDE any DB transaction)
 * → one DB transaction that mutates AND writes the audit row. Denied/failed attempts are audited too.
 *
 * Secrets: the plaintext key exists only in a local variable; it is stored through `db/dto.ts` (KEK envelope + AAD),
 * never returned, never in audit details (redaction denies key-like names anyway) and never in an error message.
 */
export const RATE_LIMIT = {limit: 6, windowMs: 60_000} as const;
export const TLS_WARNING = "TLS certificate verification is OFF for this connection: anyone on the network path can read the Arcane key and alter inventory. Use it only for a lab or a private CA you cannot yet trust.";
export const TIER2_WARNING = "Allowing projects:read lets this key read the raw Compose files AND the resolved environment values and env-file bytes of every project in the allowed environments. Enable it only if you accept that.";

export type ServiceDeps = {
    db: ForkDb;
    principal: ForkPrincipal | null;
    kekDir?: string;
    allowlist?: Allowlist;
    resolve?: Resolver;
    transport?: ArcaneClientOptions["transport"];
    sleep?: ArcaneClientOptions["sleep"];
    now?: () => Date;
    /** test seam; default = the real D21 gate. */
    assertConfigAllowed?: () => Promise<void>;
    /** test seam; default = process-wide limiter. */
    rate?: typeof checkRate;
};

// ---- inputs -----------------------------------------------------------------------------------------------------------
export const ApiKeyInput = z.string().min(8).max(512).regex(/^[\x21-\x7e]+$/, "The key contains characters an Arcane key never has.");
export const NameInput = z.string().trim().min(1).max(128);
export const SaveInputSchema = z.strictObject({
    connectionId: z.uuid().optional(),
    name: NameInput,
    baseUrl: z.string().trim().min(1).max(2048),
    apiKey: ApiKeyInput.optional(),
    tlsInsecure: z.boolean().optional(),
    allowProjectsRead: z.boolean().optional(),
});
export const TestInputSchema = z.strictObject({connectionId: z.uuid()});
export const RotateInputSchema = z.strictObject({connectionId: z.uuid(), apiKey: ApiKeyInput});
export const DisconnectInputSchema = z.strictObject({connectionId: z.uuid()});
export type SaveInput = z.infer<typeof SaveInputSchema>;

// ---- results ----------------------------------------------------------------------------------------------------------
export type EnvironmentCheck = {externalId: string; name: string; reachable: boolean; errorClass: ArcaneErrorClass | null};
export type Verification = {
    ok: boolean;
    state: HealthStatus;
    errorClass: ArcaneErrorClass | null;
    version: string | null;
    keyId: string | null;
    environments: EnvironmentCheck[];
    extraPermissions: string[];
    missingPermissions: string[];
    warnings: string[];
};

export type RefusalCode = "forbidden" | "not_found" | "locked" | "rate_limited" | "invalid_input" | "key_reentry_required" | "refused" | "single_tenant_required";
export type Refusal = {ok: false; code: RefusalCode; message: string; errorClass?: ArcaneErrorClass; extraPermissions?: string[]; retryAfterSeconds?: number; connection?: ConnectionDto};
export type Success = {ok: true; connection: ConnectionDto | null; verification: Verification | null; warnings: string[]};
export type Outcome = Success | Refusal;

const refuse = (code: RefusalCode, message: string, extra: Partial<Refusal> = {}): Refusal => ({ok: false, code, message, ...extra});

// ---- helpers ----------------------------------------------------------------------------------------------------------
const ACTION_CODE = {save: "fork.arcane.connection.save", test: "fork.arcane.connection.test", rotate: "fork.arcane.connection.rotate_key", disconnect: "fork.arcane.connection.disconnect"} as const;
type ActionName = keyof typeof ACTION_CODE;

async function audit(d: ServiceDeps, a: ActionName, o: {organizationId?: string | null; resourceId?: string | null; result: "success" | "denied" | "failure"; details?: Record<string, unknown>}, db: ForkDb = d.db) {
    await recordAudit(db, {
        organizationId: o.organizationId ?? null, actorUserId: d.principal?.userId ?? null, action: ACTION_CODE[a], resourceType: "arcane_connection",
        resourceId: o.resourceId ?? null, result: o.result, details: o.details, now: d.now?.(),
    });
}

async function soleOrganization(db: ForkDb): Promise<string | null> {
    const r = await db.execute(sql`select id from organization where deleted_at is null limit 2`);
    return r.rows.length === 1 ? (r.rows[0] as {id: string}).id : null;
}

type Authorized = {ok: true; organizationId: string; userId: string} | Refusal;

async function authorize(d: ServiceDeps, a: ActionName, connectionId?: string): Promise<Authorized> {
    const p = d.principal;
    if (!p) return refuse("forbidden", "You must be signed in.");
    let organizationId: string | null = null;
    try {
        if (connectionId) {
            ({organizationId} = await assertForkResource(d.db, p, "arcane.manage", {kind: "connection", id: connectionId}));
        } else {
            organizationId = await soleOrganization(d.db);
            if (!organizationId) {
                await audit(d, a, {result: "denied", details: {reason: "single-tenant-required"}});
                return refuse("single_tenant_required", "Stack Recovery needs exactly one organization (D21).");
            }
            assertForkCapability(p, organizationId, "arcane.manage");
        }
    } catch (e) {
        if (e instanceof ForkNotFoundError) {
            await audit(d, a, {resourceId: connectionId, result: "denied", details: {reason: "not-found"}});
            return refuse("not_found", "Connection not found.");
        }
        if (e instanceof ForkForbiddenError) {
            await audit(d, a, {organizationId, resourceId: connectionId, result: "denied", details: {reason: "forbidden", capability: "arcane.manage"}});
            return refuse("forbidden", "Only a system administrator can change the Arcane connection.");
        }
        throw e;
    }
    try {
        await (d.assertConfigAllowed ?? assertForkConfigAllowed)();
    } catch (e) {
        if (e instanceof ForkLockedError) {
            await audit(d, a, {organizationId, resourceId: connectionId, result: "denied", details: {reason: e.mode === "locked" ? `locked:${e.lockReason ?? "unknown"}` : "mode-off"}});
            return refuse("locked", e.mode === "locked" ? `Fork configuration is locked (${e.lockReason ?? "see status"}); fix the cause first.` : "Stack Recovery is not enabled.");
        }
        throw e;
    }
    const rate = (d.rate ?? checkRate)(`${p.userId}:arcane:${a === "disconnect" ? "disconnect" : "net"}`, RATE_LIMIT.limit, RATE_LIMIT.windowMs, d.now?.().getTime());
    if (!rate.ok) {
        await audit(d, a, {organizationId, resourceId: connectionId, result: "denied", details: {reason: "rate-limited"}});
        return refuse("rate_limited", `Too many attempts. Try again in ${rate.retryAfterSeconds} s.`, {retryAfterSeconds: rate.retryAfterSeconds});
    }
    return {ok: true, organizationId, userId: p.userId};
}

/** Strips a trailing `/api` (people paste the API base) and validates through the guard's parser. */
export function normaliseBaseUrl(raw: string): string {
    const p = parseBaseUrl(raw);
    return p.baseUrl.replace(/\/api$/i, "");
}

const safeVersion = (v: string) => (/^[\w.+-]{1,40}$/.test(v) ? v : "unknown");

/**
 * The network half of every use-case: SSRF guard → version pin → key self-test → environment list → per-environment
 * reachability. Never throws for Arcane/network problems; returns the mapped state.
 */
export async function verifyConnection(
    d: Pick<ServiceDeps, "allowlist" | "resolve" | "transport" | "sleep">,
    c: {baseUrl: string; apiKey: string; tlsInsecure: boolean; allowProjectsRead: boolean},
): Promise<Verification> {
    const v: Verification = {ok: false, state: "unknown", errorClass: null, version: null, keyId: null, environments: [], extraPermissions: [], missingPermissions: [], warnings: []};
    const fail = (cls: ArcaneErrorClass, more: Partial<Verification> = {}): Verification => ({...v, ...more, ok: false, errorClass: cls, state: HEALTH_FOR_CLASS[cls]});
    try {
        const client = await ArcaneClient.create({
            baseUrl: c.baseUrl, apiKey: c.apiKey, tlsInsecure: c.tlsInsecure, allowProjectsRead: c.allowProjectsRead,
            allowlist: d.allowlist ?? parseAllowlist(forkEnv().FORK_ARCANE_NET_ALLOWLIST), resolve: d.resolve, transport: d.transport, sleep: d.sleep,
        });
        if (client.target.viaAllowlist) v.warnings.push("The Arcane address is private or loopback and was permitted by the operator allow-list (FORK_ARCANE_NET_ALLOWLIST).");
        if (c.tlsInsecure && client.target.scheme === "https") v.warnings.push(TLS_WARNING);

        v.version = safeVersion(await client.getVersion());
        if (v.version !== ARCANE_PINNED_VERSION) return fail("incompatible", {warnings: [...v.warnings, `Arcane reports ${v.version}; this release was tested against ${ARCANE_PINNED_VERSION}.`]});

        const keys = await client.listOwnerKeys();
        const ev = evaluateKeyPermissions(keys, c.apiKey, {allowProjectsRead: c.allowProjectsRead});
        if (!ev.ok) return fail(ev.errorClass, {extraPermissions: ev.extra, keyId: ev.keyId});
        v.keyId = ev.keyId;
        v.missingPermissions = [...ev.missingGlobal, ...Object.entries(ev.missing).flatMap(([env, m]) => m.map((p) => `${p} (environment ${env})`))];

        const visible = await client.listEnvironments();
        const covered = visible.filter((e) => ev.environmentIds.includes(e.id)); // allow-list: key-covered ∩ visible; other environments are never kept
        let anyEnvFailed = false;
        for (const e of covered.slice(0, 50)) {
            try {
                await client.testEnvironment(e.id);
                v.environments.push({externalId: e.id, name: e.name, reachable: true, errorClass: null});
            } catch (err) {
                anyEnvFailed = true;
                v.environments.push({externalId: e.id, name: e.name, reachable: false, errorClass: err instanceof ArcaneError ? err.errorClass : "unreachable"});
            }
        }
        v.ok = true;
        if (ev.partial || anyEnvFailed || covered.length === 0) {
            // manager + key are fine, so the connection is degraded; the class says why (one environment 403/502/offline ⇒ its own class)
            v.errorClass = ev.partial ? "partial" : (v.environments.find((e) => !e.reachable)?.errorClass ?? "partial");
            v.state = "degraded";
            if (covered.length === 0) v.missingPermissions.push("the key covers no environment that Arcane lists");
        } else {
            v.state = "healthy";
        }
        return v;
    } catch (e) {
        if (e instanceof ArcaneError) return fail(e.errorClass, {extraPermissions: e.permission ? [e.permission] : []});
        if (e instanceof UrlGuardError) return fail("blocked_url");
        return fail("unreachable");
    }
}

const persistEnvironments = async (tx: ForkDb, connectionId: string, envs: EnvironmentCheck[]) => {
    for (const e of envs) {
        await tx.insert(forkArcaneEnvironment).values({connectionId, externalId: e.externalId, name: e.name.slice(0, 256)})
            .onConflictDoUpdate({target: [forkArcaneEnvironment.connectionId, forkArcaneEnvironment.externalId], set: {name: e.name.slice(0, 256), updatedAt: new Date()}});
    }
};

const verificationDetails = (v: Verification, c: {baseUrl: string; tlsInsecure: boolean; allowProjectsRead: boolean}) => ({
    state: v.state, errorClass: v.errorClass, version: v.version, keyId: v.keyId, endpoint: endpointIdentity(c.baseUrl), tlsInsecure: c.tlsInsecure,
    allowProjectsRead: c.allowProjectsRead, environments: v.environments.length, extraPermissions: v.extraPermissions, missingPermissions: v.missingPermissions.slice(0, 20),
});

const refusedByVerification = (v: Verification): Refusal =>
    refuse("refused", v.errorClass === "key_too_broad" ? `The Arcane key holds more than the discovery minimum: ${v.extraPermissions.join(", ")}.` : (v.errorClass ? new ArcaneError(v.errorClass, {permission: v.extraPermissions[0]}).message : "Verification failed."), {errorClass: v.errorClass ?? undefined, extraPermissions: v.extraPermissions});

const conflict = (e: unknown) => typeof e === "object" && e !== null && ((e as {code?: string}).code === "23505" || (e as {cause?: {code?: string}}).cause?.code === "23505");

// ---- use-cases --------------------------------------------------------------------------------------------------------
export async function saveConnection(d: ServiceDeps, raw: unknown): Promise<Outcome> {
    const parsed = SaveInputSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the name, URL and key format.");
    const input = parsed.data;
    const authz = await authorize(d, "save", input.connectionId);
    if (!authz.ok) return authz;
    const {organizationId} = authz;

    let baseUrl: string;
    try {
        baseUrl = normaliseBaseUrl(input.baseUrl);
    } catch (e) {
        const msg = e instanceof UrlGuardError ? e.message : "The Arcane URL is not valid.";
        await audit(d, "save", {organizationId, resourceId: input.connectionId, result: "denied", details: {reason: "invalid-url", code: e instanceof UrlGuardError ? e.code : "invalid_url"}});
        return refuse("invalid_input", msg, {errorClass: "blocked_url"});
    }

    const existing = input.connectionId ? await getConnectionDto(d.db, organizationId, input.connectionId) : null;
    if (input.connectionId && !existing) return refuse("not_found", "Connection not found.");

    // SEC-10: host, port or scheme changed ⇒ the key must be typed again (never silently reused against another endpoint).
    if (existing && endpointIdentity(existing.baseUrl) !== endpointIdentity(baseUrl) && !input.apiKey) {
        await audit(d, "save", {organizationId, resourceId: existing.id, result: "denied", details: {reason: "key-reentry-required", from: endpointIdentity(existing.baseUrl), to: endpointIdentity(baseUrl)}});
        return refuse("key_reentry_required", "The Arcane host, port or scheme changed: enter the API key again. A stored key is never sent to a different endpoint.");
    }

    const tlsInsecure = input.tlsInsecure ?? existing?.tlsInsecure ?? false;
    const allowProjectsRead = input.allowProjectsRead ?? existing?.allowProjectsRead ?? false;
    let apiKey = input.apiKey;
    if (!apiKey) {
        if (!existing) return refuse("invalid_input", "An API key is required.");
        apiKey = await readConnectionApiKey(d.db, organizationId, existing.id, d.kekDir);
    }
    const v = await verifyConnection(d, {baseUrl, apiKey, tlsInsecure, allowProjectsRead});
    const cfg = {baseUrl, tlsInsecure, allowProjectsRead};

    // Never keep (or switch to) a key we refuse: create ⇒ nothing stored; update with a NEW key ⇒ old key kept.
    const mustRefuse = !v.ok && (!existing || !!input.apiKey || v.errorClass === "key_too_broad" || v.errorClass === "blocked_url");
    if (mustRefuse) {
        await audit(d, "save", {organizationId, resourceId: existing?.id, result: "failure", details: {...verificationDetails(v, cfg), refused: true}});
        return {...refusedByVerification(v), ...(existing ? {connection: existing} : {})};
    }

    const flipsTlsOff = tlsInsecure && !(existing?.tlsInsecure ?? false);
    try {
        const connection = await d.db.transaction(async (tx0) => {
            const tx = tx0 as unknown as ForkDb;
            let id: string;
            if (!existing) {
                id = (await insertConnectionWithSecret(tx, {organizationId, name: input.name, baseUrl, apiKey}, d.kekDir)).id;
            } else {
                id = existing.id;
                if (input.apiKey) await replaceConnectionApiKey(tx, organizationId, id, input.apiKey, d.kekDir);
            }
            await tx.update(forkArcaneConnection).set({
                name: input.name, baseUrl, tlsInsecure, allowProjectsRead, healthStatus: v.state, lastErrorClass: v.errorClass, keyId: v.keyId ?? existing?.keyId ?? null,
                pinnedApiVersion: v.version === ARCANE_PINNED_VERSION ? v.version : existing?.pinnedApiVersion ?? null, lastCheckedAt: (d.now?.() ?? new Date()), updatedAt: new Date(),
            }).where(and(eq(forkArcaneConnection.id, id), eq(forkArcaneConnection.organizationId, organizationId)));
            if (v.ok) await persistEnvironments(tx, id, v.environments);
            await audit(d, "save", {organizationId, resourceId: id, result: "success", details: {...verificationDetails(v, cfg), created: !existing, keyReplaced: !!input.apiKey}}, tx);
            if (flipsTlsOff) await recordAudit(tx, {organizationId, actorUserId: d.principal?.userId ?? null, action: "fork.arcane.tls_verification_disabled", resourceType: "arcane_connection", resourceId: id, result: "success", details: {endpoint: endpointIdentity(baseUrl)}, now: d.now?.()});
            const [row] = await tx.select(CONNECTION_PUBLIC_COLUMNS).from(forkArcaneConnection).where(eq(forkArcaneConnection.id, id));
            return toConnectionDto(row);
        });
        return {ok: true, connection, verification: v, warnings: [...v.warnings, ...(allowProjectsRead ? [TIER2_WARNING] : [])]};
    } catch (e) {
        if (conflict(e)) return refuse("invalid_input", "A connection with that name already exists.");
        throw e;
    }
}

export async function testConnection(d: ServiceDeps, raw: unknown): Promise<Outcome> {
    const parsed = TestInputSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Invalid connection id.");
    const authz = await authorize(d, "test", parsed.data.connectionId);
    if (!authz.ok) return authz;
    const {organizationId} = authz;
    const conn = await getConnectionDto(d.db, organizationId, parsed.data.connectionId);
    if (!conn) return refuse("not_found", "Connection not found.");
    const apiKey = await readConnectionApiKey(d.db, organizationId, conn.id, d.kekDir);
    const cfg = {baseUrl: conn.baseUrl, tlsInsecure: conn.tlsInsecure, allowProjectsRead: conn.allowProjectsRead};
    const v = await verifyConnection(d, {...cfg, apiKey});
    const updated = await d.db.transaction(async (tx0) => {
        const tx = tx0 as unknown as ForkDb;
        await tx.update(forkArcaneConnection).set({healthStatus: v.state, lastErrorClass: v.errorClass, lastCheckedAt: d.now?.() ?? new Date(), updatedAt: new Date(), ...(v.keyId ? {keyId: v.keyId} : {}), ...(v.version === ARCANE_PINNED_VERSION ? {pinnedApiVersion: v.version} : {})})
            .where(eq(forkArcaneConnection.id, conn.id));
        if (v.ok) await persistEnvironments(tx, conn.id, v.environments);
        await audit(d, "test", {organizationId, resourceId: conn.id, result: v.state === "healthy" ? "success" : "failure", details: verificationDetails(v, cfg)}, tx);
        const [row] = await tx.select(CONNECTION_PUBLIC_COLUMNS).from(forkArcaneConnection).where(eq(forkArcaneConnection.id, conn.id));
        return toConnectionDto(row);
    });
    return {ok: true, connection: updated, verification: v, warnings: v.warnings};
}

export async function rotateKey(d: ServiceDeps, raw: unknown): Promise<Outcome> {
    const parsed = RotateInputSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Check the key format.");
    const authz = await authorize(d, "rotate", parsed.data.connectionId);
    if (!authz.ok) return authz;
    const {organizationId} = authz;
    const conn = await getConnectionDto(d.db, organizationId, parsed.data.connectionId);
    if (!conn) return refuse("not_found", "Connection not found.");
    const cfg = {baseUrl: conn.baseUrl, tlsInsecure: conn.tlsInsecure, allowProjectsRead: conn.allowProjectsRead};
    const v = await verifyConnection(d, {...cfg, apiKey: parsed.data.apiKey});
    if (!v.ok) {
        await audit(d, "rotate", {organizationId, resourceId: conn.id, result: "failure", details: {...verificationDetails(v, cfg), refused: true}});
        return {...refusedByVerification(v), connection: conn};
    }
    const updated = await d.db.transaction(async (tx0) => {
        const tx = tx0 as unknown as ForkDb;
        await replaceConnectionApiKey(tx, organizationId, conn.id, parsed.data.apiKey, d.kekDir);
        await tx.update(forkArcaneConnection).set({healthStatus: v.state, lastErrorClass: v.errorClass, keyId: v.keyId, lastCheckedAt: d.now?.() ?? new Date(), updatedAt: new Date(), pinnedApiVersion: v.version})
            .where(eq(forkArcaneConnection.id, conn.id));
        await persistEnvironments(tx, conn.id, v.environments);
        await audit(d, "rotate", {organizationId, resourceId: conn.id, result: "success", details: {...verificationDetails(v, cfg), previousKeyId: conn.keyId}}, tx);
        const [row] = await tx.select(CONNECTION_PUBLIC_COLUMNS).from(forkArcaneConnection).where(eq(forkArcaneConnection.id, conn.id));
        return toConnectionDto(row);
    });
    return {ok: true, connection: updated, verification: v, warnings: v.warnings};
}

/** Deletes the connection row (the encrypted key goes with it). Stacks and recovery points stay: their FKs are SET NULL / untouched (D32, W04 lab test). */
export async function disconnect(d: ServiceDeps, raw: unknown): Promise<Outcome> {
    const parsed = DisconnectInputSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Invalid connection id.");
    const authz = await authorize(d, "disconnect", parsed.data.connectionId);
    if (!authz.ok) return authz;
    const {organizationId} = authz;
    const conn = await getConnectionDto(d.db, organizationId, parsed.data.connectionId);
    if (!conn) return refuse("not_found", "Connection not found.");
    await d.db.transaction(async (tx0) => {
        const tx = tx0 as unknown as ForkDb;
        const stacks = await tx.execute(sql`select count(*)::int as n from fork_stack s join fork_arcane_environment e on e.id = s.environment_id where e.connection_id = ${conn.id}`);
        await tx.delete(forkArcaneConnection).where(and(eq(forkArcaneConnection.id, conn.id), eq(forkArcaneConnection.organizationId, organizationId)));
        await audit(d, "disconnect", {organizationId, resourceId: conn.id, result: "success", details: {endpoint: endpointIdentity(conn.baseUrl), keptStacks: (stacks.rows[0] as {n: number}).n}}, tx);
    });
    return {ok: true, connection: null, verification: null, warnings: ["Stacks, backups and recovery points were kept; discovery stops until a connection is added again."]};
}
