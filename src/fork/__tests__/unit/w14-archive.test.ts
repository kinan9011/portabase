import {createCipheriv, createHash, randomBytes} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {gzipSync} from "node:zlib";
import {describe, expect, it} from "vitest";
import {verifyArchiveStream} from "@/fork/verify/archive";

const FIX = path.join(process.cwd(), "scripts/fork/recover/fixtures");
const fixtures = JSON.parse(readFileSync(path.join(FIX, "fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {name: string; file: string; plaintext_sha256: string; plaintext_size: number}[]};
const KEY = Buffer.from(fixtures.master_key_b64, "base64"); // TEST-ONLY lab key (fixtures.json says so)
const LIMITS = {maxPlaintextBytes: 1 << 30, maxInflatedBytes: 1 << 30};
async function* once(b: Buffer) { yield b; }
async function* pieces(b: Buffer, n: number) { for (let i = 0; i < b.length; i += n) yield b.subarray(i, i + n); }

// minimal tar writer for synthetic cases
function tarEntry(name: string, content: Buffer): Buffer {
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8"); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124); h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
    return Buffer.concat([h, content, pad]);
}
const tarOf = (entries: [string, Buffer][]) => Buffer.concat([...entries.map(([n, c]) => tarEntry(n, c)), Buffer.alloc(1024)]);
function encrypt(plain: Buffer, key: Buffer, chunk = 16 * 1024 * 1024): Buffer {
    const base = randomBytes(8);
    const header = Buffer.from(`${JSON.stringify({version: 1, cipher: "AES-256-GCM", chunk_size: chunk, base_nonce: [...base]})}\n`);
    const out: Buffer[] = [header];
    for (let i = 0, idx = 0; i < plain.length; i += chunk, idx++) {
        const nonce = Buffer.concat([base, Buffer.alloc(4)]); nonce.writeUInt32BE(idx, 8);
        const c = createCipheriv("aes-256-gcm", key, nonce);
        const ct = Buffer.concat([c.update(plain.subarray(i, i + chunk)), c.final(), c.getAuthTag()]);
        const len = Buffer.alloc(4); len.writeUInt32BE(ct.length);
        out.push(len, ct);
    }
    return Buffer.concat(out);
}
const pgTarGz = (body = Buffer.concat([Buffer.from("PGDMP"), randomBytes(2000)])) => gzipSync(tarOf([["db.dump", body]]));

describe("W14 archive verify pipeline (D24/D43) vs the REAL agent fixtures (W02b)", () => {
    for (const f of fixtures.fixtures) {
        it(`${f.name}: decrypts, gzip + tar valid, plaintext sha256/size equal the independent oracle`, async () => {
            const v = await verifyArchiveStream(once(readFileSync(path.join(FIX, f.file))), KEY, LIMITS);
            expect(v.ok).toBe(true);
            if (v.ok) { expect(v.plaintextSha256).toBe(f.plaintext_sha256); expect(v.plaintextSize).toBe(f.plaintext_size); expect(v.tarEntries).toBeGreaterThan(0); }
        });
    }
    it("lab-postgres: the dump format is sniffed (pg_custom, `PGDMP`) and the result does not depend on how the bytes are chunked on the wire", async () => {
        const bytes = readFileSync(path.join(FIX, "lab-postgres.tar.gz.enc"));
        const a = await verifyArchiveStream(pieces(bytes, 7), KEY, LIMITS);
        expect(a.ok && a.dumpFormat).toBe("pg_custom");
    });
});

describe("W14 archive verify: every integrity failure is a closed code, never ok", () => {
    const good = encrypt(pgTarGz(), KEY);
    const run = (b: Buffer, key = KEY, lim = LIMITS) => verifyArchiveStream(once(b), key, lim);

    it("TRUNCATED mid-chunk (the lab case: `.tar.gz.enc` cut) ⇒ truncated", async () => {
        expect(await run(good.subarray(0, good.length - 40))).toEqual({ok: false, code: "truncated"});
        expect(await run(good.subarray(0, good.indexOf(0x0a) + 10))).toEqual({ok: false, code: "truncated"});
        expect(await run(good.subarray(0, 60))).toEqual({ok: false, code: "bad_header"}); // cut inside the header line
    });
    it("cut EXACTLY on a chunk boundary (undetectable by the format) ⇒ gzip_invalid", async () => {
        const gz = pgTarGz(randomBytes(300_000));
        const enc = encrypt(gz, KEY, 64 * 1024); // several chunks
        const boundary = enc.indexOf(0x0a) + 1 + 2 * (4 + 64 * 1024 + 16); // after two whole chunks
        const v = await run(enc.subarray(0, boundary));
        expect(v.ok).toBe(false);
        expect(v.ok === false && ["gzip_invalid", "tar_invalid"].includes(v.code)).toBe(true);
    });
    it("a flipped ciphertext bit / wrong key ⇒ auth_failed", async () => {
        const bad = Buffer.from(good); bad[good.length - 30] ^= 1;
        expect(await run(bad)).toEqual({ok: false, code: "auth_failed"});
        expect(await run(good, randomBytes(32))).toEqual({ok: false, code: "auth_failed"});
    });
    it("header problems: not JSON, extra field, version 2, other cipher, absurd chunk size", async () => {
        const body = good.subarray(good.indexOf(0x0a) + 1);
        const hdr = (o: Record<string, unknown>) => Buffer.concat([Buffer.from(`${JSON.stringify(o)}\n`), body]);
        const ok = {version: 1, cipher: "AES-256-GCM", chunk_size: 16777216, base_nonce: [1, 2, 3, 4, 5, 6, 7, 8]};
        expect(await run(Buffer.concat([Buffer.from("garbage\n"), body]))).toEqual({ok: false, code: "bad_header"});
        expect(await run(hdr({...ok, extra: 1}))).toEqual({ok: false, code: "bad_header"});
        expect(await run(hdr({...ok, version: 2}))).toEqual({ok: false, code: "unsupported_version"});
        expect(await run(hdr({...ok, cipher: "AES-128-CBC"}))).toEqual({ok: false, code: "unsupported_version"});
        expect(await run(hdr({...ok, chunk_size: 2 ** 31}))).toEqual({ok: false, code: "bad_header"});
        expect(await run(hdr({...ok, version: true}))).toEqual({ok: false, code: "unsupported_version"});
    });
    it("an encrypted payload that is not gzip ⇒ gzip_invalid; gzip of garbage (not tar) ⇒ tar_invalid; empty tar ⇒ tar_invalid", async () => {
        expect((await run(encrypt(Buffer.from("this is not gzip at all"), KEY))).ok).toBe(false);
        expect(await run(encrypt(Buffer.from("this is not gzip at all"), KEY))).toEqual({ok: false, code: "gzip_invalid"});
        expect(await run(encrypt(gzipSync(randomBytes(4096)), KEY))).toEqual({ok: false, code: "tar_invalid"});
        expect(await run(encrypt(gzipSync(Buffer.alloc(1024)), KEY))).toEqual({ok: false, code: "tar_invalid"});
    });
    it("no data chunks at all ⇒ empty; zero-length input ⇒ bad_header", async () => {
        const hdrOnly = good.subarray(0, good.indexOf(0x0a) + 1);
        expect(await run(hdrOnly)).toEqual({ok: false, code: "empty"});
        expect(await run(Buffer.alloc(0))).toEqual({ok: false, code: "bad_header"});
    });
    it("a corrupted tar header (bad checksum) ⇒ tar_invalid", async () => {
        const tar = tarOf([["db.dump", Buffer.from("PGDMP-x")]]); tar[0] ^= 0x55;
        expect(await run(encrypt(gzipSync(tar), KEY))).toEqual({ok: false, code: "tar_invalid"});
    });
    it("size caps: plaintext and inflated (zip-bomb) limits ⇒ too_large", async () => {
        expect(await run(good, KEY, {maxPlaintextBytes: 100, maxInflatedBytes: 1 << 30})).toEqual({ok: false, code: "too_large"});
        const bomb = gzipSync(tarOf([["z.bin", Buffer.alloc(5_000_000)]]));
        expect(await run(encrypt(bomb, KEY), KEY, {maxPlaintextBytes: 1 << 30, maxInflatedBytes: 100_000})).toEqual({ok: false, code: "too_large"});
    });
    it("a pg_directory (-Fd) dump is recognised: inner `<id>.tar.gz` entry starting with the gzip magic", async () => {
        const v = await run(encrypt(gzipSync(tarOf([["dump-123.tar.gz", gzipSync(Buffer.from("toc"))]])), KEY));
        expect(v.ok && v.dumpFormat).toBe("pg_directory");
    });
    it("the verdict never echoes the key or any content", async () => {
        const v = JSON.stringify(await run(good, randomBytes(32)));
        expect(v).not.toContain(KEY.toString("base64"));
        expect(createHash("sha256").update(v).digest("hex")).toHaveLength(64);
    });
});
