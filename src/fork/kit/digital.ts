import {createCipheriv, createDecipheriv, randomBytes, scryptSync} from "node:crypto";
import type {KitDocument} from "./material";

/**
 * Digital kit file `PBKIT1` (D25 (ii), ADR-006): passphrase-wrapped, scrypt + AES-256-GCM, ASCII armoured so it can also be printed.
 *
 *   PBKIT1\n
 *   {"kdf":"scrypt","N":131072,"r":8,"p":1,"salt":"<b64 16B>","iv":"<b64 12B>"}\n
 *   <base64 of ciphertext‖tag16, wrapped at 64 columns>\n
 *
 * AAD = the header line (a modified header fails authentication). The passphrase is never stored or printed; unwrap by hand with any scrypt + AES-GCM
 * implementation (python `hashlib.scrypt` + `cryptography.AESGCM`, which are the bare-host prerequisites).
 */
export const SCRYPT = {N: 131072, r: 8, p: 1} as const;
const MAXMEM = 256 * 1024 * 1024;

export function wrapDigitalKit(kit: KitDocument, passphrase: string): string {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const header = JSON.stringify({kdf: "scrypt", ...SCRYPT, salt: salt.toString("base64"), iv: iv.toString("base64")});
    const key = scryptSync(Buffer.from(passphrase, "utf8"), salt, 32, {...SCRYPT, maxmem: MAXMEM});
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(header, "utf8"));
    const ct = Buffer.concat([c.update(JSON.stringify(kit), "utf8"), c.final(), c.getAuthTag()]);
    const body = (ct.toString("base64").match(/.{1,64}/g) ?? []).join("\n");
    return `PBKIT1\n${header}\n${body}\n`;
}

export function unwrapDigitalKit(file: string, passphrase: string): KitDocument {
    const [magic, header, ...rest] = file.trim().split("\n");
    if (magic !== "PBKIT1" || !header) throw new Error("not a PBKIT1 file");
    const h = JSON.parse(header) as {kdf: string; N: number; r: number; p: number; salt: string; iv: string};
    if (h.kdf !== "scrypt" || h.N !== SCRYPT.N || h.r !== SCRYPT.r || h.p !== SCRYPT.p) throw new Error("unsupported kdf parameters");
    const raw = Buffer.from(rest.join(""), "base64");
    const key = scryptSync(Buffer.from(passphrase, "utf8"), Buffer.from(h.salt, "base64"), 32, {...SCRYPT, maxmem: MAXMEM});
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(h.iv, "base64"));
    d.setAAD(Buffer.from(header, "utf8"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8")) as KitDocument;
}
