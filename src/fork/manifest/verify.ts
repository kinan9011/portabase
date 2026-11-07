import {createPublicKey, verify as rsaVerify} from "node:crypto";
import {canonicalJson} from "@/fork/canonical";
import {MANIFEST_MAX_BYTES, ManifestV1} from "./schema";
import {kidOfPublicKey} from "./sign";

/**
 * Pure verifier (K-3). Fail closed; the code says WHY without echoing manifest content. Order matters: size → parse → strict schema →
 * canonical form → trust anchor by kid → signature → binding to the expected stack/RP → anti-rollback floor.
 * A retired anchor still verifies (old RPs, ADR-013 §3); `rollback` = a VALIDLY SIGNED manifest older than what the verifier already knows.
 */
export type TrustAnchor = {kid: string; publicKeyPem: string};
export type VerifyExpect = {stackId: string; rpId?: string; sequence?: number; /** highest sequence already accepted for this stack */ minSequence?: number};
export type ManifestRejection = "too_large" | "bad_format" | "bad_schema" | "not_canonical" | "unknown_kid" | "bad_signature" | "stack_mismatch" | "rp_mismatch" | "sequence_mismatch" | "rollback";
export type VerifyResult = {ok: true; manifest: ManifestV1; kid: string} | {ok: false; code: ManifestRejection};

export function verifyManifestBundle(bundle: {json: Buffer | string; sig: Buffer}, anchors: readonly TrustAnchor[], expect: VerifyExpect): VerifyResult {
    const raw = typeof bundle.json === "string" ? Buffer.from(bundle.json, "utf8") : bundle.json;
    if (raw.length > MANIFEST_MAX_BYTES) return {ok: false, code: "too_large"};
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch { return {ok: false, code: "bad_format"}; }
    const m = ManifestV1.safeParse(parsed);
    if (!m.success) return {ok: false, code: "bad_schema"};
    if (canonicalJson(m.data) !== raw.toString("utf8")) return {ok: false, code: "not_canonical"};
    const anchor = anchors.find((a) => a.kid === m.data.kid && safeKid(a.publicKeyPem) === a.kid);
    if (!anchor) return {ok: false, code: "unknown_kid"};
    let sigOk = false;
    try { sigOk = rsaVerify("sha256", raw, createPublicKey(anchor.publicKeyPem), bundle.sig); } catch { sigOk = false; }
    if (!sigOk) return {ok: false, code: "bad_signature"};
    if (m.data.rp.stack_id.toLowerCase() !== expect.stackId.toLowerCase()) return {ok: false, code: "stack_mismatch"};
    if (expect.rpId !== undefined && m.data.rp.id.toLowerCase() !== expect.rpId.toLowerCase()) return {ok: false, code: "rp_mismatch"};
    if (expect.sequence !== undefined && m.data.rp.sequence !== expect.sequence) return {ok: false, code: "sequence_mismatch"};
    if (expect.minSequence !== undefined && m.data.rp.sequence < expect.minSequence) return {ok: false, code: "rollback"};
    return {ok: true, manifest: m.data, kid: anchor.kid};
}

function safeKid(pem: string): string | null {
    try { return kidOfPublicKey(pem); } catch { return null; }
}
