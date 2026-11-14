import {z} from "zod";
import {HOST_ROLES} from "@/fork/db/enums";
import {ENV_KEY, PROJECT_NAME, SERVICE_NAME} from "@/fork/inventory/labels";
import {StackInventoryV1} from "@/fork/inventory/schema";
import {SOURCE_ROLES} from "@/fork/materialize/vocab";
import {ARTIFACT_PRESENCE, RP_STATUSES} from "@/fork/recovery/status";
import {
    ACTION_KINDS, ACTION_OPS, APPROVAL_KINDS, CHECKERS, DENY_RULE_IDS, PHASES, PLAN_HOST_ROLES, PLAN_OUTCOMES, PLAN_VERSION, PLANNER_RULESET, PRECONDITION_STATES,
    PRECONDITIONS, REASONS, RESTORE_MODES, RESTORE_PURPOSES, RESTORE_TASK_PURPOSES, RISKS, SECRET_CLASSES,
} from "./vocab";

/**
 * Strict schemas of the restore planner (W16, ADR-014). Rules:
 *  - every object is `strictObject` (unknown keys are rejected at every level);
 *  - every optional field is `nullable`, never `optional` / absent, so `canonicalJson` ↔ jsonb round-trips byte-identically (the plan hash is
 *    computed over the canonical JSON of the plan and re-computed after reading the jsonb back);
 *  - NO field can hold a secret value: key NAMES only, hashes, ids, counts, paths that are hints from the (scrubbed) inventory.
 * Pure module: no DB, no env, no clock.
 */
export const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const kid12 = z.string().regex(/^[0-9a-f]{12}$/);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const uuid = z.uuid();
const int = z.number().int().min(0);
const absPath = z.string().min(1).max(1024);

// ---- request side -----------------------------------------------------------------------------------------------------------------

/** Non-secret request mappings. Validated by the rules (reasons), not by zod, beyond shape and bounds. */
export const MappingsV1 = z.strictObject({
    target_project: z.string().regex(PROJECT_NAME).nullable(),
    restore_root: z.string().max(1024).nullable(),
    volumes: z.record(z.string().max(255), z.string().max(255)).refine((r) => Object.keys(r).length <= 500, "too many volume mappings").nullable(),
    select: z.array(z.string().max(1200)).max(2000).nullable(),
    sqlite: z.record(z.string().regex(SERVICE_NAME), z.strictObject({volume: z.string().max(255), relative_path: z.string().max(1024)})).refine((r) => Object.keys(r).length <= 100, "too many sqlite mappings").nullable(),
});
export type MappingsV1 = z.infer<typeof MappingsV1>;

export const EMPTY_MAPPINGS: MappingsV1 = {target_project: null, restore_root: null, volumes: null, select: null, sqlite: null};

export const CreatePlanRequest = z.strictObject({rpId: uuid, targetAgentId: uuid, purpose: z.enum(RESTORE_TASK_PURPOSES), mode: z.enum(RESTORE_MODES), mappings: MappingsV1});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequest>;
export const ApproveRequest = z.strictObject({planId: uuid, planHash: hex64, kind: z.enum(APPROVAL_KINDS)});
export const PlanIdRequest = z.strictObject({planId: uuid});
export const PrivacyRequest = z.strictObject({stackId: uuid, containsPersonalData: z.boolean().nullable(), testRestoreOptIn: z.boolean()});

// ---- planner input ----------------------------------------------------------------------------------------------------------------

const InputArtifact = z.strictObject({
    id: uuid,
    source_name: z.string().min(1).max(256),
    engine: z.string().min(1).max(64),
    archive_kind: z.enum(["restic_snapshot", "archive_enc", "archive_plain"]),
    dump_format: z.enum(["pg_custom", "pg_directory"]).nullable(),
    encrypted: z.boolean(),
    channel_id: uuid.nullable(),
    channel_kind: z.string().max(64).nullable(),
    plaintext_sha256: hex64.nullable(),
    plaintext_size: int.nullable(),
    required: z.boolean(),
    presence: z.enum(ARTIFACT_PRESENCE),
    source: z.strictObject({
        role: z.enum(SOURCE_ROLES),
        resource_key: z.string().min(1).max(1200),
        dbms: z.string().min(1).max(64),
        member_name: z.string().min(1).max(256),
        covers_keys: z.array(z.string().max(1200)).max(2000),
    }).nullable(),
});

