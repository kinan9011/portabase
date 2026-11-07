import {spawnSync} from "node:child_process";
import {createCipheriv, createHash, randomBytes} from "node:crypto";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

/**
 * W14b (D42): `decrypt-archive` v1 hardening — streamed `gzip -t`, bomb limits, regular-file input, and the untrusted-tar audit (`--audit-tar`).
 * Hostile archives come from `scripts/fork/recover/tests/tarfix.py` (built on purpose); the encrypted wrapper is made by an INDEPENDENT node encoder.
 */
const ROOT = process.cwd();
const HELPER = path.join(ROOT, "scripts/fork/recover/decrypt-archive");
const TARFIX = path.join(ROOT, "scripts/fork/recover/tests/tarfix.py");
const FIXDIR = path.join(ROOT, "scripts/fork/recover/fixtures");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function encrypt(key: Buffer, plain: Buffer, chunk = 16 * 1024 * 1024): Buffer {
    const nonce = randomBytes(8);
    const parts: Buffer[] = [Buffer.from(`${JSON.stringify({version: 1, cipher: "AES-256-GCM", chunk_size: chunk, base_nonce: [...nonce]})}\n`)];
    for (let i = 0, n = 0; i < plain.length || n === 0; i += chunk, n++) {
        const iv = Buffer.alloc(12);
        nonce.copy(iv, 0);
        iv.writeUInt32BE(n, 8);
        const c = createCipheriv("aes-256-gcm", key, iv);
        const ct = Buffer.concat([c.update(plain.subarray(i, i + chunk)), c.final(), c.getAuthTag()]);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(ct.length);
        parts.push(len, ct);
    }
    return Buffer.concat(parts);
}

let tmp: string;
const key = randomBytes(32);
let seq = 0;
const cases = new Map<string, string>();

beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "da-harden-"));
    const r = spawnSync("python3", ["-I", TARFIX, path.join(tmp, "tars")], {encoding: "utf8"});
    expect(r.status, r.stderr).toBe(0);
    for (const l of r.stdout.trim().split("\n")) { const [n, v] = l.split(" "); cases.set(n, v); }
});
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

function run(enc: Buffer, extra: string[] = []) {
    const id = ++seq;
    const inp = path.join(tmp, `in-${id}.enc`);
    const out = path.join(tmp, `out-${id}.bin`);
    const kf = path.join(tmp, `key-${id}`);
    writeFileSync(inp, enc);
    writeFileSync(kf, `${key.toString("base64")}\n`);
    const r = spawnSync("python3", ["-I", HELPER, "--key-file", kf, ...extra, inp, out], {encoding: "utf8"});
    return {status: r.status, stdout: r.stdout, stderr: r.stderr, out, outExists: existsSync(out)};
}

describe("decrypt-archive v1 — tar audit over hostile archives", () => {
    const flagsFor = (name: string): string[] => {
        if (name === "ok-vol" || name === "reject-outside-top") return ["--audit-tar", "--expect-top", "vol"];
        if (name === "bomb") return ["--audit-tar", "--max-inflated-bytes", "1000000"];
        if (name === "many-entries") return ["--audit-tar", "--max-entries", "10"];
        return ["--audit-tar"];
    };
    const WHY: Record<string, RegExp> = {
        "reject-dotdot": /traversal/, "reject-dotdot-mid": /traversal/, "reject-absolute": /absolute/, "reject-symlink-escape": /through a symlink/,
        "reject-symlink-rel-escape": /through a symlink/, "reject-hardlink-outside": /absolute|hard link/, "reject-hardlink-dotdot": /traversal/,
        "reject-hardlink-unseen": /hard link/, "reject-hardlink-to-symlink": /hard link/, "reject-chardev": /special file/, "reject-blockdev": /special file/,
        "reject-fifo": /special file/, "reject-setuid": /setuid/, "reject-setgid-dir": /setuid/, "reject-sticky": /setuid/, "reject-control-char": /unsafe/,
        "reject-long-name": /unsafe|too deep|too long/, "reject-deep": /too deep/, "reject-type-change": /changes type/, "reject-outside-top": /top-level/,
        "reject-trailing-garbage": /after the end of the gzip/, "reject-truncated-gzip": /incomplete|not a valid gzip/, "reject-not-gzip": /not a valid gzip/,
        bomb: /bomb/, "many-entries": /too many/,
    };
    it("fixture builder produced every case", () => expect(cases.size).toBeGreaterThanOrEqual(25));

    for (const name of [
        "ok-basic", "ok-vol", "ok-dup-same-type", "reject-dotdot", "reject-dotdot-mid", "reject-absolute", "reject-symlink-escape", "reject-symlink-rel-escape",
        "reject-hardlink-outside", "reject-hardlink-dotdot", "reject-hardlink-unseen", "reject-hardlink-to-symlink", "reject-chardev", "reject-blockdev",
        "reject-fifo", "reject-setuid", "reject-setgid-dir", "reject-sticky", "reject-control-char", "reject-long-name", "reject-deep", "reject-type-change",
        "reject-outside-top", "reject-trailing-garbage", "reject-truncated-gzip", "reject-not-gzip", "bomb", "many-entries",
    ]) {
        it(`${name}: ${cases.get(name)}`, () => {
            const plain = readFileSync(path.join(tmp, "tars", `${name}.tar.gz`));
            const r = run(encrypt(key, plain), flagsFor(name));
            if (cases.get(name) === "ok") {
                expect(r.status, r.stderr).toBe(0);
                expect(r.stdout).toContain(`sha256=${sha(plain)}`);
                expect(readFileSync(r.out).equals(plain)).toBe(true);
            } else {
                expect(r.status, r.stdout).toBe(1);
                expect(r.stderr).toContain("decrypt-archive: FAILED");
                expect(r.stderr, "rejected for the right reason").toMatch(WHY[name] ?? /./);
                expect(r.outExists, "nothing may be released for a hostile archive").toBe(false);
            }
        });
    }

    it("the audit never extracts: a hostile archive audited from a scratch dir leaves no file behind", () => {
        const plain = readFileSync(path.join(tmp, "tars", "reject-dotdot.tar.gz"));
        run(encrypt(key, plain), ["--audit-tar"]);
        expect(existsSync(path.join(tmp, "evil.txt"))).toBe(false);
        expect(existsSync(path.join(path.dirname(tmp), "evil.txt"))).toBe(false);
    });
});

