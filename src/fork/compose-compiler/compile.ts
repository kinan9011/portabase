import {createHash} from "node:crypto";
import {canonicalJson} from "@/fork/canonical";
import {type MirrorDiffEntry, mirrorDiff} from "@/fork/compose-compiler/diff";
import {type MirrorIR, type MirrorRefusal, parseMirrorIR, refusal, sortRefusals} from "@/fork/compose-compiler/ir";
import {ACCESS_NETWORK, DB_ENGINES, MIRROR_COMPILER_VERSION, OWNER_LABELS, PROJECT_RE, classifyEnvKey, isDroppedLabel} from "@/fork/compose-compiler/rules";
import {SERVICE_NAME} from "@/fork/inventory/labels";
import {type PolicyVerdictV1, evaluateRenderedCompose} from "@/fork/policy/engine";
import type {RawResult} from "@/fork/policy/raw";
import {RULES_SHA256, isCanonPath} from "@/fork/policy/rules";
import {isPolicyView} from "@/fork/restore-tasks/view";

/**
 * Mirror compiler (W20, R3). Input = the POLICY VIEW of a rendered compose project (value-free, what the target agent uploads) + the stored raw
 * result. Output = a value-free, hash-bound `MirrorSpecV1` (full structural skeleton of the mirror project + a per-key action for every env var)
 * and a redacted diff. The dashboard never sees a value (D-1): the runner merges its own full render into the skeleton with `applyMirrorSpec`.
 * Mirror mode has NO overrides (D-2): every engine hard refusal and every finding is a refusal. Pure and deterministic: no clock, no I/O, no randomness.
 */
export type EnvAction = "keep" | "keep_exact" | "rotate" | "disable" | "drop";
export type MirrorAccess = {service: string; target: number; host_port: number} | null;
export type CompileOptions = {
    project: string;
    workspace: string;
    access: MirrorAccess;
    /** per-app transform profile hook / operator overrides: service → env KEY → action */
    env?: Record<string, Record<string, EnvAction>>;
};
export type CredentialReset = {service: string; engine: "postgresql" | "mysql"; user_key: string | null; password_key: string};
export type MirrorSpecV1 = {
    v: 1;
    compiler: typeof MIRROR_COMPILER_VERSION;
    project: string;
    workspace: string;
    /** sha256 of the exact view bytes compiled (= fork_compose_render.rendered_sha256) */
    source_view_sha256: string;
    rules_sha256: string;
    access: MirrorAccess;
    /** the mirror skeleton (policy view) */
    view: Record<string, unknown>;
    /** EVERY env key of every service (explicit, incl. "keep") */
    env: Record<string, Record<string, EnvAction>>;
    credential_resets: CredentialReset[];
    /** "svc.KEY" with keep_exact on a rotate-classified key */
    kept_production_secrets: string[];
};
export type CompileResult =
    | {ok: true; spec: MirrorSpecV1; spec_sha256: string; diff: MirrorDiffEntry[]; source: PolicyVerdictV1}
    | {ok: false; refusals: MirrorRefusal[]; source: PolicyVerdictV1 | null};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const CLEAN_RAW: RawResult = {refused: false, violations: [], reason: null};
const REMOVED_AFTER = ["dns", "dns_search", "dns_opt", "extra_hosts", "links", "external_links", "mac_address", "logging", "profiles", "develop", "build", "provider", "env_file", "extends"] as const;
const STATIC_IP_KEYS = ["ipv4_address", "ipv6_address", "link_local_ips", "mac_address"] as const;

const mirrorNetName = (project: string, k: string) => `${project}_${k}`;
const imageBase = (image: string) => (image.split("@")[0]?.split("/").pop()?.split(":")[0] ?? "").toLowerCase();
const falsy = (v: unknown) => v === undefined || v === null || v === false;

