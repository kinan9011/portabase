import {and, eq, lte, sql} from "drizzle-orm";
import {z} from "zod";
import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkRestoreOverride} from "@/fork/db/schema/restore-override";
import {forkRestorePlan} from "@/fork/db/schema/restore";
import {decryptForkSecret, encryptForkSecret, type ForkSecretAad} from "@/fork/kek";
import {withForkLock} from "@/fork/locks";
import {assertForkConfigAllowed} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkResource} from "@/fork/resource-scope";
import {loadFreshPlan, type RestoreDeps} from "@/fork/restore/service";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {workspaceOf} from "@/fork/restore-tasks/build";
import {checkRawCompose} from "@/fork/policy/raw";
import {buildOverridePayload, OverridesIdRequest, SetOverridesRequest, StoredOverrides, type OverrideField, type StoredOverridesV1} from "./override";
import {OVERRIDE_PURGE_REASONS, type OverridePurgeReason, type OverrideRefusal} from "./vocab";
import {RestoreOverridesView, type OverrideFailure} from "./view";

export {RestoreOverridesView, type OverrideFailure};

/**
 * Restore-time override services (W16b, D28): set / clear / view / purge. ONE pipeline like `restore/service.ts`: signed-in principal → mode gate →
 * resource-scoped `restore.plan` (SEC-12, no existence oracle) → rate limit → fresh untampered plan (`loadFreshPlan`) → work → audit. Plaintext exists
 * only in server memory here; storage is one KEK+AAD envelope (`values_enc`). NO function of this module returns a value, a value hash or YAML text —
 * only names, booleans and counts (DD7). Audit details: key names + plan hash + sizes, never a value or any hash of one (DD10). No network, no Arcane.
 */
export type OverrideDeps = RestoreDeps & {kekDir?: string};

export const OVERRIDE_RATE = {limit: 20, windowMs: 60_000} as const;
const nowOf = (d: Pick<OverrideDeps, "now">): Date => d.now?.() ?? new Date();
const allowed = async (d: OverrideDeps): Promise<boolean> => (d.configAllowed ? d.configAllowed() : assertForkConfigAllowed().then(() => true, () => false));
const iso = (t: Date) => t.toISOString();
const MAX_AUDIT_KEYS = 50;

const aadOf = (id: string): ForkSecretAad => ({table: "fork_restore_override", rowId: id, column: "values_enc"});
type OverrideRow = typeof forkRestoreOverride.$inferSelect;
type Pair = {service: string; key: string};
const pairId = (p: Pair) => `${p.service}\u0000${p.key}`;
const label = (p: Pair) => `${p.service === "" ? "-" : p.service}/${p.key}`;
const byPair = (a: Pair, b: Pair) => (a.service === b.service ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.service < b.service ? -1 : 1);

// ---- read model (names and states only) --------------------------------------------------------------------------------------------------



type Applicability = {ok: true} | {ok: false; reason: NonNullable<RestoreOverridesView["reason"]>};
/** DD9: only real restores of a ready plan that will run `compose_up` in a restore root take overrides (data-only test restores never do). */
export function applicability(plan: RestorePlanV1): Applicability {
    if (plan.purpose !== "restore") return {ok: false, reason: "purpose"};
    if (plan.outcome !== "ready") return {ok: false, reason: "outcome"};
    if (!plan.actions.some((a) => a.kind === "compose_up")) return {ok: false, reason: "no_compose_up"};
    if (!plan.target.restore_root) return {ok: false, reason: "no_restore_root"};
    return {ok: true};
}

/** Distinct `(service, key)` pairs of `plan.secrets` (DD8): `origin` = env_file when any entry has it, `class` = require_input when any entry has it. */
function planPairs(plan: RestorePlanV1): (Pair & {origin: "service_env" | "env_file"; class: "restore" | "require_input"})[] {
    const m = new Map<string, Pair & {origin: "service_env" | "env_file"; class: "restore" | "require_input"}>();
    for (const s of plan.secrets) {
        const id = pairId(s);
        const cur = m.get(id);
        if (!cur) m.set(id, {service: s.service, key: s.key, origin: s.origin, class: s.class === "require_input" ? "require_input" : "restore"});
        else m.set(id, {...cur, origin: cur.origin === "env_file" || s.origin === "env_file" ? "env_file" : "service_env", class: cur.class === "require_input" || s.class === "require_input" ? "require_input" : "restore"});
    }
    return [...m.values()].sort(byPair);
}

const namesOf = (row: OverrideRow | undefined): Pair[] => {
    const r = z.array(z.strictObject({service: z.string(), key: z.string()})).safeParse(row?.envKeys);
    return r.success ? r.data : [];
};

