import {spawnSync} from "node:child_process";
import {createCipheriv, createHash, randomBytes} from "node:crypto";
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {gzipSync} from "node:zlib";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

/**
 * W02b: `decrypt-archive` v0 (D42) decrypts the stock agent's `.tar.gz.enc` archive format
 * (agent:src/utils/file.rs:61-170). The synthetic archives below are built by an INDEPENDENT encoder (node:crypto, written
 * from the format description), so a bug shared with the helper cannot hide. Fixtures from the real stock agent are checked
 * in the second describe block. Python 3 + `cryptography` is a bare-host prerequisite of the DR path (D26), so it is a
 * hard requirement here too: missing => the suite FAILS loudly (no silent skip).
 */
const ROOT = process.cwd();
const HELPER = path.join(ROOT, "scripts/fork/recover/decrypt-archive");
const FIXDIR = path.join(ROOT, "scripts/fork/recover/fixtures");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Chunk = Buffer;
function encrypt(key: Buffer, chunks: Chunk[], opts: {header?: Record<string, unknown> | string; nonce?: Buffer} = {}): Buffer {
    const nonce = opts.nonce ?? randomBytes(8);
    const header =
        typeof opts.header === "string"
            ? opts.header
            : JSON.stringify({version: 1, cipher: "AES-256-GCM", chunk_size: 16777216, base_nonce: [...nonce], ...(opts.header ?? {})});
    const parts: Buffer[] = [Buffer.from(`${header}\n`)];
    chunks.forEach((pt, i) => {
        const iv = Buffer.alloc(12);
        nonce.copy(iv, 0);
        iv.writeUInt32BE(i, 8);
        const c = createCipheriv("aes-256-gcm", key, iv);
        const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(ct.length);
        parts.push(len, ct);
    });
    return Buffer.concat(parts);
}

let tmp: string;
beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "decrypt-archive-"));
});
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

let seq = 0;
function run(enc: Buffer | string, key: Buffer | string, extra: string[] = [], keyViaStdin = false) {
    const id = ++seq;
    const inp = typeof enc === "string" ? enc : path.join(tmp, `in-${id}.enc`);
    if (typeof enc !== "string") writeFileSync(inp, enc);
    const out = path.join(tmp, `out-${id}.bin`);
    const keyFile = path.join(tmp, `key-${id}.txt`);
    const keyB64 = typeof key === "string" ? key : key.toString("base64");
    const args = keyViaStdin ? ["--key-stdin"] : ["--key-file", keyFile];
    if (!keyViaStdin) writeFileSync(keyFile, `${keyB64}\n`);
    const r = spawnSync("python3", ["-I", HELPER, ...args, ...extra, inp, out], {input: keyViaStdin ? keyB64 : undefined, encoding: "utf8"});
    return {status: r.status, stdout: r.stdout, stderr: r.stderr, out, outExists: existsSync(out), partialLeft: readdirSync(tmp).some((n) => n.startsWith(`out-${id}.bin.`))};
}

