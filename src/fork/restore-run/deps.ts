import type {ForkPrincipal} from "@/fork/acl";
import {forkEnv} from "@/fork/env";
import type {RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {readPrincipal, type PrincipalLookup} from "@/fork/upstream";
import type {ManifestFetch} from "./manifest";

/**
 * Everything the W18a services / tick need, with a seam for every side effect (throw-away DB + keys, fixed clock, fake manifest + artifact URLs).
 * `principal` is for the SERVICES only (the caller); a tick resolves the run's starter itself (D31: no ambient service account).
 */
export type RestoreRunDeps = Omit<RestoreTaskDeps, "principal" | "onTaskInserted"> & {
    principal?: ForkPrincipal | null;
    manifest?: ManifestFetch;
    principalOf?: (userId: string) => Promise<PrincipalLookup>;
    /** Hard cap of one run (default `FORK_RESTORE_RUN_MAX_HOURS`). */
    maxRunMs?: number;
    /** Lease owner token (default: unique per process). */
    owner?: string;
};

export const nowOf = (d: Pick<RestoreRunDeps, "now">): Date => d.now?.() ?? new Date();
export const maxRunMsOf = (d: Pick<RestoreRunDeps, "maxRunMs">): number => d.maxRunMs ?? forkEnv().FORK_RESTORE_RUN_MAX_HOURS * 3_600_000;
export const principalOfUser = (d: RestoreRunDeps, userId: string): Promise<PrincipalLookup> => (d.principalOf ? d.principalOf(userId) : readPrincipal(d.db, userId));
const PROCESS_OWNER = `restore-run-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
export const ownerOf = (d: Pick<RestoreRunDeps, "owner">): string => d.owner ?? PROCESS_OWNER;
