import {BlockList, isIP} from "node:net";
import {lookup} from "node:dns/promises";

/**
 * SSRF guard for the Arcane `base_url` (W05, SEC-10, ADR-005 B2-S, ADR-012). Default deny.
 *
 *  - scheme: `https` anywhere the address rules pass; `http` ONLY when every resolved address is a restricted-class
 *    address that the operator allow-listed (lab: `FORK_ARCANE_NET_ALLOWLIST=127.0.0.1`);
 *  - addresses: public unicast is allowed; loopback / private / CGNAT / link-local / ULA / reserved / multicast need an
 *    allow-list entry (IP, CIDR or host name); cloud metadata addresses are NEVER allowed, allow-list or not;
 *  - the host is resolved ONCE; every answer must pass (a mixed answer is a rebinding signal) and the transport connects
 *    to the vetted address (`pinned-request.ts`) — it never re-resolves the name;
 *  - no userinfo, no query, no fragment in the stored URL (credentials never travel in `base_url`).
 * The allow-list is operator-controlled (`FORK_ARCANE_NET_ALLOWLIST`), never writable from the UI.
 */
export type GuardCode =
    | "invalid_url"
    | "scheme_not_allowed"
    | "userinfo_not_allowed"
    | "query_not_allowed"
    | "http_requires_allowlist"
    | "address_blocked"
    | "metadata_blocked"
    | "dns_failed";

export class UrlGuardError extends Error {
    constructor(public readonly code: GuardCode, message: string) {
        super(message);
        this.name = "UrlGuardError";
    }
}

type Family = 4 | 6;
const block = (v4: [string, number][], v6: [string, number][] = []) => {
    const b = new BlockList();
    for (const [a, p] of v4) b.addSubnet(a, p, "ipv4");
    for (const [a, p] of v6) b.addSubnet(a, p, "ipv6");
    return b;
};

/** Never reachable: cloud instance-metadata endpoints (AWS/GCP/Azure/OCI link-local, ECS task metadata, Alibaba, AWS IPv6). */
const METADATA = block(
    [["169.254.169.254", 32], ["169.254.170.2", 32], ["100.100.100.200", 32], ["192.0.0.192", 32]],
    [["fd00:ec2::254", 128]],
);
/** IPv4 ranges that are not globally routable unicast. */
const RESTRICTED_V4 = block([
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]);
/** IPv6 inside 2000::/3 that is not ordinary global unicast (documentation, 6to4, Teredo). Everything outside 2000::/3 is restricted. */
const RESTRICTED_V6_INSIDE_GLOBAL = block([], [["2001:db8::", 32], ["2002::", 16], ["2001::", 32]]);
const GLOBAL_V6 = block([], [["2000::", 3]]);

/** 16 bytes of an IPv6 literal (zone id stripped, dotted-quad tail supported), or null. */
function v6Bytes(ipIn: string): number[] | null {
    const ip = ipIn.split("%")[0].toLowerCase();
    if (isIP(ip) !== 6) return null;
    let head = ip;
    const tail: number[] = [];
    const dotted = ip.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (dotted) {
        tail.push(...dotted.slice(1, 5).map(Number));
        head = `${ip.slice(0, ip.length - dotted[0].length)}0:0`;
    }
    const [l, r] = head.split("::");
    const groups = (x: string) => (x ? x.split(":") : []);
    const left = groups(l);
    const right = r === undefined ? [] : groups(r);
    const fill = 8 - left.length - right.length;
    if (r === undefined ? left.length !== 8 : fill < 0) return null;
    const all = [...left, ...Array(r === undefined ? 0 : fill).fill("0"), ...right].map((g) => Number.parseInt(g, 16));
    if (all.length !== 8 || all.some((g) => Number.isNaN(g))) return null;
    const bytes = all.flatMap((g) => [g >> 8, g & 255]);
    if (dotted) bytes.splice(12, 4, ...tail);
    return bytes;
}

