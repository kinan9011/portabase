import type {ForkPrincipal} from "@/fork/acl";
import {forkEnv} from "@/fork/env";
import type {ManifestFetch} from "@/fork/restore-run/manifest";
import type {Resolve} from "@/fork/runner/targets";
import {readPrincipal, type PrincipalLookup} from "@/fork/upstream";
import type {MirrorTaskDeps} from "./enqueue";

/**
 * Everything the W22a services / tick need, with a seam for every side effect (throw-away DB + keys, fixed clock, fake manifest + artifact URLs + DNS).
 * `principal` is for the SERVICES only (the caller); a tick resolves the revision's starter itself (D31: no ambient service account).
 */
export type MirrorDeps = Omit<MirrorTaskDeps, "principal" | "onTaskInserted"> & {
    principal?: ForkPrincipal | null;
    manifest?: ManifestFetch;
    principalOf?: (userId: string) => Promise<PrincipalLookup>;
    /** Hard cap of one creation (default `FORK_MIRROR_MAX_HOURS`). */
    maxRunMs?: number;
    /** Lease owner token (default: unique per process). */
    owner?: string;
    /** Test seam; default `forkEnv().FORK_MIRRORS_ENABLED`. */
    mirrorsEnabled?: () => boolean;
    /** Hostname → addresses for the isolation probe (default: `dns.lookup`). */
    resolve?: Resolve;
    /** Test seam: the loopback port range (default 41000–41999). */
    portRange?: {min: number; max: number};
};

export const nowOf = (d: Pick<MirrorDeps, "now">): Date => d.now?.() ?? new Date();
export const maxRunMsOf = (d: Pick<MirrorDeps, "maxRunMs">): number => d.maxRunMs ?? forkEnv().FORK_MIRROR_MAX_HOURS * 3_600_000;
export const enabledOf = (d: Pick<MirrorDeps, "mirrorsEnabled">): boolean => (d.mirrorsEnabled ?? (() => forkEnv().FORK_MIRRORS_ENABLED))();
export const principalOfUser = (d: MirrorDeps, userId: string): Promise<PrincipalLookup> => (d.principalOf ? d.principalOf(userId) : readPrincipal(d.db, userId));
const PROCESS_OWNER = `mirror-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
export const ownerOf = (d: Pick<MirrorDeps, "owner">): string => d.owner ?? PROCESS_OWNER;
