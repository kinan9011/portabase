import type {StackInventoryV1} from "@/fork/inventory/schema";
import {isDockerSocket, isSafeAbsPath, isSystemPath, isUnder, normPath} from "./rules";
import {
    EMPTY_CONTEXT, GAP_STATUSES, type CompletenessContext, type CompletenessReport, type Directive, type Item, type ItemKind, type ItemStatus,
    type ReasonCode, type Severity,
} from "./types";

type Inv = StackInventoryV1;

/** Volume drivers the agent's docker-volume source can read by name. Anything else (NFS plugins, cloud drivers) is not captured. */
const SUPPORTED_VOLUME_DRIVERS = new Set(["local"]);

type Spec = {
    key: string; kind: ItemKind; name: string; consumers?: readonly string[];
    /** needs a host-side probe before it can be called captured (paths on the host) */
    needsProbe?: boolean;
    external?: ReasonCode;
    excluded?: boolean;
    /** unsupported regardless of coverage (a source can never make it safe: SEC-15/SEC-24) */
    hardUnsupported?: ReasonCode;
    /** unsupported unless something covers it */
    softUnsupported?: ReasonCode;
    /** status + reason + severity when nothing covers it and no probe spoke (default: missing / not_covered / blocker) */
    uncovered?: {status: "missing" | "unknown"; reason: ReasonCode; severity: Severity};
    placement?: "here" | "outside" | null;
    resolvable?: boolean;
    database?: boolean;
};

function build(spec: Spec, ctx: CompletenessContext, accepted: ReadonlySet<string>, fileCopy: boolean): Item {
    const base = {key: spec.key, kind: spec.kind, name: spec.name, consumers: spec.consumers ?? [], placement: spec.placement ?? null, consistency: null as Item["consistency"]};
    const mk = (status: ItemStatus, reason: ReasonCode, severity: Severity, resolvable = false, consistency: Item["consistency"] = null): Item =>
        ({...base, status, reason, severity, gap: GAP_STATUSES.includes(status) || reason === "db_file_copy_only", resolvable: resolvable && spec.resolvable === true, consistency});

    if (accepted.has(spec.key)) return mk("accepted_exclusion", "accepted", "info");
    if (spec.excluded) return mk("excluded", "excluded_by_label", "info");
    if (spec.external) return mk("external", spec.external, spec.external === "external_network" || spec.external === "external_dependency" ? "info" : "warn");
    if (spec.hardUnsupported) return mk("unsupported", spec.hardUnsupported, "blocker");

    const covered = ctx.coverage[spec.key];
    const probe = ctx.probes[spec.key];
    if (probe === "unreadable") return mk("inaccessible", "unreadable", "blocker", true);
    if (probe === "absent") return mk("missing", "file_absent", "blocker", true);
    if (covered) {
        if (spec.database) {
            // D29: only an engine dump saves a database safely; a file copy is a coverage gap (Partial) and never Protected.
            return covered === "engine_dump" ? mk("captured", "captured", "info", false, "engine_dump") : mk("captured", "db_file_copy_only", "warn", false, "files_only");
        }
        if (spec.needsProbe && probe !== "readable") return mk("unknown", "probe_pending", "blocker", true);
        return mk("captured", covered === "manual_files" ? "captured_manual" : "captured", "info");
    }
    if (spec.database && fileCopy) return mk("captured", "db_file_copy_only", "warn", false, "files_only");
    if (spec.softUnsupported) return mk("unsupported", spec.softUnsupported, spec.softUnsupported === "image_local" ? "warn" : "blocker");
    const u = spec.uncovered;
    if (u && probe === undefined) return mk(u.status, u.reason, u.severity, true);
    return mk("missing", "not_covered", "blocker", true);
}

/** Path checks common to bind mounts and file hints: hard-unsupported reason, or a system-path/socket directive, or fine. */
export function pathVerdict(path: string, roots: readonly string[]): {unsupported?: ReasonCode; directive?: "docker_socket" | "system_path"} {
    if (!isSafeAbsPath(path) || normPath(path) === "/") return {unsupported: "denied_path"};
    if (isDockerSocket(path)) return {directive: "docker_socket"};
    if (isSystemPath(path)) return {directive: "system_path"};
    if (roots.length > 0 && !roots.some((r) => isUnder(path, r))) return {unsupported: "outside_allowed_roots"};
    return {};
}