/** Embedded IPv4 of an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, `::ffff:7f00:1`, `0:0:0:0:0:ffff:…`), else null. */
export function embeddedIpv4(ip: string): string | null {
    const b = v6Bytes(ip);
    if (!b) return null;
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b.slice(12).join(".");
    return null;
}

export type AddressClass = "public" | "restricted" | "metadata";

export function classifyAddress(ipIn: string): {cls: AddressClass; ip: string; family: Family} {
    const mapped = embeddedIpv4(ipIn);
    const ip = mapped ?? ipIn;
    const fam = isIP(ip);
    if (fam === 0) return {cls: "restricted", ip, family: 4}; // unparseable ⇒ never public
    const family = fam as Family;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (METADATA.check(ip, type)) return {cls: "metadata", ip, family};
    if (family === 4) return {cls: RESTRICTED_V4.check(ip, "ipv4") ? "restricted" : "public", ip, family};
    const global = GLOBAL_V6.check(ip, "ipv6") && !RESTRICTED_V6_INSIDE_GLOBAL.check(ip, "ipv6");
    return {cls: global ? "public" : "restricted", ip, family};
}

export type Allowlist = {
    readonly addresses: BlockList;
    readonly names: ReadonlySet<string>;
    /** entries that could not be parsed (dropped, fail closed) — surface as a warning, never as an allow. */
    readonly invalid: readonly string[];
    readonly empty: boolean;
};

const hostNameRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function parseAllowlist(raw: string | undefined | null): Allowlist {
    const addresses = new BlockList();
    const names = new Set<string>();
    const invalid: string[] = [];
    let count = 0;
    for (const part of (raw ?? "").split(",")) {
        const e = part.trim().toLowerCase();
        if (!e) continue;
        const slash = e.indexOf("/");
        try {
            if (slash > 0) {
                const addr = e.slice(0, slash);
                const prefix = Number(e.slice(slash + 1));
                const fam = isIP(addr);
                if (!fam || !Number.isInteger(prefix) || prefix < 0 || prefix > (fam === 4 ? 32 : 128)) throw new Error("bad cidr");
                addresses.addSubnet(addr, prefix, fam === 4 ? "ipv4" : "ipv6");
            } else if (isIP(e)) {
                const mapped = embeddedIpv4(e);
                addresses.addAddress(mapped ?? e, isIP(mapped ?? e) === 4 ? "ipv4" : "ipv6");
            } else if (!/^[\d.]+$/.test(e) && hostNameRe.test(e.replace(/\.$/, ""))) {
                names.add(e.replace(/\.$/, ""));
            } else {
                throw new Error("bad entry");
            }
            count++;
        } catch {
            invalid.push(e.slice(0, 64));
        }
    }
    return {addresses, names, invalid, empty: count === 0};
}

export type ResolvedAddress = {address: string; family: number};
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const DNS_TIMEOUT_MS = 5_000;
export const systemResolver: Resolver = async (hostname) => {
    const r = await Promise.race([
        lookup(hostname, {all: true, verbatim: true}),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), DNS_TIMEOUT_MS).unref()),
    ]);
    return r.map((x) => ({address: x.address, family: x.family}));
};

export type VettedTarget = {
    /** normalised `scheme://host[:port][/path]` — no userinfo/query/fragment, no trailing slash. */
    baseUrl: string;
    scheme: "http" | "https";
    hostname: string;
    port: number;
    /** the ONE address the transport must connect to. */
    ip: string;
    family: Family;
    /** every address the name resolved to (all vetted). */
    addresses: string[];
    /** true when a restricted address was permitted by the allow-list. */
    viaAllowlist: boolean;
};

