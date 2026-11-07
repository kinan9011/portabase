import {createHash} from "node:crypto";
import {canonicalJson} from "@/fork/canonical";
import {EMPTY_CONTEXT} from "@/fork/completeness/types";
import {isSystemPath, isUnder, normPath} from "@/fork/completeness/rules";
import {pathVerdict, validateCompleteness} from "@/fork/completeness/validate";
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {safeAbsPath} from "@/fork/inventory/labels";
import {
    DUMP_ENGINES, DUMP_REQUIRED, isAcceptableDbHost, isAdoptableVolumeName, VOLUME_NAME_RE,
    type DbInput, type DumpEngine, type Plan, type PlannedSource, type Selection, type Skipped, type SkipReason,
} from "./types";

const sha = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");
const MAX_NAME = 200;

/** Member names are display text only; bounded and made unique by a hash suffix when truncated. */
function memberName(prefix: string, label: string): string {
    const full = `${prefix}: ${label}`;
    return full.length <= MAX_NAME ? full : `${full.slice(0, MAX_NAME - 8)}~${sha(label).slice(0, 6)}`;
}

/** sqlite lives on ONE explicit single-volume mount (ADR-001 §E): the broad docker volumes path is never accepted. */
export function isAcceptableSqlitePath(p: string, roots: readonly string[]): boolean {
    const n = safeAbsPath(p);
    if (!n || n === "/" || isSystemPath(n) || isUnder(n, "/var/lib/docker")) return false;
    return roots.length === 0 || roots.some((r) => isUnder(n, r));
}

function dbSource(svc: string, engineHint: string, input: DbInput, roots: readonly string[], dataKeys: readonly string[]): PlannedSource | Skipped {
    const key = `db:${svc}`;
    const invalid: Skipped = {key, reason: "db_input_invalid"};
    if (input.kind === "sqlite") {
        if (engineHint !== "sqlite" || !isAcceptableSqlitePath(input.path, roots)) return invalid;
        const config = {path: safeAbsPath(input.path) as string};
        const body = {role: "db", dbms: "sqlite", engine: "archive", config, covers: [key], needsSecret: false};
        // sqlite `.backup` saves the DB file only: it does NOT make the rest of its volume covered (data keys not added).
        return {resourceKey: key, role: "db", origin: "discovered", memberName: memberName("db", svc), dbms: "sqlite", engine: "archive", config, covers: [key], coverage: "engine_dump", secretFor: null, needsSecret: false, requiresDocker: false, hash: sha(body)};
    }
    if (!(DUMP_ENGINES as readonly string[]).includes(engineHint)) return invalid;
    const engine = engineHint as DumpEngine;
    const req = DUMP_REQUIRED[engine];
    for (const f of req.fields) if (input[f] === undefined || input[f] === "") return invalid;
    if (!isAcceptableDbHost(input.host)) return invalid;
    const config: Record<string, unknown> = {host: input.host};
    if (input.port !== undefined) config.port = input.port;
    if (input.username !== undefined) config.username = input.username;
    if (input.database !== undefined) config.database = input.database;
    const covers = [key, ...dataKeys];
    const body = {role: "db", dbms: engine, engine: "archive", config, covers: [...covers].sort(), needsSecret: req.secret};
    return {resourceKey: key, role: "db", origin: "discovered", memberName: memberName("db", svc), dbms: engine, engine: "archive", config, covers, coverage: "engine_dump", secretFor: req.secret ? svc : null, needsSecret: req.secret, requiresDocker: false, hash: sha(body)};
}

/**
 * Pure materialization plan (W10): validated inventory + operator selection → the ordinary Portabase sources that cover it.
 * No I/O, no upstream imports. The only inputs that reach a source are values already validated here; labels/hints are never
 * trusted (SEC-22): every path is re-checked with the validator's `pathVerdict`, every volume with the SEC-24 rule.
 *
 * Mapping (wave file §Scope): compose dir (+.env, one `files` source, snapshot by default) · each bind → `files` · each named volume →
 * `docker-volume` (SEC-24, never `container_name`) · DB service → engine source needing credentials input · SQLite → upstream `sqlite`
 * source (D29) · DB data mounts excluded while a dump is selected · manual sources only inside `allowed_path_roots` (D19).
 */
