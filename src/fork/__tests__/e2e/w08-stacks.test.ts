import {afterAll, describe, expect, it} from "vitest";
import {type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {richInventory} from "@/fork/__tests__/w08-fixtures";
import {contentHash} from "@/fork/inventory/schema";

/**
 * W08 e2e on the REAL production build: the stack pages over HTTP, with the real proxy, real session, real boot sequence.
 * Boot 1 (flags off) creates the database, the default org + admin and two plain accounts; flags stay off and /dashboard/stacks must be a 404.
 * Boot 2 (same DB, flag on, healthy single tenant) serves the pages.
 */
const SECRET_NAMES = ["POSTGRES_PASSWORD", "APP_SECRET", "POSTGRES_USER", "env_keys", "container_id", "abcdef123456", "fedcba654321", "provenance", "openapi_sha256", "api_key"];
const MEMBER = {email: "member@w08.test", password: "W08-member-Password!1", name: "Member"};
const OUTSIDER = {email: "outsider@w08.test", password: "W08-outsider-Password!1", name: "Outsider"};

const login = async (base: string, u: {email: string; password: string}) => {
    const r = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({email: u.email, password: u.password})});
    expect(r.status, await r.clone().text()).toBe(200);
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

let app: App | undefined;
afterAll(async () => { await app?.stop(); });

