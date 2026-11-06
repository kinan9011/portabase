import {mkdtemp, readFile, readdir, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {decryptForkSecret, encryptForkSecret, ForkCryptoError, ForkEnvelopeSchema, getOrCreateKeyring, kidOf, loadKeyring, rotateForkKek, type ForkSecretAad} from "@/fork/kek";

const CANARY = "arc_canary_SECRET_0123456789";
const aad: ForkSecretAad = {table: "fork_arcane_connection", rowId: "11111111-1111-4111-8111-111111111111", column: "api_key_enc"};
let dir: string;
beforeEach(async () => { dir = path.join(await mkdtemp(path.join(os.tmpdir(), "w04-kek-")), "fork-kek"); });

describe("D23 fork KEK envelope {kid, iv, ct, tag} + AAD table|row_id|column", () => {
    it("round-trips and has exactly the four envelope fields (no plaintext, strict schema)", async () => {
        const env = await encryptForkSecret(CANARY, aad, dir);
        expect(Object.keys(env).sort()).toEqual(["ct", "iv", "kid", "tag"]);
        expect(ForkEnvelopeSchema.safeParse(env).success).toBe(true);
        expect(ForkEnvelopeSchema.safeParse({...env, extra: 1}).success).toBe(false);
        expect(JSON.stringify(env)).not.toContain(CANARY);
        expect(await decryptForkSecret(env, aad, dir)).toBe(CANARY);
    });
    it("a fresh IV per encryption (same plaintext ⇒ different ciphertext)", async () => {
        const a = await encryptForkSecret(CANARY, aad, dir);
        const b = await encryptForkSecret(CANARY, aad, dir);
        expect(a.iv).not.toBe(b.iv);
        expect(a.ct).not.toBe(b.ct);
    });
    it.each<[string, Partial<ForkSecretAad>]>([
        ["another ROW", {rowId: "22222222-2222-4222-8222-222222222222"}],
        ["another COLUMN", {column: "other_column"}],
        ["another TABLE", {table: "fork_other"}],
    ])("ciphertext copied to %s does not decrypt", async (_n, patch) => {
        const env = await encryptForkSecret(CANARY, aad, dir);
        await expect(decryptForkSecret(env, {...aad, ...patch}, dir)).rejects.toBeInstanceOf(ForkCryptoError);
    });
    it("tampering with ct / tag / iv / kid fails; errors never contain the plaintext", async () => {
        const env = await encryptForkSecret(CANARY, aad, dir);
        const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
        for (const bad of [{...env, ct: flip(env.ct)}, {...env, tag: flip(env.tag)}, {...env, iv: flip(env.iv)}, {...env, kid: "k000000000000"}, {kid: env.kid}, null, "x"]) {
            const err = await decryptForkSecret(bad, aad, dir).then(() => null, (e: Error) => e);
            expect(err).toBeInstanceOf(ForkCryptoError);
            expect(String(err!.message) + String(err!.stack)).not.toContain(CANARY);
        }
    });
    it("no fixed kid: kid is derived from the key; two keyrings have different kids", async () => {
        const a = await getOrCreateKeyring(dir);
        const b = await getOrCreateKeyring(path.join(path.dirname(dir), "other"));
        expect(a.active).toBe(kidOf(a.keys.get(a.active)!));
        expect(a.active).not.toBe(b.active);
        expect(a.active).toMatch(/^k[0-9a-f]{12}$/);
    });
    it("rotation: new kid encrypts, old envelopes still decrypt, both keys stay in the ring", async () => {
        const old = await encryptForkSecret(CANARY, aad, dir);
        const {kid, previous} = await rotateForkKek(dir);
        expect(previous).toBe(old.kid);
        expect(kid).not.toBe(old.kid);
        const fresh = await encryptForkSecret(CANARY, aad, dir);
        expect(fresh.kid).toBe(kid);
        expect(await decryptForkSecret(old, aad, dir)).toBe(CANARY);
        expect(await decryptForkSecret(fresh, aad, dir)).toBe(CANARY);
        expect((await loadKeyring(dir))!.keys.size).toBe(2);
    });
    it("key custody: dir 0700, key + active files 0600, 32 random bytes", async () => {
        await getOrCreateKeyring(dir);
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        for (const f of await readdir(dir)) expect((await stat(path.join(dir, f))).mode & 0o777).toBe(0o600);
        const keyFile = (await readdir(dir)).find((f) => f.endsWith(".key"))!;
        expect((await readFile(path.join(dir, keyFile))).length).toBe(32);
    });
    it("a stale/forged keyring is refused: wrong length, renamed key, missing or unknown `active`", async () => {
        const ring = await getOrCreateKeyring(dir);
        await writeFile(path.join(dir, "active"), "kffffffffffff");
        await expect(loadKeyring(dir)).rejects.toBeInstanceOf(ForkCryptoError);
        await writeFile(path.join(dir, "active"), ring.active);
        await writeFile(path.join(dir, "k123456789abc.key"), Buffer.alloc(32, 1));
        await expect(loadKeyring(dir)).rejects.toBeInstanceOf(ForkCryptoError); // file name != kid(key)
    });
    it("decrypt without any keyring fails closed (does NOT create a key)", async () => {
        await expect(decryptForkSecret({kid: "k000000000000", iv: "A".repeat(16), ct: "AA", tag: "A".repeat(22)}, aad, dir)).rejects.toBeInstanceOf(ForkCryptoError);
        expect(await loadKeyring(dir)).toBeNull();
    });
    it("is independent of the instance master/edge key (static: kek.ts imports none of them)", async () => {
        const src = await readFile(path.join(process.cwd(), "src/fork/kek.ts"), "utf8");
        const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
        expect(imports.filter((i) => !i.startsWith("node:") && i !== "zod")).toEqual([]);
        const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        expect(code).not.toMatch(/edge_key|master_key|credential-crypto|getOrCreateMasterKey|MASTER/i);
    });
    it("canary: the plaintext never reaches stdout/stderr/console, including on failures", async () => {
        const seen: string[] = [];
        const spies = [
            vi.spyOn(process.stdout, "write").mockImplementation((c) => { seen.push(String(c)); return true; }),
            vi.spyOn(process.stderr, "write").mockImplementation((c) => { seen.push(String(c)); return true; }),
            ...(["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(" ")); })),
        ];
        try {
            const env = await encryptForkSecret(CANARY, aad, dir);
            await decryptForkSecret(env, {...aad, rowId: "other"}, dir).catch((e) => seen.push(String(e)));
            await decryptForkSecret({...env, ct: "AAAA"}, aad, dir).catch((e) => seen.push(String(e)));
        } finally { for (const s of spies) s.mockRestore(); }
        expect(seen.join("\n")).not.toContain(CANARY);
    });
});
