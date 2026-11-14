import {ENV_KEY_RE, REMOVED_KEYS, SERVICE_KEY_DISPOSITION} from "@/fork/compose-compiler/rules";

/**
 * Typed intermediate representation of a POLICY VIEW (W20 D-1): the value-free JSON the target agent uploads. Only the parts the mirror
 * transforms touch are modelled; every other "keep" key is passed through verbatim (the W20a engine has already checked it). The skeleton is
 * built from this IR ONLY, so a key without a disposition can never reach the output (D-3, fail closed). Pure: no I/O, no clock.
 * Refusals carry key names / service names / counts only; no value of the input is ever echoed.
 */
export const REFUSAL_CODES = ["view_invalid", "project_invalid", "workspace_invalid", "access_invalid", "policy_hard", "policy_finding", "unsupported_key", "build", "provider", "external_secret", "volume_driver_opts", "env_key_invalid", "alias_collision", "image_missing", "post_check"] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];
export type MirrorRefusal = {code: RefusalCode; service: string | null; detail: string; plain: string};

/** One sentence per code, readable by a non-expert (UI copy moves to labels.ts in W22b). */
export const PLAIN: Record<RefusalCode, string> = {
    view_invalid: "was not a valid redacted compose view, so it cannot be mirrored",
    project_invalid: "has a mirror project name that is not allowed (it must look like pbm-<name>)",
    workspace_invalid: "has a mirror workspace path that is not allowed (it must be an absolute path ending in the project name)",
    access_invalid: "has an invalid private-access setting (unknown service, or a port out of range)",
    policy_hard: "is refused by the safety rules before any mirror can be built",
    policy_finding: "uses a setting that is never allowed in a mirror (no overrides exist for mirrors)",
    unsupported_key: "uses a setting the mirror compiler does not know how to make safe",
    build: "builds an image from source, which a mirror never does",
    provider: "uses a provider service, which a mirror never starts",
    external_secret: "depends on an external secret or config that lives outside the stack",
    volume_driver_opts: "uses a volume with custom driver options that a mirror cannot copy safely",
    env_key_invalid: "has an environment variable name that is not allowed",
    alias_collision: "has a container name that collides with another service name once it becomes a network alias",
    image_missing: "has no image, so there is nothing to start",
    post_check: "produced a mirror that failed its own safety re-check (internal error)",
};