const Port = z.strictObject({port: int.max(65535), protocol: z.enum(["tcp", "udp"])});

export const PlanInputV1 = z.strictObject({
    planner: z.strictObject({version: z.literal(PLAN_VERSION), ruleset: z.literal(PLANNER_RULESET), deny_rules_sha256: hex64}),
    purpose: z.enum(RESTORE_PURPOSES),
    mode: z.enum(RESTORE_MODES),
    mappings: MappingsV1,
    rp: z.strictObject({
        id: uuid, stack_id: uuid, stack_name: z.string().min(1).max(256), sequence: int,
        rp_status: z.enum(RP_STATUSES), purged: z.boolean(),
        manifest_sha256: hex64.nullable(), manifest_sig_kid: kid12.nullable(), verified_at: iso.nullable(),
        inventory_version: int.nullable(), inventory_hash: z.string().max(128).nullable(), consistency_level: z.string().max(64),
    }),
    artifacts: z.array(InputArtifact).max(2000),
    inventory: StackInventoryV1.nullable(),
    /** `contentHash(inventory)` computed by the loader (null when there is no inventory). */
    inventory_content_hash: hex64.nullable(),
    stack: z.strictObject({id: uuid, compose_project: z.string().regex(PROJECT_NAME), environment_id: uuid.nullable(), contains_personal_data: z.boolean().nullable(), test_restore_opt_in: z.boolean(), mirror_opt_in: z.boolean()}),
    /** Non-secret subset of `fork_stack_policy.selection`: sqlite file paths (agent-side absolute) and manual source paths. */
    selection: z.strictObject({sqlite: z.record(z.string().regex(SERVICE_NAME), absPath), manual_paths: z.array(absPath).max(50)}),
    target: z.strictObject({
        agent_id: uuid, agent_name: z.string().min(1).max(256), archived: z.boolean(),
        /** purpose `mirror` only (W22a): `assertRunnerTarget` ok (designated runner + enrolment + runner.v1, no environment, no DB). Always false otherwise. */
        runner_eligible: z.boolean(),
        enrollment: z.strictObject({enabled: z.boolean(), revoked: z.boolean(), capabilities: z.array(z.string().max(64)).max(32)}).nullable(),
        environments: z.array(z.strictObject({id: uuid, name: z.string().max(256), host_role: z.enum(HOST_ROLES), allowed_path_roots: z.array(absPath).max(64), facts_fresh: z.boolean()})).max(64),
        same_environment: z.boolean(),
        facts: z.strictObject({
            projects: z.array(z.string().max(128)).max(5000),
            volumes: z.array(z.string().max(256)).max(20000),
            networks: z.array(z.string().max(128)).max(5000),
            published_ports: z.array(Port).max(5000),
            bind_paths: z.array(absPath).max(20000),
            inventory_hashes: z.array(hex64).max(5000),
            /** Unknowable on the dashboard today (D-W16-8): the loader always sets these `null`; a later agent probe fills them without a schema change. */
            arch: z.string().max(32).nullable(),
            free_disk_bytes: int.nullable(),
            image_platforms: z.record(z.string().max(512), z.array(z.string().max(32)).max(16)).nullable(),
        }),
    }),
});
export type PlanInputV1 = z.infer<typeof PlanInputV1>;

// ---- plan -------------------------------------------------------------------------------------------------------------------------