function optionRefusals(o: CompileOptions): MirrorRefusal[] {
    const out: MirrorRefusal[] = [];
    if (typeof o.project !== "string" || !PROJECT_RE.test(o.project)) out.push(refusal("project_invalid", null, "project"));
    if (!isCanonPath(o.workspace) || o.workspace === "/" || typeof o.project !== "string" || !o.workspace.endsWith(`/${o.project}`)) out.push(refusal("workspace_invalid", null, "workspace"));
    const a = o.access;
    if (a !== null) {
        const okInt = (n: unknown, lo: number, hi: number) => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
        if (!isObj(a) || typeof a.service !== "string" || !SERVICE_NAME.test(a.service)) out.push(refusal("access_invalid", null, "service"));
        else if (!okInt(a.target, 1, 65535)) out.push(refusal("access_invalid", a.service, "target port"));
        else if (!okInt(a.host_port, 1024, 65535)) out.push(refusal("access_invalid", a.service, "host port"));
    }
    return out;
}

export function compileMirror(input: {view: string | Uint8Array; raw: RawResult; options: CompileOptions}): CompileResult {
    const {options} = input;
    const bad = optionRefusals(options);
    if (bad.length > 0) return {ok: false, refusals: sortRefusals(bad), source: null};
    const {project, workspace, access} = options;

    // D-2: the source view must be clean under the shared engine; mirror mode has no override path.
    const source = evaluateRenderedCompose({rendered: input.view, roots: [workspace], raw: input.raw, drift: null});
    const refusals: MirrorRefusal[] = [];
    for (const h of source.hard) refusals.push(refusal("policy_hard", h.service, `${h.code}: ${h.detail}`));
    for (const f of source.findings) refusals.push(refusal("policy_finding", f.service, `${f.rule}: ${f.detail}`));
    if (source.hard.length > 0) return {ok: false, refusals: sortRefusals(refusals), source};

    const text = typeof input.view === "string" ? input.view : Buffer.from(input.view).toString("utf8");
    const doc: unknown = JSON.parse(text); // the engine has bounded size/depth and parsed it
    if (!isPolicyView(doc)) {
        refusals.push(refusal("view_invalid", null, "view carries a value in a blanked field"));
        return {ok: false, refusals: sortRefusals(refusals), source};
    }
    const parsed = parseMirrorIR(doc);
    if (!parsed.ok) return {ok: false, refusals: sortRefusals([...refusals, ...parsed.refusals]), source};
    const ir = parsed.ir;

    const built = buildSkeleton(ir, options, refusals);
    if (refusals.length > 0 || built === null) return {ok: false, refusals: sortRefusals(refusals), source};

    const chk = checkMirrorView(built.view, {project, workspace, access, source: doc as Record<string, unknown>});
    if (!chk.ok) return {ok: false, refusals: sortRefusals(chk.violations.map((v) => refusal("post_check", v.service, `${v.code}: ${v.detail}`))), source};

    const spec: MirrorSpecV1 = {
        v: 1,
        compiler: MIRROR_COMPILER_VERSION,
        project,
        workspace,
        source_view_sha256: source.compose_sha256,
        rules_sha256: RULES_SHA256,
        access,
        view: built.view,
        env: built.env,
        credential_resets: built.resets,
        kept_production_secrets: built.kept,
    };
    return {ok: true, spec, spec_sha256: sha256(canonicalJson(spec)), diff: mirrorDiff(ir, spec), source};
}

type Built = {view: Record<string, unknown>; env: Record<string, Record<string, EnvAction>>; resets: CredentialReset[]; kept: string[]};