describe("decrypt-archive v1 — gzip -t, limits, input kind", () => {
    const gz = readFileSync(path.join(FIXDIR, "lab-volume.tar.gz.enc")); // real agent output; used only for the truncated variant below
    it("a plaintext that is not gzip is refused by default and accepted with --no-gzip-check", () => {
        const raw = randomBytes(1000);
        expect(run(encrypt(key, raw)).status).toBe(1);
        const ok = run(encrypt(key, raw), ["--no-gzip-check"]);
        expect(ok.status, ok.stderr).toBe(0);
    });
    it("a cut on a chunk boundary is detected by gzip -t even without the manifest values", () => {
        const plain = readFileSync(path.join(tmp, "tars", "ok-basic.tar.gz"));
        const full = encrypt(key, plain, 64); // many small chunks
        const cut = (() => { // keep header + first 3 whole chunks
            let o = full.indexOf(10) + 1;
            for (let i = 0; i < 3; i++) o += 4 + full.readUInt32BE(o);
            return full.subarray(0, o);
        })();
        const r = run(cut);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/gzip stream is incomplete|not a valid gzip/);
    });
    it("checked-in truncated fixture (real agent archive minus 100 bytes) is rejected", () => {
        const kf = path.join(tmp, "fixkey");
        writeFileSync(kf, `${JSON.parse(readFileSync(path.join(FIXDIR, "fixtures.json"), "utf8")).master_key_b64}\n`);
        const out = path.join(tmp, "trunc.out");
        const r = spawnSync("python3", ["-I", HELPER, "--key-file", kf, path.join(FIXDIR, "lab-volume.truncated.tar.gz.enc"), out], {encoding: "utf8"});
        expect(r.status).toBe(1);
        expect(existsSync(out)).toBe(false);
        expect(gz.length).toBeGreaterThan(readFileSync(path.join(FIXDIR, "lab-volume.truncated.tar.gz.enc")).length);
    });
    it("real fixtures pass the full audit (volume under vol/, postgres dump at the root)", () => {
        const fx = JSON.parse(readFileSync(path.join(FIXDIR, "fixtures.json"), "utf8"));
        const kf = path.join(tmp, "fixkey2");
        writeFileSync(kf, `${fx.master_key_b64}\n`);
        for (const [file, top] of [["lab-volume.tar.gz.enc", "vol"], ["lab-postgres.tar.gz.enc", undefined]] as const) {
            const out = path.join(tmp, `${file}.out`);
            const r = spawnSync("python3", ["-I", HELPER, "--key-file", kf, "--audit-tar", ...(top ? ["--expect-top", top] : []), path.join(FIXDIR, file), out], {encoding: "utf8"});
            expect(r.status, r.stderr).toBe(0);
            expect(r.stdout).toMatch(/entries=\d+/);
        }
    });
    it("--max-size refuses an over-limit plaintext; --max-inflated-bytes stops a bomb during decryption (no audit needed)", () => {
        const plain = readFileSync(path.join(tmp, "tars", "bomb.tar.gz"));
        expect(run(encrypt(key, plain), ["--max-size", "10"]).status).toBe(1);
        const r = run(encrypt(key, plain), ["--max-inflated-bytes", "1000000"]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("bomb");
    });
    it("a symlink or directory as input is refused (no follow)", () => {
        const kf = path.join(tmp, "k3");
        writeFileSync(kf, `${key.toString("base64")}\n`);
        const real = path.join(tmp, "real.enc");
        writeFileSync(real, encrypt(key, readFileSync(path.join(tmp, "tars", "ok-basic.tar.gz"))));
        const link = path.join(tmp, "link.enc");
        spawnSync("ln", ["-s", real, link]);
        expect(spawnSync("python3", ["-I", HELPER, "--key-file", kf, link, path.join(tmp, "o1")], {encoding: "utf8"}).status).toBe(1);
        expect(spawnSync("python3", ["-I", HELPER, "--key-file", kf, tmp, path.join(tmp, "o2")], {encoding: "utf8"}).status).toBe(1);
    });
    it("--audit-tar together with --no-gzip-check is a usage error (2)", () => {
        expect(run(encrypt(key, randomBytes(100)), ["--audit-tar", "--no-gzip-check"]).status).toBe(2);
    });
});
