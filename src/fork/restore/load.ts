import {createHash} from "node:crypto";
import {and, eq, sql} from "drizzle-orm";
import type {ForkPrincipal} from "@/fork/acl";
import {canonicalJson} from "@/fork/canonical";
import type {ForkDb} from "@/fork/db/handle";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {forkRecoveryPoint, forkRecoveryPointArtifact} from "@/fork/db/schema/recovery";
import {forkStack, forkStackInventory, forkStackPolicy, forkStackSource} from "@/fork/db/schema/stack";
import {contentHash, parseInventoryStrict, type StackInventoryV1} from "@/fork/inventory/schema";
import {safeAbsPath} from "@/fork/inventory/labels";
import {SelectionSchema} from "@/fork/materialize/types";
import {RP_STATUSES} from "@/fork/recovery/status";
import denyRules from "@/fork/policy/compose-deny.json";
import {agentAclAllows, readAgent} from "@/fork/upstream/agents";
import {PlanInputV1, type MappingsV1} from "./schema";
import {PLAN_VERSION, PLANNER_RULESET, type RestoreMode, type RestorePurpose} from "./vocab";

/**
 * DB-only input loader of the restore planner (W16). Reads NON-SECRET columns only, never storage, never the network, never a key:
 * recovery point + artifact facts, the stack's pinned inventory, the non-secret subset of the stack policy selection (sqlite file paths,
 * manual source paths — NEVER the upstream `databases` row, which may hold a password), the target agent's enrolment, and the target
 * environments' last-known facts (latest inventory of each stack they hold). Arch / free disk / image platforms are unknowable on the
 * dashboard (D-W16-8): always `null`.
 */
export const TARGET_FACTS_MAX_AGE_HOURS = 24;
const RP_VERIFIED = RP_STATUSES[2];
/** Hash of the shared deny rule file (the informational findings of a plan are tied to this exact rule set). */
export const DENY_RULES_SHA256 = createHash("sha256").update(canonicalJson(denyRules)).digest("hex");

export type LoadRequest = {rpId: string; targetAgentId: string; purpose: RestorePurpose; mode: RestoreMode; mappings: MappingsV1};
export type LoadResult =
    | {ok: true; input: PlanInputV1; organizationId: string; stackId: string}
    | {ok: false; code: "not_found" | "rp_not_verified" | "rp_purged" | "invalid_input"};

function parseInv(raw: unknown): StackInventoryV1 | null {
    try { return parseInventoryStrict(raw); } catch { return null; }
}

