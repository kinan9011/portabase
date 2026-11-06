import {describe, expect, it, vi} from "vitest";
import {classifyAddress, embeddedIpv4, endpointIdentity, parseAllowlist, parseBaseUrl, UrlGuardError, vetBaseUrl, type Resolver} from "@/fork/net/guard";
import {forkEnv} from "@/fork/env";

const none = parseAllowlist("");
const res = (...addrs: string[]): Resolver => async () => addrs.map((a) => ({address: a, family: a.includes(":") ? 6 : 4}));
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: UrlGuardError) => e.code);

describe("classifyAddress — SSRF table", () => {
    it.each([
        ["169.254.169.254", "metadata"], ["169.254.170.2", "metadata"], ["100.100.100.200", "metadata"], ["192.0.0.192", "metadata"],
        ["fd00:ec2::254", "metadata"], ["::ffff:169.254.169.254", "metadata"], ["::ffff:a9fe:a9fe", "metadata"],
        ["127.0.0.1", "restricted"], ["127.1.2.3", "restricted"], ["::1", "restricted"], ["::ffff:127.0.0.1", "restricted"], ["0:0:0:0:0:ffff:7f00:1", "restricted"],
        ["0.0.0.0", "restricted"], ["::", "restricted"],
        ["10.0.0.5", "restricted"], ["172.16.0.1", "restricted"], ["172.31.255.255", "restricted"], ["192.168.1.1", "restricted"],
        ["100.64.0.1", "restricted"], ["169.254.1.1", "restricted"], ["fe80::1", "restricted"], ["fc00::1", "restricted"], ["fd12::1", "restricted"],
        ["224.0.0.1", "restricted"], ["255.255.255.255", "restricted"], ["240.0.0.1", "restricted"], ["ff02::1", "restricted"],
        ["198.18.0.1", "restricted"], ["2001:db8::1", "restricted"], ["2002:7f00:1::", "restricted"], ["64:ff9b::7f00:1", "restricted"],
        ["8.8.8.8", "public"], ["1.1.1.1", "public"], ["172.15.255.255", "public"], ["172.32.0.1", "public"], ["2606:4700:4700::1111", "public"],
    ])("%s → %s", (ip, cls) => {
        expect(classifyAddress(ip).cls).toBe(cls);
    });
    it("extracts IPv4-mapped addresses and nothing else", () => {
        expect(embeddedIpv4("::ffff:127.0.0.1")).toBe("127.0.0.1");
        expect(embeddedIpv4("::FFFF:7f00:1")).toBe("127.0.0.1");
        expect(embeddedIpv4("2606:4700::1")).toBeNull();
        expect(embeddedIpv4("127.0.0.1")).toBeNull();
    });
});

describe("parseBaseUrl", () => {
    it("normalises (lower-case host, no trailing slash, default port kept implicit)", () => {
        expect(parseBaseUrl("HTTPS://Arcane.Example.COM/").baseUrl).toBe("https://arcane.example.com");
        expect(parseBaseUrl("https://arcane.example.com:8443/sub/path/").baseUrl).toBe("https://arcane.example.com:8443/sub/path");
        expect(parseBaseUrl("http://[::1]:13552").baseUrl).toBe("http://[::1]:13552");
    });
    it.each([
        ["", "invalid_url"], ["not a url", "invalid_url"], ["ftp://x.example.com", "scheme_not_allowed"], ["file:///etc/passwd", "scheme_not_allowed"],
        ["javascript:alert(1)", "scheme_not_allowed"], ["https://user:pw@arcane.example.com", "userinfo_not_allowed"], ["https://user@arcane.example.com", "userinfo_not_allowed"],
        ["https://arcane.example.com/?api_key=abc", "query_not_allowed"], ["https://arcane.example.com/#frag", "query_not_allowed"], [`https://${"a".repeat(2100)}.com`, "invalid_url"],
    ])("rejects %s", (u, c) => {
        expect(() => parseBaseUrl(u)).toThrow(expect.objectContaining({code: c}));
    });
    it("error messages never echo the URL (no query/userinfo leak)", () => {
        for (const u of ["https://user:SECRETPW@arcane.example.com", "https://arcane.example.com/?api_key=SECRETQ"]) {
            try {
                parseBaseUrl(u);
            } catch (e) {
                expect((e as Error).message).not.toMatch(/SECRET/);
            }
        }
    });
    it("endpointIdentity: scheme+host+port, default ports filled, case-insensitive, path ignored", () => {
        expect(endpointIdentity("https://Arcane.example.com")).toBe("https://arcane.example.com:443");
        expect(endpointIdentity("https://arcane.example.com:443/x")).toBe("https://arcane.example.com:443");
        expect(endpointIdentity("http://arcane.example.com")).toBe("http://arcane.example.com:80");
        expect(endpointIdentity("https://arcane.example.com:8443")).not.toBe(endpointIdentity("https://arcane.example.com"));
        expect(endpointIdentity("http://[::1]:1")).toBe("http://::1:1");
        expect(endpointIdentity("nope")).toBeNull();
    });
});

