import {randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterAll, describe, expect, it} from "vitest";
import {type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {seedWorld, type World} from "@/fork/__tests__/w16-world";
import {STACK_DETAILS} from "@/fork/ui/labels";
import {MIRRORS} from "@/fork/ui/mirrors/labels";

/**
 * W22b e2e on the REAL production build (no agents, no runner): the wizard and progress pages over HTTP with the real proxy, session and boot sequence.
 * Flags off ⇒ real 404; mirrors flag off ⇒ honest notice + the flag-off reason on the stack page (never the old stub); mirrors on without a runner ⇒ the no-runner reason;
 * member ⇒ role notice; unknown / foreign ids ⇒ the same 404; nothing secret in HTML or RSC. The positive path (a runner, create, READY) is the lab test.
 */
const MEMBER = {email: "member@w22b.test", password: "W22b-member-Password!1", name: "Member"};
const ORGADMIN = {email: "orgadmin@w22b.test", password: "W22b-orgadmin-Password!1", name: "Org Admin"};
const STUB = "not part of this release";

const login = async (base: string, u: {email: string; password: string}) => {
    const r = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({email: u.email, password: u.password})});
    expect(r.status, await r.clone().text()).toBe(200);
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};
const rsc = (base: string, p: string, cookie: string) => fetch(`${base}${p}`, {headers: {cookie, RSC: "1"}}).then((r) => r.text());
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const mainOf = (html: string) => html.slice(html.indexOf('<main class="h-full">'));

let first: App | undefined; let second: App | undefined; let third: App | undefined;
afterAll(async () => { await third?.stop(); await second?.stop(); await first?.stop(); await first?.db.drop().catch(() => {}); });