/**
 * Pure completeness validator (W09). Input: the parsed stack inventory + coverage/probe/exclusion context (all empty until
 * W10/W11 feed them). Output: one item per REQUIRED resource, §4.4 directives, and `complete`, which is true only when no
 * required resource is missing, inaccessible, unsupported or unknown — an unknown resource can never be complete.
 */
export function validateCompleteness(inv: Inv, ctx: CompletenessContext = EMPTY_CONTEXT): CompletenessReport {
    const accepted = new Set(ctx.acceptedExclusions);
    const items: Item[] = [];
    const directives: Directive[] = [];
    const add = (s: Spec, fileCopy = false) => items.push(build(s, ctx, accepted, fileCopy));
    const wd = inv.stack.working_dir_hint && isSafeAbsPath(inv.stack.working_dir_hint) ? normPath(inv.stack.working_dir_hint) : null;
    const placementOf = (p: string): "here" | "outside" => (wd && isUnder(p, wd) ? "here" : "outside");
    const svc = new Map(inv.services.map((s) => [s.name, s]));
    const excludedSvc = new Set(inv.services.filter((s) => s.backup_hints?.exclude === true).map((s) => s.name));
    const volByName = new Map(inv.volumes.map((v) => [v.name, v]));

    // ---- compose + env files ------------------------------------------------------------------------------------------
    if (inv.stack.config_files_hint.length === 0) add({key: "file:?", kind: "compose_file", name: "", uncovered: {status: "missing", reason: "compose_location_unknown", severity: "blocker"}, resolvable: true});
    for (const p of inv.stack.config_files_hint) {
        const v = pathVerdict(p, ctx.allowedRoots);
        add({key: `file:${p}`, kind: "compose_file", name: p, needsProbe: true, placement: isSafeAbsPath(p) ? placementOf(p) : null, hardUnsupported: v.unsupported ?? (v.directive ? "denied_path" : undefined), resolvable: true});
    }
    if (inv.stack.compose_read === "none") {
        // The compose definition was not read, so which env files exist is unknown (fail closed).
        add({key: "env:undetermined", kind: "env_file", name: "", uncovered: {status: "unknown", reason: "env_files_undetermined", severity: "blocker"}, resolvable: true});
    } else {
        for (const e of inv.env_files) {
            const v = pathVerdict(e.path_hint, ctx.allowedRoots);
            add({key: `env:${e.path_hint}`, kind: "env_file", name: e.path_hint, consumers: e.referenced_by, needsProbe: true, placement: isSafeAbsPath(e.path_hint) ? placementOf(e.path_hint) : null, hardUnsupported: v.unsupported ?? (v.directive ? "denied_path" : undefined), resolvable: true});
        }
    }
    // An implicit `.env` next to the compose file is not named anywhere: only a host probe can say. Absent ⇒ no item.
    if (ctx.probes["env:implicit"] !== "absent") {
        add({key: "env:implicit", kind: "env_file", name: wd ? `${wd}/.env` : ".env", needsProbe: true, placement: wd ? "here" : null, uncovered: {status: "unknown", reason: "env_implicit_unknown", severity: "blocker"}, resolvable: true});
    }

    // ---- mounts -------------------------------------------------------------------------------------------------------
    const mountCovered = (m: Inv["mounts"][number]) => (m.kind === "named_volume" && m.volume_name ? ctx.coverage[`volume:${m.volume_name}`] : ctx.coverage[`mount:${m.id}`]);
    const allExcluded = (consumers: readonly string[]) => consumers.length > 0 && consumers.every((c) => excludedSvc.has(c));
    for (const m of inv.mounts) {
        if (m.kind === "bind") {
            const p = m.host_path_hint ?? "";
            if (!p) { add({key: `mount:${m.id}`, kind: "bind", name: m.destination, consumers: m.consumers, needsProbe: true, hardUnsupported: "denied_path"}); continue; }
            const v = pathVerdict(p, ctx.allowedRoots);
            if (v.directive) { directives.push({code: v.directive, service: m.consumers[0] ?? null, detail: m.destination}); continue; }
            add({key: `mount:${m.id}`, kind: "bind", name: p, consumers: m.consumers, needsProbe: true, excluded: allExcluded(m.consumers), hardUnsupported: v.unsupported, placement: placementOf(p), resolvable: true});
        } else if (m.kind === "anonymous_volume") {
            add({key: `mount:${m.id}`, kind: "anonymous_volume", name: m.destination, consumers: m.consumers, excluded: allExcluded(m.consumers), uncovered: {status: "missing", reason: "anonymous_volume", severity: "warn"}});
        }
        // named volumes are items through `inv.volumes` below; tmpfs holds nothing to keep.
    }

    // ---- named volumes ------------------------------------------------------------------------------------------------
    for (const v of inv.volumes) {
        add({
            key: `volume:${v.name}`, kind: "volume", name: v.name, consumers: v.in_use_by,
            excluded: v.backup_hints?.exclude === true || allExcluded(v.in_use_by),
            external: v.ownership === "external_shared" ? "external_volume" : undefined,
            softUnsupported: SUPPORTED_VOLUME_DRIVERS.has(v.driver) ? undefined : "volume_driver",
        });
    }

    // ---- databases (a name/port/mount HINT, never a probe: ADR-004 §10) ------------------------------------------------
    for (const s of inv.services) {
        if (!s.database_hint) continue;
        const dataCovered = s.mounts.some((id) => {
            const m = inv.mounts.find((x) => x.id === id);
            return m !== undefined && (m.kind === "named_volume" || m.kind === "bind") && mountCovered(m) !== undefined && !excludedSvc.has(s.name);
        });
        add({key: `db:${s.name}`, kind: "database", name: s.name, consumers: [s.name], excluded: excludedSvc.has(s.name), database: true}, dataCovered);
    }

    // ---- images, directives, networks ---------------------------------------------------------------------------------
    for (const s of inv.services) {
        if (s.image.built_locally) add({key: `image:${s.name}`, kind: "image", name: s.image.ref, consumers: [s.name], excluded: excludedSvc.has(s.name), softUnsupported: "image_local"});
        if (s.privileged === true) directives.push({code: "privileged", service: s.name, detail: null});
        if (s.network_mode === "host") directives.push({code: "host_network", service: s.name, detail: null});
        else if (s.network_mode?.startsWith("container:")) directives.push({code: "shared_netns", service: s.name, detail: null});
    }
    const networks = inv.networks.map((n) => ({name: n.name, ownership: n.classification ?? (n.external ? ("shared_external" as const) : ("stack_owned" as const)), subnets: n.subnets ?? []}));
    for (const n of networks) if (n.ownership !== "stack_owned") add({key: `network:${n.name}`, kind: "network", name: n.name, external: "external_network"});
    for (const d of inv.external_dependencies) {
        if (d.kind === "remote_service" || d.kind === "other") add({key: `dep:${d.kind}:${d.name}`, kind: "dependency", name: d.name, external: "external_dependency"});
    }

    // ---- materializer findings (W10): the stack's own sources / agent / policy ------------------------------------------------
    for (const i of ctx.sourceIssues ?? []) {
        items.push({key: i.key, kind: i.kind, name: i.name, status: i.status, reason: i.reason, severity: i.severity, gap: GAP_STATUSES.includes(i.status), resolvable: false, consumers: i.consumers ?? [], placement: null, consistency: null});
    }

    // ---- verdict ------------------------------------------------------------------------------------------------------
    const gaps = items.filter((i) => i.gap);
    const count = (s: ItemStatus) => items.filter((i) => i.status === s).length;
    return {
        complete: gaps.length === 0,
        items,
        blockers: gaps.filter((i) => i.severity === "blocker"),
        directives,
        networks,
        fileCopyOnlyDatabases: items.filter((i) => i.reason === "db_file_copy_only").map((i) => i.name),
        counts: {
            total: items.length, captured: count("captured"), gaps: gaps.length,
            blockers: gaps.filter((i) => i.severity === "blocker").length,
            warnings: items.filter((i) => i.severity === "warn" && i.status !== "excluded" && i.status !== "accepted_exclusion").length,
            external: count("external"), excluded: count("excluded"), accepted: count("accepted_exclusion"),
        },
    };
}
