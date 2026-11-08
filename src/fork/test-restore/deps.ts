import type {RestoreRunDeps} from "@/fork/restore-run/deps";

/** Everything W-TR needs, with the restore-run seams (`now`, `rate`, `configAllowed`, `principalOf`, `manifest`, `artifactUrl`, fake keys) for tests and the live lab. */
export type TestRestoreDeps = RestoreRunDeps & {trEnv?: {FORK_TEST_RESTORE_STALE_DAYS: number}};
