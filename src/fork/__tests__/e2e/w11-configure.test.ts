import {afterAll, describe, expect, it} from "vitest";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {contentHash} from "@/fork/inventory/schema";

/**
 * W11 e2e on the REAL production build: the full-page Configure Backup route and the Schedule tab over HTTP with the real proxy + session.
 * Boot 1 (flags off) creates the DB, a member, a stack and channels (one carries a planted secret); boot 2 (flag on) serves the pages;
 * boot 3 (flags off again) proves the flags-off parity of the new route (real 404). The activation itself (a server action) is covered by the
 * integration tests and the live lab run in a real browser.
 */
const MEMBER = {email: "member@w11.test", password: "W11-member-Password!1", name: "Member"};
const CANARY = "CHANNEL-SECRET-CANARY-W11";
const login = async (base: string, u: {email: string; password: string}) => {
    const r = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({email: u.email, password: u.password})});
    expect(r.status, await r.clone().text()).toBe(200);
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

let app: App | undefined;
afterAll(async () => { await app?.stop(); });

describe("W11 Configure Backup (real build)", () => {
    it("admin gets the form (no secret in the HTML/RSC payload), member an explanation, strangers a 404; Schedule tab shows the policy; flags off ⇒ 404", async () => {
        const first = await boot({}, [], undefined, true);
        const up = await fetch(`${first.base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: first.base}, body: JSON.stringify(MEMBER)});
        expect(up.status, await up.clone().text()).toBeLessThan(300);
        await first.db.pool.query(`update "user" set role = 'user' where email = $1`, [MEMBER.email]);
        const q = (s: string, p: unknown[] = []) => first.db.pool.query(s, p);
        const orgId = (await q("select id from organization where deleted_at is null order by created_at limit 1")).rows[0].id as string;
        const memberId = (await q(`select id from "user" where email = $1`, [MEMBER.email])).rows[0].id as string;
        await q(`delete from member where user_id = $1`, [memberId]);
        await q("insert into member (organization_id, user_id, role) values ($1,$2,'member')", [orgId, memberId]);
        const inv = cleanInventory();
        inv.stack.compose_project = "w11-app"; inv.stack.display_name = "w11-app";
        const stackId = (await q("insert into fork_stack (organization_id, environment_name, compose_project, display_name, runtime_state) values ($1,'local','w11-app','w11-app','running') returning id", [orgId])).rows[0].id as string;
        await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [stackId, contentHash(inv), JSON.stringify(inv)]);
        const channelId = (await q("insert into storage_channel (organization_id, provider, name, config, enabled) values ($1,'s3','offsite-e2e',$2,true) returning id", [orgId, JSON.stringify({secretAccessKey: CANARY, bucket: "b"})])).rows[0].id as string;
        await q("delete from settings"); await q("insert into settings (name, encryption) values ('w11', true)");
        const shared = first.db;
        await first.stop();

        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false"}, [], shared, true);
        const base = app.base;
        const admin = await signIn(base);
        const member = await login(base, MEMBER);

        // ---- admin: the full-page form
        const page = await get(base, `/dashboard/stacks/${stackId}/configure`, admin);
        expect(page.status).toBe(200);
        const html = await page.text();
        for (const s of ["Configure backup", "w11-app", "Resources", "Consistency", "Schedule", "Storage", "Review &amp; activate", "Nothing is saved until you press Activate", "offsite-e2e", "Deletable from source host", "not checked", "Select at least one storage channel.", "Activate backup", "Run first backup", "Advanced: custom cron expression"]) expect(html, s).toContain(s);
        expect(html).toContain('aria-disabled="true"');
        expect(html).not.toMatch(/stop \+ copy|quiesce/i);
        expect(html).not.toContain(CANARY); // channel config never reaches the browser (HTML + RSC payload)
        expect(html).not.toContain("secretAccessKey");
        expect(html).not.toMatch(/type="password"/); // no database in this stack: no password field at all

        // ---- details page: Configure is a real link for the admin, a reasoned disabled button for the member
        const det = await (await get(base, `/dashboard/stacks/${stackId}`, admin)).text();
        expect(det).toContain(`href="/dashboard/stacks/${stackId}/configure"`);
        const memberDet = await (await get(base, `/dashboard/stacks/${stackId}`, member)).text();
        expect(memberDet).not.toContain(`/configure"`);
        expect(memberDet).toContain("Only a system administrator configures backups.");

        // ---- member: explained, not shown the form; stranger/missing id: real 404 (no oracle)
        const m = await get(base, `/dashboard/stacks/${stackId}/configure`, member);
        expect(m.status).toBe(200);
        const mh = await m.text();
        expect(mh).toContain("Only a system administrator configures backups");
        expect(mh).not.toContain("offsite-e2e");
        // (the dashboard's loading.tsx makes a page-level notFound() stream as status 200, W08 open point: the answers must be IDENTICAL and show its 404 UI)
        const probes = [] as {status: number; body: string}[];
        for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) { const r = await get(base, `/dashboard/stacks/${id}/configure`, admin); probes.push({status: r.status, body: await r.text()}); }
        expect(new Set(probes.map((a) => a.status)).size).toBe(1);
        for (const a of probes) { expect(a.body).toContain("404"); expect(a.body).not.toContain("w11-app"); expect(a.body).not.toContain("offsite-e2e"); }
        const anon = await get(base, `/dashboard/stacks/${stackId}/configure`);
        expect([307, 308, 302, 404]).toContain(anon.status);

        // ---- Schedule tab: honest empty state, then the activated policy (written directly: the action is covered elsewhere)
        const empty = await (await get(base, `/dashboard/stacks/${stackId}?tab=schedule`, admin)).text();
        expect(empty).toContain("No backup policy yet");
        expect(empty).toContain("Configure backup");
        await shared.pool.query(
            `insert into fork_stack_policy (stack_id, activated_at, activated_by, schedule, policy, storage_channel_ids, consistency_profile) values ($1, now(), 'x', $2, $3, $4, 'crash')`,
            [stackId, JSON.stringify({preset: "daily", timezone: "Europe/Berlin", minute: 30, hour: 2, weekday: 0, monthday: 1}), JSON.stringify({keep_last: 3, daily: 7, weekly: 4, monthly: 6, yearly: 0}), [channelId]],
        );
        const sched = await (await get(base, `/dashboard/stacks/${stackId}?tab=schedule`, admin)).text();
        for (const s of ["Backup schedule", "30 2 * * *", "Europe/Berlin", "newest 3, then 7 daily, 4 weekly, 6 monthly, 0 yearly", "offsite-e2e", "Backup runs are not built yet"]) expect(sched, s).toContain(s);
        expect(sched).not.toContain(CANARY);

        // ---- self-check failure (D21): the form still renders but says configuration is locked
        await app.stop();
        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "true"}, [], shared, true);
        const lockedHtml = await (await get(app.base, `/dashboard/stacks/${stackId}/configure`, await signIn(app.base))).text();
        expect(lockedHtml).toContain("Fork configuration is locked, so a backup policy cannot be activated right now.");

        // ---- flags off ⇒ the new route is a real 404 (parity)
        await app.stop();
        app = await boot({}, [], shared);
        const off = await get(app.base, `/dashboard/stacks/${stackId}/configure`, await signIn(app.base));
        expect(off.status).toBe(404);
    });
});
