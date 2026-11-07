import {afterAll, describe, expect, it} from "vitest";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {richInventory} from "@/fork/__tests__/w08-fixtures";
import {contentHash, type StackInventoryV1} from "@/fork/inventory/schema";

/**
 * W09 e2e on the REAL production build: the Configuration tab, the blockers panel and the derived protection state over HTTP,
 * with the real proxy + session. Boot 1 (flags off) creates the DB and a member; boot 2 (flag on) serves the pages; boot 3
 * (AUTH_SIGNUP_ENABLED=true ⇒ self-check fails) must show the "Fork configuration locked" facet.
 */
const SECRET_NAMES = ["POSTGRES_PASSWORD", "APP_SECRET", "POSTGRES_USER", "container_id", "abcdef123456", "fedcba654321", "provenance", "openapi_sha256", "api_key"];
const MEMBER = {email: "member@w09.test", password: "W09-member-Password!1", name: "Member"};

const login = async (base: string, u: {email: string; password: string}) => {
    const r = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({email: u.email, password: u.password})});
    expect(r.status, await r.clone().text()).toBe(200);
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

let app: App | undefined;
afterAll(async () => { await app?.stop(); });

describe("W09 Configuration tab (real build)", () => {
    it("member sees blockers, derived state, config tab; read-only; no secrets; locked facet when the self-check fails", async () => {
        const first = await boot({}, [], undefined, true);
        const up = await fetch(`${first.base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: first.base}, body: JSON.stringify(MEMBER)});
        expect(up.status, await up.clone().text()).toBeLessThan(300);
        await first.db.pool.query(`update "user" set role = 'user' where email = $1`, [MEMBER.email]);
        const q = (s: string, p: unknown[] = []) => first.db.pool.query(s, p);
        const orgId = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const memberId = (await q(`select id from "user" where email = $1`, [MEMBER.email])).rows[0].id as string;
        await q(`delete from member where user_id = $1`, [memberId]);
        await q("insert into member (organization_id, user_id, role) values ($1,$2,'member')", [orgId, memberId]);
        await q("insert into organization (name, slug, deleted_at) values ('Gone Org','gone-org', now())");
        const add = async (project: string, inv: StackInventoryV1) => {
            const id = (await q("insert into fork_stack (organization_id, environment_name, compose_project, display_name, runtime_state) values ($1,'local',$2,$2,'running') returning id", [orgId, project])).rows[0].id as string;
            await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [id, contentHash(inv), JSON.stringify(inv)]);
            return id;
        };
        const tier1 = await add("forklab-demo", richInventory());
        const t2 = cleanInventory();
        t2.stack.compose_project = "tier2-app"; t2.services[0]!.env_keys = ["DATABASE_URL", "SESSION_KEY"];
        t2.services[0]!.container_id = "abcdef123456";
        const tier2 = await add("tier2-app", t2);
        const shared = first.db;
        await first.stop();

        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false"}, [], shared, true);
        const member = await login(app.base, MEMBER);
        const base = app.base;

        // ---- tier 1 (lab default: compose not read)
        const ov = await (await get(base, `/dashboard/stacks/${tier1}`, member)).text();
        for (const s of ["Full-stack recovery is not available until resolved.", "Backup blockers", "Unprotected", "Last good backup", "No verified backup yet", "Open Configuration", "Backup facts", "Not checked"]) expect(ov, s).toContain(s);
        expect(ov).not.toContain("Backup readiness is not evaluated yet");
        expect(ov).not.toMatch(/>Protected</);

        const cfg = await get(base, `/dashboard/stacks/${tier1}?tab=configuration`, member);
        expect(cfg.status).toBe(200);
        const html = await cfg.text();
        for (const s of ["Coverage checklist", "Compose and environment files", "/srv/lab/demo/compose.yml", "Managed here", "Not captured yet", "Add manual source", "Missing", "Unknown",
            "The compose file was not read, so variable names are not known.", "This tab is read-only. There is no download of file contents.", "Inventory hash", "Restore safety notes"]) expect(html, s).toContain(s);
        expect(html).toContain('aria-disabled="true"');
        for (const s of SECRET_NAMES) expect(html, `config tab leaks ${s}`).not.toContain(s);
        // scoped to the tab itself: the upstream chrome around it may legitimately carry links
        const tab = html.slice(html.indexOf('data-testid="config-tab"'), html.indexOf('data-testid="read-only-note"'));
        expect(tab.length).toBeGreaterThan(500);
        expect(tab).not.toMatch(/\bdownload\b|blob:|href="\/api\/|<a\b|<form|<input/);

        // ---- tier 2: names yes, values structurally impossible, container ids no
        const h2 = await (await get(base, `/dashboard/stacks/${tier2}?tab=configuration`, member)).text();
        for (const s of ["DATABASE_URL", "SESSION_KEY", "Hidden: values are never read or stored", "/srv/app/stack.env"]) expect(h2, s).toContain(s);
        for (const s of ["container_id", "abcdef123456", "provenance"]) expect(h2).not.toContain(s);

        // ---- the list page is unchanged by W09 (policy badge), and still leaks nothing
        const list = await (await get(base, "/dashboard/stacks", member)).text();
        expect(list).toContain("forklab-demo");
        for (const s of SECRET_NAMES) expect(list).not.toContain(s);

        // ---- unknown tab falls back to Overview, not an error
        expect((await get(base, `/dashboard/stacks/${tier1}?tab=nope`, member)).status).toBe(200);

        // ---- locked mode: sign-up enabled ⇒ self-check fails ⇒ facet + note, page still readable
        const keep = app.db;
        await keep.pool.query("insert into fork_stack_policy (stack_id, activated_at) values ($1, now())", [tier1]); // "locked" (not "off") needs an active policy (ADR-010)
        await app.stop();
        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "true"}, [], keep);
        expect(app.logs()).toMatch(/"mode":"locked"/);
        const locked = await get(app.base, `/dashboard/stacks/${tier1}`, await login(app.base, MEMBER));
        const lockedHtml = await locked.text();
        expect(locked.status).toBe(200);
        expect(lockedHtml).toContain("Fork configuration locked");
        expect(lockedHtml).toContain("Stack Recovery configuration is locked because this instance is not single-organization.");
        expect(lockedHtml).toContain("Partial"); // active policy + gaps ⇒ derived state, even while locked
        await app.stop();
        app = undefined;
    });
});
