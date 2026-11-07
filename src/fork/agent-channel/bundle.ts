/**
 * The enrolment bundle (ADR-007 D2–D4): the ONE place the agent credential, the agent task key and the pinned public key travel together, out of band of
 * the polling channel. Shown once by the enrol action; the agent reads it from a 0600 file (`FORK_CHANNEL_BUNDLE_FILE`) — never argv, never logged.
 * Format: base64url(JSON). The public key is delivered here — there is no trust-on-first-use over the channel, ever.
 */
export type ChannelBundle = {
    v: 1;
    enroll_id: string;
    server_url: string;
    agent_id: string;
    /** Full bearer value `fork.<agentId>.<secret>`. */
    credential: string;
    /** 32-byte agent task key, base64. */
    task_key_b64: string;
    pins: {kid: string; pem: string}[];
    /** SHA-256 of the SPKI DER of the pinned key, hex — compare with what the dashboard showed. */
    pin_fingerprint: string;
};

export const encodeBundle = (b: ChannelBundle): string => Buffer.from(JSON.stringify(b), "utf8").toString("base64url");
export function decodeBundle(s: string): ChannelBundle {
    const b = JSON.parse(Buffer.from(s.trim(), "base64url").toString("utf8")) as ChannelBundle;
    if (b?.v !== 1 || !Array.isArray(b.pins)) throw new Error("bad bundle");
    return b;
}
