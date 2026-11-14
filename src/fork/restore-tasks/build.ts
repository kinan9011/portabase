import type {Action, RestorePlanV1} from "@/fork/restore/schema";
import type {ApprovalKind} from "@/fork/restore/vocab";
import type {z} from "zod";
import type {ApplyPayload, CleanupPayload, ComposeRef, DbPayload, ProbePayload, RenderPayload, RestoreHeader, StagePayload, UpPayload, VerifyPayload} from "./payload-schema";

/**
 * Pure payload builders of the W17-i restore tasks (plan-W17 §4.0, §4.1 i-2): a verified plan in, a strict payload out. NO I/O, no clock, no env, no DB
 * (a static test pins the import list). The enqueue service resolves the artifact ↔ manifest index map and the download URLs and hands them in.
 * Anything the agent engine cannot do yet is a `BuildError` with a closed code, never a silently dropped action.
 */
export class BuildError extends Error {
    constructor(readonly code: "mode_unsupported" | "manifest_mismatch" | "artifact_unavailable" | "invalid_input") { super(code); }
}

export type BuildInput = {
    restoreId: string; planId: string; planHash: string; plan: RestorePlanV1; approvals: readonly ApprovalKind[];
    /** `fork_recovery_point_artifact.id` → index in the VERIFIED manifest's `artifacts[]`. */
    indexOf: ReadonlyMap<string, number>;
};

export const workspaceOf = (plan: RestorePlanV1): string => {
    if (!plan.target.restore_root) throw new BuildError("invalid_input");
    return `${plan.target.restore_root}/${plan.target.project}`;
};

export function buildHeader(i: BuildInput): z.infer<typeof RestoreHeader> {
    const {plan} = i;
    if (plan.purpose === "mirror" || plan.target.host_role === "runner") throw new BuildError("mode_unsupported"); // W22a: a mirror plan is built by `mirror/build.ts` only
    if (plan.mode === "existing_stack") throw new BuildError("mode_unsupported"); // OD-W17-5: in-place destructive restore is deferred
    return {v: 1, restore_id: i.restoreId, plan_id: i.planId, plan_hash: i.planHash, stack_id: plan.rp.stack_id, rp_id: plan.rp.id, purpose: plan.purpose, mode: plan.mode,
        host_role: plan.target.host_role, approvals: [...new Set(i.approvals)].sort(), workspace: workspaceOf(plan), project: plan.target.project};
}

/** Actions that move data (everything except planner `skip`). */
const live = (plan: RestorePlanV1): Action[] => plan.actions.filter((a) => a.op !== "skip");
const indexFor = (i: BuildInput, a: Action): number => {
    const id = a.artifact_ids[0];
    const ix = id === undefined ? undefined : i.indexOf.get(id);
    if (ix === undefined) throw new BuildError("manifest_mismatch");
    return ix;
};
const isUnder = (p: string, root: string) => p.startsWith(`${root}/`);

/** Every artifact index that must be downloaded + verified (each once), in manifest order. */
export function artifactIndexes(i: BuildInput): number[] {
    const out = new Set<number>();
    for (const a of live(i.plan)) if (a.artifact_ids.length > 0) out.add(indexFor(i, a));
    return [...out].sort((x, y) => x - y);
}

/** The stage body (manifest, artifact downloads, extraction paths) shared by the restore and the mirror stage payloads (W22a: pure extraction, behaviour unchanged). */
export function stageBody(i: BuildInput, workspace: string, a: {manifest: {jsonB64: string; sigB64: string; sha256: string; minSequence?: number}; urls: ReadonlyMap<number, string>}): Pick<z.infer<typeof StagePayload>, "manifest" | "artifacts" | "paths"> {
    const paths: {index: number; dest: string}[] = [];
    for (const act of live(i.plan)) {
        // path-destination data actions extract into `dest`; stage_only artifacts and PostgreSQL dumps are only staged (W17-ii restores the dump)
        if (act.destination.kind !== "path" || act.kind === "stage_only" || (act.kind === "restore_db_dump" && act.source.dbms === "postgresql")) continue;
        const dest = act.destination.path;
        if (!dest || !isUnder(dest, workspace)) throw new BuildError("mode_unsupported");
        paths.push({index: indexFor(i, act), dest});
    }
    const artifacts = artifactIndexes(i).map((index) => {
        const url = a.urls.get(index);
        if (!url) throw new BuildError("artifact_unavailable");
        return {index, source: "archive" as const, url};
    });
    return {manifest: {json_b64: a.manifest.jsonB64, sig_b64: a.manifest.sigB64, sha256: a.manifest.sha256, ...(a.manifest.minSequence !== undefined ? {min_sequence: a.manifest.minSequence} : {})}, artifacts, paths};
}

