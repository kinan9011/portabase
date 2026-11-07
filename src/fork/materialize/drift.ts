import {eq, sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkStackPolicy, forkStackSource} from "@/fork/db/schema/stack";
import {withForkLock} from "@/fork/locks";
import {
    agentsLastContact, backupCount, createMemberSource, dockerAccessEvidence, membersWithStoragePolicy, nonSecretConfig, projectChannelIds, readEffectivePolicy,
    readMembers, removeMemberSource, revertEffectivePolicy,
} from "@/fork/upstream";
import {loadStackContext} from "./apply";
import {configHashOf, planStack} from "./plan";
import {isAdoptableVolumeName, SelectionSchema} from "./types";

/**
 * Drift + probe + poll-guard job (W10, D30). Runs on the RUNTIME plane (it keeps running in `locked` mode: a stack's member sources must
 * never carry a cron/retention of their own, whatever the configuration lock says; never silently unscheduled, ADR-010).
 *
 * Per stack with member sources, under the same advisory lock as apply/remove:
 *  1. EFFECTIVE policy (D30/D33): any cron on a member (`databases.backup_policy`) or on the stack Project (`projects.backup_policy`, resolution
 *     `db ?? project`), and any `retention_policies` row of a member or of the Project, is reverted to NULL. The change SEEN and the revert are
 *     audited separately. No upstream lock exists (P08 is not in v1).
 *  2. STRUCTURE: a member whose row was removed/moved/re-typed/re-configured (SEC-24 re-check included) or got its own storage policy, and a Project
 *     channel set that differs from the configured one, becomes a BLOCKER (`drifted`); never auto-fixed (re-apply repairs). It clears by itself when
 *     the live row matches again.
 *  3. INVENTORY: the plan of the latest inventory differs from the one applied ⇒ `inventory_changed` (new resources are uncovered ⇒ not complete);
 *     members the plan no longer wants ⇒ `orphaned` (never deleted).
 *  4. PROBES (P-2): `last_probe` from what the dashboard already receives (`databases.last_contact` is set only when the agent's ping succeeded);
 *     docker-volume CANARY promotion / rollback and promotion of `planned` docker-volume members once Docker access is evidenced.
 */
export const AGENT_FRESH_MS = 120_000;
export const MEMBER_STALE_MS = 180_000;
/** A canary that gets no agent contact within this window is rolled back: the agent poll is blocked (CH-22c). */
export const CANARY_TIMEOUT_MS = 180_000;

export type TickSummary = {stacks: number; reverted: number; drifted: number; cleared: number; probed: number; promoted: number; rolledBack: number; orphaned: number; inventoryChanged: number; failed: number};
const zero = (): TickSummary => ({stacks: 0, reverted: 0, drifted: 0, cleared: 0, probed: 0, promoted: 0, rolledBack: 0, orphaned: 0, inventoryChanged: 0, failed: 0});

export type DriftDeps = {db: ForkDb; now?: () => Date};

export async function materializeTick(d: DriftDeps): Promise<TickSummary> {
    const out = zero();
    const ids = await d.db.execute(sql`select distinct stack_id from fork_stack_source`);
    for (const r of ids.rows as {stack_id: string}[]) {
        out.stacks++;
        try {
            const s = await driftStack(d, r.stack_id);
            for (const k of Object.keys(s) as (keyof TickSummary)[]) out[k] += s[k];
        } catch {
            out.failed++; // never aborts the other stacks; the message is not logged (it could carry anything)
        }
    }
    return out;
}