function buildSkeleton(ir: MirrorIR, options: CompileOptions, refusals: MirrorRefusal[]): Built | null {
    const {project, access} = options;
    const names = Object.keys(ir.services);
    if (access !== null && !names.includes(access.service)) refusals.push(refusal("access_invalid", access.service, "unknown service"));
    if (Object.hasOwn(ir.networks, ACCESS_NETWORK)) refusals.push(refusal("unsupported_key", null, `network ${ACCESS_NETWORK} is reserved`));

    const services: Record<string, unknown> = {};
    const envSpec: Record<string, Record<string, EnvAction>> = {};
    const resets: CredentialReset[] = [];
    const kept: string[] = [];
    const usedNets = new Set<string>();

    for (const name of names.sort()) {
        const s = ir.services[name];
        if (s === undefined) continue;
        const out: Record<string, unknown> = structuredClone(s.passthrough);
        const isAccess = access !== null && access.service === name;

        // environment: explicit action per key (D-5); dropped keys leave the skeleton
        const actions: Record<string, EnvAction> = {};
        const env: Record<string, "" | null> = {};
        for (const [key, blank] of Object.entries(s.environment)) {
            const a: EnvAction = options.env?.[name]?.[key] ?? classifyEnvKey(key);
            actions[key] = a;
            if (a !== "drop") env[key] = blank;
            if (a === "keep_exact" && classifyEnvKey(key) === "rotate") kept.push(`${name}.${key}`);
        }
        envSpec[name] = actions;
        if (Object.keys(env).length > 0) out.environment = env;
        resets.push(...credentialResets(name, s.image ?? "", actions));

        const labels = Object.fromEntries(Object.entries(s.labels).filter(([k]) => !isDroppedLabel(k)));
        if (Object.keys(labels).length > 0) out.labels = labels;

        // network_mode / networks (D-4)
        const mode = s.networkMode;
        if (mode === "none" || (mode !== null && mode.startsWith("service:"))) {
            out.network_mode = mode;
            if (isAccess) refusals.push(refusal("access_invalid", name, "access service has a network_mode"));
        } else if (mode === null || mode === "bridge" || mode === "default") {
            let attach = s.networks !== null && Object.keys(s.networks).length > 0 ? s.networks : {default: {aliases: [] as string[], hadStaticIp: false}};
            if (s.containerName !== null && s.containerName !== name) {
                if (names.includes(s.containerName)) refusals.push(refusal("alias_collision", name, `container_name ${s.containerName}`));
                const alias = s.containerName;
                attach = Object.fromEntries(Object.entries(attach).map(([n, a]) => [n, {...a, aliases: [...a.aliases, alias]}]));
            }
            const nets: Record<string, {aliases: string[]} | null> = {};
            for (const [n, a] of Object.entries(attach)) {
                const al = [...new Set(a.aliases)].sort();
                nets[n] = al.length > 0 ? {aliases: al} : null;
                usedNets.add(n);
            }
            if (isAccess) {
                nets[ACCESS_NETWORK] = null;
                usedNets.add(ACCESS_NETWORK);
            }
            out.networks = nets;
        } else refusals.push(refusal("unsupported_key", name, "network_mode"));

        // ports: removed; the single private-access port is published on loopback only (OD-W20-2)
        if (isAccess && access !== null) out.ports = [{mode: "ingress", host_ip: "127.0.0.1", target: access.target, published: String(access.host_port), protocol: "tcp"}];
        services[name] = out;
    }

    // top-level: every network replaced by an isolated mirror network; external → local (D-4)
    const networks: Record<string, unknown> = {};
    for (const k of Object.keys(ir.networks)) networks[k] = {name: mirrorNetName(project, k), internal: true};
    if (usedNets.has("default") && !Object.hasOwn(networks, "default")) networks.default = {name: mirrorNetName(project, "default"), internal: true};
    if (access !== null) networks[ACCESS_NETWORK] = {name: mirrorNetName(project, ACCESS_NETWORK)};
    const volumes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ir.volumes)) volumes[k] = v.tmpfsOpts === null ? {name: mirrorNetName(project, k)} : {name: mirrorNetName(project, k), driver_opts: v.tmpfsOpts};

    const view: Record<string, unknown> = {name: project, services};
    if (Object.keys(networks).length > 0) view.networks = networks;
    if (Object.keys(volumes).length > 0) view.volumes = volumes;
    for (const section of ["secrets", "configs"] as const) {
        const defs = Object.fromEntries(Object.entries(ir[section]).map(([k, d]) => {
            const {name: _name, external: _external, ...rest} = d;
            return [k, rest];
        }));
        if (Object.keys(defs).length > 0) view[section] = defs;
    }
    return {view, env: envSpec, resets: resets.sort((a, b) => (a.service + a.password_key < b.service + b.password_key ? -1 : 1)), kept: kept.sort()};
}