export function buildOverridesView(plan: RestorePlanV1, row: OverrideRow | undefined): RestoreOverridesView {
    const app = applicability(plan);
    const set = new Set(namesOf(row).map(pairId));
    const fields = planPairs(plan).map((p) => ({service: p.service, key: p.key, origin: p.origin, class: p.class, isSet: set.has(pairId(p))}));
    return RestoreOverridesView.parse({
        applicable: app.ok, reason: app.ok ? null : app.reason, frozen: !!row?.frozenAt, revision: row?.revision ?? 0,
        fields, yml: {present: !!row?.ymlPresent, bytes: row?.ymlBytes ?? 0},
        missingRequired: fields.filter((f) => f.class === "require_input" && !f.isSet).length,
    });
}

// ---- the only decryptor (together with resolve.ts) -----------------------------------------------------------------------------------------

/** Decrypt + validate a stored set. A copied / tampered / re-keyed envelope fails closed (`null`): never partial content. */
export async function decryptStored(row: Pick<OverrideRow, "id" | "valuesEnc">, kekDir?: string): Promise<StoredOverridesV1 | null> {
    try {
        const parsed = StoredOverrides.safeParse(JSON.parse(await decryptForkSecret(row.valuesEnc, aadOf(row.id), kekDir)));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

// ---- pipeline ----------------------------------------------------------------------------------------------------------------------------

type Audit = (result: "success" | "denied" | "failure", details: Record<string, unknown>, orgId?: string | null) => Promise<unknown>;
const auditor = (d: OverrideDeps, action: string, resourceId: string | null): Audit => (result, details, orgId = null) =>
    recordAudit(d.db, {organizationId: orgId, actorUserId: d.principal?.userId ?? null, action, resourceType: "restore_plan", resourceId, result, details, now: nowOf(d)});

type Gated = {ok: true; organizationId: string; planId: string; planHash: string; row: typeof forkRestorePlan.$inferSelect; plan: RestorePlanV1; now: Date} | OverrideFailure;

async function gated(d: OverrideDeps, raw: unknown, schema: z.ZodType<{planId: string; planHash: string}>, action: string, opts: {rate: boolean}): Promise<Gated> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden"};
    const input = schema.safeParse(raw);
    const audit = auditor(d, action, input.success ? input.data.planId : null);
    if (!input.success) { await audit("denied", {reason: "invalid_input"}); return {ok: false, code: "invalid_input"}; }
    const {planId, planHash} = input.data;
    if (!(await allowed(d))) { await audit("denied", {reason: "locked", plan_hash: planHash}); return {ok: false, code: "locked"}; }
    let organizationId: string;
    try { organizationId = (await assertForkResource(d.db, p, "restore.plan", {kind: "restore_plan", id: planId})).organizationId; } catch (e) {
        if (e instanceof ForkNotFoundError) { await audit("denied", {reason: "not_found"}); return {ok: false, code: "not_found"}; }
        if (e instanceof ForkForbiddenError) { await audit("denied", {reason: "forbidden"}); return {ok: false, code: "forbidden"}; }
        throw e;
    }
    const now = nowOf(d);
    if (opts.rate) {
        const rl = (d.rate ?? checkRate)(`${p.userId}:restore-override`, OVERRIDE_RATE.limit, OVERRIDE_RATE.windowMs, now.getTime());
        if (!rl.ok) { await audit("denied", {reason: "rate_limited", plan_hash: planHash}, organizationId); return {ok: false, code: "rate_limited", retryAfterSeconds: rl.retryAfterSeconds}; }
    }
    await purgeExpiredOverrides(d.db, now); // lazy expiry purge (DD5)
    const loaded = await loadFreshPlan(d, planId, planHash);
    if (!loaded.ok) { await audit("denied", {reason: loaded.code, plan_hash: planHash}, organizationId); return {ok: false, code: loaded.code as OverrideRefusal}; }
    return {ok: true, organizationId, planId, planHash: loaded.row.planHash, row: loaded.row, plan: loaded.plan, now};
}

const deny = async (d: OverrideDeps, action: string, g: Extract<Gated, {ok: true}>, code: OverrideRefusal, extra: Record<string, unknown> = {}): Promise<OverrideFailure> => {
    await auditor(d, action, g.planId)("denied", {reason: code, plan_hash: g.planHash, ...extra}, g.organizationId);
    return {ok: false, code};
};

const auditKeys = (names: Pair[]) => ({env_keys: names.slice(0, MAX_AUDIT_KEYS).map(label), env_count: names.length});

// ---- set ---------------------------------------------------------------------------------------------------------------------------------

class Refused extends Error { constructor(readonly failure: OverrideFailure, readonly detail: Record<string, unknown> = {}) { super("refused"); } }

export async function setRestoreOverrides(d: OverrideDeps, raw: unknown): Promise<{ok: true; view: RestoreOverridesView} | OverrideFailure> {
    const parsed = SetOverridesRequest.safeParse(raw);
    const ids = raw && typeof raw === "object" ? {planId: (raw as Record<string, unknown>).planId, planHash: (raw as Record<string, unknown>).planHash} : null;
    const g = await gated(d, ids, OverridesIdRequest, "fork.restore_override.denied", {rate: true});
    if (!g.ok) return g;
    if (!parsed.success) return deny(d, "fork.restore_override.denied", g, "invalid_input");
    const req = parsed.data;
    const app = applicability(g.plan);
    if (!app.ok) return deny(d, "fork.restore_override.denied", g, "overrides_not_applicable", {applicability: app.reason});
    const known = new Set(planPairs(g.plan).map(pairId));
    if ([...req.set, ...req.unset].some((f) => !known.has(pairId(f)))) return deny(d, "fork.restore_override.denied", g, "unknown_key");

    try {
        return await withForkLock(d.db, `restore-plan:${g.planId}`, async (tx) => {
            const [cur] = await tx.select().from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, g.planId)).for("update");
            if (cur?.frozenAt) throw new Refused({ok: false, code: "overrides_frozen"});
            let stored: StoredOverridesV1 = {v: 1, env: [], yml: null};
            if (cur) {
                const s = await decryptStored(cur, d.kekDir);
                if (!s) throw new Refused({ok: false, code: "overrides_unreadable"});
                stored = s;
            }
            const gone = new Set(req.unset.map(pairId));
            const merged = new Map<string, OverrideField>(stored.env.filter((f) => !gone.has(pairId(f))).map((f) => [pairId(f), f]));
            for (const f of req.set) merged.set(pairId(f), {service: f.service, key: f.key, value: f.value});
            const next: StoredOverridesV1 = {v: 1, env: [...merged.values()].sort(byPair), yml: req.overrideYml === undefined ? stored.yml : req.overrideYml === "" ? null : req.overrideYml};
            const built = buildOverridePayload(next);
            if (!built.ok) throw new Refused({ok: false, code: built.code});
            if (built.overrideYml !== null) {
                const ws = workspaceOf(g.plan);
                const file = `${ws}/.portabase/secret/override.yml`;
                const raw = checkRawCompose({root: ws, entry: [file], files: [{path: file, text: built.overrideYml}]});
                if (raw.refused) throw new Refused({ok: false, code: "override_raw_refused", violations: raw.violations.map((v) => ({kind: v.kind, service: v.service}))}, {violation_kinds: [...new Set(raw.violations.map((v) => v.kind))]});
            }
            const cleared = (await tx.update(forkRestorePlan).set({approvals: []}).where(and(eq(forkRestorePlan.id, g.planId), sql`jsonb_array_length(${forkRestorePlan.approvals}) > 0`)).returning({id: forkRestorePlan.id})).length;
            const names = next.env.map(({service, key}) => ({service, key}));
            const empty = next.env.length === 0 && next.yml === null;
            let revision = 0;
            if (empty) {
                if (cur) await tx.delete(forkRestoreOverride).where(eq(forkRestoreOverride.id, cur.id));
            } else {
                const id = cur?.id ?? crypto.randomUUID();
                const valuesEnc = await encryptForkSecret(JSON.stringify(next), aadOf(id), d.kekDir);
                revision = (cur?.revision ?? 0) + 1;
                const common = {
                    planHash: g.planHash, revision, envKeys: names, ymlPresent: next.yml !== null, ymlBytes: next.yml === null ? 0 : Buffer.byteLength(next.yml, "utf8"),
                    valuesEnc, renderTaskId: null, updatedBy: d.principal!.userId, updatedAt: g.now,
                };
                if (cur) await tx.update(forkRestoreOverride).set(common).where(eq(forkRestoreOverride.id, id));
                else await tx.insert(forkRestoreOverride).values({id, organizationId: g.organizationId, planId: g.planId, ...common, createdAt: g.now, expiresAt: g.row.expiresAt});
            }
            await recordAudit(tx, {
                organizationId: g.organizationId, actorUserId: d.principal!.userId, action: "fork.restore_override.set", resourceType: "restore_plan", resourceId: g.planId, result: "success", now: g.now,
                details: {plan_hash: g.planHash, revision, ...auditKeys(names), yml_present: next.yml !== null, yml_bytes: next.yml === null ? 0 : Buffer.byteLength(next.yml, "utf8"), approvals_cleared: cleared},
            });
            const [after] = await tx.select().from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, g.planId));
            return {ok: true as const, view: buildOverridesView(g.plan, after)};
        });
    } catch (e) {
        if (e instanceof Refused) return deny(d, "fork.restore_override.denied", g, e.failure.code, e.detail).then((r) => (e.failure.violations ? {...r, violations: e.failure.violations} : r));
        throw e;
    }
}