describe("W22b mirror pages (real build)", () => {
    it("flags off ⇒ 404; mirrors off ⇒ notice + flag reason; mirrors on, no runner ⇒ no-runner reason; member role notice; unknown/foreign ids ⇒ 404; no leak", async () => {
        const priv = mkdtempSync(path.join(os.tmpdir(), "w22b-priv-"));
        const base1 = {FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false", PRIVATE_PATH: priv};
        // ---- boot 1 (flags off)
        first = await boot({PRIVATE_PATH: priv}, [], undefined, true);
        for (const u of [MEMBER, ORGADMIN]) {
            const up = await fetch(`${first.base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: first.base}, body: JSON.stringify(u)});
            expect(up.status, await up.clone().text()).toBeLessThan(300);
            await first.db.pool.query(`update "user" set role = 'user' where email = $1`, [u.email]);
        }
        const flagsOff = await signIn(first.base);
        for (const p of ["/dashboard/mirrors/new", `/dashboard/mirrors/${randomUUID()}`]) expect((await get(first.base, p, flagsOff)).status, p).toBe(404);

        // ---- seed
        const pool = first.db.pool;
        const q = (s: string, a: unknown[] = []) => pool.query(s, a);
        const org = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const userId = async (email: string) => (await q(`select id from "user" where email = $1`, [email])).rows[0].id as string;
        const [memberId, orgAdminId] = [await userId(MEMBER.email), await userId(ORGADMIN.email)];
        await q(`delete from member where user_id in ($1,$2)`, [memberId, orgAdminId]);
        await q("insert into member (organization_id, user_id, role) values ($1,$2,'member'), ($1,$3,'admin')", [org, memberId, orgAdminId]);
        const foreignOrg = (await q("insert into organization (name, slug, deleted_at) values ('Gone Org','gone-org', now()) returning id")).rows[0].id as string;
        const w: World = await seedWorld(pool, {org, hostRole: "production", roots: ["/srv"]});
        const fw: World = await seedWorld(pool, {org: foreignOrg, hostRole: "production", roots: ["/srv"]});
        await q("update agents set organization_id = null where id = $1", [fw.agent]);
        await q("update storage_channel set organization_id = null where organization_id = $1", [foreignOrg]);
        await first.stop();

        // ---- boot 2: stacks on, MIRRORS OFF
        second = await boot({...base1, FORK_MIRRORS_ENABLED: "false"}, [], first.db, true);
        const adminCk2 = await signIn(second.base);
        const wiz2 = await get(second.base, `/dashboard/mirrors/new?stack=${w.stack}`, adminCk2);
        expect(wiz2.status).toBe(200);
        expect(visible(mainOf(await wiz2.text()))).toContain("Test mirrors are not enabled on this installation.");
        const stack2 = await (await get(second.base, `/dashboard/stacks/${w.stack}`, adminCk2)).text();
        expect(visible(mainOf(stack2))).toContain(STACK_DETAILS.actions.mirror.reason);
        expect(stack2).not.toContain(STUB);
        expect(stack2).not.toContain(`/dashboard/mirrors/new?stack=${w.stack}`); // no link while the flag is off
        await second.stop();

        // ---- boot 3: MIRRORS ON (no runner designated)
        third = await boot({...base1, FORK_MIRRORS_ENABLED: "true"}, [], first.db);
        const base = third.base;
        const admin = await signIn(base);
        const memberCk = await login(base, MEMBER);
        const orgAdminCk = await login(base, ORGADMIN);

        // entry on the stack page: no runner ⇒ the reason, not the stub, no link (reason 5); a member gets the role reason (2)
        const stack3 = await (await get(base, `/dashboard/stacks/${w.stack}`, orgAdminCk)).text();
        expect(visible(mainOf(stack3))).toContain(MIRRORS.entry.noRunner);
        expect(stack3).not.toContain(STUB);
        expect(stack3).not.toContain(`href="/dashboard/mirrors/new?stack=${w.stack}"`);
        expect(visible(mainOf(await (await get(base, `/dashboard/stacks/${w.stack}`, memberCk)).text()))).toContain(MIRRORS.entry.role);

        // the wizard: org admin sees step 1 with the verified backup; no runner ⇒ honest empty state on step 2; the privacy block is shown
        const step1 = await get(base, `/dashboard/mirrors/new?stack=${w.stack}`, orgAdminCk);
        expect(step1.status).toBe(200);
        const s1 = visible(mainOf(await step1.text()));
        expect(s1).toContain(MIRRORS.steps.title.source);
        expect(s1).toContain(MIRRORS.source.privacy.heading);
        const step2 = visible(mainOf(await (await get(base, `/dashboard/mirrors/new?stack=${w.stack}&point=1&step=runner`, orgAdminCk)).text()));
        expect(step2).toContain(MIRRORS.runner.empty);
        // a member gets the role notice; no stack param ⇒ the "open an app" note
        expect(visible(mainOf(await (await get(base, "/dashboard/mirrors/new", memberCk)).text()))).toContain(MIRRORS.entry.role);
        expect(visible(mainOf(await (await get(base, "/dashboard/mirrors/new", orgAdminCk)).text()))).toContain(MIRRORS.noStack);
        // no existence oracle: a foreign stack and a random stack are dropped with the same sentence
        for (const sid of [fw.stack, randomUUID()]) expect(visible(mainOf(await (await get(base, `/dashboard/mirrors/new?stack=${sid}`, orgAdminCk)).text())), sid).toContain(MIRRORS.gone);
        // a point that is not verified / does not exist is dropped
        expect(visible(mainOf(await (await get(base, `/dashboard/mirrors/new?stack=${w.stack}&point=999&step=runner`, orgAdminCk)).text()))).toContain(MIRRORS.gone);
        // unknown mirror ids and a malformed id are the same not-found page (a page-level notFound() streams as 200 behind loading.tsx, so the marker is in the body)
        const notFound = async (id: string) => { const h = await (await get(base, `/dashboard/mirrors/${id}`, admin)).text(); const body = mainOf(h); return h.includes("NEXT_HTTP_ERROR_FALLBACK") && !body.includes("mirror-headline") && !body.includes(`${MIRRORS.progress.title} ·`); };
        for (const id of [randomUUID(), "not-a-uuid"]) expect(await notFound(id), id).toBe(true);

        // private path / host path / stub text: never in the wizard HTML or RSC
        for (const p of [`/dashboard/mirrors/new?stack=${w.stack}`, `/dashboard/mirrors/new?stack=${w.stack}&point=1&step=runner`]) {
            for (const body of [await (await get(base, p, orgAdminCk)).text(), await rsc(base, p, orgAdminCk), await rsc(base, `${p}&_rsc=1`, orgAdminCk)]) {
                expect(body.includes(priv), `${p} leaks the private path`).toBe(false);
                expect(body, p).not.toContain("/srv/portabase-mirrors");
                expect(body, p).not.toContain(STUB);
            }
        }
    }, 900_000);
});
