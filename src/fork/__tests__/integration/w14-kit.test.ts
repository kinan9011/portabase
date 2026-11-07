import {randomBytes, randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {rotateForkKek} from "@/fork/kek";
import {ForkLockedError} from "@/fork/mode";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {confirmKitFingerprint, beginKitGeneration, generateKitArtifact, isKitVerified, loadKitView, type KitDeps} from "@/fork/kit/service";
import {watchKit} from "@/fork/kit/watch";
import {unwrapDigitalKit} from "@/fork/kit/digital";
import {freshForkDb, seedConnection, seedEnvironment, seedOrg, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

let t: W04Db; let pool: Pool; let kekDir: string; let orgId: string;
const master = randomBytes(32); // TEST-ONLY, per run
let signing = testKeypair();
const PASSWORD = `pw-${randomUUID()}`; // TEST-ONLY
const PASSPHRASE = `Pass-${randomUUID().slice(0, 12)}-Z9!`;
beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool; kekDir = mkdtempSync(path.join(tmpdir(), "w14-kek-"));
    orgId = await seedOrg(pool);
});
afterAll(async () => { await t?.drop(); rmSync(kekDir, {recursive: true, force: true}); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];

async function mkUser(role: string) {
    const id = randomUUID();
    await pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,$2,$3,true,$4)`, [id, role, `${id}@t.test`, role]);
    const {hashPassword} = await import("better-auth/crypto");
    await pool.query(`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$3,$4,now(),now())`, [randomUUID(), id, id, await hashPassword(PASSWORD)]);
    return id;
}
const deps = (userId: string | null, role: string | null, o: Partial<KitDeps> = {}): KitDeps => ({
    db: t.db, principal: userId ? {userId, systemRole: role, memberships: [{organizationId: orgId, role: "owner"}]} : null, kekDir, now: () => new Date("2026-11-07T12:00:00Z"),
    keys: {master: async () => master, signing: async () => ({privateKeyPem: signing.privateKey, publicKeyPem: signing.publicKey})},
    assertConfigAllowed: async () => undefined, nonce: () => "TESTNONCE", ...o,
});
async function generate(d: KitDeps, kind: "paper" | "digital", pass = PASSPHRASE) {
    const b = await beginKitGeneration(d, {types: [kind], password: PASSWORD});
    if (!b.ok) throw new Error(`begin refused: ${b.code}`);
    return generateKitArtifact(d, {kind, token: b.tokens[kind], ...(kind === "digital" ? {passphrase: pass, passphraseConfirm: pass} : {})});
}

describe("kit: who may generate (system admin only, step-up, audited)", () => {
    it("role matrix: org owner / member / user / unsigned / system admin without the password / locked mode", async () => {
        resetRateLimits();
        const admin = await mkUser("admin"); const user = await mkUser("user");
        for (const [u, role] of [[user, "user"], [null, null]] as const) {
            const r = await beginKitGeneration(deps(u, role), {types: ["paper"], password: PASSWORD});
            expect(r).toMatchObject({ok: false, code: "forbidden"});
        }
        expect(await beginKitGeneration(deps(admin, "admin"), {types: ["paper"], password: "wrong"})).toMatchObject({ok: false, code: "step_up_failed"});
        const locked = deps(admin, "admin", {assertConfigAllowed: async () => { throw new ForkLockedError("locked", "self-check-failed"); }});
        expect(await beginKitGeneration(locked, {types: ["paper"], password: PASSWORD})).toMatchObject({ok: false, code: "locked"});
        expect(await beginKitGeneration(deps(admin, "admin"), {types: [], password: PASSWORD})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await beginKitGeneration(deps(admin, "admin"), {types: ["paper"], password: PASSWORD, extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
        const audits = await q("select action, result, redacted_details from fork_audit_event where action = 'fork.kit.step_up' order by seq");
        expect(audits.filter((a) => a.result === "denied").length).toBe(3); // user, wrong password, locked (an unsigned caller has no identity to audit)
        expect(JSON.stringify(audits)).not.toContain(PASSWORD);
        expect((await q("select count(*)::int c from fork_kit"))[0].c).toBe(0); // nothing was generated
    });

    it("an account without a password (SSO/passkey only) is refused with a plain reason", async () => {
        resetRateLimits();
        const id = randomUUID();
        await pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'sso',$2,true,'admin')`, [id, `${id}@t.test`]);
        expect(await beginKitGeneration(deps(id, "admin"), {types: ["paper"], password: "x"})).toMatchObject({ok: false, code: "no_password"});
    });

    it("step-up is rate limited (5 wrong attempts) and the grant is single-use, per kind, user-bound", async () => {
        resetRateLimits();
        const admin = await mkUser("admin"); const other = await mkUser("admin");
        let last: unknown;
        for (let i = 0; i < 6; i++) last = await beginKitGeneration(deps(admin, "admin"), {types: ["paper"], password: "nope"});
        expect(last).toMatchObject({ok: false, code: "rate_limited"});
        resetRateLimits();
        const b = await beginKitGeneration(deps(admin, "admin"), {types: ["paper", "digital"], password: PASSWORD});
        if (!b.ok) throw new Error("begin");
        // another admin cannot spend it; a different kind cannot spend it
        expect(await generateKitArtifact(deps(other, "admin"), {kind: "paper", token: b.tokens.paper})).toMatchObject({ok: false, code: "token_invalid"});
        expect(await generateKitArtifact(deps(admin, "admin"), {kind: "digital", token: b.tokens.paper, passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE})).toMatchObject({ok: false, code: "token_invalid"});
        const ok = await generateKitArtifact(deps(admin, "admin"), {kind: "paper", token: b.tokens.paper});
        expect(ok).toMatchObject({ok: true, kind: "paper", contentType: "text/html; charset=utf-8"});
        expect(await generateKitArtifact(deps(admin, "admin"), {kind: "paper", token: b.tokens.paper})).toMatchObject({ok: false, code: "token_invalid"}); // single use
        // expired
        const late = deps(admin, "admin", {now: () => new Date("2026-11-07T12:06:00Z")});
        expect(await generateKitArtifact(late, {kind: "digital", token: b.tokens.digital, passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE})).toMatchObject({ok: false, code: "token_invalid"});
        // only the hash is stored
        expect(JSON.stringify(await q("select * from fork_kit_token"))).not.toContain(b.tokens.paper);
    });
});

