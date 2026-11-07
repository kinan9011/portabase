import {type ChildProcess, spawn} from "node:child_process";
import {mkdtempSync} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {expect} from "vitest";
import {applyUpstreamMigrations, createTestDb, type TestDb} from "@/fork/__tests__/db-helpers";
import {runForkMigrations} from "@/fork/db/migrate";

/**
 * e2e tier (ARCH-18): boots the REAL production build (`pnpm build` first) with the real upstream
 * boot sequence (upstream migrations → initFork) and drives it over HTTP.
 * Flags-off parity is asserted on RENDERED output (server-rendered dashboard HTML + route status).
 */
export const ADMIN = {email: "admin@w01.test", password: "W01-lab-Password!1"};

const freePort = () => new Promise<number>((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
});

export type App = { base: string; logs: () => string; stop: () => Promise<void>; db: TestDb };

type Seed = "default-org" | "active-policy";

/**
 * `seed` (W04): the D21 self-check reads the DB at boot (initFork runs BEFORE upstream creates the default user/org), so
 * scenarios that need a healthy single-tenant instance pre-create what upstream would create (`organization` slug
 * `default`, the exact row `createDefaultOrganization()` looks for, so no second org appears).
 */
export async function boot(flags: Record<string, string>, seed: Seed[] = [], reuse?: TestDb, keepDb = false): Promise<App> {
    const db = reuse ?? (await createTestDb());
    if (seed.length && !reuse) {
        await applyUpstreamMigrations(db.pool);
        await db.pool.query(`insert into organization (name, slug) values ('Default Organization', 'default')`);
        if (seed.includes("active-policy")) {
            await runForkMigrations({databaseUrl: db.url, env: {NODE_ENV: "development"}});
            const org = (await db.pool.query("select id from organization where slug='default'")).rows[0].id;
            const st = (await db.pool.query("insert into fork_stack (organization_id, environment_name, compose_project, display_name) values ($1,'e','demo','demo') returning id", [org])).rows[0].id;
            await db.pool.query("insert into fork_stack_policy (stack_id, activated_at) values ($1, now())", [st]);
        }
    }
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
        if (!keepDb) await db.drop();
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

export async function signIn(base: string): Promise<string> {
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

export const get = (base: string, p: string, cookie?: string) => fetch(base + p, {headers: cookie ? {cookie} : {}, redirect: "manual"});
export const tableExists = async (db: TestDb, rel: string) => (await db.pool.query("select to_regclass($1) t", [rel])).rows[0].t !== null;