export function buildStagePayload(i: BuildInput, a: {manifest: {jsonB64: string; sigB64: string; sha256: string; minSequence?: number}; urls: ReadonlyMap<number, string>}): z.infer<typeof StagePayload> {
    const header = buildHeader(i);
    return {...header, ...stageBody(i, header.workspace, a)};
}

/** The apply body (volumes, sqlite files, networks, unpack) shared by the restore and the mirror apply payloads (W22a: pure extraction). */
export function applyBody(i: BuildInput, project: string, manifestSha256: string): Omit<z.infer<typeof ApplyPayload>, keyof z.infer<typeof RestoreHeader>> {
    const volumes: z.infer<typeof ApplyPayload>["volumes"] = [];
    const sqlite: z.infer<typeof ApplyPayload>["sqlite"] = [];
    const unpack: z.infer<typeof ApplyPayload>["unpack"] = [];
    for (const act of live(i.plan)) {
        const d = act.destination;
        if (act.kind === "restore_volume" && d.kind === "volume") {
            if (!d.name) throw new BuildError("mode_unsupported");
            const prefix = `${project}_`;
            volumes.push({index: indexFor(i, act), name: d.name, compose_volume: d.name.startsWith(prefix) && d.name.length > prefix.length ? d.name.slice(prefix.length) : d.name});
        } else if (act.kind === "restore_sqlite_file" && d.kind === "volume") {
            if (!d.name || !d.relative_path) throw new BuildError("mode_unsupported");
            sqlite.push({index: indexFor(i, act), volume: d.name, relative_path: d.relative_path});
        } else if (act.kind === "restore_db_dump" && d.kind === "db_service" && act.source.dbms !== "postgresql") {
            if (!d.name) throw new BuildError("mode_unsupported");
            unpack.push({index: indexFor(i, act), service: d.name});
        }
    }
    const networks = live(i.plan).filter((a) => a.kind === "create_network").map((a) => {
        if (!a.destination.name) throw new BuildError("mode_unsupported");
        return {name: a.destination.name};
    });
    // sqlite files may only land in a volume this same restore created (the agent re-checks ownership)
    for (const s of sqlite) if (!volumes.some((v) => v.name === s.volume)) throw new BuildError("mode_unsupported");
    return {manifest_sha256: manifestSha256, volumes, sqlite, networks, unpack};
}

export function buildApplyPayload(i: BuildInput, manifestSha256: string): z.infer<typeof ApplyPayload> {
    const header = buildHeader(i);
    return {...header, ...applyBody(i, header.project, manifestSha256)};
}

/** W-TR (ADR-007 A16, plan D-4): one engine integrity check of a TEST plan's artifact. */
export type EngineCheck = {index: number; engine: "sqlite" | "postgresql"};
const engineOf = (a: Action): EngineCheck["engine"] | null =>
    a.kind === "restore_sqlite_file" ? "sqlite" : a.kind === "restore_db_dump" && a.source.dbms === "postgresql" ? "postgresql" : null;

/** Engine-checkable artifacts of a TEST plan (+ how many DB dumps have no checker). Throws BuildError("manifest_mismatch") on an unmapped artifact. Deduped by index, ordered by index. */
export function engineChecks(i: BuildInput): {checks: EngineCheck[]; notSupported: number} {
    const byIndex = new Map<number, EngineCheck>();
    const unsupported = new Set<string>();
    for (const a of live(i.plan)) {
        const engine = engineOf(a);
        if (engine) byIndex.set(indexFor(i, a), {index: indexFor(i, a), engine});
        else if (a.kind === "restore_db_dump") unsupported.add(a.artifact_ids[0] ?? `none:${unsupported.size}`);
    }
    return {checks: [...byIndex.values()].sort((x, y) => x.index - y.index), notSupported: unsupported.size};
}

