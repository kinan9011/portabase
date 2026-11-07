import {createHash} from "node:crypto";
import {ARCANE_OPENAPI_SHA256} from "@/fork/arcane/endpoints";
import type {DiscoveredContainer, DiscoveredImage, DiscoveredNetwork, DiscoveredProject, DiscoveredVolume} from "@/fork/discovery/provider";
import type {ParsedCompose} from "@/fork/inventory/compose-yaml";
import {COMPOSE_LABEL, ENV_KEY, parseBackupHints, parseDependsOnLabel, parsePathList, PROJECT_NAME, safeAbsPath, SERVICE_NAME, type BackupHints} from "@/fork/inventory/labels";
import {contentHash, InventoryRejectedError, parseInventoryStrict, type StackInventoryV1} from "@/fork/inventory/schema";

/**
 * Inventory normaliser (W07, ADR-004 §4). Pure and deterministic: the same Arcane facts in any order produce the same
 * canonical hash. The output is built field by field from an ALLOW-LIST — no input object is ever spread or copied wholesale —
 * and finally passed through the strict schema (unknown key / wrong type / oversize ⇒ rejected, never truncated).
 *
 * Never read, never stored: environment values (the client already drops them), command lines, label maps (only the compose
 * keys and the three D18 hint keys are looked at), file contents, raw compose YAML. Labels are attacker-controlled (SEC-22):
 * they feed hints and display strings after validation, never identity, never a path anyone opens.
 */
export type Runtime = "running" | "partial" | "stopped" | "absent" | "unknown";
type Inv = StackInventoryV1;
type Warning = Inv["warnings"][number];

export type NormalizeInput = {
    connectionId: string;
    /** Arcane's external environment id. */
    environmentId: string;
    arcaneVersion: string;
    capturedAt: Date;
    /** HOST-WIDE lists as Arcane returns them (untrusted; filtered by compose project here). */
    containers: readonly DiscoveredContainer[];
    volumes: readonly DiscoveredVolume[];
    networks: readonly DiscoveredNetwork[];
    images: readonly DiscoveredImage[];
    projects: readonly DiscoveredProject[];
    /** tier 2 only: parsed compose per compose project (names/paths only). */
    compose?: ReadonlyMap<string, ParsedCompose>;
    /** tier 2: compose text that the SEC-17 limits refused → that stack stays `compose_read: "none"` with a warning. */
    composeRejected?: ReadonlyMap<string, string>;
};

export type NormalizedStack = {
    composeProject: string;
    displayName: string;
    runtimeState: Runtime;
    inventory: Inv;
    contentHash: string;
    counts: {services: number; mounts: number; volumes: number; networks: number; warnings: number};
};
export type RejectedStack = {composeProject: string | null; code: "invalid_project" | "inventory_limit" | "inventory_invalid"};
export type NormalizeResult = {stacks: NormalizedStack[]; rejected: RejectedStack[]; unmanagedContainers: number; ignoredOneOff: number};