const clean = (d: string) => d.replace(/[^A-Za-z0-9_./:=@-]/gu, "?").slice(0, 128);
export function refusal(code: RefusalCode, service: string | null, detail: string): MirrorRefusal {
    const d = clean(detail);
    return {code, service, detail: d, plain: `${service === null ? "the Compose file" : `service "${service}"`} ${PLAIN[code]} (${d})`};
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const sortRefusals = (r: MirrorRefusal[]): MirrorRefusal[] => [...r].sort((a, b) => cmp(a.code, b.code) || cmp(a.service ?? "", b.service ?? "") || cmp(a.detail, b.detail));

export type PortIR = {host_ip: string | null; published: string | null; target: number; protocol: string | null};
export type NetAttach = {aliases: string[]; hadStaticIp: boolean};
export type ServiceIR = {
    passthrough: Record<string, unknown>;
    environment: Record<string, "" | null>;
    labels: Record<string, "" | null>;
    /** null ⇒ no `networks` key (attached to `default`) or `network_mode` set */
    networks: Record<string, NetAttach> | null;
    networkMode: string | null;
    containerName: string | null;
    ports: PortIR[];
    /** removed keys → entry count (diff shows counts only, never values) */
    removed: Record<string, number>;
    image: string | null;
};
export type VolumeIR = {external: boolean; driver: string | null; tmpfsOpts: Record<string, unknown> | null};
export type MirrorIR = {
    name: string | null;
    services: Record<string, ServiceIR>;
    networks: Record<string, {external: boolean}>;
    volumes: Record<string, VolumeIR>;
    secrets: Record<string, Record<string, unknown>>;
    configs: Record<string, Record<string, unknown>>;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k);
const empty = (v: unknown) => v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const STATIC_IP_KEYS = ["ipv4_address", "ipv6_address", "link_local_ips", "mac_address"] as const;
const blankVal = (v: unknown): v is "" | null => v === "" || v === null;

function parseService(name: string, s: Record<string, unknown>, out: MirrorRefusal[]): ServiceIR {
    const ir: ServiceIR = {passthrough: {}, environment: {}, labels: {}, networks: null, networkMode: null, containerName: null, ports: [], removed: {}, image: null};
    const bad = (detail: string) => out.push(refusal("view_invalid", name, detail));
    for (const [k, v] of Object.entries(s)) {
        if (k.startsWith("x-")) { ir.removed[k] = 1; continue; }
        const disp = Object.hasOwn(SERVICE_KEY_DISPOSITION, k) ? SERVICE_KEY_DISPOSITION[k] : undefined;
        if (disp === undefined) { out.push(refusal("unsupported_key", name, k)); continue; }
        if (disp === "keep") { ir.passthrough[k] = structuredClone(v); continue; }
        if (disp === "refuse") { if (!empty(v)) out.push(refusal(k === "build" ? "build" : k === "provider" ? "provider" : "unsupported_key", name, k)); continue; }
        if ((REMOVED_KEYS as readonly string[]).includes(k)) {
            const n = Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : empty(v) ? 0 : 1;
            if (n > 0) ir.removed[k] = n;
            continue;
        }
        switch (k) {
            case "environment": case "labels": {
                if (v === null || v === undefined) break;
                if (!isObj(v)) { bad(k); break; }
                const dst = k === "environment" ? ir.environment : ir.labels;
                for (const [key, val] of Object.entries(v)) {
                    if (!blankVal(val)) { bad(`${k} value`); continue; }
                    if (k === "environment" && !ENV_KEY_RE.test(key)) { out.push(refusal("env_key_invalid", name, key)); continue; }
                    dst[key] = val;
                }
                break;
            }
            case "container_name":
                if (typeof v === "string" && ALIAS_RE.test(v)) ir.containerName = v;
                else if (v !== null && v !== undefined) bad("container_name");
                break;
            case "network_mode":
                if (typeof v === "string") ir.networkMode = v;
                else if (v !== null && v !== undefined) bad("network_mode");
                break;
            case "ports":
                if (v === null || v === undefined) break;
                if (!Array.isArray(v)) { bad("ports"); break; }
                for (const p of v) {
                    if (!isObj(p) || typeof p.target !== "number" || !Number.isInteger(p.target) || p.target < 1 || p.target > 65535) { bad("ports"); continue; }
                    const pub = typeof p.published === "string" || typeof p.published === "number" ? String(p.published) : null;
                    ir.ports.push({host_ip: typeof p.host_ip === "string" ? p.host_ip : null, published: pub, target: p.target, protocol: typeof p.protocol === "string" ? p.protocol : null});
                }
                break;
            case "networks": {
                if (v === null || v === undefined) break;
                const nets: Record<string, NetAttach> = {};
                if (Array.isArray(v)) {
                    for (const n of v) { if (typeof n !== "string") bad("networks"); else nets[n] = {aliases: [], hadStaticIp: false}; }
                } else if (isObj(v)) {
                    for (const [n, att] of Object.entries(v)) {
                        if (att !== null && !isObj(att)) { bad("networks"); continue; }
                        const aliases: string[] = [];
                        if (att && att.aliases !== undefined && att.aliases !== null) {
                            if (!Array.isArray(att.aliases) || !att.aliases.every((a) => typeof a === "string" && ALIAS_RE.test(a))) { bad("aliases"); continue; }
                            aliases.push(...(att.aliases as string[]));
                        }
                        nets[n] = {aliases, hadStaticIp: att !== null && STATIC_IP_KEYS.some((key) => has(att, key) && !empty(att[key]))};
                    }
                } else bad("networks");
                ir.networks = nets;
                break;
            }
            default: // transform key without a handler: fail closed
                out.push(refusal("unsupported_key", name, k));
        }
    }
    if (typeof s.image === "string" && s.image !== "") ir.image = s.image;
    else out.push(refusal("image_missing", name, "image"));
    return ir;
}

export function parseMirrorIR(view: unknown): {ok: true; ir: MirrorIR} | {ok: false; refusals: MirrorRefusal[]} {
    const out: MirrorRefusal[] = [];
    if (!isObj(view) || !isObj(view.services)) return {ok: false, refusals: [refusal("view_invalid", null, "services")]};
    const ir: MirrorIR = {name: typeof view.name === "string" ? view.name : null, services: {}, networks: {}, volumes: {}, secrets: {}, configs: {}};
    for (const [name, s] of Object.entries(view.services)) {
        if (!isObj(s)) { out.push(refusal("view_invalid", name, "service")); continue; }
        ir.services[name] = parseService(name, s, out);
    }
    if (view.networks !== undefined && view.networks !== null) {
        if (!isObj(view.networks)) out.push(refusal("view_invalid", null, "networks"));
        else for (const [k, n] of Object.entries(view.networks)) ir.networks[k] = {external: isObj(n) && n.external !== undefined && n.external !== null && n.external !== false};
    }
    if (view.volumes !== undefined && view.volumes !== null) {
        if (!isObj(view.volumes)) out.push(refusal("view_invalid", null, "volumes"));
        else for (const [k, v] of Object.entries(view.volumes)) {
            const d = isObj(v) ? v : {};
            const driver = typeof d.driver === "string" ? d.driver : null;
            const opts = d.driver_opts;
            const tmpfs = isObj(opts) && opts.type === "tmpfs";
            if ((driver !== null && driver !== "local") || (!empty(opts) && !tmpfs)) out.push(refusal("volume_driver_opts", null, `volume ${k}`));
            ir.volumes[k] = {external: d.external !== undefined && d.external !== null && d.external !== false, driver, tmpfsOpts: tmpfs ? structuredClone(opts as Record<string, unknown>) : null};
        }
    }
    for (const section of ["secrets", "configs"] as const) {
        const defs = view[section];
        if (defs === undefined || defs === null) continue;
        if (!isObj(defs)) { out.push(refusal("view_invalid", null, section)); continue; }
        for (const [k, d] of Object.entries(defs)) {
            if (!isObj(d)) { out.push(refusal("view_invalid", null, `${section} ${k}`)); continue; }
            if (d.external !== undefined && d.external !== null && d.external !== false) out.push(refusal("external_secret", null, `${section} ${k}`));
            ir[section][k] = structuredClone(d);
        }
    }
    return out.length > 0 ? {ok: false, refusals: sortRefusals(out)} : {ok: true, ir};
}
