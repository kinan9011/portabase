import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";
import {chmod, mkdir, open, readdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";

/**
 * Fork KEK (D23, ADR-004 §6). Encrypts fork secrets with a versioned envelope `{kid, iv, ct, tag}`.
 *
 * - NEVER the edge key / instance master key: this module imports nothing from them (a static test pins it).
 * - AES-256-GCM, random 12-byte IV, AAD = `table|row_id|column` ⇒ a ciphertext copied to another row,
 *   column or table does not decrypt.
 * - No fixed kid: `kid = "k" + sha256(key)[0..12]`, so it identifies key material. The keyring directory holds
 *   every kid ever used (decrypt) and an `active` file naming the kid that encrypts (rotation-ready).
 * - Threat statement (CH-01): protects against holders of the instance master key and row/column swapping inside the
 *   DB. It does NOT protect against dashboard-process compromise or theft of DB dump + keyring together.
 * - Errors are generic by design: no plaintext, key bytes or envelope content in messages.
 */
export type ForkSecretAad = {table: string; rowId: string; column: string};
export const aadString = (a: ForkSecretAad) => `${a.table}|${a.rowId}|${a.column}`;

const b64u = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const ForkEnvelopeSchema = z.strictObject({
    kid: z.string().regex(/^k[0-9a-f]{12}$/),
    iv: b64u.length(16), // 12 bytes
    ct: b64u,
    tag: b64u.length(22), // 16 bytes
});
export type ForkEnvelope = z.infer<typeof ForkEnvelopeSchema>;

export class ForkCryptoError extends Error {
    constructor(message = "fork secret operation failed") {
        super(message);
        this.name = "ForkCryptoError";
    }
}

export type Keyring = {active: string; keys: ReadonlyMap<string, Buffer>};

export const kidOf = (key: Buffer) => `k${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;

export const defaultKekDir = (privatePath = process.env.PRIVATE_PATH) => {
    if (!privatePath) throw new ForkCryptoError("PRIVATE_PATH is not set; fork KEK location unknown");
    return path.join(privatePath, "keys", "fork-kek");
};

async function writeKeyFile(dir: string, key: Buffer): Promise<string> {
    const kid = kidOf(key);
    const fh = await open(path.join(dir, `${kid}.key`), "wx", 0o600).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "EEXIST") return null;
        throw e;
    });
    if (fh) {
        await fh.writeFile(key);
        await fh.close();
    }
    return kid;
}

/** Loads the keyring; returns null if the directory has no key yet. Validates length, kid-vs-filename and mode. */
export async function loadKeyring(dir: string): Promise<Keyring | null> {
    let files: string[];
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".key"));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
    }
    if (files.length === 0) return null;
    const keys = new Map<string, Buffer>();
    for (const f of files) {
        const key = await readFile(path.join(dir, f));
        if (key.length !== 32) throw new ForkCryptoError("fork KEK file has an invalid length");
        const kid = kidOf(key);
        if (f !== `${kid}.key`) throw new ForkCryptoError("fork KEK file name does not match its key id");
        keys.set(kid, key);
    }
    const active = (await readFile(path.join(dir, "active"), "utf8").catch(() => "")).trim();
    if (!keys.has(active)) throw new ForkCryptoError("fork KEK `active` file is missing or names an unknown key");
    return {active, keys};
}

/** First use generates a 256-bit key (0600, dir 0700), same custody pattern as `getOrCreateMasterKey` but a separate secret. */
export async function getOrCreateKeyring(dir = defaultKekDir()): Promise<Keyring> {
    const existing = await loadKeyring(dir);
    if (existing) return existing;
    await mkdir(dir, {recursive: true, mode: 0o700});
    await chmod(dir, 0o700);
    const kid = await writeKeyFile(dir, randomBytes(32));
    await writeFile(path.join(dir, "active"), kid, {mode: 0o600});
    const created = await loadKeyring(dir);
    if (!created) throw new ForkCryptoError("fork KEK could not be created");
    return created;
}

/** Adds a new key and makes it active. Old kids stay for decryption; re-encrypting rows is the W14 key-management job. */
export async function rotateForkKek(dir = defaultKekDir()): Promise<{kid: string; previous: string}> {
    const ring = await getOrCreateKeyring(dir);
    const kid = await writeKeyFile(dir, randomBytes(32));
    await writeFile(path.join(dir, "active"), kid, {mode: 0o600});
    return {kid, previous: ring.active};
}

export function encryptWith(ring: Keyring, plaintext: string, aad: ForkSecretAad): ForkEnvelope {
    const key = ring.keys.get(ring.active);
    if (!key) throw new ForkCryptoError();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(aadString(aad), "utf8"));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return {kid: ring.active, iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: c.getAuthTag().toString("base64url")};
}

export function decryptWith(ring: Keyring, envelope: unknown, aad: ForkSecretAad): string {
    const parsed = ForkEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) throw new ForkCryptoError();
    const e = parsed.data;
    const key = ring.keys.get(e.kid);
    if (!key) throw new ForkCryptoError();
    try {
        const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64url"));
        d.setAAD(Buffer.from(aadString(aad), "utf8"));
        d.setAuthTag(Buffer.from(e.tag, "base64url"));
        return Buffer.concat([d.update(Buffer.from(e.ct, "base64url")), d.final()]).toString("utf8");
    } catch {
        throw new ForkCryptoError(); // wrong AAD, tampering, wrong key: indistinguishable on purpose
    }
}

export async function encryptForkSecret(plaintext: string, aad: ForkSecretAad, dir?: string): Promise<ForkEnvelope> {
    return encryptWith(await getOrCreateKeyring(dir), plaintext, aad);
}

export async function decryptForkSecret(envelope: unknown, aad: ForkSecretAad, dir?: string): Promise<string> {
    const ring = await loadKeyring(dir ?? defaultKekDir());
    if (!ring) throw new ForkCryptoError();
    return decryptWith(ring, envelope, aad);
}