describe("vetBaseUrl — default deny", () => {
    it.each([
        ["http://169.254.169.254/latest/meta-data", "metadata_blocked"],
        ["https://169.254.169.254", "metadata_blocked"],
        ["http://[fd00:ec2::254]", "metadata_blocked"],
        ["http://[::ffff:169.254.169.254]", "metadata_blocked"],
        ["https://127.0.0.1", "address_blocked"],
        ["http://127.0.0.1:13552", "address_blocked"],
        ["https://[::1]", "address_blocked"],
        ["https://10.1.2.3", "address_blocked"],
        ["https://192.168.0.10:9443", "address_blocked"],
        ["http://2130706433", "address_blocked"], // decimal 127.0.0.1
        ["http://0x7f000001", "address_blocked"], // hex
        ["http://0177.0.0.1", "address_blocked"], // octal
        ["http://127.1", "address_blocked"], // short form
        ["http://0", "address_blocked"],
        ["http://[::ffff:127.0.0.1]", "address_blocked"],
        ["http://8.8.8.8", "http_requires_allowlist"],
        ["http://[2606:4700:4700::1111]", "http_requires_allowlist"],
    ])("%s → %s", async (url, c) => {
        expect(await code(vetBaseUrl(url, {allowlist: none}))).toBe(c);
    });

    it("`localhost` resolves to loopback and is blocked without an allow-list entry", async () => {
        expect(await code(vetBaseUrl("https://localhost", {allowlist: none, resolve: res("127.0.0.1", "::1")}))).toBe("address_blocked");
        expect(await code(vetBaseUrl("http://localhost:13552", {allowlist: none, resolve: res("127.0.0.1")}))).toBe("address_blocked");
    });

    it("metadata is NEVER allow-listable (IP, CIDR, name)", async () => {
        const al = parseAllowlist("169.254.169.254,169.254.0.0/16,metadata.internal,fd00:ec2::254");
        expect(await code(vetBaseUrl("http://169.254.169.254", {allowlist: al}))).toBe("metadata_blocked");
        expect(await code(vetBaseUrl("https://metadata.internal", {allowlist: al, resolve: res("169.254.169.254")}))).toBe("metadata_blocked");
        expect(await code(vetBaseUrl("https://x.example.com", {allowlist: al, resolve: res("fd00:ec2::254")}))).toBe("metadata_blocked");
    });

    it("DNS rebinding: ANY bad answer in the record set denies (mixed public + loopback / public + metadata)", async () => {
        expect(await code(vetBaseUrl("https://arcane.example.com", {allowlist: none, resolve: res("93.184.216.34", "127.0.0.1")}))).toBe("address_blocked");
        expect(await code(vetBaseUrl("https://arcane.example.com", {allowlist: none, resolve: res("93.184.216.34", "169.254.169.254")}))).toBe("metadata_blocked");
        expect(await code(vetBaseUrl("https://arcane.example.com", {allowlist: parseAllowlist("127.0.0.1"), resolve: res("93.184.216.34", "169.254.169.254")}))).toBe("metadata_blocked");
    });

    it("DNS failure / empty answer → dns_failed (no address leaked)", async () => {
        expect(await code(vetBaseUrl("https://nx.example.com", {allowlist: none, resolve: async () => { throw new Error("ENOTFOUND secret-host"); }}))).toBe("dns_failed");
        expect(await code(vetBaseUrl("https://nx.example.com", {allowlist: none, resolve: res()}))).toBe("dns_failed");
    });

    it("public https passes, returns the vetted address (first answer) and every answer", async () => {
        const r = await vetBaseUrl("https://arcane.example.com:8443/api-gw/", {allowlist: none, resolve: res("93.184.216.34", "2606:2800:220:1::1")});
        expect(r).toMatchObject({baseUrl: "https://arcane.example.com:8443/api-gw", scheme: "https", hostname: "arcane.example.com", port: 8443, ip: "93.184.216.34", family: 4, viaAllowlist: false});
        expect(r.addresses).toEqual(["93.184.216.34", "2606:2800:220:1::1"]);
    });

    it("resolves exactly once (the pinned address is what the transport uses)", async () => {
        const resolve = vi.fn(res("93.184.216.34"));
        await vetBaseUrl("https://arcane.example.com", {allowlist: none, resolve});
        expect(resolve).toHaveBeenCalledTimes(1);
    });
});

