import {createHash, randomUUID} from "node:crypto";
import {asc, gt, sql} from "drizzle-orm";
import {canonicalJson} from "@/fork/canonical";
import type {ForkDb} from "@/fork/db/handle";
import {forkAuditEvent} from "@/fork/db/schema/audit";
import {forkEnv} from "@/fork/env";
import {AUDIT_ACTOR_KINDS, AUDIT_RESULTS} from "@/fork/db/enums";
import {withForkLock} from "@/fork/locks";

/**
 * Fork audit (SEC-07). Exports exactly ONE writer (`recordAudit`) and no update/delete helper — the only deletion path
 * is the retention purge below. Details are always redacted before they touch the DB.
 *
 * Integrity: per-row SHA-256 hash chain written under an advisory lock + a DB trigger that rejects UPDATE/TRUNCATE and
 * DELETE outside the retention transaction. HONEST LIMIT: the chain detects edits, row removal and re-ordering
 * (`verifyAuditChain`); a superuser who rewrites every row can recompute it, and head truncation is visible only through
 * the `fork.audit.purged` event. External anchoring (signed head) is a W14 key-management follow-up.
 */
export const REDACTED = "[REDACTED]";
const GENESIS = "0".repeat(64);
const LOCK_KEY = "portabase-fork-audit";

// Normalised (lower-case, alphanumerics only) key fragments whose VALUE is never stored.
const DENY_FRAGMENTS = ["key", "token", "secret", "password", "passwd", "authorization", "credential", "cookie", "session", "privatekey"];
// Whole-value env containers (names are fine elsewhere as `env_keys`; values never).
const DENY_EXACT = new Set(["env", "environment", "envvalues", "envs", "dotenv", "envvars", "variables"]);
// Names that merely look sensitive.
const SAFE_EXACT = new Set(["envkeys", "keynames", "kid", "keyid", "keyfingerprint"]);

const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_STRING = 512;
export const MAX_DETAILS_BYTES = 8 * 1024;

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
export function isSensitiveKey(k: string): boolean {
    const n = normKey(k);
    if (SAFE_EXACT.has(n)) return false;
    return DENY_EXACT.has(n) || DENY_FRAGMENTS.some((f) => n.includes(f));
}

