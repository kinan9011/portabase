import crypto from "node:crypto";

/**
 * CONTROLLED COPY (D31) of upstream `src/features/database/utils/credential-crypto.ts` (+ `credential-fields.ts`), session-free.
 * Why a copy: the upstream file is `server-only` and its helpers sit next to session-bound actions; the fork needs the exact
 * on-disk envelope so the unchanged agent/dashboard read what we wrote. `__tests__/unit/w10-upstream-contract.test.ts` runs on
 * every W-SYNC: the copy's output must decrypt with upstream `decryptSecret`, and the secret-field map must equal upstream's.
 */
export type EncryptedSecret = {__encrypted: true; version: number; kid: string; iv: string; ciphertext: string; tag: string};

const VERSION = 1 as const;
const KID = "credentials-v1" as const;

export function encryptSecret(plaintext: string, masterKey: Buffer): EncryptedSecret {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {__encrypted: true, version: VERSION, kid: KID, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64")};
}

export const isEncryptedSecret = (v: unknown): v is EncryptedSecret => {
    if (typeof v !== "object" || v === null) return false;
    const o = v as Record<string, unknown>;
    return o.__encrypted === true && typeof o.iv === "string" && typeof o.ciphertext === "string" && typeof o.tag === "string";
};

/** Upstream `DB_SECRET_FIELDS` (credential-fields.ts). Anything listed is encrypted before it touches `databases.config`. */
export const SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = {
    postgresql: ["password"], "postgresql-cluster": ["password"], mysql: ["password"], mariadb: ["password"], mssql: ["password"],
    mongodb: ["password"], redis: ["password"], valkey: ["password"], firebird: ["password"], sqlite: [], "docker-volume": [], files: [],
};

/** Removes secret fields (plain or encrypted) so a config can be compared/hashed without a password ever being read. */
export function stripSecrets(dbms: string, config: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {...(config ?? {})};
    for (const f of SECRET_FIELDS[dbms] ?? []) delete out[f];
    return out;
}

/** Encrypts the supplied secrets into `config` (new row) or keeps the previous envelope when none is supplied (update). */
export function withEncryptedSecrets(dbms: string, config: Record<string, unknown>, secrets: Readonly<Record<string, string>>, previous: Record<string, unknown> | null, masterKey?: Buffer): Record<string, unknown> {
    const out: Record<string, unknown> = {...config};
    for (const f of SECRET_FIELDS[dbms] ?? []) {
        const plain = secrets[f];
        if (plain !== undefined && plain !== "") {
            if (!masterKey) throw new Error("master key required to store a credential");
            out[f] = encryptSecret(plain, masterKey);
        }
        else if (previous && previous[f] !== undefined) out[f] = previous[f];
    }
    return out;
}