// ---- clear -------------------------------------------------------------------------------------------------------------------------------

export async function clearRestoreOverrides(d: OverrideDeps, raw: unknown): Promise<{ok: true; view: RestoreOverridesView} | OverrideFailure> {
    const g = await gated(d, raw, OverridesIdRequest, "fork.restore_override.denied", {rate: true});
    if (!g.ok) return g;
    try {
        return await withForkLock(d.db, `restore-plan:${g.planId}`, async (tx) => {
            const [cur] = await tx.select().from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, g.planId)).for("update");
            if (cur?.frozenAt) throw new Refused({ok: false, code: "overrides_frozen"});
            let cleared = 0;
            if (cur) {
                await tx.delete(forkRestoreOverride).where(eq(forkRestoreOverride.id, cur.id));
                cleared = (await tx.update(forkRestorePlan).set({approvals: []}).where(and(eq(forkRestorePlan.id, g.planId), sql`jsonb_array_length(${forkRestorePlan.approvals}) > 0`)).returning({id: forkRestorePlan.id})).length;
                await recordAudit(tx, {
                    organizationId: g.organizationId, actorUserId: d.principal!.userId, action: "fork.restore_override.clear", resourceType: "restore_plan", resourceId: g.planId, result: "success", now: g.now,
                    details: {plan_hash: g.planHash, revision: cur.revision, ...auditKeys(namesOf(cur)), yml_present: cur.ymlPresent, yml_bytes: cur.ymlBytes, approvals_cleared: cleared},
                });
            }
            return {ok: true as const, view: buildOverridesView(g.plan, undefined)};
        });
    } catch (e) {
        if (e instanceof Refused) return deny(d, "fork.restore_override.denied", g, e.failure.code);
        throw e;
    }
}

