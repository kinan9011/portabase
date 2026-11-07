import {afterAll, describe, expect, it} from "vitest";
import {type App, boot, get, signIn, tableExists} from "@/fork/__tests__/e2e/helpers";
import {MIGRATION_LEDGER} from "@/fork/db/migration-ledger";

let app: App | undefined;
afterAll(async () => { await app?.stop(); });

describe("flags OFF (default): the app renders exactly like upstream", () => {
    it("no fork output anywhere", async () => {
        app = await boot({});
        const {base, logs, db} = app;

        // boot: upstream migrations → fork lane ran (fork-owned tables only) → mode off, nothing started
        expect(logs()).toMatch(/"mode":"off"/);
        expect(logs()).toMatch(/"started":\[\]/);
        expect(logs()).not.toMatch(/Fork configuration locked/);
        expect(await tableExists(db, "public.fork_meta")).toBe(true);
        expect(Number((await db.pool.query("select count(*) c from drizzle.__fork_migrations")).rows[0].c)).toBe(MIGRATION_LEDGER.length);

        const cookie = await signIn(base);
        const home = await get(base, "/dashboard/home", cookie);
        expect(home.status).toBe(200);
        const html = await home.text();
        expect(html).toContain("Community Edition"); // sanity: the real dashboard layout rendered (not a redirect to /welcome)
        expect(html).not.toMatch(/Stack Recovery|Integrations|Arcane|Docker Stacks|\/dashboard\/integrations|\/dashboard\/stacks|\/dashboard\/recovery/);

        const unknown = await get(base, "/dashboard/this-route-does-not-exist", cookie);
        const integ = await get(base, "/dashboard/integrations", cookie);
        expect(unknown.status).toBe(404);
        expect(integ.status).toBe(404); // real 404 status, same as an unknown route (proxy page gate)
        expect(await integ.text()).not.toMatch(/Arcane|Integrations/);
        for (const c of [cookie, undefined]) {
            const r = await get(base, "/api/fork/status", c);
            expect(r.status).toBe(404);
            expect(await r.json()).toEqual({message: "This API route does not exist.", status: 404});
        }
        expect((await get(base, "/api/fork/x", cookie)).status).toBe(404);

        // Non-admin (role "user"): real 404 for the page (proxy gate) and the API route (handler ACL), no sidebar group.
        const plain = {email: "plain@w01.test", password: "W01-plain-Password!1", name: "Plain"};
        const up = await fetch(`${base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify(plain)});
        expect(up.status, await up.clone().text()).toBeLessThan(300);
        await db.pool.query(`update "user" set role = 'user' where email = $1`, [plain.email]);
        const si = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({email: plain.email, password: plain.password})});
        expect(si.status, await si.clone().text()).toBe(200);
        const plainCookie = si.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
        expect((await get(base, "/dashboard/integrations", plainCookie)).status).toBe(404);
        expect((await get(base, "/api/fork/status", plainCookie)).status).toBe(404);
        const plainHome = await get(base, "/dashboard/home", plainCookie);
        expect(plainHome.status).toBe(200);
        expect(await plainHome.text()).not.toMatch(/Stack Recovery|Arcane|\/dashboard\/integrations/);
        await app.stop();
        app = undefined;
    });
});

describe("flag ON: Integrations wiring (nav + route + ACL)", () => {
    it("system admin sees the sidebar group, the placeholder page and the diagnostic route; anonymous does not", async () => {
        // Boot 1 (flags off, upstream sign-up default): create the non-admin account — with AUTH_SIGNUP_ENABLED=false NO user can be
        // created at all, not even by an admin (observed: 403 "Sign up is disabled" from the better-auth user-create hook).
        const plain = {email: "plain@w01.test", password: "W01-plain-Password!1", name: "Plain"};
        const first = await boot({}, [], undefined, true);
        const up = await fetch(`${first.base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: first.base}, body: JSON.stringify(plain)});
        expect(up.status, await up.clone().text()).toBeLessThan(300);
        await first.db.pool.query(`update "user" set role = 'user' where email = $1`, [plain.email]);
        const shared = first.db;
        await first.stop();
        // Boot 2: same database, healthy single-tenant instance (D21: one org, sign-up closed), flag ON.
        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false"}, [], shared);
        const {base, logs, db} = app;
        expect(logs()).toMatch(/"mode":"on"/);
        expect(logs()).toMatch(/"lane":"applied"/);
        expect(await tableExists(db, "public.fork_meta")).toBe(true);

        const cookie = await signIn(base);
        const html = await (await get(base, "/dashboard/home", cookie)).text();
        expect(html).toContain("Stack Recovery");
        expect(html).toContain('href="/dashboard/integrations"');
        expect(html).toContain('href="/dashboard/stacks"'); // W08: Docker Stacks shipped (the default admin is an org member)
        expect(html).not.toMatch(/\/dashboard\/recovery/); // Recovery stays hidden until W18b

        const page = await get(base, "/dashboard/integrations", cookie);
        expect(page.status).toBe(200);
        const pageHtml = await page.text();
        expect(pageHtml).toContain("Connect your Arcane Manager"); // W06: real page, setup path (nothing connected)
        expect(pageHtml).toContain("Not configured");
        expect(pageHtml).toContain("arcane-discovery-key"); // the write-only key field is rendered empty (no value attribute)
        expect(pageHtml).not.toMatch(/name="arcane-discovery-key"[^>]*value="[^"]/);

        const status = await get(base, "/api/fork/status", cookie);
        expect(status.status).toBe(200);
        expect(await status.json()).toEqual({mode: "on", lockReason: null, banner: null, warnings: [], lane: "applied", flags: {stacks: false, arcane: true, mirrors: false}});

        expect((await get(base, "/api/fork/status")).status).toBe(404); // anonymous
        const anonPage = await get(base, "/dashboard/integrations");
        expect(anonPage.status).toBe(307); // upstream proxy redirects anonymous users to /login
        expect(anonPage.headers.get("location")).toContain("/login");

        // Non-admin (role "user"): real 404 for the page (proxy gate) and the API route (handler ACL), no sidebar group.
        const si = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({email: plain.email, password: plain.password})});
        expect(si.status, await si.clone().text()).toBe(200);
        const plainCookie = si.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
        expect((await get(base, "/dashboard/integrations", plainCookie)).status).toBe(404);
        expect((await get(base, "/api/fork/status", plainCookie)).status).toBe(404);
        const plainHome = await get(base, "/dashboard/home", plainCookie);
        expect(plainHome.status).toBe(200);
        const plainHtml = await plainHome.text();
        expect(plainHtml).not.toMatch(/Arcane|\/dashboard\/integrations/); // never the admin item
        expect(plainHtml).toContain('href="/dashboard/stacks"'); // W08: upstream sign-up made this user a member of the default org, so Docker Stacks (stacks.view) shows
        await app.stop();
        app = undefined;
    });
});

