import {createDecipheriv, createHash} from "node:crypto";
import {createGunzip} from "node:zlib";

/**
 * Server-side verification of ONE agent archive (`*.tar.gz.enc`, format v1 — `agent:src/utils/file.rs:61-170`, documented in
 * `scripts/fork/recover/decrypt-archive`): decrypt every chunk (AES-256-GCM, no AAD, nonce = base_nonce(8) ‖ u32 BE index), then prove the plaintext
 * is a COMPLETE gzip stream (the format has no final-chunk marker, so a file cut on a chunk boundary still decrypts: only the gzip trailer CRC / length
 * exposes it) containing a structurally valid tar (header checksums, whole entries). Records plaintext SHA-256 + size (D24) and sniffs the PostgreSQL dump
 * format. Streaming: memory is one chunk (≤ `chunk_size`, bounded) + the tar header. Failure codes are closed; the key, plaintext and ciphertext never
 * appear in an error. Nothing is ever written to disk.
 */
export const ARCHIVE_FAILURES = ["bad_header", "unsupported_version", "truncated", "auth_failed", "gzip_invalid", "tar_invalid", "empty", "too_large"] as const;
export type ArchiveFailure = (typeof ARCHIVE_FAILURES)[number];
export type ArchiveVerdict =
    | {ok: true; plaintextSha256: string; plaintextSize: number; formatVersion: 1; tarEntries: number; dumpFormat: "pg_custom" | "pg_directory" | null}
    | {ok: false; code: ArchiveFailure};

export type ArchiveLimits = {maxPlaintextBytes: number; maxInflatedBytes: number};
const MAX_HEADER = 4096;
const MAX_CHUNK = 64 * 1024 * 1024;
const TAG = 16;

class Fail extends Error {
    constructor(readonly code: ArchiveFailure) { super(code); }
}

/** Pull-reader over an async byte source. */
class Reader {
    private buf = Buffer.alloc(0);
    private it: AsyncIterator<Uint8Array>;
    private done = false;
    constructor(src: AsyncIterable<Uint8Array>) { this.it = src[Symbol.asyncIterator](); }
    private async fill(min: number): Promise<void> {
        while (this.buf.length < min && !this.done) {
            const n = await this.it.next();
            if (n.done) { this.done = true; break; }
            this.buf = this.buf.length ? Buffer.concat([this.buf, n.value]) : Buffer.from(n.value);
        }
    }
    async line(max: number): Promise<Buffer | null> {
        for (;;) {
            const i = this.buf.indexOf(0x0a);
            if (i >= 0) { const l = this.buf.subarray(0, i + 1); this.buf = this.buf.subarray(i + 1); return l; }
            if (this.buf.length > max) return null;
            if (this.done) return null;
            await this.fill(this.buf.length + 1);
        }
    }
    /** exactly n bytes, `null` at clean EOF before the first byte, throws `truncated` on a partial read */
    async exact(n: number): Promise<Buffer | null> {
        await this.fill(n);
        if (this.buf.length === 0 && n > 0) return null;
        if (this.buf.length < n) throw new Fail("truncated");
        const out = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return out;
    }
}

type TarState = {
    entries: number; skip: number; pad: number; header: Buffer; headerLen: number; ended: boolean; zeroBlocks: number; clean: boolean;
    firstName: string | null; sniff: Buffer; sniffing: boolean; remaining: number; isRegular: boolean;
};
const newTar = (): TarState => ({entries: 0, skip: 0, pad: 0, header: Buffer.alloc(512), headerLen: 0, ended: false, zeroBlocks: 0, clean: true, firstName: null, sniff: Buffer.alloc(0), sniffing: false, remaining: 0, isRegular: false});

function octal(b: Buffer): number {
    if (b[0] & 0x80) { // GNU base-256
        let v = b[0] & 0x7f;
        for (let i = 1; i < b.length; i++) v = v * 256 + b[i];
        return v;
    }
    const s = b.toString("latin1").replace(/\0[\s\S]*$/, "").trim();
    if (s === "") return 0;
    if (!/^[0-7]+$/.test(s)) throw new Fail("tar_invalid");
    return Number.parseInt(s, 8);
}

function feedTar(t: TarState, data: Buffer): void {
    let off = 0;
    while (off < data.length) {
        if (t.ended) return; // padding after the end-of-archive marker is tolerated
        if (t.skip > 0) {
            const n = Math.min(t.skip, data.length - off);
            if (t.sniffing && t.sniff.length < 8) t.sniff = Buffer.concat([t.sniff, data.subarray(off, off + Math.min(n, 8 - t.sniff.length))]);
            t.skip -= n; off += n;
            if (t.skip === 0) { t.sniffing = false; t.clean = true; }
            continue;
        }
        if (t.pad > 0) { const n = Math.min(t.pad, data.length - off); t.pad -= n; off += n; continue; }
        const need = 512 - t.headerLen;
        const n = Math.min(need, data.length - off);
        data.copy(t.header, t.headerLen, off, off + n);
        t.headerLen += n; off += n;
        if (t.headerLen < 512) { t.clean = t.headerLen === 0; continue; }
        t.headerLen = 0;
        if (t.header.every((b) => b === 0)) { t.zeroBlocks++; if (t.zeroBlocks >= 2) t.ended = true; continue; }
        t.zeroBlocks = 0;
        // header checksum: sum of all bytes with the checksum field read as spaces
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : t.header[i];
        if (sum !== octal(t.header.subarray(148, 156))) throw new Fail("tar_invalid");
        const type = String.fromCharCode(t.header[156] || 0x30);
        const size = octal(t.header.subarray(124, 136));
        const name = t.header.subarray(0, 100).toString("utf8").replace(/\0[\s\S]*$/, "");
        const regular = type === "0" || type === "7";
        if (regular || type === "5" || type === "2" || type === "1" || type === "x" || type === "g" || type === "L" || type === "K") {
            if (type !== "x" && type !== "g" && type !== "L" && type !== "K") t.entries++;
        } else throw new Fail("tar_invalid");
        if (regular && t.firstName === null) { t.firstName = name; t.sniffing = true; }
        t.isRegular = regular;
        const dataSize = type === "5" || type === "2" || type === "1" ? 0 : size;
        t.skip = dataSize; t.pad = (512 - (dataSize % 512)) % 512;
        t.clean = dataSize === 0;
        if (dataSize === 0) t.sniffing = false;
    }
}

