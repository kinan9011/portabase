import {eq} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import {forkStack, forkStackPolicy} from "@/fork/db/schema/stack";
import {withForkLock} from "@/fork/locks";
import {assertEncryptionForActivation, authorizeMutation, loadStackContext, materializeStack, type Deferred, type GateReason, type MaterializeDeps} from "@/fork/materialize/apply";
import {planStack} from "@/fork/materialize/plan";
import {listAvailableChannels} from "@/fork/upstream";
import {nextRuns, toCron} from "@/fork/schedule/schedule";
import {checkChannelRule} from "./channels";
import {ActivateInputSchema} from "./input";
import {knownKeys, validateSelection, type SelectionIssue} from "./validate-selection";

/**
 * Activate a stack backup policy (W11, UX-04: the ONLY mutation of the configure form; nothing is persisted before it).
 *   strict input → principal → resource-scoped `stacks.backup.manage` (system admin; foreign/missing id ⇒ identical `not_found`) → D21 gate
 *   (`locked` while the self-check fails) → rate limit → D39 (encryption on) → §4.5 channel rule (≥ 1 off-host channel) → server-side
 *   re-validation of the selection (SEC-24, roots, keys) → `materializeStack` (W10: upstream-equivalent agent ACL = D31, agent version,
 *   channel availability, plan, ONE transaction) → ONE transaction under the same per-stack lock that writes schedule, retention,
 *   accepted exclusions and the D31 authorization record, flips `activated_at` and `protection_state`, and audits.
 * Honest partial outcomes: a materialize refusal activates NOTHING; a failure of the second step leaves materialized-but-NOT-active
 * sources (visible, scheduled never) and is reported as such. Passwords flow only into W10's encrypt-into-upstream-config path.
 */
export type ActivateReason =
    | GateReason | "encryption_required" | "no_channel_selected" | "local_only_channels" | "selection_invalid" | "activation_failed" | "no_inventory" | "stack_gone";
export type FieldError = {path: string; code: string};
export type ActivateResult =
    | {ok: true; planHash: string; created: number; updated: number; unchanged: number; orphaned: number; deferred: Deferred[]; skipped: {key: string; reason: string}[]; sources: {key: string; role: string; name: string; status: string}[]; noop: boolean; activatedAt: string; cron: string; nextRuns: string[]}
    | {ok: false; code: "forbidden" | "not_found" | "locked" | "rate_limited" | "invalid_input" | "refused"; reason?: ActivateReason; message: string; retryAfterSeconds?: number; services?: string[]; issues?: SelectionIssue[]; fieldErrors?: FieldError[]};

const refuse = (code: Extract<ActivateResult, {ok: false}>["code"], message: string, extra: Partial<Extract<ActivateResult, {ok: false}>> = {}): ActivateResult => ({ok: false, code, message, ...extra});

