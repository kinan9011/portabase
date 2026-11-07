import {createHash} from "node:crypto";
import {SERVICE_NAME} from "@/fork/inventory/labels";
import type {RawResult} from "@/fork/policy/raw";
import {type HardId, RULES, RULES_SHA256, type RuleId, isCanonPath, isSocketPath, isUnderRoots, plainOf} from "@/fork/policy/rules";

/**
 * Rendered-compose policy (W20a, D27/D46). Input = the `docker compose config --format json` bytes RETURNED BY THE TARGET AGENT (untrusted);
 * the dashboard never runs compose. Pure and deterministic: no clock, no I/O, no logging. Normative semantics = vault ADR-015 D-2 (jq and the
 * agent implement the same table; the shared corpus compose-policy-vectors.json is the oracle). Verdicts carry rule ids, service names, key
 * names and PATHS only; no value of `environment`, `labels`, `command`, `entrypoint`, `healthcheck`, `x-*`, secrets or configs is ever copied.
 */
export type Verdict = "allow" | "deny" | "needs-explicit-override";
export type PolicyFinding = {service: string; rule: RuleId; detail: string; plain: string};
export type HardRefusal = {code: HardId; service: string | null; detail: string; plain: string};
export type PolicyNote = {code: "compose_changed_since_rp" | "compose_change_unknown"; rp_sequence: number; plain: string};
export type PolicyVerdictV1 = {v: 1; verdict: Verdict; compose_sha256: string; rules_sha256: string; roots: string[]; hard: HardRefusal[]; findings: PolicyFinding[]; services_needing_override: string[]; notes: PolicyNote[]};
export type DriftInput = {rp_sequence: number; rp_inventory_hash: string | null; current_inventory_hash: string | null};

export const RENDERED_LIMITS = {maxBytes: 2 * 1024 * 1024, maxDepth: 32, maxServices: 500} as const; // D-10

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k);
const truthy = (v: unknown) => v !== undefined && v !== null && v !== false;
const clean = (d: string) => d.replace(/[^A-Za-z0-9_./:=-]/gu, "?").slice(0, 128);
const asciiUpper = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** string-aware bracket depth of a JSON text (bounded BEFORE JSON.parse). */
function jsonTooDeep(text: string, max: number): boolean {
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (inStr) { if (ch === 0x5c) i++; else if (ch === 0x22) inStr = false; continue; }
        if (ch === 0x22) inStr = true;
        else if (ch === 0x5b || ch === 0x7b) { if (++depth > max) return true; }
        else if (ch === 0x5d || ch === 0x7d) depth--;
    }
    return false;
}

class Collector {
    readonly findings = new Map<string, PolicyFinding>();
    readonly hard = new Map<string, HardRefusal>();
    flag(service: string, rule: RuleId, detail: string) {
        const d = clean(detail);
        this.findings.set(`${service}\0${rule}\0${d}`, {service, rule, detail: d, plain: `service "${service}" ${plainOf(rule)} (${d})`});
    }
    refuse(code: HardId, service: string | null, detail: string) {
        const d = clean(detail);
        this.hard.set(`${code}\0${service ?? ""}\0${d}`, {code, service, detail: d, plain: `${service === null ? "the Compose file" : `service "${service}"`} ${plainOf(code)} (${d})`});
    }
}

