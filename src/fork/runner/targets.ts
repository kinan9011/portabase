import {createHash} from "node:crypto";
import {z} from "zod";
import {canonicalJson} from "@/fork/canonical";
import {isIpLiteral, isProbeableIp, isProbeHostname, MAX_PROBE_TARGETS, type ProbeKind} from "./payload-schema";
import {ADMIN_TARGET_CLASSES, DNS_CANARY, MAX_ADMIN_TARGETS, type TargetClass} from "./vocab";

/**
 * Probe targets (W21 DD-8). PURE: no network, no DB. The dashboard only RESOLVES configured hostnames (through the injected `resolve`) and never connects to anything.
 * The config sha is computed on the PRE-resolution canonical config (auto + admin), so `targets_changed` is deterministic and does not flap with DNS answers.
 */
export type AdminTarget = {kind: "tcp" | "dns_tcp" | "dns_name"; host: string; port?: number; class: (typeof ADMIN_TARGET_CLASSES)[number]; label: string};
export type ProbeTarget = {id: string; kind: ProbeKind; host: string; port?: number; class: TargetClass; label: string};
export type Endpoint = {host: string; port: number};
export type ProbeConfig = {v: 1; canary: string; server: Endpoint | null; arcane: Endpoint[]; admin: AdminTarget[]};
export type Skipped = {class: TargetClass; label: string; reason: "loopback" | "unresolved"};

export const LABEL_RE = /^[A-Za-z0-9 ._-]{1,64}$/;

const AdminTargetSchema = z
    .strictObject({
        kind: z.enum(["tcp", "dns_tcp", "dns_name"]),
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535).optional(),
        class: z.enum(ADMIN_TARGET_CLASSES),
        label: z.string().regex(LABEL_RE),
    })
    .superRefine((t, ctx) => {
        if (t.kind === "dns_name") {
            if (t.port !== undefined || !isProbeHostname(t.host)) ctx.addIssue({code: "custom", message: "dns_name needs a lowercase hostname and no port"});
        } else if (t.port === undefined) ctx.addIssue({code: "custom", message: "port required"});
        else if (isIpLiteral(t.host) ? !isProbeableIp(t.host) : !isProbeHostname(t.host)) ctx.addIssue({code: "custom", message: "host must be a routable IP literal or a hostname"});
        else if (t.kind === "dns_tcp" && !isIpLiteral(t.host)) ctx.addIssue({code: "custom", message: "dns_tcp needs the resolver's IP literal"});
    });

/** Admin list → typed list, or `"target_invalid"` / `"too_many_targets"`. URLs, userinfo, paths, loopback, link-local, multicast and unspecified hosts are refused. */
export function parseAdminTargets(input: unknown): AdminTarget[] | "target_invalid" | "too_many_targets" {
    if (!Array.isArray(input)) return "target_invalid";
    if (input.length > MAX_ADMIN_TARGETS) return "too_many_targets";
    const out: AdminTarget[] = [];
    for (const raw of input) {
        const r = AdminTargetSchema.safeParse(raw);
        if (!r.success) return "target_invalid";
        out.push(r.data as AdminTarget);
    }
    return out;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** `http(s)://host[:port]/…` → host + port (defaults 80/443). `null` when the URL is not usable. */
export function endpointOf(url: string): Endpoint | null {
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (!host) return null;
        return {host, port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80};
    } catch {
        return null;
    }
}

/** Canonical pre-resolution config + its sha. Arcane endpoints are de-duplicated and sorted, admin targets keep their order. */
export function configOf(a: {serverUrl: string; arcaneUrls: readonly string[]; admin: readonly AdminTarget[]}): {config: ProbeConfig; sha256: string} {
    const seen = new Set<string>();
    const arcane = a.arcaneUrls.map(endpointOf).filter((e): e is Endpoint => e !== null).filter((e) => (seen.has(`${e.host}:${e.port}`) ? false : (seen.add(`${e.host}:${e.port}`), true))).sort((x, y) => `${x.host}:${x.port}`.localeCompare(`${y.host}:${y.port}`));
    const config: ProbeConfig = {v: 1, canary: DNS_CANARY, server: endpointOf(a.serverUrl), arcane, admin: [...a.admin]};
    return {config, sha256: sha(canonicalJson(config))};
}

/** The sha the agent echoes: over the RESOLVED list (id, kind, host, port). */
export const targetsSha = (targets: readonly ProbeTarget[]): string => sha(canonicalJson(targets.map((t) => ({id: t.id, kind: t.kind, host: t.host, port: t.port}))));

export type Resolve = (host: string) => Promise<string[]>;
export type Materialized = {ok: true; targets: ProbeTarget[]; skipped: Skipped[]} | {ok: false; code: "too_many_targets" | "target_invalid"};

type Draft = Omit<ProbeTarget, "id">;

/** Config → resolved target list (ids `t01…`, de-duplicated by (kind, host, port)). An AUTO target that has no routable address is skipped (reported), an ADMIN one is refused. */
export async function materialize(config: ProbeConfig, resolve: Resolve): Promise<Materialized> {
    const drafts: Draft[] = [];
    const skipped: Skipped[] = [];
    const addEndpoint = async (e: Endpoint, cls: TargetClass, label: string, auto: boolean): Promise<boolean> => {
        if (isIpLiteral(e.host)) {
            if (!isProbeableIp(e.host)) { if (auto) { skipped.push({class: cls, label, reason: "loopback"}); return true; } return false; }
            drafts.push({kind: "tcp", host: e.host, port: e.port, class: cls, label});
            return true;
        }
        if (!isProbeHostname(e.host)) { if (auto) { skipped.push({class: cls, label, reason: "unresolved"}); return true; } return false; }
        const ips = (await resolve(e.host).catch(() => [])).filter((ip) => isProbeableIp(ip));
        if (ips.length === 0) {
            // resolves to nothing routable (e.g. `*.localhost` → 127.0.0.1): meaningless as an isolation target
            if (auto) { skipped.push({class: cls, label, reason: "loopback"}); return true; }
            return false;
        }
        for (const ip of ips) drafts.push({kind: "tcp", host: ip, port: e.port, class: cls, label});
        drafts.push({kind: "dns_name", host: e.host, class: cls, label});
        return true;
    };
    if (config.server) await addEndpoint(config.server, "dashboard", "Dashboard", true);
    for (const [i, e] of config.arcane.entries()) await addEndpoint(e, "arcane", `Arcane ${i + 1}`, true);
    drafts.push({kind: "dns_name", host: config.canary, class: "dns", label: "DNS canary"});
    for (const t of config.admin) {
        if (t.kind === "dns_name") { drafts.push({kind: "dns_name", host: t.host, class: t.class, label: t.label}); continue; }
        if (t.kind === "dns_tcp") { drafts.push({kind: "dns_tcp", host: t.host, port: t.port, class: t.class, label: t.label}); continue; }
        if (!(await addEndpoint({host: t.host, port: t.port!}, t.class, t.label, false))) return {ok: false, code: "target_invalid"};
    }
    const seen = new Set<string>();
    const unique = drafts.filter((d) => { const k = `${d.kind}|${d.host}|${d.port ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
    if (unique.length > MAX_PROBE_TARGETS) return {ok: false, code: "too_many_targets"};
    const sorted = [...unique].sort((a, b) => `${a.kind}|${a.host}|${a.port ?? ""}`.localeCompare(`${b.kind}|${b.host}|${b.port ?? ""}`));
    return {ok: true, targets: sorted.map((d, i) => ({id: `t${String(i + 1).padStart(2, "0")}`, ...d})), skipped};
}
