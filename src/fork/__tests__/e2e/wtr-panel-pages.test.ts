import {randomBytes} from "node:crypto";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, describe, expect, it} from "vitest";
import {ADMIN, type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {seedWorld, type World} from "@/fork/__tests__/w16-world";
import type {ForkDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {runTestRestoreNow, setTestRestoreSchedule} from "@/fork/test-restore/service";
import type {TestRestoreDeps} from "@/fork/test-restore/deps";
import {DEFAULT_TR_SCHEDULE} from "@/fork/test-restore/vocab";
import {FACET_COPY} from "@/fork/ui/labels";
import {TR} from "@/fork/ui/stacks/test-restore/labels";

/**
 * W-TR-f e2e on the REAL production build (no agents, no docker, runs in CI): the Schedule-tab test-restore panel over HTTP with the real proxy, session and boot sequence.
 * The finished run is made by the real services (schedule + run now) and then settled in SQL (all times from the DB `now()`: nothing compares a fixture date with the real clock).
 * Canaries: the restore folder is an admin-only value (OD-WTRF-2); the scratch workspace path, the agent id (for members), enrolment secrets and the project secret never reach HTML or RSC.
 */
const MEMBER = {email: "member@wtrf.test", password: "Wtrf-member-Password!1", name: "Member"};
const ORGADMIN = {email: "orgadmin@wtrf.test", password: "Wtrf-orgadmin-Password!1", name: "Org Admin"};
const CANARY_ROOT = `/srv/wtrf-${randomBytes(6).toString("hex")}`;
const CANARY_CRED = randomBytes(32).toString("hex");
const CANARY_PIN = `CANARY_PIN_${randomBytes(8).toString("hex")}`;
const PROJECT_SECRET = "w01-e2e-secret-not-a-real-secret-0123456789"; // the value `boot()` gives the server

const login = async (base: string, u: {email: string; password: string}) => {
    const r = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({email: u.email, password: u.password})});
    expect(r.status, await r.clone().text()).toBe(200);
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};
const rsc = (base: string, p: string, cookie: string) => fetch(`${base}${p}`, {headers: {cookie, RSC: "1"}}).then((r) => r.text());
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

let first: App | undefined; let second: App | undefined; let third: App | undefined;
afterAll(async () => { await third?.stop(); await second?.stop(); await first?.stop(); await first?.db.drop().catch(() => {}); });

