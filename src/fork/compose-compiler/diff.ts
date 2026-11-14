import type {MirrorSpecV1} from "@/fork/compose-compiler/compile";
import type {MirrorIR} from "@/fork/compose-compiler/ir";
import {ACCESS_NETWORK, isDroppedLabel} from "@/fork/compose-compiler/rules";

/**
 * Redacted, readable diff of what the mirror compiler changed (W20 D-8). Content = service names, network/volume keys, port numbers + host_ip,
 * label KEYS, env KEYS + action, container_name, image refs and counts. NEVER values: env/label values, extra_hosts/dns values, command/healthcheck.
 * The compiler's input is a value-free policy view, so values cannot reach this module; the sanitiser below is a second line of defence.
 */
export type MirrorDiffKind =
    | "project_renamed" | "port_removed" | "port_published_loopback" | "container_name_to_alias" | "network_mode_reset" | "static_ip_dropped" | "network_replaced" | "network_isolated"
    | "volume_renamed" | "volume_external_replaced" | "label_dropped" | "env_rotate" | "env_disable" | "env_drop" | "env_keep_exact" | "removed_key" | "credential_reset" | "image_unpinned";
export type MirrorDiffEntry = {kind: MirrorDiffKind; service: string | null; subject: string; plain: string};

const LINE_MAX = 200;
const san = (s: string) => s.replace(/[^A-Za-z0-9_./:=@-]/gu, "?").slice(0, 128);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function mirrorDiff(ir: MirrorIR, spec: MirrorSpecV1): MirrorDiffEntry[] {
    const out: MirrorDiffEntry[] = [];
    const add = (kind: MirrorDiffKind, service: string | null, subject: string, plain: string) => out.push({kind, service, subject: san(subject), plain: plain.slice(0, LINE_MAX)});
    const P = spec.project;
    if (ir.name !== P) add("project_renamed", null, P, `project: name ${san(ir.name ?? "(none)")} → ${san(P)} (the mirror is a separate Compose project)`);

    for (const [svc, s] of Object.entries(ir.services)) {
        const isAccess = spec.access !== null && spec.access.service === svc;
        for (const p of s.ports) {
            if (p.published === null) continue;
            const host = p.host_ip === null || p.host_ip === "" ? "0.0.0.0" : p.host_ip;
            add("port_removed", svc, `${host}:${p.published}`, `${svc}: published port ${san(host)}:${san(p.published)} → ${p.target}/${san(p.protocol ?? "tcp")} removed (a mirror is reachable only through private access)`);
        }
        if (isAccess && spec.access !== null) add("port_published_loopback", svc, `127.0.0.1:${spec.access.host_port}`, `${svc}: private access published on 127.0.0.1:${spec.access.host_port} → ${spec.access.target}/tcp (reachable only on the runner, through an SSH tunnel)`);
        if (s.containerName !== null && s.containerName !== svc) add("container_name_to_alias", svc, s.containerName, `${svc}: container name ${san(s.containerName)} → kept as a network alias so other services still find it`);
        if (s.networkMode === "bridge" || s.networkMode === "default") add("network_mode_reset", svc, s.networkMode, `${svc}: network_mode ${san(s.networkMode)} → reset, attached to an isolated mirror network`);
        for (const [n, a] of Object.entries(s.networks ?? {})) if (a.hadStaticIp) add("static_ip_dropped", svc, n, `${svc}: fixed network address (static IP or MAC) on network ${san(n)} dropped`);
        for (const k of Object.keys(s.labels)) if (isDroppedLabel(k) && !k.startsWith("com.portabase.fork.")) add("label_dropped", svc, k, `${svc}: label ${san(k)} dropped (proxy, updater and scheduler labels do not belong to a mirror)`);
        for (const [key, action] of Object.entries(spec.env[svc] ?? {})) {
            if (action === "rotate") add("env_rotate", svc, key, `${svc}: environment ${san(key)} → replaced by a mirror-only value`);
            else if (action === "disable") add("env_disable", svc, key, `${svc}: environment ${san(key)} → pointed at disabled.invalid so it cannot reach a real service`);
            else if (action === "drop") add("env_drop", svc, key, `${svc}: environment ${san(key)} → removed`);
            else if (action === "keep_exact") add("env_keep_exact", svc, key, `${svc}: environment ${san(key)} → production value kept exactly, on operator request`);
        }
        for (const [k, n] of Object.entries(s.removed)) {
            if (k.startsWith("x-")) add("removed_key", svc, k, `${svc}: extension ${san(k)} removed`);
            else add("removed_key", svc, k, `${svc}: ${san(k)} removed (${n} ${n === 1 ? "entry" : "entries"}; values are never shown)`);
        }
        for (const r of spec.credential_resets) if (r.service === svc) add("credential_reset", svc, r.password_key, `${svc}: ${r.engine} role password (${r.user_key === null ? "admin role" : `user from ${san(r.user_key)}`}) must be reset to the mirror-only value after a volume restore`);
        if (s.image !== null && !s.image.includes("@sha256:")) add("image_unpinned", svc, s.image, `${svc}: image ${san(s.image)} is not pinned by digest`);
    }
    for (const [k, n] of Object.entries(ir.networks)) {
        if (n.external) add("network_replaced", null, k, `network ${san(k)}: was shared with production (external) → replaced by an isolated mirror network`);
        else add("network_isolated", null, k, `network ${san(k)}: replaced by an isolated mirror network (no outside access)`);
    }
    for (const k of Object.keys((spec.view.networks as Record<string, unknown> | undefined) ?? {})) {
        if (Object.hasOwn(ir.networks, k)) continue;
        if (k === ACCESS_NETWORK) add("network_isolated", null, k, `network ${san(k)}: added for private access to ${san(spec.access?.service ?? "?")} (loopback publish only; the runner firewall blocks its egress)`);
        else add("network_isolated", null, k, `network ${san(k)}: created as an isolated mirror network (no outside access)`);
    }
    for (const [k, v] of Object.entries(ir.volumes)) {
        if (v.external) add("volume_external_replaced", null, k, `volume ${san(k)}: was external → replaced by an empty mirror volume (starts empty unless the recovery point restores it)`);
        else add("volume_renamed", null, k, `volume ${san(k)}: renamed to ${san(`${P}_${k}`)} (a mirror never shares production volumes)`);
    }
    if (Object.values(spec.env).some((m) => Object.keys(m).length > 0)) add("env_rotate", null, "url-passwords", "environment: any password inside a URL value is replaced by a mirror-only value (all services)");
    return sortDiff(out);
}

const sortDiff = (e: MirrorDiffEntry[]): MirrorDiffEntry[] => [...e].sort((a, b) => cmp(a.service ?? "", b.service ?? "") || cmp(a.kind, b.kind) || cmp(a.subject, b.subject));

/** one line per entry, ≤ 200 chars, sorted service → kind → subject */
export const renderMirrorDiff = (entries: MirrorDiffEntry[]): string => sortDiff(entries).map((e) => e.plain.slice(0, LINE_MAX)).join("\n");