describe("kit: generation, stored fingerprint, fingerprint entry (D41), key canary", () => {
    it("paper + digital are generated, ONE issue row stores the verification code; the code is neither on the kit nor in any response; the digital kit opens with the passphrase", async () => {
        resetRateLimits();
        const admin = await mkUser("admin");
        const d = deps(admin, "admin");
        const paper = await generate(d, "paper");
        const digital = await generate(d, "digital");
        if (!paper.ok || paper.kind !== "paper" || !digital.ok || digital.kind !== "digital") throw new Error("generation failed");
        const kits = await q("select * from fork_kit where superseded_at is null");
        expect(kits).toHaveLength(1);
        expect(kits[0]).toMatchObject({status: "issued", verified_at: null});
        expect([...kits[0].types].sort()).toEqual(["digital", "paper"]);
        expect(kits[0].fingerprint).toMatch(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
        const code = kits[0].fingerprint as string;
        for (const out of [paper.body, digital.body, JSON.stringify(paper), JSON.stringify(digital)]) { expect(out).not.toContain(code); expect(out).not.toContain(code.replace(/-/g, "")); }
        const kit = unwrapDigitalKit(digital.body, PASSPHRASE);
        expect(Buffer.from(kit.master_key_b64, "base64")).toEqual(master);
        expect(kit.signing_public_keys[0].kid).toBe(signing.kid);
        expect(kit.kek.keys.length).toBeGreaterThanOrEqual(1);
        expect(digital.filename).toMatch(/^portabase-recovery-kit-2026-11-07\.pbkit$/);
        // CANARY: no key material, passphrase, password or code anywhere in the audit chain, outbox or kit tables
        const everything = JSON.stringify([await q("select * from fork_audit_event"), await q("select * from fork_notification_outbox"), await q("select * from fork_trust_anchor")]);
        for (const secret of [master.toString("base64"), master.toString("hex"), PASSPHRASE, PASSWORD, signing.privateKey, ...kit.kek.keys.map((k) => k.key_b64)]) expect(everything).not.toContain(secret);
        expect(everything).not.toContain(code); // the verification code is not in the audit chain / outbox either (it lives only in fork_kit)
        expect((await q("select action, result, redacted_details from fork_audit_event where action='fork.kit.generate' and result='success'")).length).toBeGreaterThanOrEqual(2);
        // weak passphrase never burns the grant and is audited without the passphrase
        const b = await beginKitGeneration(d, {types: ["digital"], password: PASSWORD});
        if (!b.ok) throw new Error("begin");
        expect(await generateKitArtifact(d, {kind: "digital", token: b.tokens.digital, passphrase: "short", passphraseConfirm: "short"})).toMatchObject({ok: false, code: "weak_passphrase"});
        expect(await generateKitArtifact(d, {kind: "digital", token: b.tokens.digital, passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE})).toMatchObject({ok: true});
    });

    it("until the code is entered: kit NOT verified (fails closed); wrong code ⇒ refused, counted, locked after 5; right code ⇒ verified on <date>, type", async () => {
        resetRateLimits();
        const admin = await mkUser("admin");
        const d = deps(admin, "admin");
        expect(await isKitVerified(t.db)).toBe(false);
        const [{fingerprint}] = await q("select fingerprint from fork_kit where superseded_at is null");
        // a raw key is never accepted, and never echoed
        const asKey = await confirmKitFingerprint(d, {fingerprint: master.toString("base64"), type: "paper"});
        expect(asKey).toMatchObject({ok: false, code: "never_type_key"});
        expect(JSON.stringify(asKey)).not.toContain(master.toString("base64"));
        expect(await confirmKitFingerprint(d, {fingerprint: "12", type: "paper"})).toMatchObject({ok: false, code: "invalid_input"});
        for (let i = 0; i < 4; i++) expect(await confirmKitFingerprint(d, {fingerprint: "0000-0000-0000-0000-0000", type: "paper"})).toMatchObject({ok: false, code: "wrong_code"});
        expect(await confirmKitFingerprint(d, {fingerprint: "0000-0000-0000-0000-0000", type: "paper"})).toMatchObject({ok: false, code: "code_locked"});
        expect(await confirmKitFingerprint(d, {fingerprint, type: "paper"})).toMatchObject({ok: false, code: "code_locked"}); // even the right one while locked
        expect(await isKitVerified(t.db)).toBe(false);
        const later = deps(admin, "admin", {now: () => new Date("2026-11-07T12:20:00Z")});
        const ok = await confirmKitFingerprint(later, {fingerprint: fingerprint.toLowerCase().replace(/-/g, " "), type: "paper"});
        expect(ok).toMatchObject({ok: true, type: "paper"});
        expect(await isKitVerified(t.db, new Date("2026-11-07T12:21:00Z"))).toBe(true);
        expect(await loadKitView(t.db, new Date("2026-11-07T12:21:00Z"))).toMatchObject({state: "verified", verifiedType: "paper", types: expect.arrayContaining(["paper", "digital"])});
        // re-prompt every 12 months (§4.2)
        expect(await isKitVerified(t.db, new Date("2027-11-08T12:00:00Z"))).toBe(false);
        expect((await loadKitView(t.db, new Date("2027-11-08T12:00:00Z"))).state).toBe("stale");
        // a non-admin cannot enter the code either
        expect(await confirmKitFingerprint(deps(await mkUser("user"), "user"), {fingerprint, type: "paper"})).toMatchObject({ok: false, code: "forbidden"});
    });

    it("KEY ROTATION: the watch marks the kit stale, queues ONE kit.key_rotated per active stack (deduped), entry of the old code is refused until a new kit is generated", async () => {
        resetRateLimits();
        const admin = await mkUser("admin");
        // an active-policy stack so the notification has a target
        const stackId = await seedStack(pool, orgId, await seedEnvironment(pool, await seedConnection(pool, orgId, "kitc")));
        await pool.query("insert into fork_stack_policy (stack_id, activated_at) values ($1, now())", [stackId]);
        const wd = {db: t.db, keys: deps(admin, "admin").keys, kekDir, now: () => new Date("2026-11-07T13:00:00Z"), unverifiedHours: 24};
        expect((await watchKit(wd)).state).toBe("verified");
        await rotateForkKek(kekDir);
        const r = await watchKit(wd);
        expect(r).toMatchObject({state: "stale", staleNow: true, queued: 1});
        expect((await watchKit(wd)).queued).toBe(0);
        const rows = await q("select kind, dedupe_key, payload from fork_notification_outbox where kind='kit.key_rotated'");
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0].payload).sort()).toEqual(["link", "stackId"]);
        expect(await isKitVerified(t.db, new Date("2026-11-07T13:00:00Z"))).toBe(false);
        const [{fingerprint}] = await q("select fingerprint from fork_kit where superseded_at is null");
        expect(await confirmKitFingerprint(deps(admin, "admin"), {fingerprint, type: "paper"})).toMatchObject({ok: false, code: "stale_kit"});
        // a new kit covers the rotated keyring: new issue row, old superseded, still unverified
        await generate(deps(admin, "admin"), "paper");
        const cur = await q("select status, kek_kids from fork_kit where superseded_at is null");
        expect(cur).toHaveLength(1); expect(cur[0]).toMatchObject({status: "issued"}); expect(cur[0].kek_kids.length).toBe(2);
        expect((await q("select count(*)::int c from fork_kit"))[0].c).toBe(2);
    });

    it("kit.unverified is queued once per stack per epoch after FORK_KIT_UNVERIFIED_HOURS (also when no kit exists)", async () => {
        const t2 = await freshForkDb();
        try {
            const org = await seedOrg(t2.pool);
            const s = await seedStack(t2.pool, org, await seedEnvironment(t2.pool, await seedConnection(t2.pool, org, "kitc2")));
            await t2.pool.query("insert into fork_stack_policy (stack_id, activated_at) values ($1, $2)", [s, new Date("2026-11-05T00:00:00Z")]);
            const wd = {db: t2.db, keys: deps(null, null).keys, kekDir, now: () => new Date("2026-11-07T00:00:00Z"), unverifiedHours: 24};
            expect(await watchKit(wd)).toMatchObject({state: "none", queued: 1});
            expect(await watchKit(wd)).toMatchObject({queued: 0});
            expect(await watchKit({...wd, unverifiedHours: 24 * 30})).toMatchObject({queued: 0}); // not yet due
        } finally { await t2.drop(); }
    });
});
