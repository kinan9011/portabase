import type {ForkDb} from "@/fork/db/handle";
import {syncConnection} from "@/fork/discovery/sync";
import {currentForkMode, type ForkMode} from "@/fork/mode";
import {hashViaUpstream, type HashArtifact} from "@/fork/recovery-point/hash";
import {deleteBackupViaUpstream, encryptionEnabled, readPrincipal, type DeleteBackup, type PrincipalLookup} from "@/fork/upstream";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {runConfig, type RunConfig} from "./config";

/** Everything the run services need, with a seam for each side effect so every path runs on a fake clock / fake storage in tests. */
export type RunDeps = {
    db: ForkDb;
    now?: () => Date;
    cfg?: RunConfig;
    mode?: () => Promise<ForkMode>;
    /** Refreshes the stack's inventory from Arcane (UX-09). Default: the W07 discovery sync of the stack's connection. */
    refresh?: (stack: {id: string; connectionId: string | null}) => Promise<"ok" | "failed">;
    hash?: HashArtifact;
    deleteBackup?: DeleteBackup;
    encryptionOn?: () => Promise<boolean>;
    principalOf?: (userId: string) => Promise<PrincipalLookup>;
    /** lease owner token of this process (default: unique per process) */
    owner?: string;
    /** W17b: what the composite quiesce step needs to sign + enqueue a task (the job wires the real keys / server URL; tests inject their own). Absent ⇒ quiesce is never used. */
    channel?: Pick<ChannelDeps, "keys" | "serverUrl" | "env" | "kekDir">;
    /** W17b test seam: the dashboard-side quiesce switch (default: `FORK_QUIESCE_ENABLED`). */
    flag?: () => boolean;
};

export const nowOf = (d: Pick<RunDeps, "now">): Date => d.now?.() ?? new Date();
export const cfgOf = (d: Pick<RunDeps, "cfg">): RunConfig => d.cfg ?? runConfig();
export const modeOf = async (d: Pick<RunDeps, "mode">): Promise<ForkMode> => (d.mode ? d.mode() : (await currentForkMode()).mode);
export const encryptionOf = (d: RunDeps): Promise<boolean> => (d.encryptionOn ? d.encryptionOn() : encryptionEnabled(d.db));
export const principalOfUser = (d: RunDeps, userId: string): Promise<PrincipalLookup> => (d.principalOf ? d.principalOf(userId) : readPrincipal(d.db, userId));
export const hasherOf = (d: RunDeps): HashArtifact => d.hash ?? hashViaUpstream;
export const deleterOf = (d: RunDeps): DeleteBackup => d.deleteBackup ?? deleteBackupViaUpstream;
const PROCESS_OWNER = `run-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
export const ownerOf = (d: Pick<RunDeps, "owner">): string => d.owner ?? PROCESS_OWNER;

export async function defaultRefresh(db: ForkDb, now: (() => Date) | undefined, stack: {connectionId: string | null}): Promise<"ok" | "failed"> {
    if (!stack.connectionId) return "failed";
    const r = await syncConnection({db, now}, stack.connectionId, "cron");
    if (r.kind === "ran") return r.run.status === "failed" ? "failed" : "ok";
    return r.reason === "already_running" ? "ok" : "failed";
}