describe("decrypt-archive v0 — synthetic archives (independent encoder)", () => {
    const key = randomBytes(32);
    const plain = gzipSync(randomBytes(2000)); // incompressible: stays > 700 bytes, so the 2-chunk split is non-empty

    it("environment: python3 + cryptography available", () => {
        const r = spawnSync("python3", ["-c", "import cryptography.hazmat.primitives.ciphers.aead"], {encoding: "utf8"});
        expect(r.status, r.stderr).toBe(0);
    });

    it("round-trips a multi-chunk archive; stdout reports sha256 + size; output is 0600", () => {
        const a = plain.subarray(0, 700);
        const b = plain.subarray(700);
        const r = run(encrypt(key, [a, b]), key);
        expect(r.status, r.stderr).toBe(0);
        expect(readFileSync(r.out).equals(plain)).toBe(true);
        expect(r.stdout).toContain(`sha256=${sha(plain)}`);
        expect(r.stdout).toContain(`size=${plain.length}`);
        expect(statSync(r.out).mode & 0o777).toBe(0o600);
    });

    it("reads the key from stdin too", () => {
        const r = run(encrypt(key, [plain]), key, [], true);
        expect(r.status, r.stderr).toBe(0);
        expect(readFileSync(r.out).equals(plain)).toBe(true);
    });

    it("--expect-sha256 / --expect-size: match passes, mismatch fails closed (chunk-boundary truncation guard, D24)", () => {
        const enc = encrypt(key, [plain.subarray(0, 100), plain.subarray(100)]);
        expect(run(enc, key, ["--expect-sha256", sha(plain), "--expect-size", String(plain.length)]).status).toBe(0);
        const wrongHash = run(enc, key, ["--expect-sha256", "0".repeat(64)]);
        expect(wrongHash.status).toBe(1);
        expect(wrongHash.outExists).toBe(false);
        const wrongSize = run(enc, key, ["--expect-size", String(plain.length + 1)]);
        expect(wrongSize.status).toBe(1);
        expect(wrongSize.outExists).toBe(false);
        // truncation exactly at a chunk boundary is invisible to the format itself (no final marker) but the manifest hash catches it
        const boundary = encrypt(key, [plain.subarray(0, 100)]);
        expect(run(boundary, key, ["--expect-sha256", sha(plain)]).status).toBe(1);
    });

    const rejects: Array<[string, () => ReturnType<typeof run>]> = [
        ["flipped tag byte", () => { const e = encrypt(key, [plain]); e[e.length - 1] ^= 1; return run(e, key); }],
        ["flipped ciphertext byte", () => { const e = encrypt(key, [plain]); e[e.length - 40] ^= 1; return run(e, key); }],
        ["wrong key", () => run(encrypt(key, [plain]), randomBytes(32))],
        ["truncated mid-chunk", () => { const e = encrypt(key, [plain]); return run(e.subarray(0, e.length - 7), key); }],
        ["truncated inside the length prefix", () => { const e = encrypt(key, [plain]); const h = e.indexOf(10) + 1; return run(e.subarray(0, h + 2), key); }],
        ["header only (zero chunks)", () => run(encrypt(key, []), key)],
        ["empty file", () => run(Buffer.alloc(0), key)],
        ["header without newline", () => run(Buffer.from('{"version":1}'), key)],
        ["header is not JSON", () => run(encrypt(key, [plain], {header: "not json"}), key)],
        ["header is a JSON array", () => run(encrypt(key, [plain], {header: "[1,2]"}), key)],
        ["version 2", () => run(encrypt(key, [plain], {header: {version: 2}}), key)],
        ["version true (bool is not 1)", () => run(encrypt(key, [plain], {header: {version: true}}), key)],
        ["cipher AES-128-GCM", () => run(encrypt(key, [plain], {header: {cipher: "AES-128-GCM"}}), key)],
        ["base_nonce of 7 bytes", () => run(encrypt(key, [plain], {header: {base_nonce: [1, 2, 3, 4, 5, 6, 7]}}), key)],
        ["base_nonce byte out of range", () => run(encrypt(key, [plain], {header: {base_nonce: [1, 2, 3, 4, 5, 6, 7, 256]}}), key)],
        ["unknown header field", () => run(encrypt(key, [plain], {header: {compression: "zstd"}}), key)],
        ["chunk_size 0", () => run(encrypt(key, [plain], {header: {chunk_size: 0}}), key)],
        ["chunk length larger than chunk_size + tag (no huge allocation)", () => {
            const e = encrypt(key, [plain], {header: {chunk_size: 64}});
            return run(e, key);
        }],
        ["declared chunk length of 4 GiB", () => {
            const h = Buffer.from(`${JSON.stringify({version: 1, cipher: "AES-256-GCM", chunk_size: 16777216, base_nonce: [1, 2, 3, 4, 5, 6, 7, 8]})}\n`);
            return run(Buffer.concat([h, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.alloc(32)]), key);
        }],
        ["chunk length shorter than a GCM tag", () => {
            const h = Buffer.from(`${JSON.stringify({version: 1, cipher: "AES-256-GCM", chunk_size: 16777216, base_nonce: [1, 2, 3, 4, 5, 6, 7, 8]})}\n`);
            return run(Buffer.concat([h, Buffer.from([0, 0, 0, 8]), Buffer.alloc(8)]), key);
        }],
        ["chunks reordered (index is part of the nonce)", () => {
            const nonce = randomBytes(8);
            const e = encrypt(key, [plain.subarray(0, 50), plain.subarray(50)], {nonce});
            const h = e.indexOf(10) + 1;
            const l1 = e.readUInt32BE(h);
            const c1 = e.subarray(h, h + 4 + l1);
            const c2 = e.subarray(h + 4 + l1);
            return run(Buffer.concat([e.subarray(0, h), c2, c1]), key);
        }],
        ["key that is not base64", () => run(encrypt(key, [plain]), "%%% not base64 %%%")],
        ["key of 16 bytes", () => run(encrypt(key, [plain]), randomBytes(16))],
        ["missing input file", () => run(path.join(tmp, "does-not-exist"), key)],
    ];
    for (const [name, fn] of rejects) {
        it(`fails closed: ${name}`, () => {
            const r = fn();
            expect(r.status, `${name}: stdout=${r.stdout} stderr=${r.stderr}`).not.toBe(0);
            expect(r.outExists, "no output file may remain").toBe(false);
            expect(r.partialLeft, "no .partial file may remain").toBe(false);
        });
    }

    it("error messages never contain key material or plaintext", () => {
        const secretPlain = Buffer.from("TOP-SECRET-PLAINTEXT");
        const e = encrypt(key, [secretPlain]);
        e[e.length - 1] ^= 1;
        const r = run(e, key);
        expect(r.status).not.toBe(0);
        expect(r.stderr + r.stdout).not.toContain(key.toString("base64"));
        expect(r.stderr + r.stdout).not.toContain("TOP-SECRET");
    });

    it("refuses to put the key on the command line; unknown/abbreviated options exit 2", () => {
        const inp = path.join(tmp, "argv.enc");
        writeFileSync(inp, encrypt(key, [plain]));
        for (const flag of [["--key", key.toString("base64")], ["--key-file"], ["--master-key", "x"]]) {
            const r = spawnSync("python3", ["-I", HELPER, ...flag, inp, path.join(tmp, "argv.out")], {encoding: "utf8"});
            expect(r.status).toBe(2);
        }
        expect(existsSync(path.join(tmp, "argv.out"))).toBe(false);
    });

    it("never overwrites an existing output file", () => {
        const inp = path.join(tmp, "ow.enc");
        const out = path.join(tmp, "ow.out");
        const kf = path.join(tmp, "ow.key");
        writeFileSync(inp, encrypt(key, [plain]));
        writeFileSync(out, "precious");
        writeFileSync(kf, key.toString("base64"));
        const r = spawnSync("python3", ["-I", HELPER, "--key-file", kf, inp, out], {encoding: "utf8"});
        expect(r.status).not.toBe(0);
        expect(readFileSync(out, "utf8")).toBe("precious");
    });
});