function evaluateDoc(doc: unknown, roots: string[], c: Collector) {
    if (!isObj(doc) || !isObj(doc.services)) return c.refuse("shape_invalid", null, "services");
    const services = doc.services;
    if (Object.keys(services).length > RENDERED_LIMITS.maxServices) return c.refuse("limits", null, "services");
    for (const k of Object.keys(doc)) if (!k.startsWith("x-") && !RULES.top_level_keys.includes(k)) c.refuse("top_level_unknown", null, k);

    const readPath = (svc: string | null, p: unknown, what: string) => {
        if (!isCanonPath(p)) c.refuse("path_ambiguous", svc, what);
        else if (!isUnderRoots(p, roots)) c.refuse("read_outside_root", svc, `${what}: ${p}`);
    };
    const hostPath = (svc: string, p: unknown, what: string) => {
        if (!isCanonPath(p)) return c.refuse("path_ambiguous", svc, what);
        if (isSocketPath(p)) c.flag(svc, "docker_sock", `${what}: ${p}`);
        if (!isUnderRoots(p, roots)) c.flag(svc, "bind_outside_root", `${what}: ${p}`);
    };

    for (const section of ["secrets", "configs"] as const) {
        const defs = doc[section];
        if (isObj(defs)) for (const def of Object.values(defs)) if (isObj(def) && def.file !== undefined && def.file !== null) readPath(null, def.file, "file");
    }
    const networks = isObj(doc.networks) ? doc.networks : {};
    const volumes = isObj(doc.volumes) ? doc.volumes : {};

    for (const [svc, s] of Object.entries(services)) {
        if (!SERVICE_NAME.test(svc)) { c.refuse("service_name", null, "service"); continue; }
        if (!isObj(s)) { c.refuse("shape_invalid", svc, "service"); continue; }
        for (const k of Object.keys(s)) if (!k.startsWith("x-") && !RULES.service_keys_known.includes(k)) c.flag(svc, "unknown_directive", k);
        if (truthy(s.privileged)) c.flag(svc, "privileged", "privileged");
        if (truthy(s.use_api_socket)) c.flag(svc, "docker_sock", "use_api_socket");
        for (const [key, hostRule] of [["network_mode", "network_mode_host"], ["pid", "pid_host"], ["ipc", "ipc_host"]] as const) {
            const v = s[key];
            if (v === undefined || v === null) continue;
            if (v === "host") c.flag(svc, hostRule, `${key}: host`);
            else if (typeof v === "string" && v.startsWith("service:") && has(services, v.slice(8))) continue;
            else if (typeof v === "string" && RULES.namespace_values_ok.includes(v)) continue;
            else c.flag(svc, "shared_namespace", key);
        }
        const nonEmpty = (v: unknown) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
        if (nonEmpty(s.devices)) c.flag(svc, "devices", "devices");
        const deploy = s.deploy;
        if (truthy(deploy)) {
            const res = isObj(deploy) ? deploy.resources : undefined;
            const rsv = isObj(res) ? res.reservations : undefined;
            if (!isObj(deploy) || (truthy(res) && !isObj(res)) || (truthy(rsv) && !isObj(rsv))) c.refuse("shape_invalid", svc, "deploy");
            else if (isObj(rsv) && nonEmpty(rsv.devices)) c.flag(svc, "devices", "deploy devices");
        }
        if (s.cap_add !== undefined && s.cap_add !== null) {
            if (!Array.isArray(s.cap_add)) c.refuse("shape_invalid", svc, "cap_add");
            else for (const cap of s.cap_add) {
                if (typeof cap !== "string") { c.refuse("shape_invalid", svc, "cap_add"); continue; }
                const name = asciiUpper(cap).replace(/^CAP_/, "");
                if (!RULES.cap_add_allowlist.includes(name)) c.flag(svc, "cap_add", `cap_add: ${name}`);
            }
        }
        if (s.security_opt !== undefined && s.security_opt !== null && !(Array.isArray(s.security_opt) && s.security_opt.every((o) => typeof o === "string" && RULES.security_opt_ok.includes(o)))) c.flag(svc, "unknown_directive", "security_opt");
        if (s.env_file !== undefined && s.env_file !== null) {
            for (const it of Array.isArray(s.env_file) ? s.env_file : [s.env_file]) readPath(svc, isObj(it) ? it.path : it, "env_file");
        }
        if (s.networks !== undefined && s.networks !== null) {
            const names = Array.isArray(s.networks) ? s.networks : isObj(s.networks) ? Object.keys(s.networks) : null;
            if (names === null) c.refuse("shape_invalid", svc, "networks");
            else for (const n of names) {
                const nd = typeof n === "string" && has(networks, n) ? networks[n] : undefined;
                if (!isObj(nd)) c.refuse("shape_invalid", svc, "network");
                else if (nd.name === "host" || nd.driver === "host") c.flag(svc, "network_mode_host", `networks: ${String(n)}`);
                else if (!RULES.network_drivers_ok.includes(truthy(nd.driver) ? String(nd.driver) : "bridge") || (nd.driver !== undefined && nd.driver !== null && typeof nd.driver !== "string")) c.flag(svc, "unknown_directive", "network driver");
            }
        }
        if (s.volumes !== undefined && s.volumes !== null) {
            if (!Array.isArray(s.volumes)) c.refuse("shape_invalid", svc, "volumes");
            else for (const m of s.volumes) {
                if (!isObj(m)) { c.refuse("shape_invalid", svc, "volumes"); continue; }
                if (m.type === "bind") hostPath(svc, m.source, "volumes");
                else if (m.type === "volume") {
                    if (m.source === undefined || m.source === null || m.source === "") continue;
                    const def = typeof m.source === "string" && has(volumes, m.source) ? volumes[m.source] : undefined;
                    if (!isObj(def)) c.refuse("shape_invalid", svc, "volume");
                    else if (def.driver !== undefined && def.driver !== null && def.driver !== "local") c.flag(svc, "unknown_directive", "volume driver");
                    else if (def.driver_opts === undefined || def.driver_opts === null) continue;
                    else if (!isObj(def.driver_opts)) c.refuse("shape_invalid", svc, "volume");
                    else if (def.driver_opts.type === "tmpfs") continue;
                    else if (typeof def.driver_opts.device === "string" && def.driver_opts.device.startsWith("/")) hostPath(svc, def.driver_opts.device, "volume device");
                    else c.flag(svc, "unknown_directive", "volume driver_opts");
                } else if (m.type !== "tmpfs") c.flag(svc, "unknown_directive", "volume type");
            }
        }
    }
}

