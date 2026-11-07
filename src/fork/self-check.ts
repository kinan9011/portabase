import {sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {appDb} from "@/fork/db/handle";
import {withForkLock} from "@/fork/locks";
import {enqueueForkNotification} from "@/fork/notify";
import type {SelfCheckResult} from "@/fork/mode";

/**
 * D21 single-tenant self-check (ADR-011, REVISED-PLAN §4.1) + the real active-policy probe.
 *
 * C1 `org-count`           count(organization WHERE deleted_at IS NULL) = 1       (DETECTIVE: own-org creation can not be disabled — ADR-011 Facts)
 * C2 `signup-open`         AUTH_SIGNUP_ENABLED !== "true" (unset ⇒ upstream default "true" ⇒ fails)
 * C3 `agent-foreign-org`   no agent REFERENCED BY FORK ROWS is bound to another org — column AND organization_agents; org-less allowed
 * C4 `storage-foreign-org` same for storage channels referenced by fork rows
 * C5 `mcp-enabled`         advisory only (warning, never locks)
 * A DB error is fail-closed for configuration: `check-error` (the cause is never put in the result; callers log it).
 * Results carry stable codes only — never an org/agent/channel name, id or path (ADR-011 test 6).
 */
const HUMAN: Record<string, string> = {
    "org-count": "this instance does not have exactly one organization",
    "signup-open": "public sign-up is enabled (AUTH_SIGNUP_ENABLED must be false)",
    "agent-foreign-org": "an agent used by Stack Recovery belongs to another organization",
    "storage-foreign-org": "a storage channel used by Stack Recovery belongs to another organization",
    "check-error": "the single-tenant check could not be evaluated",
};

/** Banner/facet text for a `failed` code list. Codes only in, fixed strings out — no names. */
export function selfCheckHumanText(failed: string | undefined | null): string {
    const parts = (failed ?? "").split(",").map((c) => c.trim()).filter(Boolean).map((c) => HUMAN[c] ?? "a single-tenant check failed");
    return `Fork configuration locked: ${parts.length ? parts.join("; ") : "a single-tenant check failed"}`;
}

export type SelfCheckEnv = Record<string, string | undefined>;

const isTrue = (v: string | undefined) => v?.trim().toLowerCase() === "true";

/** Evaluates C1–C5 against `db`. Never throws. */
export async function evaluateSelfCheck(db: ForkDb, env: SelfCheckEnv = process.env): Promise<SelfCheckResult> {
    const failed: string[] = [];
    try {
        const orgs = await db.execute(sql`select id from organization where deleted_at is null limit 2`);
        if (orgs.rows.length !== 1) failed.push("org-count");

        if ((env.AUTH_SIGNUP_ENABLED?.trim() ?? "true") === "true") failed.push("signup-open");

        if (orgs.rows.length === 1) {
            const orgId = (orgs.rows[0] as {id: string}).id;
            const agents = await db.execute(sql`
                select 1 from agents a
                 where a.id in (select agent_id from fork_arcane_environment where agent_id is not null)
                   and (a.organization_id is distinct from null and a.organization_id <> ${orgId}
                        or exists (select 1 from organization_agents oa where oa.agent_id = a.id and oa.organization_id <> ${orgId}))
                 limit 1`);
            if (agents.rows.length) failed.push("agent-foreign-org");

            // Channels referenced by fork rows: RP artifacts (denormalised ids, no FK) and, since W10, the channels of a stack's policy
            // (`fork_stack_policy.storage_channel_ids`, copied ids).
            const storage = await db.execute(sql`
                select 1 from storage_channel c
                 where (c.id in (select channel_id from fork_recovery_point_artifact where channel_id is not null)
                        or c.id in (select unnest(storage_channel_ids) from fork_stack_policy))
                   and (c.organization_id is distinct from null and c.organization_id <> ${orgId}
                        or exists (select 1 from organization_storage_channels os where os.storage_channel_id = c.id and os.organization_id <> ${orgId}))
                 limit 1`);
            if (storage.rows.length) failed.push("storage-foreign-org");
        }
    } catch {
        return {ok: false, failed: "check-error"};
    }
    const warnings = isTrue(env.MCP_ENABLED) ? ["mcp-enabled"] : undefined;
    return failed.length ? {ok: false, failed: failed.join(","), warnings} : {ok: true, warnings};
}

/**
 * Real probe for `registerActivePolicyProbe`: activated stack policies. Guarded by `to_regclass` so a skipped/failed lane
 * (no fork tables) reads as 0 — flags-off parity must survive that. Any other error propagates (⇒ mode "locked", never "off").
 */
export async function countActivePolicies(db: ForkDb): Promise<number> {
    const t = await db.execute(sql`select to_regclass('public.fork_stack_policy') as t`);
    if (!(t.rows[0] as {t: string | null}).t) return 0;
    const r = await db.execute(sql`select count(*)::int as n from fork_stack_policy where activated_at is not null and deactivated_at is null`);
    return (r.rows[0] as {n: number}).n;
}

const STATE_KEY = "selfcheck.state";

/**
 * Transition handling: when the result differs from the persisted state, ONE audit event
 * (`fork.selfcheck.failed|recovered`, codes only) and ONE outbox notification per state change are written under a lock,
 * so concurrent evaluations (several requests, several processes) cannot duplicate them. Fork tables must exist.
 */
export async function recordSelfCheckTransition(db: ForkDb, result: SelfCheckResult): Promise<"unchanged" | "failed" | "recovered"> {
    const state = result.ok ? "ok" : `failed:${result.failed ?? "unknown"}`;
    return withForkLock(db, "portabase-fork-selfcheck", async (tx) => {
        const cur = await tx.execute(sql`select value from fork_meta where key = ${STATE_KEY}`);
        const prev = (cur.rows[0] as {value: string} | undefined)?.value;
        if (prev === state) return "unchanged" as const;
        await tx.execute(sql`insert into fork_meta (key, value, updated_at) values (${STATE_KEY}, ${state}, now())
                             on conflict (key) do update set value = excluded.value, updated_at = now()`);
        if (prev === undefined && result.ok) return "unchanged" as const; // first-ever evaluation is healthy: nothing to report
        const kind = result.ok ? "recovered" : "failed";
        const codes = result.ok ? [] : (result.failed ?? "").split(",");
        const {seq} = await recordAudit(tx, {action: `fork.selfcheck.${kind}`, result: result.ok ? "success" : "failure", details: {codes}});
        await enqueueForkNotification(tx, {kind: `fork.selfcheck.${kind}`, dedupeKey: `selfcheck:${seq}`, payload: {codes}});
        return kind;
    });
}

/** Wires the real probe + self-check into the mode machine (called from `initFork()` after the lane ran). */
export async function registerRealChecks(
    reg: {registerActivePolicyProbe: (fn: () => Promise<number>) => void; registerSelfCheck: (fn: () => Promise<SelfCheckResult>) => void},
    opts: {db?: ForkDb; env?: SelfCheckEnv; log?: {error: (o: object, m: string) => void}} = {},
): Promise<void> {
    const db = opts.db ?? (await appDb());
    reg.registerActivePolicyProbe(() => countActivePolicies(db));
    reg.registerSelfCheck(async () => {
        const result = await evaluateSelfCheck(db, opts.env);
        try {
            await recordSelfCheckTransition(db, result);
        } catch (error) {
            opts.log?.error({error: error instanceof Error ? error.name : "unknown"}, "self-check transition could not be recorded"); // never fail the check because bookkeeping failed
        }
        return result;
    });
}

/** Banner / facet text for the current mode (system-admin banner and every stack strip). null when nothing is locked. */
export function forkBannerText(m: {mode: string; lockReason?: string; detail?: string}): string | null {
    if (m.mode !== "locked") return null;
    if (m.lockReason === "self-check-failed") return selfCheckHumanText(m.detail);
    if (m.lockReason === "lane-failed") return "Fork configuration locked: the fork database migrations did not apply";
    return "Fork configuration locked: the Stack Recovery feature flags are off";
}
