/**
 * Agent task channel vocabulary (ADR-007, W15). Closed lists: a type or capability that is not here does not exist, on either side.
 * No `agentVersion >= x` anywhere in this directory (D34, ARCH-09): features are negotiated by capabilities only (a static test pins that).
 */
export const CHANNEL_VERSION = 1;
/** Domain-separation prefix of the signed bytes: `SIGN_DOMAIN ‖ envelope_text`. */
export const SIGN_DOMAIN = "portabase-fork-task:v1\n";

/** W15 executes `noop` only; restore / compose / quiesce types are added by W17 / W17b (their `requires` entries land with them). */
export const TASK_TYPES = ["noop"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_REQUIRES: Readonly<Record<TaskType, readonly string[]>> = {noop: ["noop.v1"]};

/** Capabilities a fork agent may report (ADR-007 D6). Unknown strings that match the grammar are stored but never satisfy a `requires`. */
export const KNOWN_CAPABILITIES = ["channel.v1", "noop.v1", "plaintext-hash.v1", "compose.render.v1", "restore.target.v1", "quiesce.v1", "sweep.v1"] as const;
export const CAPABILITY_RE = /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31})*\.v[0-9]{1,2}$/;
export const MAX_CAPABILITIES = 32;

/** `noop` payload: a bounded, non-secret echo token the round trip proves end to end. */
export const NOOP_ECHO_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_BODY_BYTES = 128 * 1024;
/** Clock skew accepted on `not_after` (D3) and on future-dated `issued_at` (agent side mirrors both). */
export const SKEW_AFTER_SECONDS = 60;
export const SKEW_BEFORE_SECONDS = 120;
/** Rotation overlap (D2). */
export const ROTATION_OVERLAP_HOURS = 24;

/** Per-agent / per-source limits (D2: ≤ 2 req/s per agent). */
export const RATE = {agent: {limit: 120, windowMs: 60_000}, ip: {limit: 600, windowMs: 60_000}, failedIp: {limit: 30, windowMs: 60_000}} as const;
