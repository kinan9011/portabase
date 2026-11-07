import {createHash, createPrivateKey, createPublicKey, sign as rsaSign, verify as rsaVerify} from "node:crypto";
import {z} from "zod";
import {canonicalJson} from "@/fork/canonical";
import {kidOfPublicKey} from "@/fork/manifest/sign";
import {SIGN_DOMAIN} from "./vocab";

/**
 * The signed task envelope (ADR-007 D3). Numbers are integers only (epoch seconds, seq) so canonical JSON is deterministic everywhere; and the agent
 * never re-canonicalises: it verifies the signature over the EXACT bytes the dashboard stored and sent (`SIGN_DOMAIN ‖ envelope_text`), then parses.
 * RSASSA-PKCS1-v1_5 / SHA-256 with the dashboard key — the same primitive and key custody as the manifest signature (ADR-013 §2).
 */
export const EnvelopeSchema = z.strictObject({
    v: z.literal(1),
    task_id: z.uuid(),
    agent_id: z.uuid(),
    /** Enrolment generation: binds the agent's persisted replay state; a re-enrolment (e.g. after a dashboard DB rollback) starts a new one. */
    enroll_id: z.uuid(),
    type: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
    seq: z.number().int().min(1).max(2_147_483_647),
    issued_at: z.number().int().min(0),
    not_after: z.number().int().min(0),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    requires: z.array(z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/)).max(16),
    kid: z.string().regex(/^[0-9a-f]{12}$/),
    target_agent_id: z.uuid().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export type SignedEnvelope = {text: string; signature: string; kid: string};

const signedBytes = (text: string) => Buffer.from(SIGN_DOMAIN + text, "utf8");

export function signEnvelope(envelope: Envelope, privateKeyPem: string): SignedEnvelope {
    const e = EnvelopeSchema.parse(envelope);
    const priv = createPrivateKey(privateKeyPem);
    const kid = kidOfPublicKey(createPublicKey(priv).export({type: "spki", format: "pem"}).toString());
    if (e.kid !== kid) throw new Error("envelope kid does not match the signing key");
    const text = canonicalJson({...e, requires: [...e.requires].sort()});
    return {text, signature: rsaSign("sha256", signedBytes(text), priv).toString("base64"), kid};
}

export type Pin = {kid: string; pem: string};

/** Reference verifier (tests and parity vectors for the Rust agent): valid ⇔ some pinned key with the envelope's kid verifies the signature. */
export function verifyEnvelope(text: string, signatureB64: string, pins: readonly Pin[]): {ok: true; envelope: Envelope} | {ok: false; reason: "bad_signature" | "unknown_kid" | "bad_envelope"} {
    let parsed: Envelope;
    try { parsed = EnvelopeSchema.parse(JSON.parse(text)); } catch { return {ok: false, reason: "bad_envelope"}; }
    const pin = pins.find((p) => p.kid === parsed.kid);
    if (!pin) return {ok: false, reason: "unknown_kid"};
    let good = false;
    try { good = rsaVerify("sha256", signedBytes(text), createPublicKey(pin.pem), Buffer.from(signatureB64, "base64")); } catch { good = false; }
    return good ? {ok: true, envelope: parsed} : {ok: false, reason: "bad_signature"};
}

/** Fingerprint shown at enrolment and logged by the agent (SHA-256 of the SPKI DER, hex). */
export const pinFingerprint = (publicKeyPem: string) => createHash("sha256").update(createPublicKey(publicKeyPem).export({type: "spki", format: "der"})).digest("hex");