/** `scheme://host:port` (default port filled, host lower-cased, IPv6 without brackets) — the SEC-10 identity of an endpoint. */
export function endpointIdentity(baseUrl: string): string | null {
    try {
        const u = new URL(baseUrl);
        const scheme = u.protocol.replace(":", "");
        if (scheme !== "http" && scheme !== "https") return null;
        const port = u.port ? Number(u.port) : scheme === "https" ? 443 : 80;
        return `${scheme}://${stripBrackets(u.hostname).toLowerCase().replace(/\.$/, "")}:${port}`;
    } catch {
        return null;
    }
}

const stripBrackets = (h: string) => (h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h);

export function parseBaseUrl(raw: string): {baseUrl: string; scheme: "http" | "https"; hostname: string; port: number} {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) throw new UrlGuardError("invalid_url", "The Arcane URL is missing or too long.");
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        throw new UrlGuardError("invalid_url", "The Arcane URL is not a valid URL.");
    }
    const scheme = u.protocol.replace(":", "");
    if (scheme !== "http" && scheme !== "https") throw new UrlGuardError("scheme_not_allowed", "Only http:// and https:// URLs are supported.");
    if (u.username || u.password) throw new UrlGuardError("userinfo_not_allowed", "The URL must not contain credentials.");
    if (u.search || u.hash) throw new UrlGuardError("query_not_allowed", "The URL must not contain a query string or fragment.");
    const hostname = stripBrackets(u.hostname).toLowerCase().replace(/\.$/, "");
    if (!hostname) throw new UrlGuardError("invalid_url", "The Arcane URL has no host.");
    const port = u.port ? Number(u.port) : scheme === "https" ? 443 : 80;
    const path = u.pathname.replace(/\/+$/, "");
    const hostPart = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    const portPart = u.port ? `:${u.port}` : "";
    return {baseUrl: `${scheme}://${hostPart}${portPart}${path}`, scheme, hostname, port};
}

export type VetOptions = {allowlist: Allowlist; resolve?: Resolver};

/** Parses + resolves + vets. Throws `UrlGuardError` (never leaks the URL path/query in the message). */
export async function vetBaseUrl(raw: string, opts: VetOptions): Promise<VettedTarget> {
    const p = parseBaseUrl(raw);
    let answers: ResolvedAddress[];
    if (isIP(p.hostname)) {
        answers = [{address: p.hostname, family: isIP(p.hostname)}];
    } else {
        try {
            answers = await (opts.resolve ?? systemResolver)(p.hostname);
        } catch {
            throw new UrlGuardError("dns_failed", "The Arcane host name could not be resolved.");
        }
    }
    if (!answers || answers.length === 0) throw new UrlGuardError("dns_failed", "The Arcane host name did not resolve to any address.");

    const nameAllowed = !isIP(p.hostname) && opts.allowlist.names.has(p.hostname);
    let viaAllowlist = false;
    const vetted: {ip: string; family: Family}[] = [];
    for (const a of answers) {
        const c = classifyAddress(a.address);
        if (c.cls === "metadata") throw new UrlGuardError("metadata_blocked", "That address is a cloud metadata endpoint and can never be used.");
        if (c.cls === "restricted") {
            const type = c.family === 4 ? "ipv4" : "ipv6";
            const allowed = nameAllowed || opts.allowlist.addresses.check(c.ip, type);
            if (!allowed) {
                throw new UrlGuardError(
                    "address_blocked",
                    `The address ${c.ip} is loopback, private or otherwise not publicly routable. The operator can allow it with FORK_ARCANE_NET_ALLOWLIST.`,
                );
            }
            viaAllowlist = true;
        } else if (p.scheme === "http") {
            throw new UrlGuardError("http_requires_allowlist", "http:// is only allowed for allow-listed private or loopback addresses; use https://.");
        }
        vetted.push({ip: c.ip, family: c.family});
    }
    if (p.scheme === "http" && !viaAllowlist) throw new UrlGuardError("http_requires_allowlist", "http:// is only allowed for allow-listed private or loopback addresses; use https://.");
    const first = vetted[0];
    return {...p, ip: first.ip, family: first.family, addresses: vetted.map((v) => v.ip), viaAllowlist};
}
