import {createHash, createPrivateKey, createPublicKey, sign as rsaSign} from "node:crypto";
import {canonicalJson} from "@/fork/canonical";
import {ManifestV1} from "./schema";

/**
 * Detached RSA signature over the canonical manifest bytes. RSA-2048 PKCS#1 v1.5 + SHA-256 = what
 * `openssl dgst -sha256 -verify server_public.pem -signature manifest.json.sig manifest.json` checks (ADR-013 §2): no fork tooling needed to verify.
 * The private key is a parameter (read by `upstream/keys.ts`, never stored or logged here).
 */
export type SignedManifest = {json: string; sig: Buffer; kid: string};

/** First 12 hex of SHA-256(SPKI DER). Accepts the PKCS#1 or SPKI public PEM the dashboard writes. */
export function kidOfPublicKey(publicKeyPem: string): string {
    const der = createPublicKey(publicKeyPem).export({type: "spki", format: "der"});
    return createHash("sha256").update(der).digest("hex").slice(0, 12);
}

/** Full SHA-256 of the SPKI DER (shown in the kit and mixed into the kit verification code). */
export function spkiSha256(publicKeyPem: string): string {
    return createHash("sha256").update(createPublicKey(publicKeyPem).export({type: "spki", format: "der"})).digest("hex");
}

export function publicKeyPemOf(privateKeyPem: string): string {
    return createPublicKey(createPrivateKey(privateKeyPem)).export({type: "spki", format: "pem"}).toString();
}

/** Validates (strict schema) then signs. `manifest.kid` MUST equal the kid of the signing key (a mismatch is a programming error, never signed). */
export function signManifest(manifest: ManifestV1, privateKeyPem: string): SignedManifest {
    const parsed = ManifestV1.parse(manifest);
    const priv = createPrivateKey(privateKeyPem);
    const kid = kidOfPublicKey(createPublicKey(priv).export({type: "spki", format: "pem"}).toString());
    if (parsed.kid !== kid) throw new Error("manifest kid does not match the signing key");
    const json = canonicalJson(parsed);
    return {json, sig: rsaSign("sha256", Buffer.from(json, "utf8"), priv), kid};
}