describe("allow-list (FORK_ARCANE_NET_ALLOWLIST)", () => {
    it("lab: http://127.0.0.1 passes with an IP entry, only that address", async () => {
        const al = parseAllowlist("127.0.0.1");
        expect((await vetBaseUrl("http://127.0.0.1:13552", {allowlist: al})).viaAllowlist).toBe(true);
        expect(await code(vetBaseUrl("http://127.0.0.2:13552", {allowlist: al}))).toBe("address_blocked");
        expect(await code(vetBaseUrl("http://10.0.0.1", {allowlist: al}))).toBe("address_blocked");
    });
    it("CIDR entries (v4 + v6) and IPv4-mapped normalisation", async () => {
        const al = parseAllowlist("10.0.0.0/8, 192.168.1.0/24, fd12::/16");
        expect((await vetBaseUrl("https://10.200.3.4", {allowlist: al})).ip).toBe("10.200.3.4");
        expect((await vetBaseUrl("https://192.168.1.77", {allowlist: al})).ip).toBe("192.168.1.77");
        expect(await code(vetBaseUrl("https://192.168.2.1", {allowlist: al}))).toBe("address_blocked");
        expect((await vetBaseUrl("https://[fd12::5]", {allowlist: al})).ip).toBe("fd12::5");
        expect((await vetBaseUrl("http://[::ffff:10.1.1.1]", {allowlist: al})).ip).toBe("10.1.1.1");
    });
    it("a host-name entry vouches for that name only (resolved private address allowed, other names still blocked)", async () => {
        const al = parseAllowlist("arcane.lan");
        expect((await vetBaseUrl("http://arcane.lan:3552", {allowlist: al, resolve: res("192.168.1.9")})).viaAllowlist).toBe(true);
        expect(await code(vetBaseUrl("http://other.lan", {allowlist: al, resolve: res("192.168.1.9")}))).toBe("address_blocked");
    });
    it("http to a PUBLIC address is refused even when something is allow-listed", async () => {
        expect(await code(vetBaseUrl("http://arcane.example.com", {allowlist: parseAllowlist("127.0.0.1,arcane.lan"), resolve: res("93.184.216.34")}))).toBe("http_requires_allowlist");
    });
    it("invalid entries are dropped (fail closed) and reported", () => {
        const al = parseAllowlist("127.0.0.1, 999.1.1.1, 10.0.0.0/99, ../etc, , *.lan, ok.lan");
        expect(al.invalid).toEqual(["999.1.1.1", "10.0.0.0/99", "../etc", "*.lan"]);
        expect(al.names.has("ok.lan")).toBe(true);
        expect(al.empty).toBe(false);
    });
    it("empty / unset = deny everything restricted; env var is read through forkEnv", () => {
        expect(parseAllowlist(undefined).empty).toBe(true);
        expect(parseAllowlist("  ,, ").empty).toBe(true);
        expect(forkEnv({}).FORK_ARCANE_NET_ALLOWLIST).toBe("");
        expect(forkEnv({FORK_ARCANE_NET_ALLOWLIST: " 127.0.0.1 "}).FORK_ARCANE_NET_ALLOWLIST).toBe("127.0.0.1");
    });
});