describe("W04 D21 self-check at boot (real production build, real DB)", () => {
    it("flag ON but AUTH_SIGNUP_ENABLED left at its upstream default (true) and nothing activated ⇒ mode off: the fork stays invisible, the breach is audited", async () => {
        app = await boot({FORK_ARCANE_ENABLED: "true"}, ["default-org"]);
        const {base, logs, db} = app;
        expect(logs()).toMatch(/"mode":"off"/);
        const cookie = await signIn(base);
        const html = await (await get(base, "/dashboard/home", cookie)).text();
        expect(html).not.toMatch(/Stack Recovery|Arcane|\/dashboard\/integrations/);
        expect((await get(base, "/api/fork/status", cookie)).status).toBe(404);
        const ev = (await db.pool.query("select action, redacted_details d from fork_audit_event order by seq")).rows;
        expect(ev).toEqual([{action: "fork.selfcheck.failed", d: {codes: ["signup-open"]}}]);
        await app.stop();
        app = undefined;
    });

    it("activated policy + failed self-check ⇒ LOCKED: admin gets the banner data, the runtime plane STILL starts, audit + notification recorded", async () => {
        app = await boot({FORK_ARCANE_ENABLED: "true"}, ["default-org", "active-policy"]);
        const {base, logs, db} = app;
        expect(logs()).toMatch(/"mode":"locked"/);
        expect(logs()).toMatch(/"lockReason":"self-check-failed"/);
        expect(logs()).toMatch(/"started":\["fork-audit-retention","fork-materialize-drift","fork-stack-runs","fork-notifications","fork-verify","fork-kit-watch"\]/); // runtime plane keeps running in degraded mode (W10 adds the drift/probe job)
        const cookie = await signIn(base);
        const status = await get(base, "/api/fork/status", cookie);
        expect(status.status).toBe(200);
        expect(await status.json()).toEqual({
            mode: "locked", lockReason: "self-check-failed", lane: "applied", flags: {stacks: false, arcane: true, mirrors: false}, warnings: [],
            banner: "Fork configuration locked: public sign-up is enabled (AUTH_SIGNUP_ENABLED must be false)",
        });
        expect((await db.pool.query("select action from fork_audit_event")).rows).toEqual([{action: "fork.selfcheck.failed"}]);
        expect((await db.pool.query("select kind, state, payload from fork_notification_outbox")).rows).toEqual([{kind: "fork.selfcheck.failed", state: "pending", payload: {codes: ["signup-open"]}}]);
        expect(logs()).not.toMatch(/Default Organization/); // no org name in the lock log lines
        await app.stop();
        app = undefined;
    });
});
