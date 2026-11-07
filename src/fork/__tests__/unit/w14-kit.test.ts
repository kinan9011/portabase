import {execFileSync} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {unwrapDigitalKit, wrapDigitalKit} from "@/fork/kit/digital";
import {codesEqual, kitVerificationCode, looksLikeKey, normalizeCode} from "@/fork/kit/fingerprint";
import {buildKit, pointerOf, wrapCredentials} from "@/fork/kit/material";
import {base32, keyLines, lineCheck, renderPaperKit} from "@/fork/kit/paper";
import {checkPassphrase} from "@/fork/kit/passphrase";
import {kidOf, type Keyring} from "@/fork/kek";
import {spkiSha256} from "@/fork/manifest/sign";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

// ALL key material here is generated per run (TEST-ONLY); nothing is a real key.
const hasPy = (() => { try { execFileSync("python3", ["-c", "import cryptography.hazmat.primitives.ciphers.aead"], {stdio: "ignore"}); return true; } catch { return false; } })();
const mkKit = () => {
    const master = randomBytes(32);
    const k1 = randomBytes(32); const k2 = randomBytes(32);
    const kek: Keyring = {active: kidOf(k2), keys: new Map([[kidOf(k1), k1], [kidOf(k2), k2]])};
    const sign = testKeypair();
    const kit = buildKit({
        master, kek, now: new Date("2026-11-07T12:00:00Z"),
        anchors: [{kid: sign.kid, publicKeyPem: sign.publicKey, spkiSha256: spkiSha256(sign.publicKey), retired: false}],
        channels: [{name: "lab-minio", provider: "s3", config: {endPointUrl: "http://minio:9000", bucketName: "b", accessKey: "AKIA-TEST-ONLY", secretKey: "SECRET-TEST-ONLY-xyz", region: "us-east-1"}}, {name: "empty", provider: "local", config: {}}],
    });
    return {master, kek, sign, kit};
};

