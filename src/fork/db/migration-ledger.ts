/**
 * Central fork-migration numbering (ARCH-14, ADR-003).
 *
 * drizzle-kit numbers migrations by journal position, so two waves generating a migration on
 * parallel branches would both claim the same number. The ledger makes ownership explicit:
 *  - every fork migration tag MUST be listed here, in journal order, with its owning wave;
 *  - a later wave appends its entry in the SAME PR that generates the migration;
 *  - parallel branches then conflict on this file (and on meta/_journal.json) in review/CI,
 *    never at deploy; `__tests__/unit/migration-ledger.test.ts` fails on any mismatch.
 * Fork migrations are forward-only (rollback = restore the pre-deploy pg_dump, ADR-003).
 */
export type LedgerEntry = { tag: string; wave: string; note: string };

export const MIGRATION_LEDGER: readonly LedgerEntry[] = [
    {tag: "0000_fork_meta", wave: "W01", note: "fork_meta: proves the lane"},
    {tag: "0001_fork_schema_v1", wave: "W04", note: "schema v1: arcane/stack/inventory/audit(+append-only trigger)/locks/schedule/outbox/RP+artifact (D32, D43, D44)"},
    {tag: "0002_arcane_connection_flags", wave: "W05", note: "fork_arcane_connection: tls_insecure, allow_projects_read, key_id, last_checked_at"},
    {tag: "0003_discovery_sync_state", wave: "W07", note: "fork_arcane_connection: last_sync_attempt_at, sync_failure_streak, circuit_open_until; fork_arcane_environment: last_sync_summary"},
    {tag: "0004_stack_sources", wave: "W10", note: "fork_stack_source (member links, FK databases SET NULL, D32); fork_stack_policy: selection, storage_channel_ids, consistency_profile, applied_plan_hash, materialize_state"},
    {tag: "0005_stack_policy_activation", wave: "W11", note: "fork_stack_policy: schedule, accepted_exclusions, activation (D31 authorization record)"},
    {tag: "0006_stack_runs", wave: "W12", note: "fork_stack_run + fork_stack_run_item (durable step engine state, one active run per stack, slot idempotency); RP run_id FK (SET NULL) + UNIQUE(run_id), artifact stack_source_id FK (SET NULL), extended RP reasons; fork_stack_policy: paused_at, pause_reason (F7)"},
    {tag: "0007_notification_delivery", wave: "W13", note: "fork_notification_outbox: attempts, next_attempt_at, claimed_until, last_error_code, state `suppressed`; fork_alert_state (per-stack alert episodes: drift to Partial, no good backup)"},
    {tag: "0008_manifest_kit", wave: "W14", note: "fork_trust_anchor (signing public keys, never deleted), fork_kit (kit ISSUE record + verification code, no key material), fork_kit_token (single-use kit grants, hash only), fork_dashboard_db_source (D40)"},
    {tag: "0009_agent_task_channel", wave: "W15", note: "fork_agent_enrollment (per-agent credential hash, pinned kids, task key envelope, capabilities, next_seq), fork_agent_task (D34 queue: signed envelope text, payload_enc, lease), fork_agent_hash_report (D45)"},
    {tag: "0010_agent_channel_rotation", wave: "W15b", note: "fork_agent_enrollment: pending_credential_hash, pending_task_id, pending_valid_until (signed rotate_credential overlap slot, ADR-007 A12)"},
    {tag: "0011_restore_plan", wave: "W16", note: "fork_restore_plan (hash-bound dry-run plans, approvals, expiry); fork_stack: contains_personal_data, test_restore_opt_in_at/_by (D44, §4.8)"},
    {tag: "0012_compose_render", wave: "W17-ii", note: "fork_compose_render (policy view of a rendered compose document uploaded by the restore-target agent, raw check result, sha256; ADR-007 A14)"},
    {tag: "0013_restore_override", wave: "W16b", note: "fork_restore_override (single-use, plan-bound, KEK-encrypted restore-time overrides; D28, SEC-08)"},
    {tag: "0014_restore_run", wave: "W18a", note: "fork_restore_run (durable restore orchestrator state: W12 steps, one active run per target agent, one run per plan) + fork_restore_run_task (step journal written in the enqueue transaction)"},
    // R2: append here; one entry per generated migration, in order.
];

/** Informational reservation of ownership by wave (not enforced; drizzle numbers by position). */
export const WAVE_MIGRATION_OWNERS = {
    W01: "lane bootstrap",
    W04: "schema v1, ACL/audit tables, fork KEK metadata",
    "W05-W14": "R1 tables: discovery cache, stack policy, runs, RP, manifest",
    "W15-W19": "R2: fork_agent_task, restore plans",
    "W20+": "R3 only if the go/no-go opens",
} as const;
