import {randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterAll, describe, expect, it} from "vitest";
import {type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {seedWorld, type World} from "@/fork/__tests__/w16-world";
import {MIRRORS} from "@/fork/ui/mirrors/labels";

/**
 * W23 e2e on the REAL production build (no agents, no runner): the list, the detail tabs and the sidebar over HTTP with the real proxy, session and boot sequence.
 * Flags off ⇒ real 404; mirrors flag off ⇒ list with the flag-off notice, no sidebar entry; both on ⇒ sidebar link, list rows, four detail tabs; member ⇒ list without Delete;
 * foreign / unknown ids ⇒ the same 404; a deleted mirror ⇒ the deleted notice; no workspace path or secret in HTML or RSC. The READY path (a real runner) is the lab test.
 * Rows are seeded by SQL: the status is what the pages render (health comes from `services`); creation semantics are covered by the integration + lab tests.
 */
const MEMBER = {email: "member@w23.test", password: "W23-member-Password!1", name: "Member"};
const ORGADMIN = {email: "orgadmin@w23.test", password: "W23-orgadmin-Password!1", name: "Org Admin"};
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

describe("W23 mirror pages (real build)", () => {
    it("flags off ⇒ 404; mirrors off ⇒ flag-off notice, no sidebar entry; both on ⇒ sidebar, list, tabs; member read-only; foreign/unknown ⇒ 404; deleted notice; no leak", async () => {
        const priv = mkdtempSync(path.join(os.tmpdir(), "w23-priv-"));
        const base1 = {FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false", PRIVATE_PATH: priv};
        first = await boot({PRIVATE_PATH: priv}, [], undefined, true);
        for (const u of [MEMBER, ORGADMIN]) {
            const up = await fetch(`${first.base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: first.base}, body: JSON.stringify(u)});
            expect(up.status, await up.clone().text()).toBeLessThan(300);
            await first.db.pool.query(`update "user" set role = 'user' where email = $1`, [u.email]);
        }
        const flagsOff = await signIn(first.base);
        for (const p of ["/dashboard/mirrors", `/dashboard/mirrors/${randomUUID()}`]) expect((await get(first.base, p, flagsOff)).status, p).toBe(404);

        // ---- seed: a "ready"-status mirror (healthy services), a failed one with a failed newer revision shape, a deleted one, and a foreign one
        const pool = first.db.pool;
        const q = (s: string, a: unknown[] = []) => pool.query(s, a);
        const org = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const userId = async (email: string) => (await q(`select id from "user" where email = $1`, [email])).rows[0].id as string;
        const [memberId, orgAdminId] = [await userId(MEMBER.email), await userId(ORGADMIN.email)];
        await q(`delete from member where user_id in ($1,$2)`, [memberId, orgAdminId]);
        await q("insert into member (organization_id, user_id, role) values ($1,$2,'member'), ($1,$3,'admin')", [org, memberId, orgAdminId]);
        // the foreign org is soft-deleted like in W22b: the single-organization resolver (D21) must still find ONE org
        const foreignOrg = (await q("insert into organization (name, slug, deleted_at) values ('Gone Org','gone-org-w23', now()) returning id")).rows[0].id as string;
        const w: World = await seedWorld(pool, {org, hostRole: "production", roots: ["/srv"]});
        const fw: World = await seedWorld(pool, {org: foreignOrg, hostRole: "production", roots: ["/srv"]});
        await q("update agents set organization_id = null where id = $1", [fw.agent]);
        await q("update storage_channel set organization_id = null where organization_id = $1", [foreignOrg]);
        const WS = "/srv/portabase-mirrors/pbm-seed-r1";
        const mirror = async (name: string, status: string, stack: string, orgId: string, port: number, o: {services?: unknown; deleted?: boolean} = {}) => {
            const id = (await q(`insert into fork_mirror (organization_id, stack_id, runner_agent_name, name, policy, status, created_by, created_at, updated_at, deleted_at)
                values ($1,$2,'lab-runner',$3,$4,$5,'u',now(),now(),$6) returning id`, [orgId, stack, name, JSON.stringify({v: 1, access: {service: "web", target: 8080}, http_path: "/", env: {web: {SMTP_URL: "disable"}}, kept_confirmed: [], limits: {mem_bytes: 1073741824, pids: 512, nano_cpus: 1000000000}}), status, o.deleted ? new Date() : null])).rows[0].id as string;
            const rev = (await q(`insert into fork_mirror_revision (mirror_id, organization_id, stack_id, seq, rp_sequence, plan_hash, project, workspace, host_port, state, reason, finished_at, wipe_state, started_by, created_at, deadline_at, updated_at, services)
                values ($1,$2,$3,1,1,$4,'pbm-seed-r1',$5,$6,'failed','smoke_failed',now(),'verified','u',now(),now(),now(),$7::jsonb) returning id`, [id, orgId, stack, "a".repeat(64), WS, port, JSON.stringify(o.services ?? [])])).rows[0].id as string;
            if (status === "ready") await q("update fork_mirror set active_revision_id=$2 where id=$1", [id, rev]);
            return id;
        };
        const readyId = await mirror("e2e-ready", "ready", w.stack, org, 41001, {services: [{service: "web", state: "running", health: "none"}]});
        const failedId = await mirror("e2e-failed", "failed", w.stack, org, 41002);
        const deletedId = await mirror("e2e-deleted", "deleted", w.stack, org, 41003, {deleted: true});
        const foreignId = await mirror("e2e-foreign", "ready", fw.stack, foreignOrg, 41004);
        await first.stop();

        // ---- boot 2: stacks on, MIRRORS OFF ⇒ list with the notice, rows visible, no sidebar entry
        second = await boot({...base1, FORK_MIRRORS_ENABLED: "false"}, [], first.db, true);
        const adminCk2 = await signIn(second.base);
        const list2 = await get(second.base, "/dashboard/mirrors", adminCk2);
        expect(list2.status).toBe(200);
        const l2 = await list2.text();
        expect(visible(mainOf(l2))).toContain(MIRRORS.list.flagOff);
        expect(visible(mainOf(l2))).toContain("e2e-ready");
        expect(l2).not.toContain('href="/dashboard/mirrors"'); // no sidebar entry while the flag is off
        await second.stop();

        // ---- boot 3: both flags on
        third = await boot({...base1, FORK_MIRRORS_ENABLED: "true"}, [], first.db);
        const base = third.base;
        const admin = await signIn(base);
        const memberCk = await login(base, MEMBER);
        const orgAdminCk = await login(base, ORGADMIN);

        const list = await (await get(base, "/dashboard/mirrors", orgAdminCk)).text();
        const lv = visible(mainOf(list));
        expect(list).toContain('href="/dashboard/mirrors"'); // sidebar link
        expect(lv).toContain("Test Mirrors");
        expect(lv).toContain(MIRRORS.list.title);
        expect(lv).toContain("e2e-ready");
        expect(lv).toContain("e2e-failed");
        expect(lv).not.toContain("e2e-deleted");
        expect(lv).not.toContain("e2e-foreign");
        expect(lv).toContain("Healthy");
        expect(lv).toContain(MIRRORS.list.banner);
        expect(lv).toContain("Loopback only");
        expect(list).not.toMatch(/ssh -L/);
        expect(lv).not.toContain(MIRRORS.list.flagOff);
        expect(mainOf(list)).toMatch(/data-testid="mirror-delete"/); // org admin can delete
        const memberList = await (await get(base, "/dashboard/mirrors", memberCk)).text();
        expect(visible(mainOf(memberList))).toContain("e2e-ready");
        expect(mainOf(memberList)).not.toMatch(/data-testid="mirror-delete"/);

        // detail: the four tabs (200), the tab param is parsed (unknown ⇒ overview), the banner is on the page
        for (const tab of ["overview", "configuration", "history", "logs", "<script>alert(1)</script>"]) {
            const r = await get(base, `/dashboard/mirrors/${readyId}?tab=${encodeURIComponent(tab)}`, orgAdminCk);
            expect(r.status, tab).toBe(200);
            const html = await r.text();
            expect(visible(mainOf(html)), tab).toContain("lab-runner");
            expect(html, tab).not.toContain("<script>alert(1)</script>");
        }
        const cfg = visible(mainOf(await (await get(base, `/dashboard/mirrors/${readyId}?tab=configuration`, orgAdminCk)).text()));
        expect(cfg).toContain("SMTP_URL"); // org admin sees the overridden key NAME
        const memCfgHtml = await (await get(base, `/dashboard/mirrors/${readyId}?tab=configuration`, memberCk)).text();
        expect(visible(mainOf(memCfgHtml))).not.toContain("SMTP_URL"); // a member sees counts only
        expect(visible(mainOf(memCfgHtml))).toContain("1 setting changed from the safe default");

        // deleted mirror ⇒ the deleted notice, no tabs, no actions; foreign, unknown and malformed ids ⇒ the same not-found page
        const del = await (await get(base, `/dashboard/mirrors/${deletedId}`, orgAdminCk)).text();
        expect(visible(mainOf(del))).toContain(MIRRORS.detail.deleted);
        expect(mainOf(del)).not.toMatch(/role="tablist"|data-testid="mirror-delete"/);
        const notFound = async (id: string) => { const h = await (await get(base, `/dashboard/mirrors/${id}`, admin)).text(); const body = mainOf(h); return h.includes("NEXT_HTTP_ERROR_FALLBACK") && !body.includes("mirror-headline") && !body.includes("e2e-foreign"); };
        for (const id of [randomUUID(), "not-a-uuid", foreignId]) expect(await notFound(id), id).toBe(true);
        void failedId;

        // the workspace path, the private path and tunnel commands are never in HTML or RSC of the list or any tab
        for (const p of ["/dashboard/mirrors", ...["overview", "configuration", "history", "logs"].map((t) => `/dashboard/mirrors/${readyId}?tab=${t}`)]) {
            for (const body of [await (await get(base, p, orgAdminCk)).text(), await rsc(base, p, orgAdminCk)]) {
                expect(body.includes(priv), `${p} leaks the private path`).toBe(false);
                expect(body, p).not.toContain("/srv/portabase-mirrors");
                expect(body, p).not.toMatch(/ssh -L/);
            }
        }
    }, 900_000);
});