export async function verifyArchiveStream(source: AsyncIterable<Uint8Array>, masterKey: Buffer, limits: ArchiveLimits): Promise<ArchiveVerdict> {
    if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
    try {
        const r = new Reader(source);
        const line = await r.line(MAX_HEADER);
        if (!line) throw new Fail(line === null ? "bad_header" : "truncated");
        let h: unknown;
        try { h = JSON.parse(line.toString("utf8")); } catch { throw new Fail("bad_header"); }
        if (typeof h !== "object" || h === null || Array.isArray(h)) throw new Fail("bad_header");
        const o = h as Record<string, unknown>;
        const keys = Object.keys(o).sort().join(",");
        if (keys !== "base_nonce,chunk_size,cipher,version") throw new Fail("bad_header");
        if (o.version !== 1) throw new Fail("unsupported_version");
        if (o.cipher !== "AES-256-GCM") throw new Fail("unsupported_version");
        const chunkSize = o.chunk_size;
        if (typeof chunkSize !== "number" || !Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK) throw new Fail("bad_header");
        const nonce = o.base_nonce;
        if (!Array.isArray(nonce) || nonce.length !== 8 || nonce.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw new Fail("bad_header");
        const base = Buffer.from(nonce as number[]);

        const gunzip = createGunzip();
        const tar = newTar();
        let inflated = 0;
        let gzErr: Fail | null = null;
        gunzip.on("data", (d: Buffer) => {
            inflated += d.length;
            if (inflated > limits.maxInflatedBytes) { gzErr = new Fail("too_large"); gunzip.destroy(); return; }
            try { feedTar(tar, d); } catch (e) { gzErr = e instanceof Fail ? e : new Fail("tar_invalid"); gunzip.destroy(); }
        });
        const ended = new Promise<void>((res, rej) => {
            gunzip.on("end", () => res());
            gunzip.on("error", () => rej(gzErr ?? new Fail("gzip_invalid")));
            gunzip.on("close", () => { if (gzErr) rej(gzErr); });
        });
        ended.catch(() => undefined); // surfaced below

        const digest = createHash("sha256");
        let size = 0;
        let idx = 0;
        for (;;) {
            const lb = await r.exact(4);
            if (lb === null) break;
            if (lb.length !== 4) throw new Fail("truncated");
            const n = lb.readUInt32BE(0);
            if (n <= TAG || n > chunkSize + TAG) throw new Fail("bad_header");
            const ct = await r.exact(n);
            if (ct === null || ct.length !== n) throw new Fail("truncated");
            const nonceFull = Buffer.concat([base, Buffer.alloc(4)]);
            nonceFull.writeUInt32BE(idx, 8);
            let pt: Buffer;
            try {
                const d = createDecipheriv("aes-256-gcm", masterKey, nonceFull);
                d.setAuthTag(ct.subarray(n - TAG));
                pt = Buffer.concat([d.update(ct.subarray(0, n - TAG)), d.final()]);
            } catch { throw new Fail("auth_failed"); }
            size += pt.length;
            if (size > limits.maxPlaintextBytes) throw new Fail("too_large");
            digest.update(pt);
            if (gzErr) throw gzErr;
            if (!gunzip.write(pt)) await new Promise<void>((res) => gunzip.once("drain", () => res()));
            idx++;
            if (idx > 0xffffffff) throw new Fail("bad_header");
        }
        if (idx === 0) throw new Fail("empty");
        gunzip.end();
        try { await ended; } catch (e) { throw e instanceof Fail ? e : new Fail("gzip_invalid"); }
        if (gzErr) throw gzErr;
        if (tar.entries === 0 || !tar.clean || tar.skip > 0 || tar.pad > 0 || tar.headerLen > 0) throw new Fail("tar_invalid");
        const dumpFormat = tar.sniff.subarray(0, 5).toString("latin1") === "PGDMP" ? "pg_custom"
            : tar.sniff[0] === 0x1f && tar.sniff[1] === 0x8b && (tar.firstName ?? "").endsWith(".tar.gz") ? "pg_directory" : null;
        return {ok: true, plaintextSha256: digest.digest("hex"), plaintextSize: size, formatVersion: 1, tarEntries: tar.entries, dumpFormat};
    } catch (e) {
        return {ok: false, code: e instanceof Fail ? e.code : "truncated"};
    }
}