/** Same counts without an index map (used by the pure step derivation): DISTINCT `artifact_ids[0]`, so it equals `engineChecks(i).checks.length`. */
export function engineCheckCount(plan: RestorePlanV1): {checkable: number; notSupported: number} {
    const ok = new Set<string>();
    const no = new Set<string>();
    for (const a of live(plan)) {
        const key = a.artifact_ids[0] ?? `none:${ok.size + no.size}`;
        if (engineOf(a)) ok.add(key);
        else if (a.kind === "restore_db_dump") no.add(key);
    }
    return {checkable: ok.size, notSupported: no.size};
}

export function buildVerifyPayload(i: BuildInput, manifestSha256: string): z.infer<typeof VerifyPayload> {
    if (i.plan.purpose !== "test_restore") throw new BuildError("mode_unsupported");
    const header = buildHeader(i);
    const {checks} = engineChecks(i);
    if (checks.length === 0) throw new BuildError("mode_unsupported");
    return {...header, manifest_sha256: manifestSha256, checks};
}

export function buildCleanupPayload(i: BuildInput, c: {workspace: boolean; volumes: boolean; networks: boolean; containers: boolean}): z.infer<typeof CleanupPayload> {
    return {...buildHeader(i), workspace_remove: c.workspace, volumes: c.volumes, networks: c.networks, containers: c.containers};
}

export function buildProbePayload(workspace?: string): z.infer<typeof ProbePayload> {
    return {v: 1, ...(workspace ? {workspace} : {})};
}

// --- W17-ii compose types (plan-W17-ii ii-2). Pure: the enqueue service supplies the verified render hash and the approval token. ---
/** The single compose directory + the path map of the plan (every restored path whose original location is known). */
export function buildComposeRef(i: BuildInput, o: {env: Record<string, string>; overrideYml: string | null} | null): z.infer<typeof ComposeRef> {
    const ws = workspaceOf(i.plan);
    const dirs = live(i.plan).filter((a) => a.kind === "restore_compose_dir");
    const dir = dirs.length === 1 ? dirs[0]!.destination.path : undefined;
    if (!dir || !isUnder(dir, ws)) throw new BuildError("mode_unsupported");
    const map = new Map<string, string>();
    for (const a of live(i.plan)) {
        const from = a.source.original_path, to = a.destination.path;
        if (a.destination.kind === "path" && from && to) map.set(`${from}\0${to}`, from);
    }
    const path_map = [...map.keys()].map((k) => { const [from, to] = k.split("\0") as [string, string]; return {from, to}; })
        .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0));
    return {dir, override_yml: o?.overrideYml ?? null, env: {...(o?.env ?? {})}, path_map};
}

export function buildRenderPayload(i: BuildInput, manifestSha256: string, ref: z.infer<typeof ComposeRef>): z.infer<typeof RenderPayload> {
    if (!live(i.plan).some((a) => a.kind === "compose_up")) throw new BuildError("mode_unsupported");
    return {...buildHeader(i), manifest_sha256: manifestSha256, compose: ref};
}

export function buildDbPayload(i: BuildInput, manifestSha256: string, ref: z.infer<typeof ComposeRef>, composeSha256: string, approval: unknown): z.infer<typeof DbPayload> {
    const dbs = live(i.plan).filter((a) => a.kind === "restore_db_dump" && a.source.dbms === "postgresql" && a.destination.kind === "db_service")
        .map((a) => { if (!a.destination.name) throw new BuildError("mode_unsupported"); return {index: indexFor(i, a), service: a.destination.name}; });
    if (dbs.length === 0) throw new BuildError("mode_unsupported");
    return {...buildHeader(i), manifest_sha256: manifestSha256, compose: ref, compose_sha256: composeSha256, approval: approval ?? null, dbs};
}

export function buildUpPayload(i: BuildInput, manifestSha256: string, ref: z.infer<typeof ComposeRef>, composeSha256: string, approval: unknown): z.infer<typeof UpPayload> {
    if (!live(i.plan).some((a) => a.kind === "compose_up")) throw new BuildError("mode_unsupported");
    const volumes = live(i.plan).filter((a) => a.kind === "restore_volume" && a.destination.kind === "volume").map((a) => {
        if (!a.destination.name) throw new BuildError("mode_unsupported");
        return a.destination.name;
    });
    return {...buildHeader(i), manifest_sha256: manifestSha256, compose: ref, compose_sha256: composeSha256, approval: approval ?? null, volumes};
}
