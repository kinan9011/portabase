import {randomBytes, randomUUID} from "node:crypto";
import {mkdtempSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {insertConnectionWithSecret, readConnectionApiKey} from "@/fork/db/dto";
import {loadKeyring} from "@/fork/kek";
import {ENVELOPE_COLUMNS, reencryptForkSecrets} from "@/fork/kek-rotation";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {rotateKek, type KitDeps} from "@/fork/kit/service";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

let t: W04Db; let pool: Pool; let dir: string; let org: string;
const master = randomBytes(32); const signing = testKeypair(); const PASSWORD = `pw-${randomUUID()}`;
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; dir = mkdtempSync(path.join(tmpdir(), "w14-kek2-")); org = await seedOrg(pool); });
afterAll(async () => { await t?.drop(); rmSync(dir, {recursive: true, force: true}); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const deps = (userId: string, role: string): KitDeps => ({db: t.db, kekDir: dir, principal: {userId, systemRole: role, memberships: []}, now: () => new Date("2026-11-07T12:00:00Z"),
    keys: {master: async () => master, signing: async () => ({privateKeyPem: signing.privateKey, publicKeyPem: signing.publicKey})}, assertConfigAllowed: async () => undefined});
async function user(role: string) {
    const id = randomUUID();
    await pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,$2,$3,true,$4)`, [id, role, `${id}@t.test`, role]);
    const {hashPassword} = await import("better-auth/crypto");
    await pool.query(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), id, id, await hashPassword(PASSWORD)]);
    return id;
}

describe("KEK rotation + re-encrypt (ADR-013 §4)", () => {
    it("moves every envelope to the new key, keeps the old key, verifies by decrypting, audits codes only; a non-admin and a wrong password cannot rotate", async () => {
        resetRateLimits();
        const conns = [];
        for (let i = 0; i < 3; i++) conns.push(await insertConnectionWithSecret(t.db, {organizationId: org, name: `c${i}`, baseUrl: "https://a.lab", apiKey: `KEY-TEST-ONLY-${i}`}, dir));
        const before = await loadKeyring(dir);
        const oldKid = before?.active as string;
        expect((await q("select api_key_enc->>'kid' kid from fork_arcane_connection")).every((r) => r.kid === oldKid)).toBe(true);

        expect(await rotateKek(deps(await user("user"), "user"), {password: PASSWORD})).toMatchObject({ok: false, code: "forbidden"});
        const admin = await user("admin");
        expect(await rotateKek(deps(admin, "admin"), {password: "wrong"})).toMatchObject({ok: false, code: "step_up_failed"});
        expect(readdirSync(dir).filter((f) => f.endsWith(".key"))).toHaveLength(1); // nothing rotated yet

        const r = await rotateKek(deps(admin, "admin"), {password: PASSWORD});
        expect(r).toMatchObject({ok: true, moved: 3, failed: 0});
        const after = await loadKeyring(dir);
        expect(after?.active).not.toBe(oldKid);
        expect(after?.keys.has(oldKid)).toBe(true); // the old key is KEPT (kit still opens old data; operator retires it deliberately)
        expect((await q("select api_key_enc->>'kid' kid from fork_arcane_connection")).every((x) => x.kid === after?.active)).toBe(true);
        for (let i = 0; i < 3; i++) expect(await readConnectionApiKey(t.db, org, conns[i].id, dir)).toBe(`KEY-TEST-ONLY-${i}`);
        const audit = JSON.stringify(await q("select * from fork_audit_event where action = 'fork.kek.rotate'"));
        expect(audit).toContain('"moved":3'); expect(audit).not.toContain("KEY-TEST-ONLY"); expect(audit).not.toContain(PASSWORD);
        // idempotent
        expect(await reencryptForkSecrets(t.db, dir)).toEqual({rows: 3, moved: 0, failed: 0});
    });

    it("a row that cannot be decrypted is left untouched and counted (never overwritten, never silently dropped)", async () => {
        const c = await insertConnectionWithSecret(t.db, {organizationId: org, name: "swap", baseUrl: "https://a.lab", apiKey: "KEY-TEST-ONLY-X"}, dir);
        const other = await insertConnectionWithSecret(t.db, {organizationId: org, name: "other", baseUrl: "https://a.lab", apiKey: "KEY-TEST-ONLY-Y"}, dir);
        // row/column swapping (the AAD threat): copy the envelope of `other` onto `swap`
        await pool.query("update fork_arcane_connection set api_key_enc = (select api_key_enc from fork_arcane_connection where id=$1) where id=$2", [other.id, c.id]);
        const {rotateForkKek} = await import("@/fork/kek");
        await rotateForkKek(dir);
        const r = await reencryptForkSecrets(t.db, dir);
        expect(r.failed).toBe(1);
        expect(r.moved).toBeGreaterThanOrEqual(1);
        await expect(readConnectionApiKey(t.db, org, c.id, dir)).rejects.toThrow();
    });

    it("the registry lists every fork-KEK envelope column (no `_enc` column can be forgotten)", async () => {
        const cols = await q("select table_name, column_name from information_schema.columns where table_schema='public' and table_name like 'fork\\_%' and column_name like '%\\_enc'");
        const registered = new Set(ENVELOPE_COLUMNS.map((c) => `${c.table}.${c.column}`));
        for (const c of cols) expect(registered.has(`${c.table_name}.${c.column_name}`), `${c.table_name}.${c.column_name}`).toBe(true);
    });
});
