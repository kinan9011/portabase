import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterAll, describe, expect, it, vi} from "vitest";
import {manifestRepoPassword} from "@/fork/manifest/repo-password";
import {createResticRunner} from "@/fork/manifest/restic-runner";
import {writeManifestSnapshot} from "@/fork/manifest/store";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {defaultManifestFetch} from "@/fork/restore-run/manifest";
import {signedFixture, testMaster} from "@/fork/__tests__/w14-fixtures";

const hasRestic = (() => { try { execFileSync("restic", ["version"], {stdio: "ignore"}); return true; } catch { return false; } })();
vi.setConfig({testTimeout: 90_000});
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, {recursive: true, force: true}); });
const CH1 = "11111111-1111-4111-8111-111111111111";
const CH2 = "22222222-2222-4222-8222-222222222222";
const keys = {master: async () => testMaster(), signing: async () => { throw new Error("not used"); }};

describe("W18a manifest fetch (verification happens elsewhere; this only returns the exact signed bytes)", () => {
    it("malformed / empty refs and an unavailable master key ⇒ null, nothing opened", async () => {
        let opened = 0;
        const open = (async () => { opened += 1; throw new Error("no"); }) as never;
        const f = defaultManifestFetch({} as never, {keys, open});
        for (const refs of [null, [], "x", [{channel_id: "no", snapshot_id: "a".repeat(64)}], [{channel_id: CH1, snapshot_id: "../etc"}], [{channel_id: CH1, snapshot_id: "a".repeat(64), extra: 1}], Array.from({length: 17}, () => ({channel_id: CH1, snapshot_id: "a".repeat(64)}))]) {
            expect(await f({id: "i", stackId: "s", manifestRefs: refs})).toBeNull();
        }
        expect(opened).toBe(0);
        const noKey = defaultManifestFetch({} as never, {keys: {master: async () => { throw new Error("k"); }, signing: keys.signing}, open});
        expect(await noKey({id: "i", stackId: "s", manifestRefs: [{channel_id: CH1, snapshot_id: "a".repeat(64)}]})).toBeNull();
        expect(opened).toBe(0);
    });

    describe.skipIf(!hasRestic)("against a real local restic repository", () => {
        it("returns the bundle byte-exact (it still verifies); the first ref unreadable ⇒ the second copy is used; every copy unreadable ⇒ null; cleanup always runs", async () => {
            const fx = signedFixture();
            const repo = mkdtempSync(path.join(tmpdir(), "w18a-repo-")); dirs.push(repo);
            const run = createResticRunner({repository: repo, password: manifestRepoPassword(testMaster(), fx.rp.stackId), env: {RESTIC_CACHE_DIR: path.join(repo, "..", "w18a-cache")}});
            const {snapshotId} = await writeManifestSnapshot(run, {json: fx.signed.json, sig: fx.signed.sig, publicKeyPem: fx.key.publicKey}, {rpId: fx.rp.id, sequence: 3});
            let cleaned = 0;
            const opened: string[] = [];
            const open = (async (_db: unknown, channelId: string) => {
                opened.push(channelId);
                if (channelId === CH1) throw new Error("channel offline");
                return {run, cleanup: async () => { cleaned += 1; }};
            }) as never;
            const f = defaultManifestFetch({} as never, {keys, open});
            const got = await f({id: fx.rp.id, stackId: fx.rp.stackId, manifestRefs: [{channel_id: CH1, snapshot_id: snapshotId}, {channel_id: CH2, snapshot_id: snapshotId}]});
            expect(opened).toEqual([CH1, CH2]);
            expect(got?.json).toBe(fx.signed.json);
            expect(got?.sigB64).toBe(fx.signed.sig.toString("base64"));
            expect(cleaned).toBe(1);
            expect(verifyManifestBundle({json: got!.json, sig: Buffer.from(got!.sigB64, "base64")}, fx.anchors, {stackId: fx.rp.stackId, rpId: fx.rp.id, sequence: 3}).ok).toBe(true);
            // a snapshot id that does not exist ⇒ unreadable ⇒ null (and the handle is still cleaned)
            const none = await f({id: fx.rp.id, stackId: fx.rp.stackId, manifestRefs: [{channel_id: CH2, snapshot_id: "f".repeat(64)}]});
            expect(none).toBeNull();
            expect(cleaned).toBe(2);
        });
    });
});