describe("W-TR-f test-restore panel (real build)", () => {
    it("admin and member see the finished run with its duration; the restore folder is admin-only; no scratch path, agent id (member) or secret in HTML / RSC; flags off ⇒ 404", async () => {
        const priv = mkdtempSync(path.join(os.tmpdir(), "wtrf-priv-"));
        mkdirSync(path.join(priv, "keys"), {recursive: true}); writeFileSync(path.join(priv, "keys", "master_key.bin"), randomBytes(32), {mode: 0o600});
        process.env.PRIVATE_PATH = priv; process.env.PROJECT_URL ??= "http://wtrf-e2e.localhost"; process.env.PROJECT_SECRET ??= PROJECT_SECRET;
        const flags = {FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false", FORK_RESTORE_TICK_SECONDS: "0", FORK_TEST_RESTORE_TICK_SECONDS: "0", PRIVATE_PATH: priv};
        // ---- boot 1 (flags off): database, default org + admin, two plain accounts
        first = await boot({PRIVATE_PATH: priv}, [], undefined, true);
        for (const u of [MEMBER, ORGADMIN]) {
            const up = await fetch(`${first.base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: first.base}, body: JSON.stringify(u)});
            expect(up.status, await up.clone().text()).toBeLessThan(300);
            await first.db.pool.query(`update "user" set role = 'user' where email = $1`, [u.email]);
        }
        const pool = first.db.pool;
        const q = (s: string, p: unknown[] = []) => pool.query(s, p);
        const db = drizzle({client: pool}) as unknown as ForkDb;
        const org = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const userId = async (email: string) => (await q(`select id from "user" where email = $1`, [email])).rows[0].id as string;
        const [memberId, orgAdminId, adminUid] = [await userId(MEMBER.email), await userId(ORGADMIN.email), await userId(ADMIN.email)];
        const adminRow = {id: adminUid};
        await q(`delete from member where user_id in ($1,$2,$3)`, [memberId, orgAdminId, adminRow.id]);
        await q("insert into member (organization_id, user_id, role) values ($1,$2,'member'), ($1,$3,'admin'), ($1,$4,'owner')", [org, memberId, orgAdminId, adminRow.id]);
        // ---- seed through the services: a test machine, a verified recovery point, a schedule with the canary restore folder, one run settled as finished
        const w: World = await seedWorld(pool, {org, hostRole: "test", roots: ["/srv"], caps: ["channel.v1", "restore.target.v1", "compose.render.v1", "test-restore.v1"]});
        await q("update fork_stack set contains_personal_data=false where id=$1", [w.stack]);
        await q("update fork_agent_enrollment set credential_hash=$2, pin_fingerprint=$3 where agent_id=$1", [w.agent, CANARY_CRED, CANARY_PIN]);
        const op = {userId: adminRow.id, systemRole: "superadmin" as const, memberships: [{organizationId: org, role: "owner"}]};
        const td = (): TestRestoreDeps => ({db, principal: op, keys: fileKeyProvider, serverUrl: () => "http://wtrf-e2e.localhost", configAllowed: async () => true, stepUp: async () => "ok",
            env: () => ({FORK_ALLOW_INSECURE_LOOPBACK: true, FORK_AGENT_TASK_TTL_MINUTES: 30, FORK_AGENT_LEASE_SECONDS: 60})} as TestRestoreDeps);
        const set = await setTestRestoreSchedule(td(), {stackId: w.stack, enabled: true, schedule: DEFAULT_TR_SCHEDULE, targetAgentId: w.agent, restoreRoot: CANARY_ROOT, staleAfterDays: 14});
        expect(set, JSON.stringify(set)).toEqual({ok: true});
        const run = await runTestRestoreNow(td(), {stackId: w.stack});
        expect(run.ok, JSON.stringify(run)).toBe(true);
        if (!run.ok) return;
        await q(`update fork_restore_run set state='succeeded', verification='data_verified', wipe_state='verified', wipe_finished_at=now(), integrity='{"checked":2,"failed":0,"not_supported":1}'::jsonb,
                 created_at=now() - interval '125 seconds', finished_at=now() where id=$1`, [run.runId]);
        await first.stop(); // keepDb

        // ---- boot 2: flags on, same database
        second = await boot(flags, [], first.db);
        const base = second.base;
        const admin = await signIn(base);
        const memberCk = await login(base, MEMBER);
        const orgAdminCk = await login(base, ORGADMIN);
        const page = `/dashboard/stacks/${w.stack}?tab=schedule`;

        // 1 admin: the panel with the duration, both integrity lines, the wipe line and the run-now control
        const aRes = await get(base, page, admin);
        expect(aRes.status).toBe(200);
        const aHtml = await aRes.text();
        const aText = visible(aHtml);
        for (const x of [TR.heading, FACET_COPY.testRestore.label, "Took 2 min 5 s", "2 databases checked", "1 database not engine-checked", TR.wipe.verified, TR.actions.runNow, TR.last.succeeded]) expect(aText, x).toContain(x);
        expect(aText).not.toContain("Not tested");

        // 2 member: reads the result (with the duration), sees the visible reason, and neither the restore folder nor the agent id reaches HTML or RSC
        const mRes = await get(base, page, memberCk);
        expect(mRes.status).toBe(200);
        const mHtml = await mRes.text();
        const mText = visible(mHtml);
        for (const x of [TR.heading, "Took 2 min 5 s", TR.reasons.member]) expect(mText, x).toContain(x);
        for (const body of [mHtml, await rsc(base, page, memberCk), await rsc(base, `${page}&_rsc=1`, memberCk)]) {
            expect(body.includes(CANARY_ROOT), "member: restore folder").toBe(false);
            expect(body.includes(w.agent), "member: agent id").toBe(false);
        }
        const oText = visible(await (await get(base, page, orgAdminCk)).text());
        expect(oText).toContain(TR.reasons.configure); // an org admin who is not a system admin cannot configure

        // 3 admin RSC: carries the restore folder (the edit form is pre-filled, OD-WTRF-2) but never a path below it (the scratch workspace)
        for (const body of [aHtml, await rsc(base, page, admin)]) {
            expect(body.includes(CANARY_ROOT)).toBe(true);
            expect(body.includes(`${CANARY_ROOT}/`), "admin: scratch workspace path").toBe(false);
        }
        expect((await rsc(base, page, admin)).includes(CANARY_ROOT)).toBe(true);

        // 4 both roles, HTML + RSC: no project secret, no key material, no enrolment credential / pin
        for (const ck of [admin, memberCk]) {
            for (const body of [await (await get(base, page, ck)).text(), await rsc(base, page, ck)]) {
                for (const c of [PROJECT_SECRET, "master_key", CANARY_CRED, CANARY_PIN, priv]) expect(body.includes(c), `leaks ${c.slice(0, 12)}`).toBe(false);
            }
        }

        // 5 flags off on the same database ⇒ the real 404
        await second.stop(); second = undefined;
        third = await boot({PRIVATE_PATH: priv}, [], first.db);
        const off = await signIn(third.base);
        expect((await get(third.base, page, off)).status).toBe(404);
    }, 900_000);
});
