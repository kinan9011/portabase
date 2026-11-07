import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";

/** Stock-agent archive format (decrypt-archive contract): JSON header line, then per chunk `u32be len ‖ ciphertext ‖ tag(16)`, nonce = base_nonce(8) ‖ index(u32be). TEST-ONLY helpers. */
export function encryptAgentArchive(key: Buffer, plain: Buffer, chunkSize = 16 * 1024 * 1024): Buffer {
    const base = randomBytes(8);
    const parts: Buffer[] = [Buffer.from(JSON.stringify({version: 1, cipher: "AES-256-GCM", chunk_size: chunkSize, base_nonce: [...base]}) + "\n")];
    for (let i = 0, off = 0; off < plain.length || i === 0; i++, off += chunkSize) {
        const nonce = Buffer.concat([base, Buffer.alloc(4)]); nonce.writeUInt32BE(i, 8);
        const c = createCipheriv("aes-256-gcm", key, nonce);
        const ct = Buffer.concat([c.update(plain.subarray(off, off + chunkSize)), c.final(), c.getAuthTag()]);
        const len = Buffer.alloc(4); len.writeUInt32BE(ct.length);
        parts.push(len, ct);
        if (off + chunkSize >= plain.length) break;
    }
    return Buffer.concat(parts);
}

export function decryptAgentArchive(key: Buffer, enc: Buffer): Buffer {
    const nl = enc.indexOf(10);
    const header = JSON.parse(enc.subarray(0, nl).toString()) as {base_nonce: number[]};
    const base = Buffer.from(header.base_nonce);
    const out: Buffer[] = [];
    for (let pos = nl + 1, i = 0; pos < enc.length; i++) {
        const n = enc.readUInt32BE(pos); pos += 4;
        const ct = enc.subarray(pos, pos + n); pos += n;
        const nonce = Buffer.concat([base, Buffer.alloc(4)]); nonce.writeUInt32BE(i, 8);
        const d = createDecipheriv("aes-256-gcm", key, nonce);
        d.setAuthTag(ct.subarray(ct.length - 16));
        out.push(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]));
    }
    return Buffer.concat(out);
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