export const Action = z.strictObject({
    id: z.string().regex(/^a[0-9a-f]{12}$/),
    order: int,
    phase: z.enum(PHASES),
    kind: z.enum(ACTION_KINDS),
    op: z.enum(ACTION_OPS),
    risk: z.enum(RISKS),
    destructive: z.boolean(),
    resource_key: z.string().max(1200).nullable(),
    artifact_ids: z.array(uuid).max(16),
    expect: z.strictObject({plaintext_sha256: hex64.nullable(), plaintext_size: int.nullable()}),
    source: z.strictObject({role: z.enum(SOURCE_ROLES).nullable(), dbms: z.string().max(64).nullable(), member: z.string().max(256).nullable(), original_path: z.string().max(1024).nullable(), service: z.string().max(128).nullable()}),
    destination: z.strictObject({kind: z.enum(["volume", "path", "db_service", "stage", "network", "project"]), name: z.string().max(255).nullable(), path: z.string().max(1024).nullable(), relative_path: z.string().max(1024).nullable()}),
    reasons: z.array(z.enum(REASONS)).max(16),
});
export type Action = z.infer<typeof Action>;

/** Plan v2 (W22a): the type names keep their `V1` suffix to avoid churn; the version is `PLAN_VERSION`. */
export const RestorePlanV1 = z.strictObject({
    plan_version: z.literal(PLAN_VERSION),
    ruleset: z.literal(PLANNER_RULESET),
    deny_rules_sha256: hex64,
    inputs_digest: hex64,
    purpose: z.enum(RESTORE_PURPOSES),
    mode: z.enum(RESTORE_MODES),
    rp: z.strictObject({id: uuid, stack_id: uuid, stack_name: z.string().max(256), sequence: int, manifest_sha256: hex64.nullable(), manifest_sig_kid: kid12.nullable(), verified_at: iso.nullable(), inventory_hash: z.string().max(128).nullable(), consistency_level: z.string().max(64)}),
    source: z.strictObject({compose_project: z.string().max(128), environment_id: uuid.nullable()}),
    target: z.strictObject({
        agent_id: uuid, agent_name: z.string().max(256), environment_ids: z.array(uuid).max(64),
        host_role: z.enum(PLAN_HOST_ROLES), host_role_source: z.enum(["environment", "default"]),
        same_environment: z.boolean(), project: z.string().regex(PROJECT_NAME), restore_root: z.string().max(1024).nullable(),
    }),
    actions: z.array(Action).max(2000),
    preconditions: z.array(z.strictObject({code: z.enum(PRECONDITIONS), state: z.enum(PRECONDITION_STATES), checked_by: z.enum(CHECKERS), reason: z.enum(REASONS).nullable()})).max(64),
    secrets: z.array(z.strictObject({service: z.string().max(128), key: z.string().regex(ENV_KEY), origin: z.enum(["service_env", "env_file"]), class: z.enum(SECRET_CLASSES), flagged: z.boolean(), reason: z.enum(REASONS).nullable()})).max(5000),
    decisions: z.array(z.strictObject({code: z.enum(REASONS), subject: z.string().max(1200), suggestion: z.string().max(1200).nullable(), flagged: z.boolean()})).max(2000),
    compose_findings: z.array(z.strictObject({rule_id: z.enum(DENY_RULE_IDS), service: z.string().max(128), informational: z.literal(true)})).max(2000),
    compose_findings_basis: z.literal("inventory"),
    approvals_required: z.array(z.strictObject({kind: z.enum(APPROVAL_KINDS), capability: z.string().max(64)})).max(4),
    blockers: z.array(z.enum(REASONS)).max(64),
    outcome: z.enum(PLAN_OUTCOMES),
    totals: z.strictObject({artifacts: int, actions: int, plaintext_bytes: int.nullable()}),
});
export type RestorePlanV1 = z.infer<typeof RestorePlanV1>;

/** An approval row appended to `fork_restore_plan.approvals` (not part of the hash; each records the hash it approved). */
export const ApprovalRecord = z.strictObject({kind: z.enum(APPROVAL_KINDS), capability: z.string().max(64), plan_hash: hex64, approved_by: z.string().min(1).max(128), approved_at: iso});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;
