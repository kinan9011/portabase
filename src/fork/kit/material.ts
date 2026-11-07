import {createCipheriv, hkdfSync, randomBytes} from "node:crypto";
import type {Keyring} from "@/fork/kek";

/**
 * Recovery kit CONTENT (D25, §4.2, ADR-006 data contract `kit_version: 1`). Built in memory only, handed once to a renderer, never persisted, never
 * logged. W14b's `verify-kit` consumes exactly this document (digital: after unwrapping; paper: the retyped groups of the key sections).
 */
export const KIT_VERSION = 1 as const;
const PENDING = "pending-W14b";

export type KitChannel = {name: string; provider: string; config: unknown};
export type KitAnchor = {kid: string; publicKeyPem: string; spkiSha256: string; retired: boolean};
export type KitSources = {master: Buffer; kek: Keyring; anchors: readonly KitAnchor[]; channels: readonly KitChannel[]; now: Date};

export type KitDocument = {
    kit_version: typeof KIT_VERSION;
    issued_at: string;
    master_key_b64: string;
    kek: {active: string; keys: {kid: string; key_b64: string}[]};
    signing_public_keys: {kid: string; spki_sha256: string; pem: string; retired: boolean}[];
    storage: {name: string; provider: string; pointer: Record<string, string | number | boolean>; credentials_wrapped: WrappedCredentials | null}[];
    recover: {image_digest: string; cli_version: string; guide: string};
};
export type WrappedCredentials = {alg: "AES-256-GCM"; kdf: string; iv: string; ct: string; tag: string};

/** Non-secret fields that locate a channel (where the data is), per provider shape. Anything else (keys, passwords, tokens) is NOT copied. */
const POINTER_KEYS = ["endPointUrl", "endpointUrl", "bucketName", "region", "port", "ssl", "host", "path", "remotePath", "containerName", "accountName", "remoteName", "folderId"] as const;
export function pointerOf(config: unknown): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    if (typeof config !== "object" || config === null) return out;
    for (const k of POINTER_KEYS) {
        const v = (config as Record<string, unknown>)[k];
        if (typeof v === "string" && v.length <= 512 && !/:\/\/[^/\s]*@/.test(v)) out[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
    return out;
}

export const CREDENTIAL_WRAP_INFO = "portabase-fork/kit/storage-credentials/v1";

/** Storage credentials wrapped under a key derived from the master key (so whoever holds the kit's master key can open them; nothing else can). */
export function wrapCredentials(master: Buffer, config: unknown, channelName: string): WrappedCredentials | null {
    if (config === null || config === undefined || (typeof config === "object" && Object.keys(config as object).length === 0)) return null;
    const key = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), CREDENTIAL_WRAP_INFO, 32));
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(`channel:${channelName}`, "utf8"));
    const ct = Buffer.concat([c.update(JSON.stringify(config), "utf8"), c.final()]);
    return {alg: "AES-256-GCM", kdf: `HKDF-SHA256 info=${CREDENTIAL_WRAP_INFO}`, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64")};
}

export function buildKit(s: KitSources): KitDocument {
    if (s.master.length !== 32) throw new Error("master key must be 32 bytes");
    return {
        kit_version: KIT_VERSION,
        issued_at: s.now.toISOString(),
        master_key_b64: s.master.toString("base64"),
        kek: {active: s.kek.active, keys: [...s.kek.keys.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kid, key]) => ({kid, key_b64: key.toString("base64")}))},
        signing_public_keys: s.anchors.map((a) => ({kid: a.kid, spki_sha256: a.spkiSha256, pem: a.publicKeyPem, retired: a.retired})),
        storage: s.channels.map((c) => ({name: c.name, provider: c.provider, pointer: pointerOf(c.config), credentials_wrapped: wrapCredentials(s.master, c.config, c.name)})),
        recover: {image_digest: PENDING, cli_version: PENDING, guide: PENDING},
    };
}