export async function driftStack(d: DriftDeps, stackId: string): Promise<TickSummary> {
    const sum = zero();
    const now = d.now?.() ?? new Date();
    await withForkLock(d.db, `materialize:${stackId}`, async (tx) => {
        const ctx = await loadStackContext(tx, stackId);
        if (!ctx) return;
        const aud = (action: string, details: Record<string, unknown>, result: "success" | "failure" = "success") =>
            recordAudit(tx, {organizationId: ctx.organizationId, actorKind: "system", action, resourceType: "stack", resourceId: stackId, result, details, now});
        const links = await tx.select().from(forkStackSource).where(eq(forkStackSource.stackId, stackId));
        const [policy] = await tx.select().from(forkStackPolicy).where(eq(forkStackPolicy.stackId, stackId));
        const memberIds = links.flatMap((l) => (l.databaseId ? [l.databaseId] : []));

        // ---- 1. effective policy (D30/D33) ---------------------------------------------------------------------------------------
        const seen = await readEffectivePolicy(tx, {databaseIds: memberIds, projectId: ctx.projectId});
        if (seen.memberCrons.length || seen.projectCron !== null || seen.memberRetention.length || seen.projectRetention) {
            const summary = {memberCrons: seen.memberCrons.length, projectCron: seen.projectCron !== null, memberRetention: seen.memberRetention.length, projectRetention: seen.projectRetention !== null, crons: [...seen.memberCrons.map((c) => c.cron), ...(seen.projectCron ? [seen.projectCron] : [])].slice(0, 10)};
            await aud("fork.materialize.drift.seen", {kind: "effective_policy", ...summary});
            await revertEffectivePolicy(tx, {databaseIds: memberIds, projectId: ctx.projectId});
            await aud("fork.materialize.drift.reverted", {kind: "effective_policy", reverted_to: null, ...summary});
            sum.reverted++;
        }

        // ---- 2. structure -----------------------------------------------------------------------------------------------------------
        const rows = await readMembers(tx, memberIds);
        const withOwnPolicy = await membersWithStoragePolicy(tx, memberIds);
        for (const l of links) {
            if (!["active", "canary", "drifted"].includes(l.status)) continue;
            const row = l.databaseId ? rows.get(l.databaseId) : undefined;
            const cfg = row ? nonSecretConfig(row) : {};
            let reason: string | null = null;
            if (!row || row.deletedAt !== null) reason = "source_removed";
            else if (row.projectId !== ctx.projectId) reason = "source_moved";
            else if (row.agentId !== ctx.agentId) reason = "agent_changed";
            else if (row.dbms !== l.dbms) reason = "type_changed";
            else if (row.backupEngine !== l.engine) reason = "method_changed";
            else if (row.dbms === "docker-volume" && (!isAdoptableVolumeName(String(cfg.volume_name ?? "")) || "container_name" in cfg)) reason = "unsafe_volume"; // SEC-24 / D29 re-check
            else if (configHashOf(row.dbms, row.backupEngine, cfg) !== l.desiredHash) reason = "config_changed";
            else if (withOwnPolicy.has(row.id)) reason = "channel_changed";
            if (reason && (l.status !== "drifted" || l.driftReason !== reason)) {
                await tx.update(forkStackSource).set({status: "drifted", driftReason: reason, updatedAt: now}).where(eq(forkStackSource.id, l.id));
                await aud("fork.materialize.drift.source", {resourceKey: l.resourceKey, reason});
                sum.drifted++;
                l.status = "drifted";
            } else if (!reason && l.status === "drifted" && l.driftReason !== "not_in_plan") {
                await tx.update(forkStackSource).set({status: "active", driftReason: null, updatedAt: now}).where(eq(forkStackSource.id, l.id));
                await aud("fork.materialize.drift.cleared", {resourceKey: l.resourceKey});
                sum.cleared++;
                l.status = "active";
            }
        }
        let state = policy?.materializeState ?? "none";
        if (ctx.projectId && policy && ["ready", "blocked", "inventory_changed"].includes(state)) {
            const have = (await projectChannelIds(tx, ctx.projectId)).join(",");
            const want = [...policy.storageChannelIds].sort().join(",");
            if (have !== want && state !== "blocked") { state = "blocked"; await aud("fork.materialize.drift.channels", {kind: "project_channels"}); sum.drifted++; }
            else if (have === want && state === "blocked") state = "ready";
        }

        // ---- 3. inventory change / orphans ---------------------------------------------------------------------------------------
        let planKeys: Map<string, ReturnType<typeof planStack>["sources"][number]> | null = null;
        if (ctx.inventory && ctx.runtimeState !== "absent" && policy) {
            const sel = SelectionSchema.safeParse(policy.selection);
            if (sel.success) {
                const plan = planStack(ctx.inventory, sel.data, ctx.allowedRoots);
                planKeys = new Map(plan.sources.map((s) => [s.resourceKey, s]));
                if (state !== "blocked") {
                    if (plan.planHash !== policy.appliedPlanHash && state === "ready") { state = "inventory_changed"; await aud("fork.materialize.drift.inventory", {kind: "inventory_changed"}); sum.inventoryChanged++; }
                    else if (plan.planHash === policy.appliedPlanHash && state === "inventory_changed") state = "ready";
                }
                for (const l of links) {
                    if (planKeys.has(l.resourceKey) || l.status === "orphaned") continue;
                    await tx.update(forkStackSource).set({status: "orphaned", driftReason: "not_in_plan", updatedAt: now}).where(eq(forkStackSource.id, l.id));
                    await aud("fork.materialize.drift.orphaned", {resourceKey: l.resourceKey});
                    sum.orphaned++;
                    l.status = "orphaned";
                }
            }
        }
        if (policy && state !== policy.materializeState) await tx.update(forkStackPolicy).set({materializeState: state, updatedAt: now}).where(eq(forkStackPolicy.stackId, stackId));

        // ---- 4. probes, canary, planned docker-volume members ---------------------------------------------------------------------
        if (!ctx.agentId) return;
        const agent = (await agentsLastContact(tx, [ctx.agentId])).get(ctx.agentId);
        const lc = agent?.lastContact ?? null;
        const agentFresh = lc !== null && now.getTime() - lc.getTime() <= AGENT_FRESH_MS;
        let promoteQueued = false;
        for (const l of links) {
            if (!["active", "canary"].includes(l.status) || !l.databaseId) continue;
            const row = rows.get(l.databaseId);
            if (!row || row.deletedAt !== null) continue;
            const contactFresh = row.lastContact !== null && now.getTime() - row.lastContact.getTime() <= MEMBER_STALE_MS;
            if (l.status === "canary") {
                const started = l.lastProbeAt ?? l.createdAt;
                if (agentFresh && row.lastContact !== null && row.lastContact.getTime() > started.getTime()) {
                    await tx.update(forkStackSource).set({status: "active", lastProbe: "readable", lastProbeAt: now, updatedAt: now}).where(eq(forkStackSource.id, l.id));
                    await aud("fork.materialize.canary.confirmed", {resourceKey: l.resourceKey});
                    sum.promoted++; promoteQueued = true; l.status = "active";
                } else if (now.getTime() - started.getTime() > CANARY_TIMEOUT_MS && (lc === null || lc.getTime() < started.getTime())) {
                    // The agent stopped reporting right after this docker-volume source appeared: it blocks every backup on that agent (CH-22c). Roll back what WE created.
                    if ((await backupCount(tx, l.databaseId)) === 0) await removeMemberSource(tx, l.databaseId);
                    await tx.update(forkStackSource).set({status: "blocked", driftReason: "agent_poll_failing", databaseId: null, lastProbeAt: now, updatedAt: now}).where(eq(forkStackSource.id, l.id));
                    await aud("fork.materialize.canary.rolled_back", {resourceKey: l.resourceKey, reason: "agent_poll_failing"});
                    sum.rolledBack++;
                }
                continue;
            }
            if (row.dbms === "sqlite") continue; // sqlite ping is always true (ADR-001 §E): reachability is proven by a test backup, never by a probe
            if (!agentFresh) continue; // nothing is known while the agent is silent: the old probe expires on its own (loader TTL)
            const probe = contactFresh ? "readable" : now.getTime() - l.createdAt.getTime() > MEMBER_STALE_MS ? "unreadable" : null;
            if (probe) {
                await tx.update(forkStackSource).set({lastProbe: probe, lastProbeAt: now}).where(eq(forkStackSource.id, l.id));
                sum.probed++;
            }
        }
        // planned docker-volume members: created only once Docker access is evidenced (never on the operator's word alone, never blindly).
        const planned = links.filter((l) => l.status === "planned" && l.dbms === "docker-volume" && !l.databaseId);
        if (planned.length && ctx.projectId && planKeys && (promoteQueued || (await dockerAccessEvidence(tx, ctx.agentId)))) {
            for (const l of planned) {
                const s = planKeys.get(l.resourceKey);
                if (!s) continue;
                const created = await createMemberSource(tx, {agentId: ctx.agentId, projectId: ctx.projectId, name: s.memberName, dbms: s.dbms, engine: s.engine, config: s.config, secrets: {}});
                await tx.update(forkStackSource).set({status: "active", databaseId: created.id, lastProbe: null, lastProbeAt: null, updatedAt: now}).where(eq(forkStackSource.id, l.id));
                await aud("fork.materialize.promoted", {resourceKey: l.resourceKey});
                sum.promoted++;
            }
        }
    });
    return sum;
}
