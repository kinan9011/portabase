import {spawnSync} from "node:child_process";
import {createHash, hkdfSync, randomBytes} from "node:crypto";
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {wrapDigitalKit} from "@/fork/kit/digital";
import {kitVerificationCode} from "@/fork/kit/fingerprint";
import {buildKit} from "@/fork/kit/material";
import {renderPaperKit} from "@/fork/kit/paper";
import {kidOf, type Keyring} from "@/fork/kek";
import {spkiSha256} from "@/fork/manifest/sign";
import {manifestRepoPassword} from "@/fork/manifest/repo-password";

/**
 * W14b: `kit-tool` (the offline verifier's crypto) is checked against the REAL producers of W14 (`buildKit`, `wrapDigitalKit`, `renderPaperKit`,
 * `kitVerificationCode`, `manifestRepoPassword`): a drift in either side fails here. ALL keys are generated per run (TEST-ONLY).
 */
const TOOL = path.join(process.cwd(), "scripts/fork/recover/kit-tool");
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(path.join(tmpdir(), "kit-tool-")); });
afterAll(() => rmSync(tmp, {recursive: true, force: true}));
let n = 0;
const tool = (args: string[]) => spawnSync("python3", ["-I", TOOL, ...args], {encoding: "utf8"});
const fresh = (name: string) => path.join(tmp, `${++n}-${name}`);
const PASS = "correct horse battery 7 staple!";

const make = () => {
    const master = randomBytes(32);
    const k1 = randomBytes(32); const k2 = randomBytes(32);
    const kek: Keyring = {active: kidOf(k2), keys: new Map([[kidOf(k1), k1], [kidOf(k2), k2]])};
    const sign = testKeypair();
    const kit = buildKit({
        master, kek, now: new Date("2026-11-07T12:00:00Z"),
        anchors: [{kid: sign.kid, publicKeyPem: sign.publicKey, spkiSha256: spkiSha256(sign.publicKey), retired: false}],
        channels: [{name: "lab-minio", provider: "s3", config: {endPointUrl: "http://minio:9000", bucketName: "b", accessKey: "AKIA-TEST-ONLY", secretKey: "SECRET-TEST-ONLY-xyz"}}, {name: "empty", provider: "local", config: {}}],
    });
    const code = kitVerificationCode({master, kek: kek.keys, spkiSha256Hex: spkiSha256(sign.publicKey)});
    return {master, kek, sign, kit, code};
};
const paperLines = (html: string) => html.replace(/<\/?(h1|h2|p|pre|ul|li|div|body|title)[^>]*>/g, "\n").replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").split("\n").map((l) => l.trim()).filter((l) => /^(MASTER|KEK-k[0-9a-f]{12}) \d:|^[0-9a-f]{12} \((current|retired)\)/.test(l)).join("\n");

