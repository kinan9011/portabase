import {createHash} from "node:crypto";
import {canonicalJson} from "@/fork/canonical";
import {PROJECT_RE as MIRROR_PROJECT_RE} from "@/fork/compose-compiler/rules";
import {isDockerSocket, isSystemPath, isUnder, normPath} from "@/fork/completeness/rules";
import {PROJECT_NAME, SERVICE_NAME, safeAbsPath, safePathHint} from "@/fork/inventory/labels";
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {DUMP_ENGINES, isAdoptableVolumeName} from "@/fork/materialize/types";
import {RP_STATUSES} from "@/fork/recovery/status";
import {PlanInputV1, RestorePlanV1, type Action} from "./schema";
import {
    ACTION_KINDS, APPROVAL_CAPABILITY, APPROVAL_KINDS, PHASES, PLAN_VERSION, PRECONDITIONS, type ApprovalKind, type Reason,
} from "./vocab";

/**
 * The restore planner (W16, ADR-014). PURE and deterministic: no clock, no DB, no env, no randomness, no network, no secrets
 * (there is no field that could hold one). `planRestore(input)` → `{plan, planHash, inputsDigest}`.
 *
 * Hash binding (D-W16-2): `inputsDigest = sha256(canonicalJson(normalized input))` is folded INTO the plan, and
 * `planHash = sha256(canonicalJson(plan))`. Any change of any input therefore changes the plan hash, even when the derived actions are
 * identical. Arrays are sorted by stable keys before hashing, so the hash is permutation-invariant.
 * Refusals (D43 / D44) throw `PlannerRefusal`; the service turns them into audited refusals.
 */
export class PlannerRefusal extends Error {
    constructor(readonly code: "rp_not_verified" | "rp_purged" | "test_restore_target_not_test" | "personal_data_no_opt_in" | "test_restore_mode_invalid" | "mirror_mode_invalid" | "mirror_target_not_runner" | "personal_data_no_mirror_opt_in") {
        super(code);
        this.name = "PlannerRefusal";
    }
}

const sha = (v: unknown): string => createHash("sha256").update(canonicalJson(v)).digest("hex");
const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);
const sortBy = <T>(arr: readonly T[], key: (t: T) => (string | number)[]): T[] =>
    [...arr].sort((x, y) => { const kx = key(x), ky = key(y); for (let i = 0; i < kx.length; i++) { const c = cmp(kx[i], ky[i]); if (c) return c; } return 0; });
const uniqSorted = (a: readonly string[]): string[] => [...new Set(a)].sort(cmp);
const RP_VERIFIED = RP_STATUSES[2];
const badChars = (s: string): boolean => s.includes("$") || s.includes("~");

// ---- normalisation -------------------------------------------------------------------------------------------------------------

function normalizeInventory(inv: StackInventoryV1): StackInventoryV1 {
    return {
        ...inv,
        services: sortBy(inv.services, (s) => [s.name]).map((s) => ({
            ...s,
            ports: sortBy(s.ports, (p) => [p.target, p.published ?? -1, p.protocol]),
            networks: uniqSorted(s.networks), mounts: uniqSorted(s.mounts), env_keys: uniqSorted(s.env_keys),
            ...(s.depends_on ? {depends_on: uniqSorted(s.depends_on)} : {}), ...(s.profiles ? {profiles: uniqSorted(s.profiles)} : {}),
        })),
        mounts: sortBy(inv.mounts, (m) => [m.id]).map((m) => ({...m, consumers: uniqSorted(m.consumers)})),
        volumes: sortBy(inv.volumes, (v) => [v.name]).map((v) => ({...v, in_use_by: uniqSorted(v.in_use_by)})),
        networks: sortBy(inv.networks, (n) => [n.name]).map((n) => ({...n, members: uniqSorted(n.members), ...(n.subnets ? {subnets: uniqSorted(n.subnets)} : {})})),
        env_files: sortBy(inv.env_files, (e) => [e.path_hint]).map((e) => ({...e, key_names: uniqSorted(e.key_names), referenced_by: uniqSorted(e.referenced_by)})),
        external_dependencies: sortBy(inv.external_dependencies, (e) => [e.kind, e.name, e.note_key]),
        warnings: sortBy(inv.warnings, (w) => [w.code, w.path ?? "", w.severity, w.message_key]),
    };
}