/** advisory (D-5): a DB restored from a VOLUME keeps the production role password and needs ALTER ROLE before app start. */
function credentialResets(service: string, image: string, actions: Record<string, EnvAction>): CredentialReset[] {
    const base = imageBase(image);
    const out: CredentialReset[] = [];
    if ((DB_ENGINES.postgresql as readonly string[]).includes(base) && actions.POSTGRES_PASSWORD === "rotate") {
        out.push({service, engine: "postgresql", user_key: Object.hasOwn(actions, "POSTGRES_USER") ? "POSTGRES_USER" : null, password_key: "POSTGRES_PASSWORD"});
    }
    if ((DB_ENGINES.mysql as readonly string[]).includes(base)) {
        for (const p of ["MYSQL", "MARIADB"]) {
            if (actions[`${p}_ROOT_PASSWORD`] === "rotate") out.push({service, engine: "mysql", user_key: null, password_key: `${p}_ROOT_PASSWORD`});
            if (Object.hasOwn(actions, `${p}_USER`) && actions[`${p}_PASSWORD`] === "rotate") out.push({service, engine: "mysql", user_key: `${p}_USER`, password_key: `${p}_PASSWORD`});
        }
    }
    return out;
}

export type MirrorViolation = {code: string; service: string | null; detail: string};
export type CheckContext = {project: string; workspace: string; access: MirrorAccess; source?: Record<string, unknown>; requireOwnerLabels?: boolean};
const vclean = (d: string) => d.replace(/[^A-Za-z0-9_./:=@-]/gu, "?").slice(0, 128);

/**
 * D-7 invariant gate. Run on the skeleton inside `compileMirror` and (W22a) on the runner's final view (`requireOwnerLabels: true`).
 * Tolerates compose re-render normalisation (added `ipam: {}`, `volume: {}`, `required: true`): these are invariants, not equality.
 */