export async function activateStackPolicy(d: MaterializeDeps, raw: unknown): Promise<ActivateResult> {
    const parsed = ActivateInputSchema.safeParse(raw);
    if (!parsed.success) {
        // paths + codes only: never the offending value (it may be a secret)
        return refuse("invalid_input", "Check the values you entered.", {fieldErrors: parsed.error.issues.slice(0, 20).map((i) => ({path: i.path.join("."), code: i.code === "custom" ? i.message : i.code}))});
    }
    const input = parsed.data;
    const auth = await authorizeMutation(d, "fork.stack_policy.activate", input.stackId, "stack-policy");
    if (!("organizationId" in auth)) return auth as ActivateResult;
    const {organizationId} = auth;
    const p = d.principal!;
    const audit = (result: "success" | "denied" | "failure", details: Record<string, unknown>, db: MaterializeDeps["db"] = d.db) =>
        recordAudit(db, {organizationId, actorUserId: p.userId, action: "fork.stack_policy.activate", resourceType: "stack", resourceId: input.stackId, result, details, now: d.now?.()});
    const deny = async (reason: ActivateReason, message: string, extra: Partial<Extract<ActivateResult, {ok: false}>> = {}) => {
        await audit("denied", {reason, ...(extra.issues ? {issues: extra.issues.length} : {})});
        return refuse("refused", message, {reason, ...extra});
    };

    const ctx = await loadStackContext(d.db, input.stackId);
    if (!ctx) return refuse("not_found", "Stack not found.");
    if (ctx.runtimeState === "absent") return deny("stack_gone", "This stack is no longer on the host; nothing to protect.");
    if (!ctx.inventory) return deny("no_inventory", "No usable inventory for this stack yet; run a sync first.");

    // D39: encryption on before anything is activated.
    if (!(await assertEncryptionForActivation(d.db)).ok) return deny("encryption_required", "Encryption must be enabled in the instance settings before a backup policy can be activated.");

    // §4.5: channels must be available to the organization; at least one must be off-host.
    const available = await listAvailableChannels(d.db, organizationId);
    const byId = new Map(available.map((c) => [c.id, c]));
    if (input.storageChannelIds.some((id) => !byId.has(id))) return deny("channels_unavailable", "A selected storage channel is not available to this organization.");
    const rule = checkChannelRule([...new Set(input.storageChannelIds)].map((id) => ({id, provider: byId.get(id)!.provider})));
    if (!rule.ok) {
        return deny(rule.reason, rule.reason === "local_only_channels"
            ? "Local storage lives on the dashboard host and is lost with it; add an off-host channel."
            : "Select at least one storage channel.");
    }

    // SEC-24 / roots / keys: every thing the operator typed or picked must be honourable; the planner would otherwise skip it silently.
    const plan = planStack(ctx.inventory, input.selection, ctx.allowedRoots);
    const issues = validateSelection(ctx.inventory, input.selection, ctx.allowedRoots, plan);
    const known = knownKeys(ctx.inventory);
    for (const k of input.acceptedExclusions) if (!known.has(k)) issues.push({field: "accepted", key: k, code: "key_unknown"});
    if (issues.length) return deny("selection_invalid", "Some of the entered resources cannot be backed up as entered.", {issues});

    const m = await materializeStack(d, {stackId: input.stackId, selection: input.selection, storageChannelIds: input.storageChannelIds, secrets: input.secrets, confirmDockerAccess: input.confirmDockerAccess});
    if (!m.ok) return m as ActivateResult;

    const now = d.now?.() ?? new Date();
    const cron = toCron(input.schedule);
    try {
        await withForkLock(d.db, `materialize:${input.stackId}`, async (tx) => {
            const [cur] = await tx.select({activatedAt: forkStackPolicy.activatedAt, deactivatedAt: forkStackPolicy.deactivatedAt}).from(forkStackPolicy).where(eq(forkStackPolicy.stackId, input.stackId));
            const alreadyActive = !!cur?.activatedAt && !cur.deactivatedAt;
            const activation = {userId: p.userId, capability: "stacks.backup.manage", aclAgentId: ctx.agentId, organizationId, encryption: true, channelIds: [...new Set(input.storageChannelIds)], at: now.toISOString()};
            await tx.update(forkStackPolicy).set({
                schedule: input.schedule, policy: input.retention, acceptedExclusions: [...new Set(input.acceptedExclusions)], activation,
                activatedAt: alreadyActive ? cur!.activatedAt : now, activatedBy: p.userId, deactivatedAt: null, updatedAt: now,
                // W12 (F7): an authorized (re-)activation is the ONLY thing that clears a pause caused by run-time re-authorization
                pausedAt: null, pauseReason: null,
            }).where(eq(forkStackPolicy.stackId, input.stackId));
            await tx.update(forkStack).set({protectionState: "active", updatedAt: now}).where(eq(forkStack.id, input.stackId));
            // ids/hashes/counts only: no selection, no key, no secret (the audit redactor is a second line of defence)
            await audit("success", {planHash: m.planHash, schedulePreset: input.schedule.preset, timezone: input.schedule.timezone, retentionKeepLast: input.retention.keep_last, channels: activation.channelIds.length, accepted: input.acceptedExclusions.length, sourcesCreated: m.created, sourcesUpdated: m.updated, deferred: m.deferred.length, reactivation: alreadyActive}, tx);
        });
    } catch (e) {
        await audit("failure", {error: e instanceof Error ? e.name : "unknown", step: "activation"});
        return refuse("refused", "The backup sources were prepared, but the policy could not be activated. Nothing is scheduled; try again.", {reason: "activation_failed"});
    }
    return {
        ok: true, planHash: m.planHash, created: m.created, updated: m.updated, unchanged: m.unchanged, orphaned: m.orphaned, deferred: m.deferred, skipped: m.skipped, sources: m.sources, noop: m.noop,
        activatedAt: now.toISOString(), cron, nextRuns: nextRuns(input.schedule, now, 3).map((x) => x.toISOString()),
    };
}
