import {createHash, timingSafeEqual} from "node:crypto";

/**
 * Kit verification code (ADR-013 §8, D41). NOT printed on the kit: the operator obtains it only by running the offline verifier over the kit
 * (`portabase-recover verify-kit`, W14b) and types it into the dashboard, which compares it with the value stored at generation. One-way hash of
 * 256-bit random keys (safe to store). Recompute by hand:  see ADR-006 ("verification code") — the byte layout below is the contract.
 *
 *   SHA-256( "portabase-fork-kit/v1" ‖ 00 ‖ master(32) ‖ 00 ‖ ⋃ sorted-by-kid ( kid ‖ ':' ‖ key(32) ‖ 00 ) ‖ SHA-256(SPKI DER of the CURRENT public key) (32) )
 *   → first 10 bytes as `XXXX-XXXX-XXXX-XXXX-XXXX` (uppercase hex)
 */
export const KIT_CODE_PREFIX = "portabase-fork-kit/v1";

export type CodeInput = {master: Buffer; kek: ReadonlyMap<string, Buffer>; spkiSha256Hex: string};

export function kitVerificationCode(i: CodeInput): string {
    if (i.master.length !== 32 || !/^[0-9a-f]{64}$/.test(i.spkiSha256Hex)) throw new Error("bad kit code input");
    const h = createHash("sha256");
    h.update(Buffer.from(KIT_CODE_PREFIX, "utf8")).update(Buffer.from([0])).update(i.master).update(Buffer.from([0]));
    for (const kid of [...i.kek.keys()].sort()) {
        const key = i.kek.get(kid) as Buffer;
        if (key.length !== 32) throw new Error("bad kit code input");
        h.update(Buffer.from(`${kid}:`, "utf8")).update(key).update(Buffer.from([0]));
    }
    h.update(Buffer.from(i.spkiSha256Hex, "hex"));
    const hex = h.digest("hex").slice(0, 20).toUpperCase();
    return hex.match(/.{4}/g)?.join("-") as string;
}

/** `XXXX-XXXX-XXXX-XXXX-XXXX` or the bare 20 hex digits (any case, spaces/dashes tolerated); null = not a code. */
export function normalizeCode(input: string): string | null {
    if (input.length > 40) return null;
    const bare = input.replace(/[\s-]/g, "").toUpperCase();
    return /^[0-9A-F]{20}$/.test(bare) ? (bare.match(/.{4}/g) as string[]).join("-") : null;
}

/** Looks like a raw key (base64/base32/hex of ≥ 32 bytes) rather than a code: the screen refuses it without echoing it. */
export const looksLikeKey = (input: string): boolean => input.replace(/[\s-]/g, "").length >= 32;

export function codesEqual(a: string, b: string): boolean {
    const x = Buffer.from(a); const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}
