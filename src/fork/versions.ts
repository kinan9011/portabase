/** Fork constants. The fork only reads these; it never edits upstream version gates (P13). */
export const FORK_BASE_VERSION = "1.35.2";
export const FORK_BASE_COMMIT = "392280cfe697cb3345131499452ec4b10aaf9602";
export const FORK_PLAN_VERSION = "2.2";
/** Min agent for stack sources (files / restic, upstream version gates 1.24.0). R2 features use capabilities, not versions (D34). */
export const FORK_MIN_AGENT_FOR_STACKS = "1.24.0";
/** Bump when the fork migration lane's runner semantics change (not per migration). */
export const FORK_LANE_VERSION = 1;