export function evaluateRenderedCompose(input: {rendered: string | Uint8Array; roots: string[]; raw: RawResult; drift: DriftInput | null}): PolicyVerdictV1 {
    const bytes = typeof input.rendered === "string" ? Buffer.from(input.rendered, "utf8") : Buffer.from(input.rendered);
    const c = new Collector();
    const roots = input.roots.filter((r) => {
        const ok = isCanonPath(r) && r !== "/" && !isSocketPath(r);
        if (!ok) c.refuse("path_ambiguous", null, "restore root");
        return ok;
    });
    if (input.roots.length === 0) c.refuse("path_ambiguous", null, "restore root");

    if (bytes.length > RENDERED_LIMITS.maxBytes) c.refuse("limits", null, "rendered size");
    else {
        const text = bytes.toString("utf8");
        if (jsonTooDeep(text, RENDERED_LIMITS.maxDepth)) c.refuse("limits", null, "rendered depth");
        else {
            let doc: unknown;
            try { doc = JSON.parse(text); } catch { c.refuse("shape_invalid", null, "not json"); doc = undefined; }
            if (doc !== undefined) evaluateDoc(doc, roots, c);
        }
    }
    // raw (pre-render) result: required, so no caller can skip it
    if (input.raw.reason !== null) c.refuse(input.raw.reason, null, "compose yaml");
    for (const v of input.raw.violations) {
        if (v.kind === "missing") c.refuse("raw_incomplete", v.service, `${v.kind}: ${v.target}`);
        else c.refuse("read_outside_root", v.service, `${v.kind}: ${v.target}`);
    }
    if (input.raw.refused && input.raw.reason === null && input.raw.violations.length === 0) c.refuse("yaml_invalid", null, "compose yaml");

    const hard = [...c.hard.values()].sort((a, b) => cmp(a.code, b.code) || cmp(a.service ?? "", b.service ?? "") || cmp(a.detail, b.detail));
    const findings = [...c.findings.values()].sort((a, b) => cmp(a.service, b.service) || cmp(a.rule, b.rule) || cmp(a.detail, b.detail));
    return {
        v: 1,
        verdict: hard.length > 0 ? "deny" : findings.length > 0 ? "needs-explicit-override" : "allow",
        compose_sha256: createHash("sha256").update(bytes).digest("hex"),
        rules_sha256: RULES_SHA256,
        roots: [...input.roots].sort(),
        hard,
        findings,
        services_needing_override: [...new Set(findings.map((f) => f.service))].sort(),
        notes: driftNote(input.drift),
    };
}

function driftNote(d: DriftInput | null): PolicyNote[] {
    if (d === null) return [];
    if (d.rp_inventory_hash === null || d.current_inventory_hash === null) {
        return [{code: "compose_change_unknown", rp_sequence: d.rp_sequence, plain: `Cannot tell whether the stack configuration changed since recovery point #${d.rp_sequence}.`}];
    }
    if (d.rp_inventory_hash === d.current_inventory_hash) return [];
    return [{code: "compose_changed_since_rp", rp_sequence: d.rp_sequence, plain: `Stack configuration (as discovered) changed since recovery point #${d.rp_sequence}.`}];
}