/** Sorts every set-like array by a stable key so the digest is permutation-invariant. `config_files_hint` is ordered (compose override order) and kept. */
export function normalizeInput(i: PlanInputV1): PlanInputV1 {
    const f = i.target.facts;
    return {
        ...i,
        mappings: {...i.mappings, select: i.mappings.select && uniqSorted(i.mappings.select)},
        artifacts: sortBy(i.artifacts.map((a) => ({...a, source: a.source && {...a.source, covers_keys: uniqSorted(a.source.covers_keys)}})), (a) => [a.source_name, a.channel_id ?? "", a.id]),
        inventory: i.inventory && normalizeInventory(i.inventory),
        selection: {sqlite: i.selection.sqlite, manual_paths: uniqSorted(i.selection.manual_paths)},
        target: {
            ...i.target,
            enrollment: i.target.enrollment && {...i.target.enrollment, capabilities: uniqSorted(i.target.enrollment.capabilities)},
            environments: sortBy(i.target.environments.map((e) => ({...e, allowed_path_roots: uniqSorted(e.allowed_path_roots)})), (e) => [e.id]),
            facts: {
                ...f,
                projects: uniqSorted(f.projects), volumes: uniqSorted(f.volumes), networks: uniqSorted(f.networks), bind_paths: uniqSorted(f.bind_paths),
                inventory_hashes: uniqSorted(f.inventory_hashes),
                published_ports: sortBy(f.published_ports, (p) => [p.port, p.protocol]).filter((p, ix, a) => ix === 0 || p.port !== a[ix - 1].port || p.protocol !== a[ix - 1].protocol),
                image_platforms: f.image_platforms && Object.fromEntries(Object.entries(f.image_platforms).map(([k, v]) => [k, uniqSorted(v)])),
            },
        },
    };
}

export function hashPlan(plan: RestorePlanV1): string {
    return sha(RestorePlanV1.parse(plan));
}

// ---- the rules -----------------------------------------------------------------------------------------------------------------

type InArt = PlanInputV1["artifacts"][number];
type Group = {key: string; arts: InArt[]; present: InArt[]; role: NonNullable<InArt["source"]>["role"] | null; dbms: string | null; member: string | null; required: boolean};
type Decision = RestorePlanV1["decisions"][number];
type Prec = RestorePlanV1["preconditions"][number];
type ActionDraft = Omit<Action, "id" | "order">;
type Kind = "compose" | "volume" | "bind" | "dump" | "sqlite" | "stage";

const groupOrder: Kind[] = ["compose", "volume", "bind", "dump", "stage", "sqlite"];

function classify(g: Group): Kind {
    if (g.role === null) return "stage";
    if (g.role === "compose" || g.role === "env") return "compose";
    if (g.role === "volume" || g.dbms === "docker-volume") return "volume";
    if (g.role === "bind") return "bind";
    if (g.role === "db") {
        if (g.dbms === "sqlite") return "sqlite";
        if ((DUMP_ENGINES as readonly string[]).includes(g.dbms ?? "")) return "dump";
    }
    return "stage";
}

/** Candidate order (D-W16-16): non-`local` channels first, then channel id, then artifact id. */
const candidateOrder = (a: InArt): (string | number)[] => [a.channel_kind === "local" ? 1 : 0, a.channel_id ?? "", a.id];