export async function loadPlanInput(db: ForkDb, req: LoadRequest, o: {principal: ForkPrincipal | null; organizationId: string; now: Date; factsMaxAgeHours?: number; skipAgentAcl?: boolean; ignoreProject?: string}): Promise<LoadResult> {
    const [rp] = await db.select().from(forkRecoveryPoint).where(eq(forkRecoveryPoint.id, req.rpId));
    if (!rp) return {ok: false, code: "not_found"};
    const [stack] = await db.select().from(forkStack).where(eq(forkStack.id, rp.stackId));
    if (!stack || stack.organizationId !== o.organizationId) return {ok: false, code: "not_found"};
    if (rp.purgedAt !== null) return {ok: false, code: "rp_purged"};
    if (rp.status !== RP_VERIFIED) return {ok: false, code: "rp_not_verified"};

    // target agent: upstream ACL copy (D31); a foreign / deleted / unauthorised agent is indistinguishable from a missing one.
    // `skipAgentAcl` (freshness re-check only): the actor was authorised when the plan was created and the plan itself is authorised by its
    // own capability; the re-read must not depend on WHO asks, only on the agent still belonging to the organization.
    const agentRow = await readAgent(db, req.targetAgentId);
    if (!agentRow || agentRow.deleted) return {ok: false, code: "not_found"};
    const agentOk = o.skipAgentAcl ? !agentRow.foreignOrg && (agentRow.organizationId === null || agentRow.organizationId === o.organizationId) : agentAclAllows(o.principal, agentRow, o.organizationId);
    if (!agentOk) return {ok: false, code: "not_found"};

    // artifacts ⟕ sources (FK is SET NULL, D32: fall back to member_name == source_name inside the stack)
    const arts = await db.select().from(forkRecoveryPointArtifact).where(eq(forkRecoveryPointArtifact.rpId, rp.id));
    const sources = await db.select().from(forkStackSource).where(eq(forkStackSource.stackId, stack.id));
    const srcById = new Map(sources.map((s) => [s.id, s]));
    const srcByMember = new Map<string, typeof sources[number] | null>();
    for (const s of sources) srcByMember.set(s.memberName, srcByMember.has(s.memberName) ? null : s);
    const artifacts = arts.map((a) => {
        const s = (a.stackSourceId ? srcById.get(a.stackSourceId) : undefined) ?? srcByMember.get(a.sourceName) ?? null;
        return {
            id: a.id, source_name: a.sourceName, engine: a.engine, archive_kind: a.archiveKind, dump_format: a.dumpFormat, encrypted: a.encrypted,
            channel_id: a.channelId, channel_kind: a.channelKind, plaintext_sha256: a.plaintextSha256,
            plaintext_size: a.plaintextSize === null ? null : Number(a.plaintextSize), required: a.required, presence: a.presence,
            source: s ? {role: s.role, resource_key: s.resourceKey, dbms: s.dbms, member_name: s.memberName, covers_keys: s.coversKeys} : null,
        };
    });

    // pinned inventory of the RP
    let inventory: StackInventoryV1 | null = null;
    if (rp.inventoryVersion !== null) {
        const [row] = await db.select({inv: forkStackInventory.inventory}).from(forkStackInventory).where(and(eq(forkStackInventory.stackId, stack.id), eq(forkStackInventory.version, rp.inventoryVersion)));
        inventory = row ? parseInv(row.inv) : null;
    }

    // non-secret subset of the policy selection (the upstream `databases` row is never read)
    const [policy] = await db.select({selection: forkStackPolicy.selection}).from(forkStackPolicy).where(eq(forkStackPolicy.stackId, stack.id));
    const sel = SelectionSchema.safeParse(policy?.selection ?? {});
    const sqlite: Record<string, string> = {};
    const manual: string[] = [];
    if (sel.success) {
        for (const [svc, d] of Object.entries(sel.data.databases)) if (d.kind === "sqlite" && safeAbsPath(d.path)) sqlite[svc] = d.path;
        for (const m of sel.data.manual) if (safeAbsPath(m.path)) manual.push(m.path);
    }

    // target: enrolment, environments, last-known facts
    const [enr] = await db.select({enabled: forkAgentEnrollment.enabled, revokedAt: forkAgentEnrollment.revokedAt, capabilities: forkAgentEnrollment.capabilities}).from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentRow.id));
    const envs = await db.select().from(forkArcaneEnvironment).where(eq(forkArcaneEnvironment.agentId, agentRow.id));
    const maxAgeMs = (o.factsMaxAgeHours ?? TARGET_FACTS_MAX_AGE_HOURS) * 3_600_000;
    const envIds = envs.map((e) => e.id);
    const facts = {projects: new Set<string>(), volumes: new Set<string>(), networks: new Set<string>(), ports: new Map<string, {port: number; protocol: "tcp" | "udp"}>(), binds: new Set<string>(), hashes: new Set<string>()};
    if (envIds.length > 0) {
        const held = await db.execute(sql`
            select s.id as stack_id, s.compose_project, i.content_hash, i.inventory
              from fork_stack s
              left join lateral (select content_hash, inventory from fork_stack_inventory where stack_id = s.id order by version desc limit 1) i on true
             where s.environment_id in (${sql.join(envIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
        for (const r of held.rows as {stack_id: string; compose_project: string; content_hash: string | null; inventory: unknown}[]) {
            if (o.ignoreProject && r.compose_project === o.ignoreProject) continue; // W18a D-8: the project an ACTIVE run of this very plan created on the target is not a collision
            facts.projects.add(r.compose_project);
            const inv = r.inventory ? parseInv(r.inventory) : null;
            if (!inv) continue;
            facts.hashes.add(r.content_hash ?? contentHash(inv));
            const own = req.mode === "existing_stack" && (r.stack_id === stack.id || r.compose_project === stack.composeProject);
            for (const v of inv.volumes) facts.volumes.add(v.name);
            for (const m of inv.mounts) if (m.kind === "named_volume" && m.volume_name) facts.volumes.add(m.volume_name);
            if (own) continue; // the stack being replaced does not collide with itself (networks / ports / binds); its volumes are what gets replaced
            for (const n of inv.networks) facts.networks.add(n.name);
            for (const s of inv.services) for (const p of s.ports) if (p.published && p.published > 0) facts.ports.set(`${p.published}/${p.protocol}`, {port: p.published, protocol: p.protocol});
            for (const m of inv.mounts) { const hp = m.kind === "bind" ? safeAbsPath(m.host_path_hint) : null; if (hp) facts.binds.add(hp); }
        }
    }

    const parsed = PlanInputV1.safeParse({
        planner: {version: PLAN_VERSION, ruleset: PLANNER_RULESET, deny_rules_sha256: DENY_RULES_SHA256},
        purpose: req.purpose, mode: req.mode, mappings: req.mappings,
        rp: {
            id: rp.id, stack_id: rp.stackId, stack_name: rp.stackName, sequence: Number(rp.sequence), rp_status: rp.status, purged: rp.purgedAt !== null,
            manifest_sha256: rp.manifestSha256, manifest_sig_kid: rp.manifestSigKid, verified_at: rp.verifiedAt ? rp.verifiedAt.toISOString() : null,
            inventory_version: rp.inventoryVersion, inventory_hash: rp.inventoryHash, consistency_level: rp.consistencyLevel,
        },
        artifacts, inventory, inventory_content_hash: inventory ? contentHash(inventory) : null,
        stack: {id: stack.id, compose_project: stack.composeProject, environment_id: stack.environmentId, contains_personal_data: stack.containsPersonalData, test_restore_opt_in: stack.testRestoreOptInAt !== null},
        selection: {sqlite, manual_paths: manual},
        target: {
            agent_id: agentRow.id, agent_name: agentRow.name, archived: agentRow.archived,
            enrollment: enr ? {enabled: enr.enabled, revoked: enr.revokedAt !== null, capabilities: enr.capabilities} : null,
            environments: envs.map((e) => ({
                id: e.id, name: e.name, host_role: e.hostRole, allowed_path_roots: e.allowedPathRoots,
                facts_fresh: e.lastSyncStatus === "ok" && e.lastSyncAt !== null && o.now.getTime() - e.lastSyncAt.getTime() <= maxAgeMs,
            })),
            same_environment: stack.environmentId !== null && envIds.includes(stack.environmentId),
            facts: {
                projects: [...facts.projects], volumes: [...facts.volumes], networks: [...facts.networks], published_ports: [...facts.ports.values()], bind_paths: [...facts.binds],
                inventory_hashes: [...facts.hashes], arch: null, free_disk_bytes: null, image_platforms: null,
            },
        },
    });
    if (!parsed.success) return {ok: false, code: "invalid_input"};
    return {ok: true, input: parsed.data, organizationId: stack.organizationId, stackId: stack.id};
}