const VALUE_PATTERNS: [RegExp, string][] = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
    [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${REDACTED}@`], // URL userinfo
    [/([?&](?:api[-_]?key|token|access[-_]?token|secret|password|sig|signature)=)[^&\s]+/gi, `$1${REDACTED}`],
];

function scrubString(s: string): string {
    let out = s;
    for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep);
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
}

function redact(v: unknown, depth: number): unknown {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === "string") return scrubString(v);
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return {name: v.name}; // messages can carry secrets; the class is enough for audit
    if (depth >= MAX_DEPTH) return "[depth-limit]";
    if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => redact(x, depth + 1));
    if (typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_ITEMS)) out[k] = isSensitiveKey(k) ? REDACTED : redact(x, depth + 1);
        return out;
    }
    return "[unsupported]";
}

/** Denylist redaction (keys: key/token/secret/password/authorization/credential/cookie/session + env containers) + value scrubbing + caps. */
export function redactDetails(details: unknown): Record<string, unknown> {
    const r = redact(details ?? {}, 0);
    const obj = r !== null && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : {value: r};
    return Buffer.byteLength(JSON.stringify(obj), "utf8") > MAX_DETAILS_BYTES ? {truncated: true} : obj;
}

export type AuditInput = {
    organizationId?: string | null;
    actorUserId?: string | null;
    actorKind?: (typeof AUDIT_ACTOR_KINDS)[number];
    /** dotted lower-case code, e.g. `fork.host_role.set` */
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    result: (typeof AUDIT_RESULTS)[number];
    details?: unknown;
    now?: Date;
};

const ACTION_RE = /^[a-z][a-z0-9_.]{1,95}$/;

type HashFields = {
    seq: number; id: string; organizationId: string | null; actorUserId: string | null; actorKind: string; action: string;
    resourceType: string | null; resourceId: string | null; result: string; redactedDetails: unknown; createdAt: Date; prevHash: string;
};
export const hashAuditEvent = (e: HashFields) =>
    createHash("sha256")
        .update(canonicalJson({
            seq: e.seq, id: e.id, organizationId: e.organizationId, actorUserId: e.actorUserId, actorKind: e.actorKind, action: e.action,
            resourceType: e.resourceType, resourceId: e.resourceId, result: e.result, redactedDetails: e.redactedDetails,
            createdAt: e.createdAt.toISOString(), prevHash: e.prevHash,
        }))
        .digest("hex");

/** Appends one event. Throws on invalid input or DB failure — a mutation must not proceed without its audit trail. */
export async function recordAudit(db: ForkDb, input: AuditInput): Promise<{seq: number; eventHash: string}> {
    if (!ACTION_RE.test(input.action)) throw new Error("invalid audit action code");
    const trunc = (s?: string | null) => (s == null ? null : s.slice(0, 128));
    const createdAt = new Date((input.now ?? new Date()).getTime()); // ms precision survives the timestamptz round trip
    return withForkLock(db, LOCK_KEY, async (tx) => {
        const [last] = await tx.select({seq: forkAuditEvent.seq, eventHash: forkAuditEvent.eventHash}).from(forkAuditEvent).orderBy(sql`seq desc`).limit(1);
        const fields: HashFields = {
            seq: (last?.seq ?? 0) + 1,
            id: randomUUID(),
            organizationId: input.organizationId ?? null,
            actorUserId: trunc(input.actorUserId),
            actorKind: input.actorKind ?? (input.actorUserId ? "user" : "system"),
            action: input.action,
            resourceType: trunc(input.resourceType),
            resourceId: trunc(input.resourceId),
            result: input.result,
            redactedDetails: redactDetails(input.details),
            createdAt,
            prevHash: last?.eventHash ?? GENESIS,
        };
        const eventHash = hashAuditEvent(fields);
        await tx.insert(forkAuditEvent).values({
            seq: fields.seq, id: fields.id, organizationId: fields.organizationId, actorUserId: fields.actorUserId, actorKind: fields.actorKind,
            action: fields.action, resourceType: fields.resourceType, resourceId: fields.resourceId, result: fields.result,
            redactedDetails: fields.redactedDetails, prevHash: fields.prevHash, eventHash, createdAt,
        });
        return {seq: fields.seq, eventHash};
    });
}

export type ChainReport = {ok: boolean; checked: number; badSeq?: number; reason?: "hash-mismatch" | "link-broken" | "gap"};

/** Recomputes the chain from the oldest remaining row (its `prev_hash` is the retention anchor). */
export async function verifyAuditChain(db: ForkDb, batch = 500): Promise<ChainReport> {
    let checked = 0;
    let prev: {seq: number; eventHash: string} | null = null;
    let after = -1;
    for (;;) {
        const rows = await db.select().from(forkAuditEvent).where(gt(forkAuditEvent.seq, after)).orderBy(asc(forkAuditEvent.seq)).limit(batch);
        if (rows.length === 0) return {ok: true, checked};
        for (const r of rows) {
            if (prev) {
                if (r.seq !== prev.seq + 1) return {ok: false, checked, badSeq: r.seq, reason: "gap"};
                if (r.prevHash !== prev.eventHash) return {ok: false, checked, badSeq: r.seq, reason: "link-broken"};
            }
            if (hashAuditEvent({...r, createdAt: r.createdAt}) !== r.eventHash) return {ok: false, checked, badSeq: r.seq, reason: "hash-mismatch"};
            prev = {seq: r.seq, eventHash: r.eventHash};
            checked++;
            after = r.seq;
        }
    }
}

export const AUDIT_RETENTION_FLOOR_DAYS = 90;

/**
 * Retention (ADR-004 §7: ≥ 400 days by default, floor 90). Deletes only the oldest contiguous prefix, always keeps the
 * newest row as the chain anchor, and writes a `fork.audit.purged` event. Runs inside the one transaction that sets the
 * session flag the trigger looks for.
 */
export async function purgeAuditEvents(db: ForkDb, o: {now?: Date; retentionDays?: number} = {}): Promise<{purged: number}> {
    const days = Math.max(AUDIT_RETENTION_FLOOR_DAYS, o.retentionDays ?? forkEnv().FORK_AUDIT_RETENTION_DAYS);
    const cutoff = new Date((o.now ?? new Date()).getTime() - days * 86_400_000);
    return withForkLock(db, LOCK_KEY, async (tx) => {
        const keepRow = await tx.execute(sql`select coalesce((select min(seq) from fork_audit_event where created_at >= ${cutoff}), (select max(seq) from fork_audit_event)) as keep`);
        const keep = (keepRow.rows[0] as {keep: string | number | null}).keep;
        if (keep === null) return {purged: 0};
        await tx.execute(sql`select set_config('fork.audit_retention', 'on', true)`);
        const del = await tx.execute(sql`delete from fork_audit_event where seq < ${Number(keep)} returning seq`);
        await tx.execute(sql`select set_config('fork.audit_retention', 'off', true)`);
        const purged = del.rows.length;
        if (purged > 0) await recordAudit(tx, {action: "fork.audit.purged", result: "success", details: {purged, retentionDays: days, keptFromSeq: Number(keep)}, now: o.now});
        return {purged};
    });
}
