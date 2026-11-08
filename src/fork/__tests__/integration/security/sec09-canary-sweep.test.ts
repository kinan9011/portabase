import {randomBytes, randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {eq} from "drizzle-orm";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {Pool} from "pg";
import {enrolAgent} from "@/fork/agent-channel/admin";
import {decodeBundle} from "@/fork/agent-channel/bundle";
import {enqueueTask, leaseTask, submitResult} from "@/fork/agent-channel/tasks";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {getRestoreOverridesView, setRestoreOverrides, type OverrideDeps} from "@/fork/config/service";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import {beginKitGeneration, generateKitArtifact, type KitDeps} from "@/fork/kit/service";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {getRestorePlanView} from "@/fork/restore/service";
import {listRestoreRuns} from "@/fork/restore-run/view";
import {getTestRestoreView} from "@/fork/test-restore/view";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {adminUser, approveRestorePlan, createRestorePlan, deps as chDeps, newKek, P, PASSWORD, req, seedW17World} from "@/fork/__tests__/w17-world";
import {assertNoCanary, captureOutput, dumpForkTables, findCanary, makeCanaries} from "../../security/canary";

/**
 * SEC-09 canary sweep (plan D-9): per-run canaries planted at every secret input the fork accepts, the main services driven, then EVERY sink scanned in raw / base64 / base64url / hex / URL-encoded form:
 * all `fork_%` tables (a table added later is covered automatically), the audit rows, the outbox, the view payloads ("browser"), captured console + stdout/stderr.
 * ALLOWED EXCEPTIONS (plaintext in a sink) — none, except what is listed here with a reason:
 *   - the one-time enrol bundle and the one-time kit artifact RETURN VALUES (that is their purpose); they are NOT scanned as sinks, but must not appear anywhere else.
 *   - `fork_agent_task.result` is DENYLIST-redacted (keys/patterns), not allow-listed: free-form text under a non-sensitive key survives. Residual F-23 (ADR-005 §13); the canary below is
 *     therefore planted in the forms the redactor is specified for (sensitive key, Bearer, URL userinfo, ?token=), which MUST be scrubbed.
 * Other canary coverage that already exists and is cited, not repeated: w07-canary (hostile Arcane fixture → inventory), w15 (bundle), w13 (notification render), wtr T9, w17live N14 (host process canary).
 */
let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string;
const key = testKeypair(); const master = randomBytes(32);
const t0 = new Date();
const c = makeCanaries();

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); process.env.PRIVATE_PATH = kek; org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); delete process.env.PRIVATE_PATH; });

