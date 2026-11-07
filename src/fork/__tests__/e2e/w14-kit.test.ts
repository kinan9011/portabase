import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, describe, expect, it} from "vitest";
import type {ForkDb} from "@/fork/db/handle";
import {type App, boot, signIn} from "@/fork/__tests__/e2e/helpers";
import {mkWorld} from "@/fork/__tests__/w12-fixtures";

/**
 * W14 on the REAL production build: the kit delivery route (CSRF first, API keys refused, no-store on every answer, single-use grant), the admin-only kit page,
 * the instance banner (active policy + no kit ⇒ "Recovery kit not created"; members see the text, admins the link), and the verify/kit jobs on the runtime plane.
 */
let app: App | undefined;
afterAll(async () => { await app?.stop(); });

describe("W14 kit route, page and banner (real build)", () => {
    it("route: cross-site/no-origin refused, API-key refused, bad grant refused — all no-store; page: admin only; banner: shown with an active policy and no kit", async () => {
        const first = await boot({}, [], undefined, true);
        const shared = first.db;
        const q = (s: string, p: unknown[] = []) => shared.pool.query(s, p);
        const org = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const admin = (await q(`select u.id from "user" u join member m on m.user_id=u.id where m.organization_id=$1 order by u.created_at limit 1`, [org])).rows[0].id as string;
        await first.stop();
        const w = await mkWorld({...shared, db: drizzle({client: shared.pool}) as unknown as ForkDb}, {existing: {orgId: org, userId: admin}});
        await q("update fork_stack_policy set activated_at = now() where stack_id=$1", [w.stackId]);

        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false"}, [], shared, true);
        expect(app.logs()).toMatch(/"mode":"on"/);
        expect(app.logs()).toMatch(/"started":\[[^\]]*"fork-verify","fork-kit-watch"\]/);
        const cookie = await signIn(app.base);
        const post = (p: string, headers: Record<string, string>, body: unknown = {token: "x".repeat(30)}) =>
            fetch(app!.base + p, {method: "POST", redirect: "manual", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify(body)});
        const same = {"sec-fetch-site": "same-origin", cookie};

        const cross = await post("/api/fork/kit/paper", {"sec-fetch-site": "cross-site", cookie});
        expect(cross.status).toBe(403);
        const apiKey = await post("/api/fork/kit/paper", {...same, "x-api-key": "k"});
        expect(apiKey.status).toBe(403);
        expect(apiKey.headers.get("cache-control")).toMatch(/no-store/);
        expect(await apiKey.json()).toMatchObject({code: "forbidden"});
        const badGrant = await post("/api/fork/kit/paper", same);
        expect(badGrant.status).toBe(410); // admin session, same origin, but no valid single-use grant
        expect(badGrant.headers.get("cache-control")).toMatch(/no-store/);
        expect(await badGrant.json()).toMatchObject({code: "token_invalid"});
        expect((await post("/api/fork/kit/nonsense", same)).status).toBe(404);
        const anon = await post("/api/fork/kit/paper", {"sec-fetch-site": "same-origin"});
        expect([403, 404, 401, 307, 302]).toContain(anon.status); // no session: never a kit
        expect((await q("select count(*)::int c from fork_kit")).rows[0].c).toBe(0);

        const page = await fetch(`${app.base}/dashboard/integrations/recovery-kit`, {headers: {cookie}, redirect: "manual"});
        expect(page.status).toBe(200);
        const html = await page.text();
        for (const t of ["Recovery kit", "Create a kit", "Enter the verification code", "Back up this dashboard", "Rotate the fork encryption key", "No recovery kit has been created."]) expect(html, t).toContain(t);
        expect(html).not.toMatch(/PBKIT1|master_key|-----BEGIN/);
        const anonPage = await fetch(`${app.base}/dashboard/integrations/recovery-kit`, {redirect: "manual"});
        expect(anonPage.status).not.toBe(200);

        const list = await (await fetch(`${app.base}/dashboard/stacks`, {headers: {cookie}})).text();
        expect(list).toContain("Recovery kit not created");
        expect(list).toContain("/dashboard/integrations/recovery-kit"); // admin link
        // a verified kit removes the banner (state is SQL; the page reads it fresh)
        await q("insert into fork_kit (fingerprint, signing_kid, status, issued_by, verified_at, verified_type, types) values ('AAAA-AAAA-AAAA-AAAA-AAAA','aaaaaaaaaaaa','verified',$1,now(),'paper','{paper}')", [admin]);
        const list2 = await (await fetch(`${app.base}/dashboard/stacks`, {headers: {cookie}})).text();
        expect(list2).not.toContain("Recovery kit not created");
        expect(list2).not.toContain("Recovery kit not verified");
    });
});
