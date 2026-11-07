import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterAll, describe, expect, it, vi} from "vitest";
import {manifestRepoPassword} from "@/fork/manifest/repo-password";
import {createResticRunner} from "@/fork/manifest/restic-runner";
import {forgetManifestSnapshots, listManifestSnapshots, readManifestSnapshot, writeManifestSnapshot} from "@/fork/manifest/store";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {signedFixture, testMaster} from "@/fork/__tests__/w14-fixtures";

const hasRestic = (() => { try { execFileSync("restic", ["version"], {stdio: "ignore"}); return true; } catch { return false; } })();
vi.setConfig({testTimeout: 90_000}); // restic init/backup run scrypt
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, {recursive: true, force: true}); });

describe.skipIf(!hasRestic)("W14 manifest restic store (real restic, local repo)", () => {
    const mk = (stackId: string) => {
        const repo = mkdtempSync(path.join(tmpdir(), "w14-repo-"));
        dirs.push(repo);
        return createResticRunner({repository: repo, password: manifestRepoPassword(testMaster(), stackId), env: {RESTIC_CACHE_DIR: path.join(repo, "..", "w14-cache")}});
    };

    it("writes one snapshot per RP, reads it back byte-exact and the signature still verifies; sequence/rp tags are set", async () => {
        const f = signedFixture();
        const run = mk(f.rp.stackId);
        const {snapshotId} = await writeManifestSnapshot(run, {json: f.signed.json, sig: f.signed.sig, publicKeyPem: f.key.publicKey}, {rpId: f.rp.id, sequence: 3});
        expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);
        expect(await listManifestSnapshots(run, f.rp.id)).toEqual([snapshotId]);
        const back = await readManifestSnapshot(run, snapshotId);
        expect(back.json).toBe(f.signed.json);
        expect(Buffer.compare(back.sig, f.signed.sig)).toBe(0); // raw binary survived (no string round trip)
        expect(verifyManifestBundle({json: back.json, sig: back.sig}, f.anchors, {stackId: f.rp.stackId, rpId: f.rp.id, sequence: 3}).ok).toBe(true);
    });

    it("OFFLINE with plain restic + openssl (what the CLI does): restore, then `openssl dgst -verify`", async () => {
        const f = signedFixture();
        const stackId = f.rp.stackId;
        const repo = mkdtempSync(path.join(tmpdir(), "w14-repo-")); dirs.push(repo);
        const run = createResticRunner({repository: repo, password: manifestRepoPassword(testMaster(), stackId), env: {RESTIC_CACHE_DIR: path.join(repo, "..", "w14-cache")}});
        await writeManifestSnapshot(run, {json: f.signed.json, sig: f.signed.sig, publicKeyPem: f.key.publicKey}, {rpId: f.rp.id, sequence: 3});
        const out = mkdtempSync(path.join(tmpdir(), "w14-out-")); dirs.push(out);
        const pw = execFileSync("openssl", ["kdf", "-keylen", "32", "-kdfopt", "digest:SHA256", "-kdfopt", `hexkey:${testMaster().toString("hex")}`, "-kdfopt", `info:portabase-fork/manifest/v1/${stackId}`, "-binary", "HKDF"]).toString("hex");
        execFileSync("restic", ["-r", repo, "restore", "latest", "--tag", `rp:${f.rp.id}`, "--target", out], {env: {...process.env, RESTIC_PASSWORD: pw, RESTIC_CACHE_DIR: path.join(repo, "..", "w14-cache")}, stdio: "pipe"});
        const found = execFileSync("find", [out, "-name", "manifest.json"]).toString().trim();
        const dir = path.dirname(found);
        writeFileSync(path.join(out, "pub.pem"), readFileSync(path.join(dir, "signing-key.pub.pem")));
        const v = execFileSync("openssl", ["dgst", "-sha256", "-verify", path.join(out, "pub.pem"), "-signature", path.join(dir, "manifest.json.sig"), found]).toString();
        expect(v).toContain("Verified OK");
    });

    it("a wrong repo password cannot read it; forget removes the snapshots (idempotent)", async () => {
        const f = signedFixture();
        const repo = mkdtempSync(path.join(tmpdir(), "w14-repo-")); dirs.push(repo);
        const good = createResticRunner({repository: repo, password: manifestRepoPassword(testMaster(), f.rp.stackId), env: {RESTIC_CACHE_DIR: path.join(repo, "..", "w14-cache")}});
        await writeManifestSnapshot(good, {json: f.signed.json, sig: f.signed.sig, publicKeyPem: f.key.publicKey}, {rpId: f.rp.id, sequence: 3});
        const bad = createResticRunner({repository: repo, password: manifestRepoPassword(testMaster(), "99999999-9999-9999-9999-999999999999"), env: {RESTIC_CACHE_DIR: path.join(repo, "..", "w14-cache2")}});
        await expect(listManifestSnapshots(bad, f.rp.id)).rejects.toMatchObject({code: "list_failed"});
        expect(await forgetManifestSnapshots(good, f.rp.id)).toBe(1);
        expect(await forgetManifestSnapshots(good, f.rp.id)).toBe(0);
    });
});