export function planStack(inv: StackInventoryV1, sel: Selection, allowedRoots: readonly string[] = []): Plan {
    const sources: PlannedSource[] = [];
    const skipped: Skipped[] = [];
    const skip = (key: string, reason: SkipReason) => skipped.push({key, reason});
    const include = new Set(sel.includeKeys);
    const exclude = new Set(sel.excludeKeys);
    const excludedSvc = new Set(inv.services.filter((s) => s.backup_hints?.exclude === true).map((s) => s.name));
    // D18: an `exclude` hint is a DEFAULT; explicit selection wins in both directions.
    const isExcluded = (key: string, hintExcluded: boolean) => (include.has(key) ? false : exclude.has(key) || hintExcluded);
    const allExcluded = (consumers: readonly string[]) => consumers.length > 0 && consumers.every((c) => excludedSvc.has(c));
    const reason = (key: string): SkipReason => (exclude.has(key) ? "excluded_selection" : "excluded_hint");

    // Which services a dump will cover, and the data mounts that makes redundant.
    const dumpSvc = new Set<string>();
    for (const s of inv.services) {
        const input = sel.databases[s.name];
        if (s.database_hint && input?.kind === "dump" && !isExcluded(`db:${s.name}`, excludedSvc.has(s.name))) dumpSvc.add(s.name);
    }
    const dumpCovers = (consumers: readonly string[]) => consumers.length > 0 && consumers.every((c) => dumpSvc.has(c));
    const dataKeysOf = (svcName: string): string[] => {
        const s = inv.services.find((x) => x.name === svcName);
        const out: string[] = [];
        for (const id of s?.mounts ?? []) {
            const m = inv.mounts.find((x) => x.id === id);
            if (!m) continue;
            if (m.kind === "named_volume" && m.volume_name && dumpCovers(m.consumers)) out.push(`volume:${m.volume_name}`);
            else if (m.kind === "bind" && dumpCovers(m.consumers)) out.push(`mount:${m.id}`);
        }
        return out;
    };

    // ---- compose directory (+ env files, implicit .env) ----------------------------------------------------------------
    const wd = safeAbsPath(inv.stack.working_dir_hint);
    if (!wd) skip("dir:?", "compose_location_unknown");
    else {
        const key = `dir:${wd}`;
        const v = pathVerdict(wd, allowedRoots);
        if (v.unsupported || v.directive) skip(key, "bind_path_denied");
        else if (isExcluded(key, false)) skip(key, reason(key));
        else {
            const covers = [
                ...inv.stack.config_files_hint.filter((p) => safeAbsPath(p) !== null && isUnder(p, wd)).map((p) => `file:${p}`),
                ...inv.env_files.filter((e) => safeAbsPath(e.path_hint) !== null && isUnder(e.path_hint, wd)).map((e) => `env:${e.path_hint}`),
                "env:implicit",
            ];
            const engine = sel.composeMethod === "snapshot" ? "restic" : "archive";
            const config = {path: wd};
            sources.push({resourceKey: key, role: "compose", origin: "discovered", memberName: memberName("compose", wd), dbms: "files", engine, config, covers, coverage: "files", secretFor: null, needsSecret: false, requiresDocker: false, hash: sha({role: "compose", dbms: "files", engine, config, covers: [...covers].sort(), needsSecret: false})});
        }
    }

    // ---- bind mounts ------------------------------------------------------------------------------------------------------
    for (const m of inv.mounts) {
        if (m.kind === "tmpfs") continue;
        if (m.kind === "anonymous_volume") { skip(`mount:${m.id}`, "anonymous_volume"); continue; }
        if (m.kind !== "bind") continue;
        const key = `mount:${m.id}`;
        if (isExcluded(key, allExcluded(m.consumers))) { skip(key, reason(key)); continue; }
        if (!include.has(key) && dumpCovers(m.consumers)) continue; // data dir of a dump-covered DB: covered through the DB source
        const p = safeAbsPath(m.host_path_hint);
        const v = p ? pathVerdict(p, allowedRoots) : {unsupported: "denied_path" as const};
        if (!p || v.unsupported || v.directive) { skip(key, "bind_path_denied"); continue; }
        const engine = sel.bindMethod === "snapshot" ? "restic" : "archive";
        const config = {path: normPath(p)};
        sources.push({resourceKey: key, role: "bind", origin: "discovered", memberName: memberName("bind", p), dbms: "files", engine, config, covers: [key], coverage: "files", secretFor: null, needsSecret: false, requiresDocker: false, hash: sha({role: "bind", dbms: "files", engine, config, covers: [key], needsSecret: false})});
    }

    // ---- named volumes (SEC-24) --------------------------------------------------------------------------------------------
    const volByName = new Map(inv.volumes.map((v) => [v.name, v]));
    for (const m of inv.mounts) {
        if (m.kind === "named_volume" && m.volume_name && !volByName.has(m.volume_name)) skip(`volume:${m.volume_name}`, "volume_not_in_inventory");
    }
    for (const v of inv.volumes) {
        const key = `volume:${v.name}`;
        if (isExcluded(key, v.backup_hints?.exclude === true || allExcluded(v.in_use_by))) { skip(key, reason(key)); continue; }
        if (v.ownership === "external_shared") { skip(key, "external_volume"); continue; }
        if (!include.has(key) && dumpCovers(v.in_use_by)) continue; // DB data volume while a dump is selected
        if (v.driver !== "local") { skip(key, "unsupported_driver"); continue; }
        if (!VOLUME_NAME_RE.test(v.name) || v.name.length > 255) { skip(key, "volume_name_invalid"); continue; }
        if (!isAdoptableVolumeName(v.name)) { skip(key, "anonymous_volume"); continue; }
        const config = {volume_name: v.name}; // `container_name` is NEVER set in R1 (D29)
        sources.push({resourceKey: key, role: "volume", origin: "discovered", memberName: memberName("volume", v.name), dbms: "docker-volume", engine: "archive", config, covers: [key], coverage: "files", secretFor: null, needsSecret: false, requiresDocker: true, hash: sha({role: "volume", dbms: "docker-volume", engine: "archive", config, covers: [key], needsSecret: false})});
    }

    // ---- databases ----------------------------------------------------------------------------------------------------------
    const hinted = new Map(inv.services.filter((s) => s.database_hint).map((s) => [s.name, s]));
    for (const name of Object.keys(sel.databases)) if (!hinted.has(name)) skip(`db:${name}`, "db_input_invalid");
    for (const s of hinted.values()) {
        const key = `db:${s.name}`;
        if (isExcluded(key, excludedSvc.has(s.name))) { skip(key, reason(key)); continue; }
        const input = sel.databases[s.name];
        if (!input) { skip(key, "db_not_selected"); continue; }
        const r = dbSource(s.name, s.database_hint?.engine ?? "", input, allowedRoots, dataKeysOf(s.name));
        if ("reason" in r) skipped.push(r); else sources.push(r);
    }

    // ---- manual sources (D18/D19) ------------------------------------------------------------------------------------------
    const known = new Set([...validateCompleteness(inv, EMPTY_CONTEXT).items.map((i) => i.key), "env:undetermined", "file:?"]);
    for (const ms of sel.manual) {
        const p = safeAbsPath(ms.path);
        const key = `manual:${p ?? ms.path.slice(0, 64)}`;
        const v = p ? pathVerdict(p, allowedRoots) : {unsupported: "denied_path" as const};
        // A manual source needs a configured root: with none the agent-side check cannot be bounded.
        if (!p || v.unsupported || v.directive || allowedRoots.length === 0) { skip(key, "manual_invalid"); continue; }
        if (!ms.covers.every((k) => known.has(k))) { skip(key, "manual_key_unknown"); continue; }
        const config = {path: normPath(p)};
        sources.push({resourceKey: `manual:${normPath(p)}`, role: "bind", origin: "manual", memberName: memberName("manual", p), dbms: "files", engine: "archive", config, covers: ms.covers, coverage: "manual_files", secretFor: null, needsSecret: false, requiresDocker: false, hash: sha({role: "bind", origin: "manual", dbms: "files", engine: "archive", config, covers: [...ms.covers].sort(), needsSecret: false})});
    }

    sources.sort((a, b) => (a.resourceKey < b.resourceKey ? -1 : a.resourceKey > b.resourceKey ? 1 : 0));
    const coverage: Plan["coverage"] = {};
    for (const s of sources) for (const k of s.covers) if (coverage[k] === undefined || (s.coverage === "engine_dump" && coverage[k] !== "engine_dump")) coverage[k] = s.coverage;
    skipped.sort((a, b) => (a.key + a.reason < b.key + b.reason ? -1 : 1));
    const planHash = sha({sources: sources.map((s) => [s.resourceKey, s.hash]), skipped: skipped.map((s) => [s.key, s.reason])});
    return {sources, coverage, skipped, stop: [...new Set(sel.stop)].sort(), planHash};
}