describe("W14 kit verification code (ADR-013 §8)", () => {
    it("matches an independent python implementation of the documented byte layout", () => {
        const {master, kek, sign} = mkKit();
        const code = kitVerificationCode({master, kek: kek.keys, spkiSha256Hex: spkiSha256(sign.publicKey)});
        expect(code).toMatch(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
        const kekArg = JSON.stringify([...kek.keys.entries()].map(([k, v]) => [k, v.toString("hex")]));
        const py = `
import hashlib,json,sys
m=bytes.fromhex(sys.argv[1]); keks=sorted(json.loads(sys.argv[2])); spki=bytes.fromhex(sys.argv[3])
h=hashlib.sha256(); h.update(b"portabase-fork-kit/v1\\0"+m+b"\\0")
for kid,k in keks: h.update(kid.encode()+b":"+bytes.fromhex(k)+b"\\0")
h.update(spki); x=h.hexdigest()[:20].upper(); print("-".join(x[i:i+4] for i in range(0,20,4)))`;
        const out = execFileSync("python3", ["-c", py, master.toString("hex"), kekArg, spkiSha256(sign.publicKey)]).toString().trim();
        expect(out).toBe(code);
    });
    it("changes with ANY key: master, a KEK key, a new KEK key (rotation) or the signing key", () => {
        const {master, kek, sign} = mkKit();
        const base = kitVerificationCode({master, kek: kek.keys, spkiSha256Hex: spkiSha256(sign.publicKey)});
        const other = (o: Partial<{master: Buffer; kek: Map<string, Buffer>; spki: string}>) => kitVerificationCode({master: o.master ?? master, kek: o.kek ?? kek.keys, spkiSha256Hex: o.spki ?? spkiSha256(sign.publicKey)});
        expect(other({master: randomBytes(32)})).not.toBe(base);
        const rotated = new Map(kek.keys); const nk = randomBytes(32); rotated.set(kidOf(nk), nk);
        expect(other({kek: rotated})).not.toBe(base);
        expect(other({spki: spkiSha256(testKeypair().publicKey)})).not.toBe(base);
        expect(other({})).toBe(base);
    });
    it("normalises input and refuses key-like strings without accepting them", () => {
        expect(normalizeCode("1a2b3c4d5e6f7a8b9c0d")).toBe("1A2B-3C4D-5E6F-7A8B-9C0D");
        expect(normalizeCode(" 1A2B 3C4D-5E6F 7A8B-9C0D ")).toBe("1A2B-3C4D-5E6F-7A8B-9C0D");
        expect(normalizeCode("1A2B")).toBeNull();
        expect(normalizeCode(randomBytes(32).toString("base64"))).toBeNull();
        expect(looksLikeKey(randomBytes(32).toString("base64"))).toBe(true);
        expect(looksLikeKey("1A2B-3C4D-5E6F-7A8B-9C0D")).toBe(false);
        expect(codesEqual("A", "A")).toBe(true); expect(codesEqual("A", "B")).toBe(false); expect(codesEqual("A", "AB")).toBe(false);
    });
});

describe("W14 kit content (D25 contents, §4.2)", () => {
    it("contains master, the WHOLE KEK keyring, every signing public key, pointers (no credentials) and the placeholders W14b fills", () => {
        const {kit, master, kek} = mkKit();
        expect(Buffer.from(kit.master_key_b64, "base64")).toEqual(master);
        expect(kit.kek.keys.map((k) => k.kid).sort()).toEqual([...kek.keys.keys()].sort());
        expect(kit.kek.active).toBe(kek.active);
        expect(kit.signing_public_keys).toHaveLength(1);
        expect(kit.storage[0].pointer).toEqual({endPointUrl: "http://minio:9000", bucketName: "b", region: "us-east-1"});
        expect(JSON.stringify(kit.storage[0].pointer)).not.toMatch(/AKIA|SECRET/);
        expect(kit.storage[0].credentials_wrapped).toMatchObject({alg: "AES-256-GCM"});
        expect(kit.storage[1].credentials_wrapped).toBeNull();
        expect(kit.recover.image_digest).toMatch(/not published/);
        expect(kit.recover.cli_version).toContain("fork/w14b-done");
        expect(kit.recover.guide).toContain("my-server-died.md");
    });
    it("wrapped storage credentials open with the master key (HKDF-derived) and only with it", () => {
        const {master} = mkKit();
        const w = wrapCredentials(master, {accessKey: "AKIA-TEST-ONLY"}, "ch");
        expect(w).not.toBeNull();
        expect(JSON.stringify(w)).not.toContain("AKIA-TEST-ONLY");
        const py = `
import base64,hashlib,hmac,json,sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
m=bytes.fromhex(sys.argv[1]); w=json.loads(sys.argv[2])
prk=hmac.new(b"\\0"*32,m,hashlib.sha256).digest(); okm=hmac.new(prk,b"portabase-fork/kit/storage-credentials/v1"+b"\\x01",hashlib.sha256).digest()
print(AESGCM(okm).decrypt(base64.b64decode(w["iv"]),base64.b64decode(w["ct"])+base64.b64decode(w["tag"]),b"channel:ch").decode())`;
        if (hasPy) expect(JSON.parse(execFileSync("python3", ["-c", py, master.toString("hex"), JSON.stringify(w)]).toString())).toEqual({accessKey: "AKIA-TEST-ONLY"});
    });
    it("pointerOf never copies secret-looking values or userinfo URLs", () => {
        expect(pointerOf({endPointUrl: "https://user:pw@host/x", bucketName: "b", secretKey: "s", password: "p", token: "t"})).toEqual({bucketName: "b"});
        expect(pointerOf(null)).toEqual({});
    });
});

describe("W14 digital kit (scrypt + AES-256-GCM, passphrase never stored)", () => {
    it("round-trips, fails with a wrong passphrase or a modified header", () => {
        const {kit} = mkKit();
        const file = wrapDigitalKit(kit, "correct horse battery staple 42!");
        expect(file.startsWith("PBKIT1\n")).toBe(true);
        expect(file).not.toContain(kit.master_key_b64);
        expect(unwrapDigitalKit(file, "correct horse battery staple 42!")).toEqual(kit);
        expect(() => unwrapDigitalKit(file, "wrong passphrase value 123!")).toThrow();
        const lines = file.split("\n"); lines[1] = lines[1].replace('"p":1', '"p":1 '); // header is AAD
        expect(() => unwrapDigitalKit(lines.join("\n"), "correct horse battery staple 42!")).toThrow();
    });
    it.skipIf(!hasPy)("unwraps with PLAIN python (hashlib.scrypt + cryptography), the documented bare-host route", () => {
        const {kit, master} = mkKit();
        const dir = mkdtempSync(path.join(tmpdir(), "w14-kit-"));
        try {
            writeFileSync(path.join(dir, "k.pbkit"), wrapDigitalKit(kit, "an unwrap passphrase 9#Z"));
            const py = `
import base64,hashlib,json,sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
lines=open(sys.argv[1]).read().strip().split("\\n"); assert lines[0]=="PBKIT1"
h=json.loads(lines[1]); raw=base64.b64decode("".join(lines[2:]))
key=hashlib.scrypt(sys.argv[2].encode(),salt=base64.b64decode(h["salt"]),n=h["N"],r=h["r"],p=h["p"],dklen=32,maxmem=256*1024*1024)
print(json.loads(AESGCM(key).decrypt(base64.b64decode(h["iv"]),raw,lines[1].encode()))["master_key_b64"])`;
            expect(execFileSync("python3", ["-c", py, path.join(dir, "k.pbkit"), "an unwrap passphrase 9#Z"]).toString().trim()).toBe(master.toString("base64"));
        } finally { rmSync(dir, {recursive: true, force: true}); }
    });
});

describe("W14 passphrase policy (minimum strength enforced)", () => {
    it.each([
        ["short", "Ab1!", "too_short"], ["two classes, 14", "abcdefghij1234", "too_simple"], ["repeat", "Ab1!Ab1!Ab1!Ab1!Ab1!", "repetitive"], ["same char", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "repetitive"],
        ["obvious", "Portabase-Secret-99!", "obvious"], ["mismatch", "Str0ng&long-enough-one", "mismatch"],
    ])("rejects %s", (_n, p, reason) => {
        const v = checkPassphrase(p, reason === "mismatch" ? "different" : undefined);
        expect(v).toEqual({ok: false, reason});
    });
    it("accepts a long mixed passphrase and a 24+ char words-only one", () => {
        expect(checkPassphrase("Tr1cky-Pass_phrase!", "Tr1cky-Pass_phrase!")).toEqual({ok: true});
        expect(checkPassphrase("blue train under heavy rain quietly")).toEqual({ok: true});
    });
});

describe("W14 paper kit (one-shot HTML, checksummed groups)", () => {
    it("prints keys as base32 groups whose line checksums are reproducible, never the verification code, never storage secrets, no external resources", () => {
        const {kit, master, kek, sign} = mkKit();
        const html = renderPaperKit(kit, {nonce: "NONCE123"});
        const lines = keyLines("MASTER", master);
        expect(lines).toHaveLength(4);
        expect(lines.map((l) => l.text.replace(/ /g, "")).join("")).toBe(base32(master));
        for (const l of lines) expect(html).toContain(`MASTER ${l.n}:  ${l.text}  ·  ${l.check}`);
        expect(lineCheck("MASTER", 1, base32(master).slice(0, 16))).toBe(lines[0].check);
        expect(lineCheck("MASTER", 1, "AAAAAAAAAAAAAAAA")).not.toBe(lines[0].check);
        const code = kitVerificationCode({master, kek: kek.keys, spkiSha256Hex: spkiSha256(sign.publicKey)});
        expect(html).not.toContain(code); expect(html).not.toContain(code.replace(/-/g, ""));
        expect(html).not.toMatch(/AKIA-TEST-ONLY|SECRET-TEST-ONLY/);
        expect(html).toContain("Anyone with this paper can read your backups");
        expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/[^"' <]*\.(js|css)/);
        expect(html).toContain('nonce="NONCE123"');
        expect(html).not.toContain(createHash("sha256").update(master).digest("hex")); // no derived secret hashes of the key either
    });
    it("escapes hostile storage names (no markup injection)", () => {
        const {kit} = mkKit();
        kit.storage[0].name = '<img src=x onerror=alert(1)>';
        expect(renderPaperKit(kit, {nonce: "n"})).not.toContain("<img src=x");
    });
});
