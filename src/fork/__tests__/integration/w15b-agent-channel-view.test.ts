import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {enrolAgent} from "@/fork/agent-channel/admin";
import {decodeBundle} from "@/fork/agent-channel/bundle";
import type {ChannelDeps} from "@/fork/agent-channel/deps";
import {requestCredentialRotation} from "@/fork/agent-channel/maint";
import {enqueueTask} from "@/fork/agent-channel/tasks";
import {loadAgentChannelView} from "@/fork/agent-channel/view";
import {freshForkDb, seedAgent, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

/** The admin page's read model never carries a secret: strict DTO (W15b). */
let t: W04Db; let pool: Pool; let kek: string;
const key = testKeypair(); const PASSWORD = `pw-${randomUUID()}`;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = mkdtempSync(path.join(tmpdir(), "w15b-view-kek-")); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });

describe("loadAgentChannelView", () => {
    it("lists agents (enrolled or not), counts rotation state, and contains no credential, hash, task key, envelope, signature or payload", async () => {
        const org = await seedOrg(pool);
        const admin = randomUUID();
        await pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'a',$2,true,'admin')`, [admin, `${admin}@t.test`]);
        const {hashPassword} = await import("better-auth/crypto");
        await pool.query(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), admin, admin, await hashPassword(PASSWORD)]);
        const d: ChannelDeps = {db: t.db, principal: {userId: admin, systemRole: "admin", memberships: []}, kekDir: kek, serverUrl: () => "https://dash.example.test",
            env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: false, FORK_AGENT_TASK_TTL_MINUTES: 10, FORK_AGENT_LEASE_SECONDS: 60}),
            keys: {master: async () => Buffer.alloc(32), signing: async () => ({privateKeyPem: key.privateKey, publicKeyPem: key.publicKey})}, configAllowed: async () => true};
        const plain = await seedAgent(pool, org);
        const enrolledId = await seedAgent(pool, org);
        const r = await enrolAgent(d, {agentId: enrolledId, password: PASSWORD});
        if (!r.ok) throw new Error(r.code);
        const bundle = decodeBundle(r.bundle);
        await pool.query("update fork_agent_enrollment set capabilities=$1 where agent_id=$2", [["channel.v1", "noop.v1", "channel-maint.v1"], enrolledId]);
        await enqueueTask(d, {agentId: enrolledId, type: "noop", payload: {echo: "CANARY-VIEW-ECHO"}});
        const rot = await requestCredentialRotation(d, {agentId: enrolledId, password: PASSWORD});
        expect(rot.ok).toBe(true);
        const hashes = (await pool.query("select credential_hash, pending_credential_hash, task_key_enc from fork_agent_enrollment where agent_id=$1", [enrolledId])).rows[0];
        const sig = (await pool.query("select signature, envelope_text, payload_enc from fork_agent_task where agent_id=$1 limit 1", [enrolledId])).rows[0];

        const view = await loadAgentChannelView(t.db, {signingPublicKeyPem: key.publicKey});
        const json = JSON.stringify(view);
        const rows = Object.fromEntries(view.agents.map((a) => [a.id, a]));
        expect(rows[plain]).toMatchObject({enrolled: false, enabled: false, canMaint: false, recentTasks: [], rotation: "none"});
        expect(rows[enrolledId]).toMatchObject({enrolled: true, enabled: true, revoked: false, canMaint: true, rotation: "pending", pinnedKids: [r.kid]});
        expect(rows[enrolledId].recentTasks.map((x) => x.type).sort()).toEqual(["noop", "rotate_credential"]);
        expect(view.signingKid).toBe(r.kid);
        // forbidden names and values
        for (const name of ["credential_hash", "credentialHash", "pending_credential", "pendingCredential", "task_key", "taskKey", "envelope", "signature", "payload", "bundle"]) expect(json).not.toContain(name);
        for (const secret of [hashes.credential_hash, hashes.pending_credential_hash, bundle.task_key_b64, bundle.credential, bundle.credential.split(".")[2], sig.signature, sig.envelope_text, sig.payload_enc, "CANARY-VIEW-ECHO", "BEGIN PUBLIC KEY"]) expect(json).not.toContain(secret);
        expect(JSON.stringify(hashes.task_key_enc)).not.toBe("null");
        expect(json.replaceAll(r.pinFingerprint, "")).not.toMatch(/[A-Za-z0-9_-]{43}/); // no credential-shaped secret anywhere (the public key fingerprint is hex and shown on purpose)
    });
});
