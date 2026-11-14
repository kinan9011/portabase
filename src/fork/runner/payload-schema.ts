import {BlockList, isIP} from "node:net";
import {z} from "zod";

/**
 * `runner_probe` payload (W21 DD-4). Strict on both sides: the Rust agent (`src/fork/runner/probe.rs`) applies the SAME refusals, a vector test in each repo pins the shared cases.
 * `host` is an IP literal (tcp / dns_tcp) or a lowercase hostname (dns_name); nothing here can ever reach a shell: the agent passes values as env lines and positional args only.
 */
export const PROBE_KINDS = ["tcp", "dns_tcp", "dns_name"] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];
export const PROBE_ID_RE = /^[a-z0-9]{1,8}$/;
export const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const MAX_PROBE_TARGETS = 32;
/** A hostname whose last label is all digits is an (obfuscated) IP, never a name (Rust twin: `valid_hostname`). */
export const isProbeHostname = (h: string): boolean => HOSTNAME_RE.test(h) && !/\.[0-9]+$/.test(h);

/** Loopback, unspecified, link-local, multicast and IPv4-mapped IPv6 are never probe targets (they say nothing about a route to production). */
const FORBIDDEN = new BlockList();
FORBIDDEN.addSubnet("127.0.0.0", 8, "ipv4");
FORBIDDEN.addSubnet("0.0.0.0", 8, "ipv4");
FORBIDDEN.addSubnet("169.254.0.0", 16, "ipv4");
FORBIDDEN.addSubnet("224.0.0.0", 4, "ipv4");
FORBIDDEN.addAddress("::1", "ipv6");
FORBIDDEN.addAddress("::", "ipv6");
FORBIDDEN.addSubnet("fe80::", 10, "ipv6");
FORBIDDEN.addSubnet("ff00::", 8, "ipv6");

/** `true` when `host` is an IP literal that may be probed. */
export function isProbeableIp(host: string): boolean {
    const v = isIP(host);
    if (v === 0) return false;
    // node's BlockList treats every IPv4 address as IPv4-mapped IPv6, so a `::ffff:0:0/96` rule would block all of v4: refuse mapped literals by shape instead
    if (v === 6 && /^(0{1,4}:){5}ffff:|^::ffff:/i.test(host)) return false;
    return !FORBIDDEN.check(host, v === 4 ? "ipv4" : "ipv6");
}
/** `true` when `host` is an IP literal of a kind we refuse (so an admin target can say "loopback" and not "invalid"). */
export const isIpLiteral = (host: string): boolean => isIP(host) !== 0;

export const ProbeTarget = z
    .strictObject({
        id: z.string().regex(PROBE_ID_RE),
        kind: z.enum(PROBE_KINDS),
        host: z.string().max(253),
        port: z.number().int().min(1).max(65535).optional(),
    })
    .superRefine((t, ctx) => {
        if (t.kind === "dns_name") {
            if (t.port !== undefined || !isProbeHostname(t.host)) ctx.addIssue({code: "custom", message: "dns_name needs a lowercase hostname and no port"});
        } else if (t.port === undefined || !isProbeableIp(t.host)) ctx.addIssue({code: "custom", message: "tcp / dns_tcp need a probeable IP literal and a port"});
    });

export const RunnerProbePayload = z
    .strictObject({
        v: z.literal(1),
        probe_id: z.uuid(),
        targets_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        timeout_ms: z.number().int().min(500).max(5000),
        targets: z.array(ProbeTarget).min(1).max(MAX_PROBE_TARGETS),
    })
    .superRefine((p, ctx) => {
        if (new Set(p.targets.map((t) => t.id)).size !== p.targets.length) ctx.addIssue({code: "custom", message: "duplicate target id"});
    });
export type RunnerProbePayload = z.infer<typeof RunnerProbePayload>;