// ---- view --------------------------------------------------------------------------------------------------------------------------------

export async function getRestoreOverridesView(d: OverrideDeps, raw: unknown): Promise<{ok: true; view: RestoreOverridesView} | OverrideFailure> {
    const g = await gated(d, raw, OverridesIdRequest, "fork.restore_override.denied", {rate: true});
    if (!g.ok) return g;
    const [row] = await d.db.select().from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, g.planId));
    return {ok: true, view: buildOverridesView(g.plan, row)};
}

// ---- purge -------------------------------------------------------------------------------------------------------------------------------

/** Delete the stored set of one plan (cleanup / terminal state) and audit it. Idempotent; the actor of a job is `null`. */
export async function purgeRestoreOverrides(db: ForkDb, planId: string, reason: OverridePurgeReason, now: Date, actorUserId: string | null = null): Promise<{purged: number}> {
    if (!OVERRIDE_PURGE_REASONS.includes(reason)) throw new TypeError("purgeRestoreOverrides: reason");
    return deleteRows(db, eq(forkRestoreOverride.planId, planId), reason, now, actorUserId);
}

/** Rows whose plan expiry has passed (the plan can no longer enqueue anyway). */
export async function purgeExpiredOverrides(db: ForkDb, now: Date): Promise<{purged: number}> {
    return deleteRows(db, lte(forkRestoreOverride.expiresAt, now), "expired", now, null);
}

async function deleteRows(db: ForkDb, where: ReturnType<typeof eq>, reason: OverridePurgeReason, now: Date, actorUserId: string | null): Promise<{purged: number}> {
    const rows = await db.delete(forkRestoreOverride).where(where).returning({id: forkRestoreOverride.id, organizationId: forkRestoreOverride.organizationId, planId: forkRestoreOverride.planId, planHash: forkRestoreOverride.planHash, revision: forkRestoreOverride.revision, envKeys: forkRestoreOverride.envKeys});
    for (const r of rows) {
        const names = z.array(z.strictObject({service: z.string(), key: z.string()})).safeParse(r.envKeys);
        await recordAudit(db, {organizationId: r.organizationId, actorUserId, action: "fork.restore_override.purge", resourceType: "restore_plan", resourceId: r.planId, result: "success", now,
            details: {plan_hash: r.planHash, revision: r.revision, reason, ...(names.success ? auditKeys(names.data) : {})}});
    }
    return {purged: rows.length};
}