export function checkMirrorView(view: unknown, ctx: CheckContext): {ok: boolean; violations: MirrorViolation[]} {
    const v: MirrorViolation[] = [];
    const add = (code: string, service: string | null, detail: string) => v.push({code, service, detail: vclean(detail)});
    if (!isObj(view) || !isObj(view.services)) return {ok: false, violations: [{code: "shape", service: null, detail: "services"}]};
    const {project, access} = ctx;
    const services = view.services;
    if (view.name !== project) add("project", null, "name");

    for (const [name, raw] of Object.entries(services)) {
        const s = isObj(raw) ? raw : {};
        const ports = s.ports;
        const isAccess = access !== null && access.service === name;
        if (ports !== undefined && ports !== null && !(Array.isArray(ports) && ports.length === 0)) {
            const p = Array.isArray(ports) && ports.length === 1 && isObj(ports[0]) ? ports[0] : null;
            const okPort = isAccess && access !== null && p !== null && p.host_ip === "127.0.0.1" && p.target === access.target && String(p.published) === String(access.host_port) && (p.protocol === undefined || p.protocol === "tcp") && (p.mode === undefined || p.mode === "ingress");
            if (!okPort) add("port", name, "ports");
        }
        if (s.container_name !== undefined && s.container_name !== null) add("container_name", name, "container_name");
        const mode = s.network_mode;
        if (mode !== undefined && mode !== null && !(mode === "none" || (typeof mode === "string" && mode.startsWith("service:") && Object.hasOwn(services, mode.slice(8))))) add("network_mode", name, "network_mode");
        for (const k of REMOVED_AFTER) if (s[k] !== undefined && s[k] !== null && !(Array.isArray(s[k]) && (s[k] as unknown[]).length === 0) && !(isObj(s[k]) && Object.keys(s[k] as object).length === 0)) add("removed_key", name, k);
        const nets = s.networks;
        const attached = Array.isArray(nets) ? nets.filter((n): n is string => typeof n === "string") : isObj(nets) ? Object.keys(nets) : [];
        if (attached.includes(ACCESS_NETWORK) && !isAccess) add("access_network", name, ACCESS_NETWORK);
        if (isAccess && !attached.includes(ACCESS_NETWORK)) add("access_network", name, "access service not attached");
        if (isObj(nets)) for (const [n, att] of Object.entries(nets)) if (isObj(att) && STATIC_IP_KEYS.some((k) => att[k] !== undefined && att[k] !== null && !(Array.isArray(att[k]) && (att[k] as unknown[]).length === 0))) add("static_ip", name, n);
        const labels = isObj(s.labels) ? Object.keys(s.labels) : [];
        for (const k of labels) if (isDroppedLabel(k) && !(ctx.requireOwnerLabels && (OWNER_LABELS as readonly string[]).includes(k))) add("label", name, k);
        if (ctx.requireOwnerLabels) for (const k of OWNER_LABELS) if (!labels.includes(k)) add("owner_label", name, k);
    }
    if (access === null && isObj(view.networks) && Object.hasOwn(view.networks, ACCESS_NETWORK)) add("access_network", null, "no access configured");

    const networks = isObj(view.networks) ? view.networks : {};
    for (const [k, raw] of Object.entries(networks)) {
        const n = isObj(raw) ? raw : {};
        const ipam = isObj(n.ipam) ? n.ipam : {};
        const bad =
            !falsy(n.external) || n.name !== mirrorNetName(project, k) || !(n.driver === undefined || n.driver === null || n.driver === "bridge") ||
            (Array.isArray(ipam.config) && ipam.config.length > 0) || (isObj(n.driver_opts) && Object.keys(n.driver_opts).length > 0) || (n.internal !== true && k !== ACCESS_NETWORK);
        if (bad) add("network", null, k);
        if (ctx.requireOwnerLabels && !(isObj(n.labels) && OWNER_LABELS.every((l) => Object.hasOwn(n.labels as object, l)))) add("owner_label", null, `network ${k}`);
    }
    const volumes = isObj(view.volumes) ? view.volumes : {};
    for (const [k, raw] of Object.entries(volumes)) {
        const d = isObj(raw) ? raw : {};
        const opts = d.driver_opts;
        const bad = !falsy(d.external) || d.name !== mirrorNetName(project, k) || !(d.driver === undefined || d.driver === null || d.driver === "local") || !(opts === undefined || opts === null || (isObj(opts) && (Object.keys(opts).length === 0 || opts.type === "tmpfs")));
        if (bad) add("volume", null, k);
        if (ctx.requireOwnerLabels && !(isObj(d.labels) && OWNER_LABELS.every((l) => Object.hasOwn(d.labels as object, l)))) add("owner_label", null, `volume ${k}`);
    }
    for (const section of ["secrets", "configs"] as const) {
        const defs = view[section];
        if (isObj(defs)) for (const [k, d] of Object.entries(defs)) if (isObj(d) && !falsy(d.external)) add("secret_external", null, `${section} ${k}`);
    }
    if (ctx.source !== undefined) {
        const src = isObj(ctx.source.services) ? ctx.source.services : {};
        for (const [name, raw] of Object.entries(services)) {
            const s0 = src[name];
            if (!isObj(s0)) add("image_changed", name, "service not in source");
            else if (!isObj(raw) || raw.image !== s0.image) add("image_changed", name, "image");
        }
    }
    const eng = evaluateRenderedCompose({rendered: JSON.stringify(view), roots: [ctx.workspace], raw: CLEAN_RAW, drift: null});
    if (eng.verdict !== "allow") add("engine", null, [...eng.hard.map((h) => h.code), ...eng.findings.map((f) => f.rule)].join(","));
    return {ok: v.length === 0, violations: v};
}