describe("kit-tool vs the W14 producers", () => {
    it("digital kit: unwrap round-trips and the verification code equals the TypeScript one", () => {
        const {kit, code} = make();
        const kf = fresh("kit.pbkit"); writeFileSync(kf, wrapDigitalKit(kit, PASS));
        const pf = fresh("pass"); writeFileSync(pf, `${PASS}\n`, {mode: 0o600});
        const out = fresh("kit.json");
        const u = tool(["unwrap", "--kit", kf, "--passphrase-file", pf, "--out", out]);
        expect(u.status, u.stderr).toBe(0);
        expect(statSync(out).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(JSON.parse(JSON.stringify(kit)));
        const c = tool(["code", "--kit-json", out]);
        expect(c.status, c.stderr).toBe(0);
        expect(c.stdout.trim()).toBe(code);
    });
    it("digital kit: wrong passphrase, flipped byte, edited header and unsupported scrypt cost are refused without printing anything secret", () => {
        const {kit} = make();
        const file = wrapDigitalKit(kit, PASS);
        const pf = fresh("pass"); writeFileSync(pf, `${PASS}\n`);
        const bad = fresh("badpass"); writeFileSync(bad, "not the passphrase at all\n");
        const tries: Array<[string, string, string]> = [
            ["wrong passphrase", file, bad],
            ["flipped ciphertext", file.replace(/\n([A-Za-z0-9+/])/, (_m, c: string) => `\n${c === "A" ? "B" : "A"}`), pf],
            ["header edited (AAD)", file.replace('"p":1', '"p":1 '), pf],
            ["scrypt cost raised (memory bomb)", file.replace('"N":131072', '"N":4194304'), pf],
            ["not a kit", "PBKIT2\n{}\nAAAA\n", pf],
        ];
        for (const [label, content, pass] of tries) {
            const kf = fresh("k"); writeFileSync(kf, content);
            const out = fresh("o");
            const r = tool(["unwrap", "--kit", kf, "--passphrase-file", pass, "--out", out]);
            expect(r.status, label).toBe(1);
            expect(existsSync(out), label).toBe(false);
            expect(r.stdout + r.stderr, label).not.toMatch(/SECRET-TEST-ONLY|AKIA-TEST-ONLY|master/i);
        }
    });
    it("paper kit: retyped lines (as printed) give the same code; a typo is caught by the line check", () => {
        const {kit, code} = make();
        const text = paperLines(renderPaperKit(kit, {nonce: "n"}));
        expect(text.split("\n").length).toBeGreaterThanOrEqual(9); // MASTER 4 + 2 KEK x 4 + signing
        const lf = fresh("lines"); writeFileSync(lf, `${text}\n`);
        const out = fresh("paper.json");
        const r = tool(["paper", "--lines-file", lf, "--out", out]);
        expect(r.status, r.stderr).toBe(0);
        expect(tool(["code", "--kit-json", out]).stdout.trim()).toBe(code);
        // lowercase + extra spaces tolerated; one wrong letter refused
        const lower = fresh("lines2"); writeFileSync(lower, text.replace(/MASTER (\d): +([A-Z2-7 ]+)/g, (_m, i: string, g: string) => `MASTER ${i}:  ${g.toLowerCase()}`));
        expect(tool(["paper", "--lines-file", lower, "--out", fresh("p2.json")]).status).toBe(0);
        const typo = fresh("typo"); writeFileSync(typo, text.replace(/(MASTER 2: +)([A-Z2-7])/, (_m, a: string, c: string) => `${a}${c === "A" ? "B" : "A"}`));
        const t = tool(["paper", "--lines-file", typo, "--out", fresh("p3.json")]);
        expect(t.status).toBe(1);
        expect(t.stderr).toMatch(/MASTER line 2/);
        const missing = fresh("missing"); writeFileSync(missing, text.split("\n").filter((l) => !l.startsWith("MASTER 3")).join("\n"));
        expect(tool(["paper", "--lines-file", missing, "--out", fresh("p4.json")]).status).toBe(1);
    });
    it("derive == the dashboard's HKDF (manifest + artifact passwords); the key never appears in the output", () => {
        const {kit, master} = make();
        const kj = fresh("kit.json"); writeFileSync(kj, JSON.stringify(kit), {mode: 0o600});
        const stack = "11111111-2222-4333-8444-555555555555";
        const out = fresh("pw");
        const r = tool(["derive", "--kit-json", kj, "--info", `portabase-fork/manifest/v1/${stack}`, "--out", out]);
        expect(r.status, r.stderr).toBe(0);
        expect(readFileSync(out, "utf8").trim()).toBe(manifestRepoPassword(master, stack));
        const gen = "gen_ID-12";
        const out2 = fresh("pw2");
        expect(tool(["derive", "--kit-json", kj, "--info", `portabase/restic/v1/${gen}`, "--out", out2]).status).toBe(0);
        expect(readFileSync(out2, "utf8").trim()).toBe(Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `portabase/restic/v1/${gen}`, 32)).toString("hex"));
        expect(r.stdout + r.stderr).not.toContain(master.toString("hex"));
        expect(tool(["derive", "--kit-json", kj, "--info", "x; rm -rf /", "--out", fresh("pw3")]).status).toBe(1);
        expect(tool(["derive", "--kit-json", kj, "--info", `portabase/restic/v1/${gen}`, "--out", out2]).status, "never overwrites").toBe(1);
    });
    it("unwrap-creds opens exactly the credentials the dashboard wrapped (AAD binds the channel name); export-master gives the base64 key", () => {
        const {kit, master} = make();
        const kj = fresh("kit.json"); writeFileSync(kj, JSON.stringify(kit), {mode: 0o600});
        const out = fresh("creds");
        expect(tool(["unwrap-creds", "--kit-json", kj, "--channel", "lab-minio", "--out", out]).status).toBe(0);
        expect(JSON.parse(readFileSync(out, "utf8")).secretKey).toBe("SECRET-TEST-ONLY-xyz");
        expect(tool(["unwrap-creds", "--kit-json", kj, "--channel", "empty", "--out", fresh("c2")]).status).toBe(1); // no wrapped credentials
        const swapped = JSON.parse(JSON.stringify(kit)); swapped.storage[0].name = "other-name"; // AAD mismatch
        const sj = fresh("swapped.json"); writeFileSync(sj, JSON.stringify(swapped));
        expect(tool(["unwrap-creds", "--kit-json", sj, "--channel", "other-name", "--out", fresh("c3")]).status).toBe(1);
        const mo = fresh("master.b64");
        expect(tool(["export-master", "--kit-json", kj, "--out", mo]).status).toBe(0);
        expect(Buffer.from(readFileSync(mo, "utf8").trim(), "base64").equals(master)).toBe(true);
    });
    it("rejects structurally bad kits (version, two current signing keys, id/fingerprint mismatch, short key)", () => {
        const {kit} = make();
        const mut = (f: (k: any) => void) => { const k = JSON.parse(JSON.stringify(kit)); f(k); const p = fresh("bad.json"); writeFileSync(p, JSON.stringify(k)); return tool(["code", "--kit-json", p]).status; };
        expect(mut((k) => { k.kit_version = 2; })).toBe(1);
        expect(mut((k) => { k.signing_public_keys.push({...k.signing_public_keys[0]}); })).toBe(1);
        expect(mut((k) => { k.signing_public_keys[0].kid = "0".repeat(12); })).toBe(1);
        expect(mut((k) => { k.master_key_b64 = Buffer.alloc(16).toString("base64"); })).toBe(1);
        expect(mut(() => {})).toBe(0);
    });
    it("anchors: prints kid/fingerprint/state and writes the PEM with 0600; hash equals openssl's SPKI SHA-256", () => {
        const {kit, sign} = make();
        const kj = fresh("kit.json"); writeFileSync(kj, JSON.stringify(kit));
        const dir = fresh("anchors");
        const r = tool(["anchors", "--kit-json", kj, "--dir", dir]);
        expect(r.status, r.stderr).toBe(0);
        const [kid, fp, state, pem] = r.stdout.trim().split(" ");
        expect(kid).toBe(sign.kid); expect(state).toBe("current");
        expect(fp).toBe(createHash("sha256").update(spkiDer(sign.publicKey)).digest("hex"));
        expect(statSync(pem).mode & 0o777).toBe(0o600);
    });
});

function spkiDer(pem: string): Buffer {
    return Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}
