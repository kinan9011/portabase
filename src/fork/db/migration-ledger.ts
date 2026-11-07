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
    // W12/W14/R2: append here; one entry per generated migration, in order.
];

/** Informational reservation of ownership by wave (not enforced; drizzle numbers by position). */
export const WAVE_MIGRATION_OWNERS = {
    W01: "lane bootstrap",
    W04: "schema v1, ACL/audit tables, fork KEK metadata",
    "W05-W14": "R1 tables: discovery cache, stack policy, runs, RP, manifest",
    "W15-W19": "R2: fork_agent_task, restore plans",
    "W20+": "R3 only if the go/no-go opens",
} as const;