const LIMITS = {services: 500, mounts: 2000};
const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);
const STATES: Record<string, Inv["services"][number]["state"]> = {
    running: "running", exited: "exited", paused: "paused", restarting: "restarting", created: "created", dead: "dead", removing: "dead",
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const uniqSorted = (a: Iterable<string>) => [...new Set(a)].sort();
const cleanName = (s: string | undefined | null): string | null => (s && s.length <= 128 && !/[\u0000-\u001f\u007f]/.test(s) && s.trim() === s && s.length > 0 ? s : null);

// ---- heuristics (hints only) -------------------------------------------------------------------------------------------
const IMAGE_ENGINES: [RegExp, NonNullable<Inv["services"][number]["database_hint"]>["engine"]][] = [
    [/(^|\/)(postgres|postgresql|postgis|timescaledb|pgvector)(\/|$)/, "postgresql"],
    [/(^|\/)(mysql|percona)(\/|$)/, "mysql"],
    [/(^|\/)mariadb(\/|$)/, "mariadb"],
    [/(^|\/)(mongo|mongodb)(\/|$)/, "mongodb"],
    [/(^|\/)redis(\/|$)/, "redis"],
    [/(^|\/)valkey(\/|$)/, "valkey"],
    [/(^|\/)firebird(\/|$)/, "firebird"],
    [/(^|\/)mssql(\/|$)/, "mssql"],
];
const PORT_ENGINES: Record<number, NonNullable<Inv["services"][number]["database_hint"]>["engine"]> = {5432: "postgresql", 3306: "mysql", 27017: "mongodb", 6379: "redis", 1433: "mssql", 3050: "firebird"};
const SQLITE_PATH = /\.(sqlite3?|db3?)$/i;

function repoPath(ref: string): string {
    const noDigest = ref.split("@")[0] ?? ref;
    const slash = noDigest.lastIndexOf("/");
    const tagAt = noDigest.indexOf(":", slash + 1);
    return (tagAt === -1 ? noDigest : noDigest.slice(0, tagAt)).toLowerCase();
}

function detectDatabase(image: string, ports: {target: number}[], mounts: {destination: string; volume_name?: string}[]): Inv["services"][number]["database_hint"] {
    const repo = repoPath(image);
    for (const [re, engine] of IMAGE_ENGINES) if (re.test(repo)) return {engine, basis: "image"};
    for (const p of ports) if (PORT_ENGINES[p.target]) return {engine: PORT_ENGINES[p.target], basis: "port"};
    if (mounts.some((m) => SQLITE_PATH.test(m.destination) || /sqlite/i.test(m.volume_name ?? "") || /sqlite/i.test(m.destination))) return {engine: "sqlite", basis: "mount"};
    return undefined;
}

// ---- main --------------------------------------------------------------------------------------------------------------
export function normalizeEnvironment(input: NormalizeInput): NormalizeResult {
    const rejected: RejectedStack[] = [];
    const byProject = new Map<string, DiscoveredContainer[]>();
    let unmanaged = 0;
    let oneOff = 0;
    for (const c of input.containers) {
        const project = Object.hasOwn(c.labels, COMPOSE_LABEL.project) ? c.labels[COMPOSE_LABEL.project] : undefined;
        if (project === undefined) { unmanaged++; continue; }
        if (c.labels[COMPOSE_LABEL.oneoff]?.toLowerCase() === "true") { oneOff++; continue; }
        if (!PROJECT_NAME.test(project)) { rejected.push({composeProject: null, code: "invalid_project"}); continue; } // never echo the label
        byProject.set(project, [...(byProject.get(project) ?? []), c]);
    }
    const arcaneProjects = new Map<string, DiscoveredProject>();
    for (const p of input.projects) {
        if (!PROJECT_NAME.test(p.name)) { rejected.push({composeProject: null, code: "invalid_project"}); continue; }
        arcaneProjects.set(p.name, p);
        if (!byProject.has(p.name)) byProject.set(p.name, []); // listed by Arcane, no container (stopped / never started)
    }
    const dedupRejected = new Map<string, RejectedStack>();
    for (const r of rejected) dedupRejected.set(`${r.composeProject}:${r.code}`, r);

    const stacks: NormalizedStack[] = [];
    for (const project of [...byProject.keys()].sort()) {
        try {
            stacks.push(buildStack(input, project, byProject.get(project) ?? [], arcaneProjects.get(project)));
        } catch (e) {
            const code = e instanceof LimitError ? "inventory_limit" : "inventory_invalid";
            if (!(e instanceof LimitError) && !(e instanceof InventoryRejectedError)) throw e;
            dedupRejected.set(`${project}:${code}`, {composeProject: project, code});
        }
    }
    return {stacks, rejected: [...dedupRejected.values()], unmanagedContainers: unmanaged, ignoredOneOff: oneOff};
}

class LimitError extends Error {}

function buildStack(input: NormalizeInput, project: string, group: DiscoveredContainer[], arcane: DiscoveredProject | undefined): NormalizedStack {
    const warnings: Warning[] = [];
    const prov: Inv["provenance"] = {"/stack": "container_label", "/services": "arcane_list", "/mounts": "arcane_list", "/volumes": "arcane_list", "/networks": "arcane_list"};
    const warn = (code: string, severity: Warning["severity"], messageKey: string, ptr?: string) => warnings.push({code, severity, message_key: messageKey, ...(ptr ? {path: ptr} : {})});
    const compose = input.compose?.get(project);
    const groupIds = new Set(group.map((c) => c.id));
    const imageById = new Map(input.images.map((i) => [i.id, i]));
    const volumeByName = new Map(input.volumes.map((v) => [v.name, v]));
    const networkByName = new Map(input.networks.map((n) => [n.name, n]));

    // ---- services ---------------------------------------------------------------------------------------------------
    const byService = new Map<string, DiscoveredContainer[]>();
    for (const c of group) {
        const s = c.labels[COMPOSE_LABEL.service];
        if (s === undefined || !SERVICE_NAME.test(s)) { warn("container-without-service-label", "warn", "container-without-service-label"); continue; }
        byService.set(s, [...(byService.get(s) ?? []), c]);
    }
    if (compose) for (const s of compose.services) if (!byService.has(s.name)) byService.set(s.name, []);
    if (byService.size > LIMITS.services) throw new LimitError("services");

    // mounts are collected per stack first (consumers need every service)
    type MountAcc = Inv["mounts"][number];
    const mounts = new Map<string, MountAcc>();
    const mountIdsByService = new Map<string, Set<string>>();
    const addMount = (service: string, c: DiscoveredContainer) => {
        for (const m of c.mounts) {
            const dest = safeAbsPath(m.destination);
            if (!dest) { warn("mount-destination-rejected", "warn", "mount-destination-rejected"); continue; }
            let kind: MountAcc["kind"];
            let key: string;
            let volume_name: string | undefined;
            let host_path_hint: string | undefined;
            if (m.type === "volume" && m.name) {
                const anon = /^[0-9a-f]{12}$|^[0-9a-f]{64}$/.test(m.name);
                kind = anon ? "anonymous_volume" : "named_volume";
                key = m.name;
                volume_name = m.name.slice(0, 256);
            } else if (m.type === "bind") {
                const src = safeAbsPath(m.source);
                if (!src) { warn("mount-path-rejected", "warn", "mount-path-rejected"); }
                kind = "bind";
                key = src ?? "";
                host_path_hint = src ?? undefined;
            } else if (m.type === "tmpfs") {
                kind = "tmpfs";
                key = "";
            } else { warn("mount-type-unsupported", "info", "mount-type-unsupported"); continue; }
            const id = `m:${sha(`${kind}|${key}|${dest}`).slice(0, 16)}`;
            const cur = mounts.get(id);
            if (cur) { if (!cur.consumers.includes(service)) cur.consumers.push(service); if (m.rw) cur.rw = true; }
            else {
                const entry = kind === "named_volume" || kind === "anonymous_volume" ? volumeByName.get(m.name as string) : undefined;
                mounts.set(id, {
                    id, kind, destination: dest, rw: m.rw, consumers: [service],
                    ownership: kind === "named_volume" ? ownershipOf(entry, project) : kind === "bind" ? "unknown" : "stack_owned",
                    ...(volume_name ? {volume_name} : {}), ...(host_path_hint ? {host_path_hint} : {}),
                    ...(entry?.driver ? {driver: entry.driver.slice(0, 64)} : {}),
                    ...(entry?.size && entry.size > 0 ? {size_bytes: Math.trunc(entry.size)} : {}),
                });
            }
            (mountIdsByService.get(service) ?? mountIdsByService.set(service, new Set()).get(service)!).add(id);
        }
    };

    const networkMembers = new Map<string, Set<string>>();
    const services: Inv["services"] = [];
    const serviceNames = [...byService.keys()].sort();
    for (const name of serviceNames) {
        const cs = (byService.get(name) ?? []).slice().sort((a, b) => Number(a.labels[COMPOSE_LABEL.containerNumber] ?? 1) - Number(b.labels[COMPOSE_LABEL.containerNumber] ?? 1) || a.id.localeCompare(b.id));
        const rep = cs[0];
        const declared = compose?.services.find((s) => s.name === name);
        for (const c of cs) addMount(name, c);
        if (!rep) {
            // declared in the compose file (tier 2) but no container: honest `absent`
            services.push(withoutUndef({
                name, state: "absent" as const, image: {ref: (declared?.image ?? "").slice(0, 512), pinned: /@sha256:[0-9a-f]{64}/.test(declared?.image ?? ""), built_locally: declared?.hasBuild ?? false},
                ports: [], networks: [], mounts: [], env_keys: uniqSorted(declared?.envNames ?? []).filter((k) => ENV_KEY.test(k)).slice(0, 500),
                depends_on: declared?.dependsOn.length ? uniqSorted(declared.dependsOn.filter((d) => SERVICE_NAME.test(d))) : undefined,
                profiles: declared?.profiles.length ? uniqSorted(declared.profiles) : undefined,
            }));
            continue;
        }
        const ref = rep.image.trim();
        if (ref.length > 512) throw new InventoryRejectedError("invalid", "image-ref-too-long");
        const pinned = /@sha256:[0-9a-f]{64}/.test(ref);
        const entry = rep.imageId ? imageById.get(rep.imageId) : undefined;
        let digest = /@(sha256:[0-9a-f]{64})/.exec(ref)?.[1];
        if (!digest && entry) {
            const prefix = repoPath(ref);
            const hit = entry.repoDigests.find((d) => repoPath(d) === prefix) ?? entry.repoDigests[0];
            digest = hit ? /@(sha256:[0-9a-f]{64})$/.exec(hit)?.[1] : undefined;
        }
        const ports = uniqueBy(rep.ports.map((p) => ({target: p.privatePort, ...(p.publicPort && p.publicPort > 0 ? {published: p.publicPort} : {}), protocol: p.type === "udp" ? "udp" as const : "tcp" as const})),
            (p) => `${p.target}/${p.published ?? ""}/${p.protocol}`).sort((a, b) => a.target - b.target || (a.published ?? 0) - (b.published ?? 0) || a.protocol.localeCompare(b.protocol));
        const nets = uniqSorted(rep.networks.filter((n) => n.length <= 128));
        for (const n of nets) (networkMembers.get(n) ?? networkMembers.set(n, new Set()).get(n)!).add(name);
        const {hints, ignored} = parseBackupHints(rep.labels);
        if (ignored) warn("backup-hint-ignored", "info", "backup-hint-ignored", undefined);
        const mountDefs = [...(mountIdsByService.get(name) ?? [])].map((id) => mounts.get(id) as MountAcc);
        const dbHint = detectDatabase(ref, ports, mountDefs);
        const dependsOn = parseDependsOnLabel(rep.labels[COMPOSE_LABEL.dependsOn]);
        const envNames = uniqSorted([...(declared?.envNames ?? [])]).filter((k) => ENV_KEY.test(k)).slice(0, 500);
        const specialMode = rep.networkMode && (rep.networkMode === "host" || rep.networkMode === "none" || rep.networkMode.startsWith("container:")) ? rep.networkMode.slice(0, 64) : undefined;
        const state = STATES[rep.state];
        if (!state) warn("unknown-container-state", "info", "unknown-container-state");
        const running = cs.some((c) => c.state === "running");
        services.push(withoutUndef({
            name, state: running ? "running" as const : state ?? "exited" as const,
            ...(rep.id.length >= 12 && rep.id.length <= 64 ? {container_id: rep.id} : {}),
            image: {ref, ...(digest ? {digest} : {}), pinned, built_locally: !!entry && entry.repoDigests.length === 0 || (declared?.hasBuild ?? false)},
            ports, networks: nets, mounts: [...(mountIdsByService.get(name) ?? [])].sort(), env_keys: envNames,
            depends_on: dependsOn.length ? dependsOn : declared?.dependsOn.length ? uniqSorted(declared.dependsOn.filter((d) => SERVICE_NAME.test(d))) : undefined,
            privileged: rep.privileged ? true : undefined, network_mode: specialMode,
            profiles: declared?.profiles.length ? uniqSorted(declared.profiles) : undefined,
            backup_hints: hints, database_hint: dbHint,
        }));
        if (!pinned) warn("image-not-pinned", "info", "image-not-pinned", undefined);
        if (rep.privileged) warn("privileged-service", "warn", "privileged-service", undefined);
    }
    if (mounts.size > LIMITS.mounts) throw new LimitError("mounts");
    services.sort((a, b) => a.name.localeCompare(b.name));

    // ---- mounts, volumes ----------------------------------------------------------------------------------------------
    const mountList = [...mounts.values()].map((m) => ({...m, consumers: uniqSorted(m.consumers)})).sort((a, b) => a.id.localeCompare(b.id));
    mountList.forEach((m, i) => { if (m.kind === "anonymous_volume") warn("anonymous-volume-not-backed-up", "warn", "anonymous-volume-not-backed-up", `/mounts/${i}`); if (m.kind === "bind") warn("bind-mount-host-path", "info", "bind-mount-host-path", `/mounts/${i}`); });
    const volNames = new Set<string>(mountList.filter((m) => m.kind === "named_volume").map((m) => m.volume_name as string));
    for (const v of input.volumes) if (v.labels["com.docker.compose.project"] === project) volNames.add(v.name);
    const volumes: Inv["volumes"] = [...volNames].sort().map((vn) => {
        const entry = volumeByName.get(vn);
        const {hints} = entry ? parseBackupHints(entry.labels) : {hints: undefined};
        return withoutUndef({
            name: vn.slice(0, 256), driver: (entry?.driver ?? "local").slice(0, 64),
            in_use_by: uniqSorted(mountList.filter((m) => m.volume_name === vn).flatMap((m) => m.consumers)),
            ownership: ownershipOf(entry, project), size_bytes: entry?.size && entry.size > 0 ? Math.trunc(entry.size) : undefined, backup_hints: hints,
        });
    });

    // ---- networks -------------------------------------------------------------------------------------------------------
    const netNames = new Set<string>([...networkMembers.keys()].filter((n) => !BUILTIN_NETWORKS.has(n)));
    for (const n of input.networks) if (n.labels["com.docker.compose.project"] === project && !n.isDefault && !BUILTIN_NETWORKS.has(n.name)) netNames.add(n.name);
    const others = new Map<string, number>(); // network → containers of OTHER stacks/hosts on it
    for (const c of input.containers) if (!groupIds.has(c.id)) for (const n of c.networks) others.set(n, (others.get(n) ?? 0) + 1);
    const networks: Inv["networks"] = [];
    const external: Inv["external_dependencies"] = [];
    for (const name of [...netNames].sort()) {
        const entry = networkByName.get(name);
        const owner = entry?.labels["com.docker.compose.project"];
        const classification: NonNullable<Inv["networks"][number]["classification"]> =
            owner === project ? "stack_owned" : entry || owner || (others.get(name) ?? 0) > 0 || compose?.externalNetworks.includes(name) ? "shared_external" : "manual";
        networks.push({name, driver: (entry?.driver ?? "bridge").slice(0, 64), internal: false, external: classification !== "stack_owned", members: uniqSorted(networkMembers.get(name) ?? []), classification});
        if (classification !== "stack_owned") {
            external.push({kind: "network", name, note_key: classification === "shared_external" ? "network-external-shared" : "network-external-manual"});
            warn(classification === "shared_external" ? "network-shared-external" : "network-manual", "warn", classification === "shared_external" ? "network-shared-external" : "network-manual", `/networks/${networks.length - 1}`);
        }
    }
    for (const v of volumes) if (v.ownership !== "stack_owned") external.push({kind: "volume", name: v.name, note_key: "volume-external"});
    for (const b of uniqSorted(mountList.filter((m) => m.kind === "bind").map((m) => m.host_path_hint as string).filter(Boolean))) external.push({kind: "host_path", name: b.slice(0, 256), note_key: "bind-host-path"});
    external.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

    // ---- stack facts, env files -------------------------------------------------------------------------------------------
    const any = group[0];
    const wd = safeAbsPath(any?.labels[COMPOSE_LABEL.workingDir]);
    const cfg = parsePathList(any?.labels[COMPOSE_LABEL.configFiles]);
    if ((any?.labels[COMPOSE_LABEL.workingDir] !== undefined && !wd) || cfg.rejected) warn("label-path-rejected", "warn", "label-path-rejected");
    const display = cleanName(arcane?.name) ?? project;
    if (arcane) prov["/stack/display_name"] = "arcane_list";
    if (wd) prov["/stack/working_dir_hint"] = "container_label";
    if (cfg.paths.length) prov["/stack/config_files_hint"] = "container_label";
    services.forEach((s, i) => {
        if (s.backup_hints) prov[`/services/${i}/backup_hints`] = "container_label";
        if (s.depends_on) prov[`/services/${i}/depends_on`] = "container_label";
        if (s.image.digest) prov[`/services/${i}/image/digest`] = "arcane_list";
        if (compose) { prov[`/services/${i}/env_keys`] = "arcane_compose"; if (s.profiles) prov[`/services/${i}/profiles`] = "arcane_compose"; }
        if (s.database_hint) prov[`/services/${i}/database_hint`] = "arcane_list";
    });
    volumes.forEach((v, i) => { if (v.backup_hints) prov[`/volumes/${i}/backup_hints`] = "container_label"; });
    const envFiles: Inv["env_files"] = [];
    if (compose) {
        const refs = new Map<string, Set<string>>();
        for (const s of compose.services) for (const f of s.envFiles) (refs.get(f) ?? refs.set(f, new Set()).get(f)!).add(s.name);
        for (const [path_hint, by] of [...refs].sort(([a], [b]) => a.localeCompare(b))) envFiles.push({path_hint, key_names: [], referenced_by: uniqSorted(by)});
        prov["/env_files"] = "arcane_compose";
    } else {
        const why = input.composeRejected?.get(project);
        if (why) warn("compose-yaml-rejected", "warn", `compose-yaml-${why}`);
        else warn("compose-definition-not-read", "info", "compose-definition-not-read");
    }

    const state = runtimeOf(services, arcane);
    const inv = parseInventoryStrict({
        schema_version: 1,
        captured_at: input.capturedAt.toISOString(),
        source: {arcane_version: input.arcaneVersion.slice(0, 64), openapi_sha256: `sha256:${ARCANE_OPENAPI_SHA256}`, connection_id: input.connectionId, environment_id: input.environmentId},
        stack: {compose_project: project, display_name: display, compose_read: compose ? "arcane_compose" : "none", ...(wd ? {working_dir_hint: wd} : {}), config_files_hint: cfg.paths},
        services, mounts: mountList, volumes, networks, env_files: envFiles, external_dependencies: external, provenance: prov,
        warnings: dedupeWarnings(warnings),
    });
    return {composeProject: project, displayName: display, runtimeState: state, inventory: inv, contentHash: contentHash(inv), counts: {services: services.length, mounts: mountList.length, volumes: volumes.length, networks: networks.length, warnings: inv.warnings.length}};
}

function ownershipOf(entry: DiscoveredVolume | undefined, project: string): "stack_owned" | "external_shared" | "unknown" {
    if (!entry) return "unknown";
    return entry.labels["com.docker.compose.project"] === project ? "stack_owned" : "external_shared";
}

function runtimeOf(services: Inv["services"], arcane: DiscoveredProject | undefined): Runtime {
    const present = services.filter((s) => s.state !== "absent");
    if (present.length) {
        const running = present.filter((s) => s.state === "running").length;
        return running === present.length ? "running" : running > 0 ? "partial" : "stopped";
    }
    const st = (arcane?.status ?? "").toLowerCase();
    if (st.includes("partial")) return "partial";
    if (st.includes("running")) return "running";
    if (/stopped|down|exited/.test(st)) return "stopped";
    return arcane ? "unknown" : "absent";
}

function dedupeWarnings(ws: Warning[]): Warning[] {
    const seen = new Set<string>();
    const out: Warning[] = [];
    for (const w of ws) { const k = `${w.code}|${w.path ?? ""}`; if (!seen.has(k)) { seen.add(k); out.push(w); } }
    return out.sort((a, b) => a.code.localeCompare(b.code) || (a.path ?? "").localeCompare(b.path ?? "")).slice(0, 1000);
}

function uniqueBy<T>(a: T[], key: (t: T) => string): T[] {
    const m = new Map<string, T>();
    for (const x of a) if (!m.has(key(x))) m.set(key(x), x);
    return [...m.values()];
}

function withoutUndef<T extends Record<string, unknown>>(o: T): T {
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
}