export function planRestore(raw: PlanInputV1): {plan: RestorePlanV1; planHash: string; inputsDigest: string} {
    const input = normalizeInput(PlanInputV1.parse(raw));
    const inputsDigest = sha(input);
    const {purpose, mode, mappings, rp, stack, target, inventory} = input;
    const test = purpose === "test_restore";
    const mirror = purpose === "mirror"; // W22a: a runner-only, approval-free, new_stack-like plan (the W20 compiler is authoritative for compose and secrets)
    const existing = mode === "existing_stack";
    const facts = target.facts;

    // 1. refusals (D43 / D44) ------------------------------------------------------------------------------------------------------
    if (rp.purged) throw new PlannerRefusal("rp_purged");
    if (rp.rp_status !== RP_VERIFIED) throw new PlannerRefusal("rp_not_verified");
    if (test) {
        if (mode !== "new_stack") throw new PlannerRefusal("test_restore_mode_invalid");
        if (target.environments.length === 0 || target.environments.some((e) => e.host_role !== "test")) throw new PlannerRefusal("test_restore_target_not_test");
        if (stack.contains_personal_data !== false && !stack.test_restore_opt_in) throw new PlannerRefusal("personal_data_no_opt_in");
    }
    if (mirror) {
        if (mode !== "new_stack") throw new PlannerRefusal("mirror_mode_invalid");
        if (!target.runner_eligible || target.environments.length > 0) throw new PlannerRefusal("mirror_target_not_runner");
        if (stack.contains_personal_data !== false && !stack.mirror_opt_in) throw new PlannerRefusal("personal_data_no_mirror_opt_in");
    }

    const blockers = new Set<Reason>();
    const decisions: Decision[] = [];
    const preconditions = new Map<Prec["code"], Prec>();
    const pre = (code: Prec["code"], state: Prec["state"], checked_by: Prec["checked_by"], reason: Reason | null = null) => { preconditions.set(code, {code, state, checked_by, reason}); };
    const decide = (code: Reason, subject: string, flagged: boolean, suggestion: string | null = null) => { decisions.push({code, subject: subject.slice(0, 1200), suggestion, flagged}); };

    // 2. target block ---------------------------------------------------------------------------------------------------------------
    const envs = target.environments;
    const hostRole: RestorePlanV1["target"]["host_role"] = mirror ? "runner" : envs.length === 0 || envs.some((e) => e.host_role === "production") ? "production" : "test";
    const hostRoleSource = envs.length === 0 ? "default" : "environment";
    const enr = target.enrollment;
    const caps = new Set(enr?.capabilities ?? []);
    const enrolledReason: Reason | null = target.archived ? "target_agent_archived" : !enr ? "target_not_enrolled" : enr.revoked ? "target_revoked" : !enr.enabled ? "target_channel_disabled" : null;
    if (enrolledReason) { blockers.add(enrolledReason); pre("target_enrolled", "unmet", "dashboard", enrolledReason); } else pre("target_enrolled", "met", "dashboard");
    if (mirror ? caps.has("runner.v1") && caps.has("mirror.v1") : caps.has("restore.target.v1")) pre("target_capability_restore", "met", "dashboard");
    else { blockers.add("target_capability_missing"); pre("target_capability_restore", "unmet", "dashboard", "target_capability_missing"); }
    const factsFresh = envs.length > 0 && envs.every((e) => e.facts_fresh);
    if (factsFresh) pre("target_facts_fresh", "met", "dashboard");
    else pre("target_facts_fresh", "deferred", "agent", envs.length === 0 ? "no_target_inventory" : "target_facts_stale");
    pre("restore_root_on_agent", "deferred", "agent");
    pre("target_empty", "deferred", "agent");
    pre("manifest_signature", "deferred", "orchestrator");
    if (existing) pre("safety_snapshot", "deferred", "orchestrator");

    // 3. RP block -------------------------------------------------------------------------------------------------------------------
    if (rp.manifest_sha256 === null) blockers.add("manifest_unbound");
    if (inventory === null && !test && mode !== "selective") blockers.add("inventory_missing");
    if (inventory !== null && input.inventory_content_hash !== rp.inventory_hash) blockers.add("inventory_mismatch");
    if (input.artifacts.some((a) => a.required && a.presence !== "present")) blockers.add("required_artifact_missing");

    // 4. target project -------------------------------------------------------------------------------------------------------------
    const sourceProject = stack.compose_project;
    let project = mappings.target_project ?? sourceProject;
    if (existing) {
        if (mappings.target_project !== null && mappings.target_project !== sourceProject) { blockers.add("project_name_conflict"); decide("project_name_conflict", mappings.target_project, true); }
        project = sourceProject;
        if (!facts.projects.includes(project)) blockers.add("existing_stack_not_on_target");
    } else if (mirror) {
        if (!MIRROR_PROJECT_RE.test(project)) { blockers.add("project_name_conflict"); decide("project_name_conflict", project, true); } // a runner has no environment facts: no collision check
    } else if (!test && facts.projects.includes(project)) {
        blockers.add("project_name_conflict");
        const alt = `${project}-restored`;
        decide("project_name_conflict", project, true, PROJECT_NAME.test(alt) && !facts.projects.includes(alt) ? alt : null);
    }

    // 5. restore_root (D-W16-9) -----------------------------------------------------------------------------------------------------
    const knownRoots = uniqSorted(envs.flatMap((e) => e.allowed_path_roots));
    const rootVerdict = (p: string): Reason | null => knownRoots.length === 0 ? "allowed_roots_unknown" : knownRoots.some((r) => isUnder(p, r)) ? null : "path_outside_allowed_roots";
    const rootCheck: {ok: true; root: string} | {ok: false; reason: Reason} = (() => {
        const rr = mappings.restore_root;
        if (rr === null || rr === "") return {ok: false, reason: "restore_root_required"};
        const n = safeAbsPath(rr);
        if (n === null || badChars(rr) || n === "/" || isSystemPath(n) || isDockerSocket(n)) return {ok: false, reason: "restore_root_rejected"};
        if (knownRoots.length > 0 && !knownRoots.some((r) => isUnder(n, r) && normPath(n) !== normPath(r))) return {ok: false, reason: "restore_root_outside_allowed_roots"};
        return {ok: true, root: n};
    })() as {ok: true; root: string} | {ok: false; reason: Reason};
    const rootBlock = (): Reason[] => (rootCheck.ok ? [] : [rootCheck.reason]);
    const rootPath = (...segs: string[]): string | null => (rootCheck.ok ? [rootCheck.root, project, ...segs].join("/") : null);
    const scratch = (...segs: string[]): string | null => rootPath("scratch", ...segs);

    // 6. group artifacts into resources ---------------------------------------------------------------------------------------------
    const byKey = new Map<string, InArt[]>();
    for (const a of input.artifacts) { const k = a.source?.resource_key ?? `artifact:${a.id}`; byKey.set(k, [...(byKey.get(k) ?? []), a]); }
    const groups: Group[] = [...byKey.entries()].sort((x, y) => cmp(x[0], y[0])).map(([key, arts]) => {
        const sorted = sortBy(arts, candidateOrder);
        const s = sorted[0].source;
        return {key, arts: sorted, present: sorted.filter((a) => a.presence === "present"), role: s?.role ?? null, dbms: s?.dbms ?? null, member: s?.member_name ?? null, required: sorted.some((a) => a.required)};
    });
    const selectSet = new Set(mappings.select ?? []);
    if (mode === "selective") {
        if (selectSet.size === 0) blockers.add("nothing_selected");
        const known = new Set(groups.map((g) => g.key));
        for (const k of selectSet) if (!known.has(k)) { blockers.add("selection_unknown_key"); decide("selection_unknown_key", k, true); }
    }

    const drafts: ActionDraft[] = [];
    const nonSkipped: Group[] = [];
    const volumeDest = new Map<string, string>(); // destination volume name → resource key (for sqlite mappings)
    const inv = inventory;
    const mountById = new Map((inv?.mounts ?? []).map((m) => [m.id, m]));

    const mk = (g: Group | null, o: {kind: Action["kind"]; phase: Action["phase"]; op: Action["op"]; destructive?: boolean; approval?: boolean; block?: Reason[]; info?: Reason[];
        dest: Action["destination"]; original?: string | null; service?: string | null; artifacts?: InArt[]}): ActionDraft => {
        const block = uniqReasons(o.block ?? []);
        const info = uniqReasons([...(o.info ?? []), ...(g && o.artifacts?.[0]?.archive_kind === "restic_snapshot" ? ["restic_payload_credential" as Reason] : [])]);
        const first = o.artifacts?.[0];
        for (const b of block) blockers.add(b);
        return {
            phase: o.phase, kind: o.kind, op: o.op, risk: block.length ? "blocked" : o.approval ? "needs_approval" : "safe", destructive: o.destructive === true,
            resource_key: g?.key ?? null, artifact_ids: (o.artifacts ?? []).slice(0, 16).map((a) => a.id),
            expect: {plaintext_sha256: first?.plaintext_sha256 ?? null, plaintext_size: first?.plaintext_size ?? null},
            source: {role: g?.role ?? null, dbms: g?.dbms ?? null, member: g?.member ?? null, original_path: o.original ?? null, service: o.service ?? null},
            destination: o.dest, reasons: uniqReasons([...block, ...info]),
        };
    };
    const noDest = (kind: Action["destination"]["kind"]): Action["destination"] => ({kind, name: null, path: null, relative_path: null});
    const pathDest = (kind: "path" | "stage", p: string | null): Action["destination"] => ({kind, name: null, path: p, relative_path: null});
    const kindOf: Record<Kind, Action["kind"]> = {compose: "restore_compose_dir", volume: "restore_volume", bind: "restore_path", dump: "restore_db_dump", sqlite: "restore_sqlite_file", stage: "stage_only"};
    const phaseOf: Record<Kind, Action["phase"]> = {compose: "stage", volume: "data", bind: "data", dump: "db", sqlite: "db", stage: "stage"};
    const slug = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 8);
    /** hostile hint → normalised absolute path, or null */
    const cleanOriginal = (hint: unknown): string | null => {
        const p = safeAbsPath(hint);
        return p === null || badChars(p) || isSystemPath(p) || isDockerSocket(p) ? null : p;
    };

    for (const kind of groupOrder) {
        for (const g of groups.filter((x) => classify(x) === kind)) {
            const cands = g.present;
            const skipReason: Reason | null = mode === "selective" && !selectSet.has(g.key) ? "not_selected" : !g.required ? "optional_artifact" : null;
            if (skipReason || cands.length === 0) {
                if (skipReason || !g.required) drafts.push(mk(g, {kind: kindOf[kind], phase: phaseOf[kind], op: "skip", info: [skipReason ?? "optional_artifact"], dest: noDest(kind === "volume" ? "volume" : kind === "dump" || kind === "sqlite" ? "db_service" : "path"), artifacts: cands}));
                continue; // a required resource without a present artifact is already the plan blocker `required_artifact_missing`
            }
            nonSkipped.push(g);
            const a = {artifacts: cands};
            const suffixOf = (prefix: string): string | null => (g.key.startsWith(prefix) ? g.key.slice(prefix.length) : null);
            if (kind === "compose") {
                const wd = suffixOf("dir:") ?? inv?.stack.working_dir_hint ?? null;
                if (test) { drafts.push(mk(g, {kind: kindOf[kind], phase: "stage", op: "create", block: rootBlock(), dest: pathDest("path", scratch("compose")), ...a})); continue; }
                if (existing) {
                    const orig = cleanOriginal(wd);
                    const block: Reason[] = orig === null ? ["path_rejected"] : [...(rootVerdict(orig) ? [rootVerdict(orig) as Reason] : [])];
                    drafts.push(mk(g, {kind: kindOf[kind], phase: "stage", op: "replace", destructive: true, approval: true, block, info: ["replaces_existing_data"], original: orig, dest: pathDest("path", block.length ? null : orig), ...a}));
                    continue;
                }
                drafts.push(mk(g, {kind: kindOf[kind], phase: "stage", op: "create", block: rootBlock(), original: cleanOriginal(wd), dest: pathDest("path", rootPath("compose")), ...a}));
            } else if (kind === "volume") {
                const src = suffixOf("volume:");
                if (src === null || !isAdoptableVolumeName(src)) { drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "create", block: ["volume_name_rejected"], dest: noDest("volume"), ...a})); continue; }
                if (test) { drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "create", block: rootBlock(), dest: pathDest("path", scratch("volumes", src)), ...a})); continue; }
                const renamed = project !== sourceProject && src.startsWith(`${sourceProject}_`) ? `${project}_${src.slice(sourceProject.length + 1)}` : src;
                const dest = mappings.volumes?.[src] ?? renamed;
                if (!isAdoptableVolumeName(dest)) { drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "create", block: ["volume_name_rejected"], dest: noDest("volume"), ...a})); continue; }
                const exists = facts.volumes.includes(dest);
                volumeDest.set(dest, g.key);
                const vd: Action["destination"] = {kind: "volume", name: dest, path: null, relative_path: null};
                if (existing) drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: exists ? "replace" : "create", destructive: exists, approval: exists, info: exists ? ["replaces_existing_data"] : [], dest: vd, ...a}));
                else if (exists) {
                    const alt = `${dest}-restored`;
                    decide("volume_exists", dest, true, isAdoptableVolumeName(alt) && !facts.volumes.includes(alt) ? alt : null);
                    drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "create", block: ["volume_exists"], dest: vd, ...a}));
                } else drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "create", dest: vd, ...a}));
            } else if (kind === "bind") {
                const hint = suffixOf("manual:") ?? (suffixOf("mount:") !== null ? mountById.get(suffixOf("mount:") as string)?.host_path_hint : undefined);
                const orig = cleanOriginal(hint);
                if (orig === null) { drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "create", block: ["path_rejected"], dest: noDest("path"), ...a})); continue; }
                const rel = orig.slice(1);
                if (test) { drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "create", block: rootBlock(), original: orig, dest: pathDest("path", scratch("binds", rel)), ...a})); continue; }
                if (existing) {
                    const v = rootVerdict(orig);
                    drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "replace", destructive: true, approval: true, block: v ? [v] : [], info: ["replaces_existing_data"], original: orig, dest: pathDest("path", v ? null : orig), ...a}));
                    continue;
                }
                const dp = rootPath("binds", rel);
                const inUse = dp !== null && facts.bind_paths.some((b) => isUnder(dp, b) || isUnder(b, dp));
                if (inUse) decide("path_in_use", dp as string, true);
                drafts.push(mk(g, {kind: kindOf[kind], phase: "data", op: "create", block: [...rootBlock(), ...(inUse ? ["path_in_use" as Reason] : [])], original: orig, dest: pathDest("path", dp), ...a}));
            } else if (kind === "dump") {
                const svc = suffixOf("db:");
                if (svc === null || !SERVICE_NAME.test(svc)) { drafts.push(mk(g, {kind: kindOf[kind], phase: "db", op: "create", block: ["path_rejected"], dest: noDest("db_service"), ...a})); continue; }
                if (test) { drafts.push(mk(g, {kind: kindOf[kind], phase: "db", op: "create", block: rootBlock(), service: svc, dest: pathDest("path", scratch("db", svc)), ...a})); continue; }
                drafts.push(mk(g, {kind: kindOf[kind], phase: "db", op: existing ? "replace" : "create", destructive: existing, approval: existing, info: existing ? ["replaces_existing_data"] : [], service: svc,
                    dest: {kind: "db_service", name: svc, path: null, relative_path: null}, ...a}));
            } else if (kind === "sqlite") {
                const svc = suffixOf("db:");
                if (svc === null || !SERVICE_NAME.test(svc)) { drafts.push(mk(g, {kind: kindOf[kind], phase: "db", op: "create", block: ["path_rejected"], dest: noDest("db_service"), ...a})); continue; }
                if (test) { drafts.push(mk(g, {kind: kindOf[kind], phase: "db", op: "create", block: rootBlock(), service: svc, dest: pathDest("path", scratch("db", svc)), ...a})); continue; }
                const map = mappings.sqlite?.[svc];
                if (!map) {
                    decide("sqlite_placement_unresolved", g.key, true);
                    drafts.push(mk(g, {kind: kindOf[kind], phase: "db", op: "stage_only", approval: true, block: rootBlock(), info: ["sqlite_placement_unresolved"], service: svc, dest: pathDest("stage", rootPath("stage", slug(cands[0].id))), ...a}));
                    continue;
                }
                const rel = safePathHint(map.relative_path);
                const ok = rel !== null && !rel.startsWith("/") && !rel.includes("\\") && !badChars(rel) && volumeDest.has(map.volume);
                if (!ok) { decide("sqlite_mapping_rejected", g.key, true); drafts.push(mk(g, {kind: kindOf[kind], phase: "db", op: "stage_only", block: ["sqlite_mapping_rejected"], service: svc, dest: noDest("stage"), ...a})); continue; }
                // Replaces a file the SAME plan just created inside the restored volume: not destructive, no approval.
                drafts.push(mk(g, {kind: kindOf[kind], phase: "db", op: "replace", service: svc, dest: {kind: "volume", name: map.volume, path: null, relative_path: rel}, ...a}));
            } else {
                decide("artifact_unmapped", g.key, true);
                drafts.push(mk(g, {kind: "stage_only", phase: "stage", op: "stage_only", approval: !test, block: rootBlock(), info: ["artifact_unmapped"],
                    dest: pathDest("stage", test ? scratch("stage", slug(cands[0].id)) : rootPath("stage", slug(cands[0].id))), ...a}));
            }
        }
    }

    const composeDirAction = drafts.some((d) => d.kind === "restore_compose_dir" && d.op !== "skip");
    const startPhase = !test && mode !== "selective";
    const willComposeUp = startPhase && drafts.some((d) => d.kind === "restore_compose_dir" && d.op !== "skip");
    if (startPhase && !willComposeUp) blockers.add("compose_not_in_backup");

    // 8. networks ---------------------------------------------------------------------------------------------------------------------
    if (inv && startPhase && !mirror) { // mirror: the W20 compiler replaces external networks with created internal ones, the plan carries none
        for (const n of inv.networks) {
            const cls = n.classification ?? (n.external ? "shared_external" : "stack_owned");
            if (cls === "stack_owned") {
                if (mode === "new_stack") {
                    const suffix = n.name.startsWith(`${sourceProject}_`) ? n.name.slice(sourceProject.length + 1) : n.name;
                    const dest = `${project}_${suffix}`;
                    if (facts.networks.includes(dest)) { blockers.add("network_name_conflict"); decide("network_name_conflict", dest, true); }
                }
            } else if (facts.networks.includes(n.name)) decide("shared_network_reused", n.name, true);
            else {
                decide("shared_network_missing", n.name, true);
                drafts.push(mk(null, {kind: "create_network", phase: "start", op: "create", approval: true, info: ["shared_network_missing"], dest: {kind: "network", name: n.name.slice(0, 255), path: null, relative_path: null}}));
                drafts[drafts.length - 1].resource_key = `network:${n.name}`.slice(0, 1200);
            }
        }
    }

    // 9. images + 11. ports (only when a compose_up will exist) ----------------------------------------------------------------------
    let archState: Prec["state"] = "deferred";
    let archReason: Reason | null = null;
    let portInUse = false;
    if (inv && willComposeUp) {
        let allKnown = inv.services.length > 0;
        for (const s of inv.services) {
            if (s.image.built_locally) {
                if (!target.same_environment) { blockers.add("image_unpublished"); decide("image_unpublished", s.name, true); } else decide("image_unpublished", s.name, false);
            }
            if (!s.image.pinned || !s.image.digest) decide("image_unpinned", s.name, false);
            const plats = facts.image_platforms?.[s.image.ref];
            if (facts.arch && plats) { if (!plats.includes(facts.arch)) { blockers.add("arch_mismatch"); archState = "unmet"; archReason = "arch_mismatch"; } } else allKnown = false;
        }
        if (archState !== "unmet" && allKnown && facts.arch) archState = "met";
        pre("arch_compat", archState, archState === "met" || archState === "unmet" ? "dashboard" : "agent", archReason);
        const used = new Set(facts.published_ports.map((p) => `${p.port}/${p.protocol}`));
        if (!mirror) for (const s of inv.services) for (const p of s.ports) { // mirror: W20 drops source ports
            if (p.published && p.published > 0 && used.has(`${p.published}/${p.protocol}`)) { portInUse = true; decide("port_in_use", `${p.published}/${p.protocol}`, true); }
        }
    }

    // 12. compose_up --------------------------------------------------------------------------------------------------------------------
    if (willComposeUp) {
        drafts.push(mk(null, {kind: "compose_up", phase: "start", op: existing ? "replace" : "create", destructive: existing, approval: portInUse, info: portInUse ? ["port_in_use"] : [],
            dest: {kind: "project", name: project, path: null, relative_path: null}}));
        if (mirror || caps.has("compose.render.v1")) pre("target_capability_compose", "met", "dashboard"); // mirror: `mirror.v1` is checked above
        else { blockers.add("target_capability_missing"); pre("target_capability_compose", "unmet", "dashboard", "target_capability_missing"); }
    }

    // 10. disk ------------------------------------------------------------------------------------------------------------------------
    const firstOf = (g: Group) => g.present[0];
    const sizes = nonSkipped.map((g) => firstOf(g).plaintext_size);
    const required = sizes.length === 0 ? 0 : sizes.some((s) => s === null) ? null : sizes.reduce((a, b) => (a as number) + (b as number), 0 as number);
    if (facts.free_disk_bytes !== null && required !== null) {
        if (facts.free_disk_bytes < Math.ceil((required * 11) / 10)) { blockers.add("insufficient_disk"); pre("free_disk", "unmet", "dashboard", "insufficient_disk"); } else pre("free_disk", "met", "dashboard");
    } else pre("free_disk", "deferred", "agent");

    // 13. compose findings (informational; W20a is authoritative, D27) -----------------------------------------------------------------
    const findings = new Map<string, RestorePlanV1["compose_findings"][number]>();
    const find = (rule_id: RestorePlanV1["compose_findings"][number]["rule_id"], service: string) => { findings.set(`${rule_id}\u0000${service}`, {rule_id, service, informational: true}); };
    if (inv && !test && !mirror) {
        for (const s of inv.services) { if (s.privileged === true) find("privileged", s.name); if (s.network_mode === "host") find("network_mode_host", s.name); }
        for (const m of inv.mounts) {
            if (m.kind !== "bind") continue;
            const hint = m.host_path_hint;
            for (const c of m.consumers) {
                if (hint && isDockerSocket(hint)) find("docker_sock", c);
                const p = safeAbsPath(hint);
                if (mode === "new_stack" && p && rootCheck.ok && !isUnder(p, rootCheck.root)) find("bind_outside_root", c);
            }
        }
    }

    // 14. secrets (purpose restore only; key NAMES, never values) ------------------------------------------------------------------------
    const secrets = new Map<string, RestorePlanV1["secrets"][number]>();
    if (inv && !test && !mirror) {
        const put = (service: string, key: string, origin: "service_env" | "env_file", restore: boolean) => {
            secrets.set(`${service}\u0000${key}\u0000${origin}`, {service, key, origin, class: restore ? "restore" : "require_input", flagged: !restore, reason: null});
        };
        for (const s of inv.services) for (const k of s.env_keys) put(s.name, k, "service_env", composeDirAction);
        const covered = new Set(groups.filter((g) => nonSkipped.includes(g)).flatMap((g) => g.arts.flatMap((a) => a.source?.covers_keys ?? [])));
        for (const f of inv.env_files) {
            const restore = covered.has(`env:${f.path_hint}`) || covered.has(`file:${f.path_hint}`) || (!f.path_hint.startsWith("/") && composeDirAction);
            for (const svc of f.referenced_by.length ? f.referenced_by : [""]) for (const k of f.key_names) put(svc, k, "env_file", restore);
        }
    }

    // 15. approvals + outcome -------------------------------------------------------------------------------------------------------------
    const approvals: ApprovalKind[] = [];
    if (mirror) {
        // a mirror has NO approval path: whatever would need one (sqlite placement, unmapped artifact) blocks the plan instead; the operator fixes the mapping first
        for (const d of drafts) {
            if (d.risk !== "needs_approval") continue;
            for (const r of d.reasons) if (r !== "restic_payload_credential") blockers.add(r);
            d.risk = "blocked";
        }
    }
    if (!test && !mirror && hostRole === "production") approvals.push("production_target");
    if (!mirror && drafts.some((d) => d.destructive)) approvals.push("destructive_replace");
    const approvals_required = sortBy(approvals, (k) => [APPROVAL_KINDS.indexOf(k)]).map((kind) => ({kind, capability: APPROVAL_CAPABILITY[kind] as string}));

    // 16. order + ids ---------------------------------------------------------------------------------------------------------------------
    const ordered = sortBy(drafts, (d) => [PHASES.indexOf(d.phase), ACTION_KINDS.indexOf(d.kind), d.resource_key ?? "", d.artifact_ids[0] ?? ""]);
    const actions: Action[] = ordered.map((d, ix) => ({id: `a${sha({kind: d.kind, resource_key: d.resource_key, artifact_ids: d.artifact_ids}).slice(0, 12)}`, order: ix + 1, ...d}));
    const blockerList = uniqReasons([...blockers]);
    const outcome = blockerList.length > 0 || actions.some((a) => a.risk === "blocked") ? "blocked" : "ready";

    const plan = RestorePlanV1.parse({
        plan_version: PLAN_VERSION, ruleset: input.planner.ruleset, deny_rules_sha256: input.planner.deny_rules_sha256, inputs_digest: inputsDigest, purpose, mode,
        rp: {id: rp.id, stack_id: rp.stack_id, stack_name: rp.stack_name, sequence: rp.sequence, manifest_sha256: rp.manifest_sha256, manifest_sig_kid: rp.manifest_sig_kid, verified_at: rp.verified_at, inventory_hash: rp.inventory_hash, consistency_level: rp.consistency_level},
        source: {compose_project: sourceProject, environment_id: stack.environment_id},
        target: {agent_id: target.agent_id, agent_name: target.agent_name, environment_ids: envs.map((e) => e.id), host_role: hostRole, host_role_source: hostRoleSource, same_environment: target.same_environment, project, restore_root: rootCheck.ok ? rootCheck.root : null},
        actions,
        preconditions: sortBy([...preconditions.values()], (p) => [PRECONDITIONS.indexOf(p.code)]),
        secrets: sortBy([...secrets.values()], (s) => [s.service, s.key, s.origin]),
        decisions: sortBy(dedupe(decisions), (d) => [d.code, d.subject]),
        compose_findings: sortBy([...findings.values()], (f) => [f.rule_id, f.service]),
        compose_findings_basis: "inventory",
        approvals_required, blockers: blockerList, outcome,
        totals: {artifacts: input.artifacts.length, actions: actions.length, plaintext_bytes: required},
    });
    return {plan, planHash: hashPlan(plan), inputsDigest};
}

function uniqReasons(a: readonly Reason[]): Reason[] { return [...new Set(a)].sort(cmp); }
function dedupe(d: Decision[]): Decision[] { const m = new Map<string, Decision>(); for (const x of d) m.set(`${x.code}\u0000${x.subject}`, x); return [...m.values()]; }
