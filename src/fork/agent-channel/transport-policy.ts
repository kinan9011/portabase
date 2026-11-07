/**
 * https-only for the agent channel (ADR-007 D5, SEC-20). Used by the dashboard when it enrols an agent or enqueues a task, and mirrored by the agent
 * at start-up. The single exemption is the fork lab: `FORK_ALLOW_INSECURE_LOOPBACK=true` AND a loopback host. There is no per-agent or LAN override —
 * a plain-HTTP LAN would hand the bearer credential to any host on it (ADR-007 §http).
 */
export type TransportVerdict =
    | {ok: true; insecureLab: boolean}
    | {ok: false; code: "invalid_url" | "insecure_transport"};

const IPV4_LOOPBACK = /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/;

export function isLoopbackHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (h === "[::1]") return true;
    if (IPV4_LOOPBACK.test(h)) return h.split(".").every((o) => Number(o) <= 255);
    return false;
}

export function checkChannelTransport(serverUrl: string, env: {FORK_ALLOW_INSECURE_LOOPBACK: boolean}): TransportVerdict {
    let u: URL;
    try { u = new URL(serverUrl); } catch { return {ok: false, code: "invalid_url"}; }
    if (u.username || u.password || u.hash) return {ok: false, code: "invalid_url"};
    if (u.protocol === "https:") return {ok: true, insecureLab: false};
    if (u.protocol === "http:" && env.FORK_ALLOW_INSECURE_LOOPBACK && isLoopbackHost(u.hostname)) return {ok: true, insecureLab: true};
    return {ok: false, code: u.protocol === "http:" ? "insecure_transport" : "invalid_url"};
}
