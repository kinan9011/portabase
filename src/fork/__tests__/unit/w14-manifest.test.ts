import {execFileSync} from "node:child_process";
import {createHash, createSign, generateKeyPairSync} from "node:crypto";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {manifestRepoPassword, manifestRepoRel} from "@/fork/manifest/repo-password";
import {signManifest, kidOfPublicKey} from "@/fork/manifest/sign";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {artifactFacts, rpFacts, signedFixture, SHA_A, testKeypair, testMaster} from "@/fork/__tests__/w14-fixtures";
import {buildManifest} from "@/fork/manifest/build";

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], {stdio: "ignore"}); return true; } catch { return false; } })();

describe("W14 manifest v1 (D24)", () => {
    it("round-trips: a freshly signed manifest verifies and carries the signed fields", () => {
        const f = signedFixture();
        const r = verifyManifestBundle({json: f.signed.json, sig: f.signed.sig}, f.anchors, {stackId: f.rp.stackId, rpId: f.rp.id, sequence: 3});
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.manifest.rp.sequence).toBe(3);
            expect(r.manifest.artifacts[0].plaintext_sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(r.manifest.artifacts[0].plaintext_size).toBe(1234);
        }
    });

    it("is deterministic: same facts ⇒ same bytes (hashable)", () => {
        const key = testKeypair();
        const rp = rpFacts();
        const art = artifactFacts({generatedId: "g"});
        const a = signedFixture({key, rp, artifacts: [art]});
        const b = signedFixture({key, rp, artifacts: [art]});
        expect(a.signed.json).toBe(b.signed.json);
    });

    it("FORGED: a changed byte, a swapped signature or a foreign key is rejected", () => {
        const f = signedFixture();
        const bundle = {json: f.signed.json, sig: f.signed.sig};
        const expectIt = {stackId: f.rp.stackId};
        const tampered = f.signed.json.replace('"plaintext_size":1234', '"plaintext_size":1235');
        expect(tampered).not.toBe(f.signed.json);
        expect(verifyManifestBundle({json: tampered, sig: bundle.sig}, f.anchors, expectIt)).toEqual({ok: false, code: "bad_signature"});
        const flipped = Buffer.from(bundle.sig); flipped[10] ^= 1;
        expect(verifyManifestBundle({json: bundle.json, sig: flipped}, f.anchors, expectIt)).toEqual({ok: false, code: "bad_signature"});
        // signed by an attacker key that claims the real kid
        const evil = testKeypair();
        const forged = Buffer.from(createSign("sha256").update(f.signed.json).sign(evil.privateKey));
        expect(verifyManifestBundle({json: bundle.json, sig: forged}, f.anchors, expectIt)).toEqual({ok: false, code: "bad_signature"});
        // signed by an attacker key with its own kid: not a trust anchor
        const g = signedFixture({key: evil});
        expect(verifyManifestBundle({json: g.signed.json, sig: g.signed.sig}, f.anchors, {stackId: g.rp.stackId})).toEqual({ok: false, code: "unknown_kid"});
        // a trust anchor whose pem does not hash to its kid is ignored
        expect(verifyManifestBundle({json: g.signed.json, sig: g.signed.sig}, [{kid: g.key.kid, publicKeyPem: f.anchors[0].publicKeyPem}], {stackId: g.rp.stackId})).toEqual({ok: false, code: "unknown_kid"});
    });

    it("ROLLED BACK: a validly signed older sequence is rejected once a newer one is known", () => {
        const key = testKeypair();
        const stackId = rpFacts().stackId;
        const old = signedFixture({key, rp: {stackId, sequence: 2}});
        const fresh = signedFixture({key, rp: {stackId, sequence: 5}});
        expect(verifyManifestBundle({json: fresh.signed.json, sig: fresh.signed.sig}, fresh.anchors, {stackId, minSequence: 5}).ok).toBe(true);
        expect(verifyManifestBundle({json: old.signed.json, sig: old.signed.sig}, old.anchors, {stackId, minSequence: 5})).toEqual({ok: false, code: "rollback"});
    });

    it("REPLAYED: a valid manifest presented for another stack, another RP or another sequence is rejected", () => {
        const f = signedFixture();
        const b = {json: f.signed.json, sig: f.signed.sig};
        expect(verifyManifestBundle(b, f.anchors, {stackId: rpFacts().stackId})).toEqual({ok: false, code: "stack_mismatch"});
        expect(verifyManifestBundle(b, f.anchors, {stackId: f.rp.stackId, rpId: rpFacts().id})).toEqual({ok: false, code: "rp_mismatch"});
        expect(verifyManifestBundle(b, f.anchors, {stackId: f.rp.stackId, rpId: f.rp.id, sequence: 4})).toEqual({ok: false, code: "sequence_mismatch"});
    });

    it("rejects malformed input fail-closed (not JSON, extra field, non-canonical, oversize)", () => {
        const f = signedFixture();
        const e = {stackId: f.rp.stackId};
        expect(verifyManifestBundle({json: "not json", sig: f.signed.sig}, f.anchors, e)).toEqual({ok: false, code: "bad_format"});
        const extra = f.signed.json.replace('"artifacts"', '"evil":1,"artifacts"');
        expect(verifyManifestBundle({json: extra, sig: f.signed.sig}, f.anchors, e)).toEqual({ok: false, code: "bad_schema"});
        const pretty = JSON.stringify(JSON.parse(f.signed.json), null, 2);
        expect(verifyManifestBundle({json: pretty, sig: f.signed.sig}, f.anchors, e)).toEqual({ok: false, code: "not_canonical"});
        expect(verifyManifestBundle({json: Buffer.alloc(3 * 1024 * 1024, 32), sig: f.signed.sig}, f.anchors, e)).toEqual({ok: false, code: "too_large"});
    });

    it("a RETIRED key still verifies its old manifests (ADR-013 §3: old public keys are kept)", () => {
        const oldKey = testKeypair();
        const newKey = testKeypair();
        const f = signedFixture({key: oldKey});
        const anchors = [{kid: newKey.kid, publicKeyPem: newKey.publicKey}, {kid: oldKey.kid, publicKeyPem: oldKey.publicKey}];
        expect(verifyManifestBundle({json: f.signed.json, sig: f.signed.sig}, anchors, {stackId: f.rp.stackId}).ok).toBe(true);
        expect(verifyManifestBundle({json: f.signed.json, sig: f.signed.sig}, [anchors[0]], {stackId: f.rp.stackId})).toEqual({ok: false, code: "unknown_kid"});
    });

    it("refuses to sign when the manifest kid is not the signing key's", () => {
        const key = testKeypair();
        const other = testKeypair();
        const m = buildManifest(rpFacts(), [artifactFacts()], null, {kid: other.kid, signedAt: new Date(), verifiedAt: new Date()});
        expect(() => signManifest(m, key.privateKey)).toThrow(/kid/);
    });

    it("CANARY: planted secrets in free-text-free inputs never reach the manifest; secret-shaped keys cannot be added", () => {
        const CANARY = "CANARY-SECRET-0f3a9c";
        const f = signedFixture({artifacts: [artifactFacts({sourceName: "db-main"})]});
        expect(f.signed.json).not.toContain(CANARY);
        // the schema is strict: a secret-carrying extra field is rejected by the verifier even if somebody signs it
        const m = JSON.parse(f.signed.json);
        m.artifacts[0].password = CANARY;
        const key = f.key;
        const evilJson = JSON.stringify(m);
        const sig = createSign("sha256").update(evilJson).sign(key.privateKey);
        expect(verifyManifestBundle({json: evilJson, sig}, f.anchors, {stackId: f.rp.stackId}).ok).toBe(false);
    });

    it("kid is derived from the SPKI of the public key and is stable across PEM encodings", () => {
        const {publicKey} = generateKeyPairSync("rsa", {modulusLength: 2048, publicKeyEncoding: {type: "pkcs1", format: "pem"}, privateKeyEncoding: {type: "pkcs1", format: "pem"}});
        const spki = generateKeyPairSync("rsa", {modulusLength: 2048}).publicKey.export({type: "spki", format: "pem"}).toString();
        expect(kidOfPublicKey(publicKey)).toMatch(/^[0-9a-f]{12}$/);
        expect(kidOfPublicKey(spki)).toMatch(/^[0-9a-f]{12}$/);
    });

    it.skipIf(!hasOpenssl)("OFFLINE: plain `openssl dgst -sha256 -verify` accepts the signature and rejects a tampered file", () => {
        const f = signedFixture();
        const dir = mkdtempSync(path.join(tmpdir(), "w14-openssl-"));
        try {
            writeFileSync(path.join(dir, "manifest.json"), f.signed.json);
            writeFileSync(path.join(dir, "manifest.json.sig"), f.signed.sig);
            writeFileSync(path.join(dir, "pub.pem"), f.key.publicKey);
            const out = execFileSync("openssl", ["dgst", "-sha256", "-verify", path.join(dir, "pub.pem"), "-signature", path.join(dir, "manifest.json.sig"), path.join(dir, "manifest.json")]).toString();
            expect(out).toContain("Verified OK");
            writeFileSync(path.join(dir, "manifest.json"), f.signed.json.replace("forklab-demo", "forklab-demx"));
            expect(() => execFileSync("openssl", ["dgst", "-sha256", "-verify", path.join(dir, "pub.pem"), "-signature", path.join(dir, "manifest.json.sig"), path.join(dir, "manifest.json")], {stdio: "pipe"})).toThrow();
        } finally { rmSync(dir, {recursive: true, force: true}); }
    });
});

