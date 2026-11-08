/**
 * Agent task channel vocabulary (ADR-007, W15). Closed lists: a type or capability that is not here does not exist, on either side.
 * No `agentVersion >= x` anywhere in this directory (D34, ARCH-09): features are negotiated by capabilities only (a static test pins that).
 */
export const CHANNEL_VERSION = 1;
/** Domain-separation prefix of the signed bytes: `SIGN_DOMAIN ‖ envelope_text`. */
export const SIGN_DOMAIN = "portabase-fork-task:v1\n";

/**
 * W15 executes `noop`; W15b adds the three channel-maintenance types (ADR-007 A11). Restore / compose / quiesce types come with W17 / W17b.
 * Maintenance types are NEVER enqueueable through the generic `enqueueTask` (`PUBLIC_TASK_TYPES`): only dedicated admin services build their payload.
 */
export const MAINT_CAPABILITY = "channel-maint.v1";
/**
 * W17-i adds the four restore-engine types (ADR-007 A13). Names use underscores: the envelope `type` grammar has no dots (capabilities keep theirs).
 * They are TARGETED (the envelope MUST carry `target_agent_id` = the executing agent) and, like the maintenance types, never public:
 * only `src/fork/restore-tasks/enqueue.ts` builds their payload. W17-ii adds `compose_render`, `restore_db`, `compose_up` (capability `compose.render.v1`).
 */
export const RESTORE_CAPABILITY = "restore.target.v1";
export const COMPOSE_CAPABILITY = "compose.render.v1";
export const RESTORE_TASK_TYPES = ["restore_probe", "restore_stage", "restore_apply", "restore_cleanup"] as const;
/** W17-ii adds the three compose types (ADR-007 A14): they run inside a restore workspace and need BOTH capabilities. Targeted, never public. */
export const COMPOSE_TASK_TYPES = ["compose_render", "restore_db", "compose_up"] as const;
export const TASK_TYPES = ["noop", "pin_add", "pin_revoke", "rotate_credential", ...RESTORE_TASK_TYPES, ...COMPOSE_TASK_TYPES] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const PUBLIC_TASK_TYPES = ["noop"] as const;
export const MAINT_TASK_TYPES = ["pin_add", "pin_revoke", "rotate_credential"] as const;
/** Types whose envelope must name the executing agent in `target_agent_id` (ADR-007 D8b, DD2). The agent enforces the same list. */
export const TARGETED_TASK_TYPES: readonly TaskType[] = [...RESTORE_TASK_TYPES, ...COMPOSE_TASK_TYPES];
export const isTargetedType = (t: string): boolean => (TARGETED_TASK_TYPES as readonly string[]).includes(t);
export const TASK_REQUIRES: Readonly<Record<TaskType, readonly string[]>> = {
    noop: ["noop.v1"], pin_add: [MAINT_CAPABILITY], pin_revoke: [MAINT_CAPABILITY], rotate_credential: [MAINT_CAPABILITY],
    restore_probe: [RESTORE_CAPABILITY], restore_stage: [RESTORE_CAPABILITY], restore_apply: [RESTORE_CAPABILITY], restore_cleanup: [RESTORE_CAPABILITY],
    compose_render: [RESTORE_CAPABILITY, COMPOSE_CAPABILITY], restore_db: [RESTORE_CAPABILITY, COMPOSE_CAPABILITY], compose_up: [RESTORE_CAPABILITY, COMPOSE_CAPABILITY],
};
/** Pinned dashboard keys per agent (agent enforces the same bound), PEM size bound, kid grammar (first 12 hex of SHA-256(SPKI DER)). */
export const MAX_PINS = 8;
export const PIN_PEM_MAX = 4096;
export const KID_RE = /^[0-9a-f]{12}$/;

/** Capabilities a fork agent may report (ADR-007 D6). Unknown strings that match the grammar are stored but never satisfy a `requires`. */
export const KNOWN_CAPABILITIES = ["channel.v1", "noop.v1", "plaintext-hash.v1", "channel-maint.v1", "compose.render.v1", "restore.target.v1", "quiesce.v1", "sweep.v1"] as const;
export const CAPABILITY_RE = /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31})*\.v[0-9]{1,2}$/;
export const MAX_CAPABILITIES = 32;

/** `noop` payload: a bounded, non-secret echo token the round trip proves end to end. */
export const NOOP_ECHO_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_BODY_BYTES = 128 * 1024;
/** Render upload route only (W17-ii E13): the policy view is up to 2 MiB, base64 inflates it. */
export const RENDER_MAX_BODY_BYTES = 3 * 1024 * 1024;
/** Clock skew accepted on `not_after` (D3) and on future-dated `issued_at` (agent side mirrors both). */
export const SKEW_AFTER_SECONDS = 60;
export const SKEW_BEFORE_SECONDS = 120;
/** Rotation overlap (D2). */
export const ROTATION_OVERLAP_HOURS = 24;

/** Per-agent / per-source limits (D2: ≤ 2 req/s per agent). */
export const RATE = {agent: {limit: 120, windowMs: 60_000}, ip: {limit: 600, windowMs: 60_000}, failedIp: {limit: 30, windowMs: 60_000}} as const;