describe("SEC-09 canary sweep", () => {
    it("no planted secret reaches any fork table, audit row, view payload, log line or stdout/stderr", async () => {
        const out = captureOutput();
        const payloads: string[] = [];
        let enrolBundle = ""; let kitArtifact = "";
        try {
            resetRateLimits();
            const w = await seedW17World(t, kek, key, admin, {org, caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"]});
            const adminP = P(admin, "user", [org, "admin"]);

            // 1. Arcane key → encrypted connection (the key is only in the input)
            await insertConnectionWithSecret(t.db, {organizationId: org, name: "arcane-sweep", baseUrl: "http://127.0.0.1:9", apiKey: `arc_FAKEPFX1_${c.arcaneKey}`}, kek);

            // 2. storage credentials live in the UPSTREAM storage_channel config; the fork must never copy them
            await pool.query("insert into storage_channel (organization_id, provider, name, config, enabled) values ($1,'s3','sweep-s3',$2,true)", [org, JSON.stringify({endpoint: "https://s3.example.test", accessKey: "AKIASWEEP", secretKey: c.storageSecret})]);

            // 3. plan + restore overrides (env value, override value, override file)
            const clock = {now: () => t0};
            const plan = await createRestorePlan({db: t.db, principal: adminP, configAllowed: async () => true, ...clock}, req(w, {mode: "new_stack", mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: ["dir:/srv/app", "volume:app_data", "db:db"], sqlite: null}}));
            if (!plan.ok) throw new Error(`plan refused: ${plan.code}`);
            for (const kind of ["production_target", "destructive_replace"] as const) await approveRestorePlan({db: t.db, principal: P(admin, "admin"), configAllowed: async () => true, ...clock}, {planId: plan.planId, planHash: plan.planHash, kind});
            const od: OverrideDeps = {db: t.db, principal: adminP, kekDir: kek, now: () => t0, configAllowed: async () => true};
            const id = {planId: plan.planId, planHash: plan.planHash};
            const setR = await setRestoreOverrides(od, {...id, set: [{service: "web", key: "A", value: c.envValue}], overrideYml: `services:\n  web:\n    labels:\n      note: ${c.overrideValue}\n    environment:\n      FILE_VALUE: ${c.overrideFile}\n`});
            expect(setR, "overrides were really planted").toMatchObject({ok: true});
            payloads.push(JSON.stringify(setR), JSON.stringify(await getRestoreOverridesView(od, id)));

            // 4. agent channel: enrol (bundle returned ONCE), enqueue, lease, a failed result carrying the secret in every shape the redactor knows
            const sysDeps = chDeps(t, kek, key, admin, {role: "admin", now: () => t0});
            const agentId = w.agent;
            const enr = await enrolAgent(sysDeps, {agentId, password: PASSWORD, reenroll: true});
            if (!enr.ok) throw new Error(`enrol: ${enr.code}`);
            enrolBundle = enr.bundle;
            c.agentSecret = decodeBundle(enr.bundle).credential.split(".")[2]!;
            await pool.query("update fork_agent_enrollment set capabilities=$2 where agent_id=$1", [agentId, ["channel.v1", "noop.v1", "plaintext-hash.v1"]]);
            const q = await enqueueTask(sysDeps, {agentId, type: "noop", payload: {echo: "sweep"}});
            if (!q.ok) throw new Error(`enqueue: ${q.code}`);
            const [enrollment] = await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId));
            const leased = await leaseTask(t.db, enrollment!, {capabilities: ["channel.v1", "noop.v1"], leaseSeconds: 60, now: t0});
            const leaseId = (leased as {lease_id?: string; lease?: {id: string}} | null)?.lease_id ?? (leased as {lease?: {id: string}} | null)?.lease?.id;
            expect(leaseId, "the task was really leased").toBeTruthy();
            const res = await submitResult(t.db, enrollment!, {taskId: q.taskId, organizationId: org, now: t0, body: {
                lease_id: leaseId, status: "failed", reason: "unsupported_type",
                result: {api_key: c.resultText, token: c.resultText, nested: {password: c.resultText}, header: `Authorization: Bearer ${c.resultText}`, url: `https://user:${c.resultText}@host.invalid/x?token=${c.resultText}&ok=1`},
            }});
            expect(res, "the result was really stored").toMatchObject({ok: true});
            payloads.push(JSON.stringify(res), JSON.stringify(leased));

            // 5. recovery kit: step-up password → one-time token → digital kit protected by the passphrase canary
            const kd: KitDeps = {db: t.db, principal: {userId: admin, systemRole: "admin", memberships: [{organizationId: org, role: "owner"}]}, kekDir: kek, now: () => t0,
                keys: {master: async () => master, signing: async () => ({privateKeyPem: key.privateKey, publicKeyPem: key.publicKey})}, assertConfigAllowed: async () => undefined, nonce: () => "SWEEPNONCE"};
            const b = await beginKitGeneration(kd, {types: ["digital"], password: PASSWORD});
            if (!b.ok) throw new Error(`kit begin: ${b.code}`);
            const g = await generateKitArtifact(kd, {kind: "digital", token: b.tokens.digital, passphrase: c.kitPassphrase, passphraseConfirm: c.kitPassphrase});
            expect(g, "the kit was really generated").toMatchObject({ok: true});
            kitArtifact = JSON.stringify(g);
            payloads.push(JSON.stringify({...g, body: "<kit>"}));

            // 6. the read models a browser would receive
            const rd = {db: t.db, principal: adminP, keys: {master: async () => master, signing: async () => ({privateKeyPem: key.privateKey, publicKeyPem: key.publicKey})}, serverUrl: () => "https://dash.sweep.test", kekDir: kek, now: () => t0} as never;
            payloads.push(JSON.stringify(await getRestorePlanView({db: t.db, principal: adminP, configAllowed: async () => true, now: () => t0}, {planId: plan.planId})));
            payloads.push(JSON.stringify(await listRestoreRuns(rd, {stackId: w.stack})));
            payloads.push(JSON.stringify(await getTestRestoreView({db: t.db, principal: adminP, now: () => t0} as never, {stackId: w.stack})));
        } finally { out.restore(); }

        // ---- sinks
        const sinks: Record<string, string> = {
            "fork_% tables (all, incl. audit, outbox, tasks, inventory)": await dumpForkTables(pool),
            "view / action payloads": payloads.join("\n"),
            "console + stdout/stderr": out.text(),
        };
        const planted = {...c};
        for (const [where, text] of Object.entries(sinks)) assertNoCanary(text, planted, where);
        // the one-time artifacts may carry only what they are for: the kit must not contain its own passphrase, the bundle not the storage / override canaries
        assertNoCanary(kitArtifact, {kitPassphrase: c.kitPassphrase, arcaneKey: c.arcaneKey, storageSecret: c.storageSecret}, "kit artifact");
        assertNoCanary(enrolBundle, {envValue: c.envValue, overrideValue: c.overrideValue, storageSecret: c.storageSecret, arcaneKey: c.arcaneKey}, "enrol bundle");
        // sanity: the scanner finds what it should (a canary pasted into a sink is detected in every encoding)
        for (const form of [c.envValue, Buffer.from(c.envValue).toString("base64"), Buffer.from(c.envValue).toString("hex"), encodeURIComponent(c.envValue)]) expect(findCanary(`x ${form} y`, {envValue: c.envValue}).length, form).toBeGreaterThan(0);
        void randomUUID;
    }, 120_000);
});