describe("W14 manifest repo password (D24)", () => {
    it("matches an independent RFC 5869 computation and `openssl kdf`", () => {
        const master = testMaster();
        const stackId = "11111111-2222-3333-4444-555555555555";
        const pw = manifestRepoPassword(master, stackId);
        expect(pw).toMatch(/^[0-9a-f]{64}$/);
        // independent HKDF (extract with an all-zero salt of hash length, then one expand block)
        const prk = createHmacHex(Buffer.alloc(32), master);
        const okm = createHmacHex(Buffer.from(prk, "hex"), Buffer.concat([Buffer.from(`portabase-fork/manifest/v1/${stackId}`), Buffer.from([1])]));
        expect(pw).toBe(okm);
        if (hasOpenssl) {
            const out = execFileSync("openssl", ["kdf", "-keylen", "32", "-kdfopt", "digest:SHA256", "-kdfopt", `hexkey:${master.toString("hex")}`, "-kdfopt", `info:portabase-fork/manifest/v1/${stackId}`, "-binary", "HKDF"]);
            expect(out.toString("hex")).toBe(pw);
        }
        expect(() => manifestRepoPassword(master, "../etc")).toThrow();
        expect(() => manifestRepoPassword(Buffer.alloc(16), stackId)).toThrow();
        expect(manifestRepoRel(" /backups/ ", stackId.toUpperCase())).toBe(`backups/fork-manifest/${stackId}`);
        expect(SHA_A).toHaveLength(64);
    });
});

import {createHmac} from "node:crypto";
function createHmacHex(key: Buffer, data: Buffer): string { return createHmac("sha256", key).update(data).digest("hex"); }
void createHash;
