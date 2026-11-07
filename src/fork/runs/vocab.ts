/**
 * Closed vocabularies of the stack-run state machine (W12). Pure data: shared by the DB layer (CHECK constraints, mirrored in
 * migration 0006 and kept in sync by `w12-runs-vocab`), the services and the browser DTO.
 */

/** starting → running → finalizing → succeeded | incomplete | failed | cancelled; `skipped` is terminal at birth (ARCH-17: overlap / missed slot). */
export const RUN_STATES = ["starting", "running", "finalizing", "succeeded", "incomplete", "failed", "cancelled", "skipped"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const ACTIVE_RUN_STATES = ["starting", "running", "finalizing"] as const;
export const isActiveRunState = (s: string): boolean => (ACTIVE_RUN_STATES as readonly string[]).includes(s);

export const RUN_TRIGGERS = ["schedule", "manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Why a scheduled slot did not produce a run (ARCH-17). */
export const SKIP_REASONS = ["overlap", "missed"] as const;

/** queued = `waiting` upstream backup inserted; running = the agent took it (`ongoing`). */
export const ITEM_STATES = ["queued", "running", "succeeded", "failed", "skipped"] as const;
export type ItemState = (typeof ITEM_STATES)[number];
export const TERMINAL_ITEM_STATES: readonly ItemState[] = ["succeeded", "failed", "skipped"];

/**
 * Plain-language failure / skip codes of a run or an item. The sentence for each lives in `ui/labels.ts` (RUN_REASONS); nothing
 * from an upstream error text is ever stored (it can carry URLs or credentials).
 */
export const RUN_REASONS = [
    "agent_did_not_start", // `waiting` past the wait timeout (agent silent / poll failing, CH-22c)
    "agent_made_no_progress", // `ongoing` without any progress evidence (e.g. per-source lock held, executor.rs:27-29)
    "run_timeout", // hard cap
    "member_failed", // the agent reported `failed`
    "member_busy", // a backup of that source was already waiting/ongoing (bulk-path guard)
    "member_method_conflict", // upstream `method_conflict`
    "member_not_active", // a planned/canary/drifted member is not part of a run
    "member_vanished", // the upstream source row is gone
    "storage_failed", // a required channel upload failed
    "nothing_queued", // no member could be queued
    "cancelled",
    "interrupted", // the dashboard process died mid-run and the lease expired
    "capacity", // per-agent / per-org run limit (manual refusal)
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

export const REFRESH_OUTCOMES = ["ok", "failed", "skipped_locked", "not_attempted"] as const;
export type RefreshOutcome = (typeof REFRESH_OUTCOMES)[number];

/** Step engine (ARCH-13). W12 steps; W18 defines its own list with the same engine. */
export const RUN_STEPS = ["reauthorize", "refresh_inventory", "validate", "trigger", "track", "finalize"] as const;
export type RunStep = (typeof RUN_STEPS)[number];
export const STEP_STATES = ["pending", "running", "done", "failed"] as const;
export type StepState = (typeof STEP_STATES)[number];

/** Why a policy was paused by run-time re-authorization (F7 / D31). */
export const PAUSE_REASONS = ["user_missing", "user_blocked", "capability_lost", "agent_acl_lost", "encryption_off", "channels_unavailable", "agent_gone"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
