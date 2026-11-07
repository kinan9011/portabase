import {createHash, randomBytes, timingSafeEqual} from "node:crypto";

/**
 * Per-agent random credential (ADR-007 D2). 256-bit CSPRNG secret, stored ONLY as SHA-256 (a high-entropy secret needs no slow KDF), compared in
 * constant time against BOTH slots (current + rotation overlap) without short-circuiting, so a request costs the same whichever slot — or none — matches.
 * Wire form: `Authorization: Bearer fork.<agentId>.<secret>`. The secret is never logged, audited or returned after issue.
 */
const BEARER_RE = /^Bearer fork\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export type IssuedCredential = {bearer: string; hash: string};
export function generateCredential(agentId: string): IssuedCredential {
    const secret = randomBytes(32).toString("base64url");
    return {bearer: `fork.${agentId}.${secret}`, hash: sha256Hex(secret)};
}

export function parseBearer(header: string | null | undefined): {agentId: string; secret: string} | null {
    if (!header || header.length > 200) return null;
    const m = BEARER_RE.exec(header);
    return m ? {agentId: m[1], secret: m[2]} : null;
}

/** A hash no secret hashes to: what an unknown agent is compared against, so unknown vs wrong credential do the same work. */
export const DUMMY_HASH = "0".repeat(64);

const eq = (a: string, b: string) => {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    return x.length === y.length && timingSafeEqual(x, y);
};

/** `current` | `previous` | null. Both slots are always compared. */
export function matchCredential(secret: string, current: string | null | undefined, previous: string | null | undefined): "current" | "previous" | null {
    const h = sha256Hex(secret);
    const c = eq(h, current ?? DUMMY_HASH);
    const p = eq(h, previous ?? DUMMY_HASH);
    return c ? "current" : p ? "previous" : null;
}