/**
 * Fixtures produced by the STOCK agent 1.25.2 with encryption on (dev/fork-lab/drills/archive-roundtrip.sh --write-fixtures).
 * W14b reuses them as CLI CI fixtures (D26, CH-22): they must keep decrypting byte-exactly. The master key in fixtures.json
 * is a throw-away TEST-ONLY lab key.
 */
describe("decrypt-archive v0 — stock-agent fixtures (W02b)", () => {
    const meta = JSON.parse(readFileSync(path.join(FIXDIR, "fixtures.json"), "utf8")) as {
        test_only: boolean;
        master_key_b64: string;
        produced_by: {agent_version: string};
        fixtures: Array<{name: string; file: string; ciphertext_sha256: string; ciphertext_size: number; plaintext_sha256: string; plaintext_size: number}>;
    };
    const keyFile = () => {
        const f = path.join(tmp, "fixture-key.txt");
        writeFileSync(f, meta.master_key_b64);
        return f;
    };

    it("is flagged test-only and lists the DB dump + the volume archive", () => {
        expect(meta.test_only).toBe(true);
        expect(meta.produced_by.agent_version).toBe("1.25.2");
        expect(Buffer.from(meta.master_key_b64, "base64")).toHaveLength(32);
        expect(meta.fixtures.map((f) => f.name).sort()).toEqual(["lab-postgres", "lab-volume"]);
    });

    for (const name of ["lab-postgres", "lab-volume"]) {
        describe(name, () => {
            const fx = () => meta.fixtures.find((f) => f.name === name)!;
            const file = () => path.join(FIXDIR, fx().file);

            it("ciphertext is the committed object (size + sha256) and starts with the documented header", () => {
                const b = readFileSync(file());
                expect(b.length).toBe(fx().ciphertext_size);
                expect(sha(b)).toBe(fx().ciphertext_sha256);
                expect(b.subarray(0, b.indexOf(10)).toString()).toMatch(/^\{"version":1,"cipher":"AES-256-GCM","chunk_size":16777216,"base_nonce":\[(\d+,){7}\d+\]\}$/);
            });

            it("decrypts to the expected plaintext sha256 + size (also via --expect-*), gzip -t and tar listing pass", () => {
                const out = path.join(tmp, `${name}.tar.gz`);
                const r = spawnSync("python3", ["-I", HELPER, "--key-file", keyFile(), "--expect-sha256", fx().plaintext_sha256, "--expect-size", String(fx().plaintext_size), file(), out], {encoding: "utf8"});
                expect(r.status, r.stderr).toBe(0);
                const pt = readFileSync(out);
                expect(sha(pt)).toBe(fx().plaintext_sha256);
                expect(pt.length).toBe(fx().plaintext_size);
                expect(spawnSync("gzip", ["-t", out]).status).toBe(0);
                const list = spawnSync("tar", ["-tzf", out], {encoding: "utf8"});
                expect(list.status).toBe(0);
                if (name === "lab-volume") expect(list.stdout).toContain("vol/file-1.txt");
                else {
                    const dump = list.stdout.trim().split("\n");
                    expect(dump).toHaveLength(1);
                    expect(dump[0]).toMatch(/\.dump$/);
                    // pg_dump -Fc custom format magic: this is what the agent emits for DBs <= 1 GB (agent:domain/postgres/connection.rs:350-385)
                    expect(spawnSync("tar", ["-xzOf", out], {encoding: "buffer", maxBuffer: 1 << 26}).stdout.subarray(0, 5).toString()).toBe("PGDMP");
                }
            });

            it("a truncated copy of the real artifact is rejected (non-zero, no output)", () => {
                const b = readFileSync(file());
                for (const cut of [7, 17, b.length - b.indexOf(10) - 1]) {
                    const r = run(b.subarray(0, b.length - cut), Buffer.from(meta.master_key_b64, "base64"));
                    expect(r.status, `cut=${cut}`).not.toBe(0);
                    expect(r.outExists).toBe(false);
                }
            });

            it("a wrong key is rejected", () => {
                expect(run(file(), randomBytes(32)).status).not.toBe(0);
            });
        });
    }

    it("the fixtures directory holds synthetic data only: no endpoints, agent ids, storage or DB credentials", () => {
        const text = readdirSync(FIXDIR).filter((n) => /\.(json|md)$/.test(n)).map((n) => readFileSync(path.join(FIXDIR, n), "utf8")).join("\n");
        for (const bad of [/serverUrl/i, /agentId/i, /accessKey|secretKey/i, /postgres(ql)?:\/\//i, /LAB_[A-Z_]+=/, /forklab-/, /\.localhost/]) expect(text).not.toMatch(bad);
        expect(Object.keys(meta).sort()).toEqual(["fixtures", "master_key_b64", "produced_by", "test_only", "warning"]);
    });
});
