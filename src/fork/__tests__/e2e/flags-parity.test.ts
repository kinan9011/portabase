import {type ChildProcess, spawn} from "node:child_process";
import {mkdtempSync} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {afterAll, describe, expect, it} from "vitest";
import {createTestDb, type TestDb} from "@/fork/__tests__/db-helpers";

/**
 * e2e tier (ARCH-18): boots the REAL production build (`pnpm build` first) with the real upstream
 * boot sequence (upstream migrations → initFork) and drives it over HTTP.
 * Flags-off parity is asserted on RENDERED output (server-rendered dashboard HTML + route status).
 */
const ADMIN = {email: "admin@w01.test", password: "W01-lab-Password!1"};

const freePort = () => new Promise<number>((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
});

type App = { base: string; logs: () => string; stop: () => Promise<void>; db: TestDb };

async function boot(flags: Record<string, string>): Promise<App> {
    const db = await createTestDb();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let out = "";
    const child: ChildProcess = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", "127.0.0.1"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            NODE_ENV: "production",
            DATABASE_URL: db.url,
            PROJECT_URL: base,
            PROJECT_SECRET: "w01-e2e-secret-not-a-real-secret-0123456789",
            PRIVATE_PATH: mkdtempSync(path.join(os.tmpdir(), "w01-e2e-priv-")),
            AUTH_DEFAULT_USER: ADMIN.email,
            AUTH_DEFAULT_PASSWORD: ADMIN.password,
            AUTH_DEFAULT_USER_NAME: "W01 Admin",
            SKIP_ONBOARDING: "true",
            FORK_STACKS_ENABLED: "", FORK_ARCANE_ENABLED: "", FORK_MIRRORS_ENABLED: "",
            ...flags,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d) => { out += d; });
    child.stderr!.on("data", (d) => { out += d; });
    const stop = async () => {
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (child.exitCode === null) child.kill("SIGKILL");
        await db.drop();
    };
    const deadline = Date.now() + 180_000;
    for (;;) {
        if (child.exitCode !== null || out.includes("Failed to preload entries")) {
            await stop();
            throw new Error(`server failed to start:\n${out.slice(-3000)}`);
        }
        if (out.includes("Fork initialised") || out.includes("Fork init failed")) {
            const ok = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (ok) break;
        }
        if (Date.now() > deadline) { await stop(); throw new Error(`server did not become ready:\n${out.slice(-3000)}`); }
        await new Promise((r) => setTimeout(r, 500));
    }
    return {base, logs: () => out, stop, db};
}

async function signIn(base: string): Promise<string> {
    const r = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {"content-type": "application/json", origin: base},
        body: JSON.stringify(ADMIN),
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
    expect(cookies.length).toBeGreaterThan(0);
    return cookies.join("; ");
}

const get = (base: string, p: string, cookie?: string) => fetch(base + p, {headers: cookie ? {cookie} : {}, redirect: "manual"});
const tableExists = async (db: TestDb, rel: string) => (await db.pool.query("select to_regclass($1) t", [rel])).rows[0].t !== null;

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
        expect(Number((await db.pool.query("select count(*) c from drizzle.__fork_migrations")).rows[0].c)).toBe(1);

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
        app = await boot({FORK_ARCANE_ENABLED: "true"});
        const {base, logs, db} = app;
        expect(logs()).toMatch(/"mode":"on"/);
        expect(logs()).toMatch(/"lane":"applied"/);
        expect(await tableExists(db, "public.fork_meta")).toBe(true);

        const cookie = await signIn(base);
        const html = await (await get(base, "/dashboard/home", cookie)).text();
        expect(html).toContain("Stack Recovery");
        expect(html).toContain('href="/dashboard/integrations"');
        expect(html).not.toMatch(/Docker Stacks|\/dashboard\/stacks|\/dashboard\/recovery/); // hidden until their waves

        const page = await get(base, "/dashboard/integrations", cookie);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Arcane (coming)");

        const status = await get(base, "/api/fork/status", cookie);
        expect(status.status).toBe(200);
        expect(await status.json()).toEqual({mode: "on", lockReason: null, lane: "applied", flags: {stacks: false, arcane: true, mirrors: false}});

        expect((await get(base, "/api/fork/status")).status).toBe(404); // anonymous
        const anonPage = await get(base, "/dashboard/integrations");
        expect(anonPage.status).toBe(307); // upstream proxy redirects anonymous users to /login
        expect(anonPage.headers.get("location")).toContain("/login");

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
