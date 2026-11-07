import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {gzipSync} from "node:zlib";
import {createCipheriv, randomBytes} from "node:crypto";
import {manifestRepoPassword} from "@/fork/manifest/repo-password";
import {createResticRunner} from "@/fork/manifest/restic-runner";
import type {VerifyDeps} from "@/fork/verify/service";
import {tickAllRuns} from "@/fork/runs/service";
import {startRun} from "@/fork/runs/start";
import {agent, touchAgent, waitingBackups, type World} from "@/fork/__tests__/w12-fixtures";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

export const hasRestic = (() => { try { execFileSync("restic", ["version"], {stdio: "ignore"}); return true; } catch { return false; } })();

/** REAL agent fixture (W02b, TEST-ONLY lab key — see scripts/fork/recover/fixtures/fixtures.json). */
const FIX = path.join(process.cwd(), "scripts/fork/recover/fixtures");
const fx = JSON.parse(readFileSync(path.join(FIX, "fixtures.json"), "utf8")) as {master_key_b64: string; fixtures: {file: string; plaintext_size: number; plaintext_sha256: string}[]};
export const FIXTURE_MASTER = Buffer.from(fx.master_key_b64, "base64");
export const fixtureObject = () => ({bytes: readFileSync(path.join(FIX, fx.fixtures[0].file)), plaintextSize: fx.fixtures[0].plaintext_size, plaintextSha256: fx.fixtures[0].plaintext_sha256});

/** Local-path restic repos stand in for the rclone channels (the store is backend-agnostic). One dir per (channel,stack). */
export function localRepos() {
    const root = mkdtempSync(path.join(tmpdir(), "w14-repos-"));
    const opened: string[] = [];
    return {
        root,
        runnerFor: (master: Buffer) => async (channelId: string, stackId: string) => {
            const repo = path.join(root, channelId);
            opened.push(channelId);
            return {run: createResticRunner({repository: repo, password: manifestRepoPassword(master, stackId), env: {RESTIC_CACHE_DIR: path.join(root, "cache")}}), cleanup: async () => undefined};
        },
        opened, drop: () => rmSync(root, {recursive: true, force: true}),
    };
}

export type Served = {status?: number; bytes?: Buffer; throwMidway?: boolean};
export function mkDeps(w: World, o: {serve: (backupStorageId: string) => Served; master?: Buffer; repos: ReturnType<typeof localRepos>; signingKey?: ReturnType<typeof testKeypair> | null; overrides?: Partial<VerifyDeps>}): VerifyDeps {
    const master = o.master ?? FIXTURE_MASTER;
    const key = o.signingKey === undefined ? testKeypair() : o.signingKey;
    return {
        db: w.deps.db, now: w.deps.now,
        keys: {
            master: async () => master,
            signing: async () => { if (!key) throw new (await import("@/fork/keys")).KeyUnavailableError("signing"); return {privateKeyPem: key.privateKey, publicKeyPem: key.publicKey}; },
        },
        openArchive: async (id) => {
            const s = o.serve(id);
            const bytes = s.bytes ?? Buffer.alloc(0);
            if (s.status && s.status !== 200) return {status: s.status, body: null, abort() {}};
            const body = (async function* () { yield bytes.subarray(0, Math.floor(bytes.length / 2)); if (s.throwMidway) throw new Error("socket hang up"); yield bytes.subarray(Math.floor(bytes.length / 2)); })();
            return {status: 200, body, abort() {}};
        },
        checkResticSnapshot: async () => true,
        manifestRunner: o.repos.runnerFor(master),
        limits: {maxPlaintextBytes: 1 << 30, maxInflatedBytes: 1 << 30, downloadTimeoutMs: 60_000},
        maxAttempts: 3, backoffMinutes: [1, 5], crossCheckAgentSize: true, ...o.overrides,
    };
}

/** Drives a real W12 run to a `pending_verification` RP whose artifact size = the fixture's plaintext size (what the stock agent reports). */
export async function pendingRp(pool: Pool, w: World, size: number) {
    const r = await startRun(w.deps, {stackId: w.stackId, trigger: "manual", userId: w.userId});
    if (r.kind !== "started") throw new Error(`not started: ${JSON.stringify(r)}`);
    for (let i = 0; i < 10; i++) {
        await touchAgent(pool, w);
        await tickAllRuns(w.deps);
        for (const b of await waitingBackups(pool, w)) if (b.status === "waiting") { await agent.pickUp(pool, w, b.id); await agent.succeed(pool, w, b.id, {size}); }
        w.clock.t = new Date(w.clock.t.getTime() + 1000);
        if ((await pool.query("select 1 from fork_stack_run where stack_id=$1 and state in ('starting','running','finalizing')", [w.stackId])).rows.length === 0) break;
    }
    const rp = (await pool.query("select id, status from fork_recovery_point where stack_id=$1 order by sequence desc limit 1", [w.stackId])).rows[0] as {id: string; status: string};
    if (rp.status !== "pending_verification") throw new Error(`RP is ${rp.status}`);
    return rp.id;
}

/** Re-encrypts arbitrary plaintext in the agent format under `key` (synthetic cases). */
export function encryptAgentFormat(plain: Buffer, key: Buffer): Buffer {
    const base = randomBytes(8);
    const hdr = Buffer.from(`${JSON.stringify({version: 1, cipher: "AES-256-GCM", chunk_size: 16777216, base_nonce: [...base]})}\n`);
    const nonce = Buffer.concat([base, Buffer.alloc(4)]);
    const c = createCipheriv("aes-256-gcm", key, nonce);
    const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4); len.writeUInt32BE(ct.length);
    return Buffer.concat([hdr, len, ct]);
}
export const gz = (b: Buffer) => gzipSync(b);