describe("W08 stacks pages (real build)", () => {
    it("flags off ⇒ real 404 for everyone; flag on ⇒ member list + details, no secrets, no oracle, honest states", async () => {
        // ---- boot 1: flags off
        const first = await boot({}, [], undefined, true);
        for (const u of [MEMBER, OUTSIDER]) {
            const up = await fetch(`${first.base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: first.base}, body: JSON.stringify(u)});
            expect(up.status, await up.clone().text()).toBeLessThan(300);
            await first.db.pool.query(`update "user" set role = 'user' where email = $1`, [u.email]);
        }
        const adminCookie1 = await signIn(first.base);
        const memberCookie1 = await login(first.base, MEMBER);
        for (const c of [adminCookie1, memberCookie1]) {
            expect((await get(first.base, "/dashboard/stacks", c)).status).toBe(404);
            expect((await get(first.base, "/dashboard/stacks/0b7e1c1e-7f3a-4b6e-9a40-111111111111", c)).status).toBe(404);
        }
        expect((await get(first.base, "/dashboard/stacks")).status).toBe(307); // anonymous: upstream login redirect, as for any dashboard page
        const home = await (await get(first.base, "/dashboard/home", adminCookie1)).text();
        expect(home).not.toMatch(/Docker Stacks|\/dashboard\/stacks/);

        // ---- seed: org, membership, stacks (fork lane is applied even with flags off)
        const q = (s: string, p: unknown[] = []) => first.db.pool.query(s, p);
        const orgId = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const memberId = (await q(`select id from "user" where email = $1`, [MEMBER.email])).rows[0].id as string;
        // upstream's sign-up may already have added the new users to the default org: make the roles explicit (member vs no membership at all)
        await q(`delete from member where user_id in (select id from "user" where email in ($1,$2))`, [MEMBER.email, OUTSIDER.email]);
        await q("insert into member (organization_id, user_id, role) values ($1,$2,'member')", [orgId, memberId]);
        const foreignOrg = (await q("insert into organization (name, slug, deleted_at) values ('Gone Org','gone-org', now()) returning id")).rows[0].id as string; // soft-deleted: keeps the single-tenant self-check green
        const add = async (org: string, project: string, state = "running") => {
            const inv = richInventory({project});
            const id = (await q("insert into fork_stack (organization_id, environment_name, compose_project, display_name, runtime_state) values ($1,'local',$2,$2,$3) returning id", [org, project, state])).rows[0].id as string;
            await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [id, contentHash(inv), JSON.stringify(inv)]);
            return id;
        };
        const demo = await add(orgId, "forklab-demo");
        const gone = await add(orgId, "old-blog", "absent");
        const foreign = await add(foreignOrg, "foreign-app");
        await q("insert into fork_stack (organization_id, environment_name, compose_project, display_name) values ($1,'local','no-inv','no-inv')", [orgId]);
        const adminSeen = (await q("select count(*)::int c from member where organization_id = $1 and role = 'owner'", [orgId])).rows[0].c as number;
        const shared = first.db;
        await first.stop();

        // ---- boot 2: flag on
        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false"}, [], shared);
        const {base, logs} = app;
        expect(logs()).toMatch(/"mode":"on"/);
        const admin = await signIn(base);
        const member = await login(base, MEMBER);
        const outsider = await login(base, OUTSIDER);

        // sidebar: members see Docker Stacks; only a system admin sees Integrations
        const memberHome = await (await get(base, "/dashboard/home", member)).text();
        expect(memberHome).toContain('href="/dashboard/stacks"');
        expect(memberHome).not.toMatch(/\/dashboard\/integrations/);
        const outsiderHome = await (await get(base, "/dashboard/home", outsider)).text();
        expect(outsiderHome).not.toMatch(/Docker Stacks|\/dashboard\/stacks/);
        if (adminSeen > 0) expect(await (await get(base, "/dashboard/home", admin)).text()).toContain('href="/dashboard/stacks"');

        // list (member)
        const list = await get(base, "/dashboard/stacks", member);
        expect(list.status).toBe(200);
        const listHtml = await list.text();
        expect(listHtml).toContain("forklab-demo");
        expect(listHtml).toContain("old-blog");
        expect(listHtml).toContain("No longer found");
        expect(listHtml).toContain("Unprotected");
        expect(listHtml).toContain(`/dashboard/stacks/${demo}`);
        expect(listHtml).not.toContain("foreign-app");
        for (const s of SECRET_NAMES) expect(listHtml, `list leaks ${s}`).not.toContain(s);
        expect(listHtml).not.toMatch(/\b(Backed up|Verified|Restore-tested)\b/);

        // filters over the real server
        const filtered = await (await get(base, "/dashboard/stacks?q=forklab&runtime=running&sort=attention", member)).text();
        expect(filtered).toContain("forklab-demo");
        // the LIST honours the filters; the W13 "Am I safe?" strip deliberately covers the whole estate (a filter must not hide an unsafe stack from it)
        const rows = [...filtered.matchAll(/data-testid="stack-row"[\s\S]*?<\/tr>/g)].map((m) => m[0]).join("\n");
        expect(rows).toContain("forklab-demo");
        expect(rows).not.toContain("old-blog");
        expect(filtered).toContain("Am I safe?");
        expect(await (await get(base, "/dashboard/stacks?q=%25%27%3B--&page=-3&sort=drop&runtime=x", member)).text()).toContain("No stacks match these filters");
        expect((await get(base, "/dashboard/stacks?q=" + "a".repeat(5000), member)).status).toBe(200);

        // details (member): Overview + Resources match the seeded lab-shaped inventory, shared flagged, no secrets (HTML and RSC payload)
        const det = await get(base, `/dashboard/stacks/${demo}`, member);
        expect(det.status).toBe(200);
        const html = await det.text();
        expect(html, `details page missing the stack name; server log: ${logs().split("\n").filter((x) => /error|digest/i.test(x)).slice(-3).join(" | ").slice(0, 800)}`).toContain("forklab-demo");
        for (const s of ["forklab-demo", "lab_proxy", "Shared", "Overview", "Resources", "Unprotected", "Running", "None yet", "Configure backup", "Back up now", "Restore"]) expect(html, s).toContain(s);
        expect(html).toContain('aria-disabled="true"');
        for (const s of SECRET_NAMES) expect(html, `details leaks ${s}`).not.toContain(s);
        const resources = await (await get(base, `/dashboard/stacks/${demo}?tab=resources`, member)).text();
        expect(resources).toMatch(/aria-selected="true"[^>]*>Resources|Resources<\/button>/);
        expect(resources).toContain("forklab-demo_pgdata");
        expect(resources).toContain("/srv/lab/demo/uploads");
        expect(resources).toContain("Arcane lists these resources; it cannot read their contents");

        // gone stack: honest banner
        expect(await (await get(base, `/dashboard/stacks/${gone}`, member)).text()).toContain("No longer found in Arcane");

        // no oracle: another organization's stack, a random uuid and a malformed id answer identically and reveal nothing
        const probes = [foreign, "7c9e6679-7425-40de-944b-e07fc1f90ae7", "not-a-uuid", "..%2f..%2fetc"];
        const answers: {status: number; leak: boolean; body: string}[] = [];
        for (const id of probes) {
            const r = await get(base, `/dashboard/stacks/${id}`, member);
            const body = await r.text();
            answers.push({status: r.status, leak: /foreign-app|lab_proxy|POSTGRES/.test(body), body});
        }
        expect(answers.map((a) => a.leak)).toEqual([false, false, false, false]);
        expect(new Set(answers.map((a) => a.status)).size).toBe(1);
        expect(answers[0].body).toContain("404"); // the dashboard's not-found UI

        // authenticated but not a member of the organization: honest unauthorized state, no data, not even the names
        const out = await get(base, "/dashboard/stacks", outsider);
        const outHtml = await out.text();
        expect(outHtml).toContain("You do not have access to Docker Stacks");
        expect(outHtml).not.toContain("forklab-demo");
        const outDetail = await (await get(base, `/dashboard/stacks/${demo}`, outsider)).text();
        expect(outDetail).not.toContain("lab_proxy");
        expect(outDetail).not.toContain("forklab-demo");

        // anonymous: upstream login redirect
        expect((await get(base, `/dashboard/stacks/${demo}`)).status).toBe(307);
        await app.stop();
        app = undefined;
    });
});
