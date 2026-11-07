import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, describe, expect, it} from "vitest";
import type {ForkDb} from "@/fork/db/handle";
import {type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {mkWorld} from "@/fork/__tests__/w12-fixtures";

/**
 * W13 on the REAL production build: the Backups / Schedule / Activity tabs and the "Am I safe?" strip over HTTP with the real proxy + session, the timeline
 * surviving a reload, and §4.7 notifications delivered through a REAL upstream channel (a webhook pointing at a local sink) — once each, with sanitised bodies —
 * in healthy mode AND while the fork is locked (ADR-010).
 */
const CANARY = "CANARY-RAW-ERROR /srv/secret AKIACANARYKEY postgres://u:hunter2@db/x";
let app: App | undefined;
let sink: Server | undefined;
afterAll(async () => { sink?.close(); await app?.stop(); });

const startSink = async () => {
    const got: {title: string; message: string; level: string; event: string}[] = [];
    const server = createServer((req, res) => {
        let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { got.push(JSON.parse(b)); } catch { /* ignore */ } res.statusCode = 200; res.end("ok"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {server, got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`};
};
/** Rendered text only: the RSC payload in <script> tags legitimately carries the DTO's closed CODES (never secrets — those are checked on the whole document). */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "");
const until = async <T>(fn: () => T | undefined | false, ms = 120_000, step = 1000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, step)); }
};

describe("W13 tabs, strip and notification delivery (real build)", () => {
    it("healthy: tabs render honest states and survive a reload; the strip lists the stack; §4.7 notifications arrive once each, sanitised; then LOCKED: still delivered, editing refused with the reason", async () => {
        // boot 1 (flags off): creates the DB, the default organization and the default administrator
        const first = await boot({}, [], undefined, true);
        const shared = first.db;
        const q = (s: string, p: unknown[] = []) => shared.pool.query(s, p);
        const org = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const admin = (await q(`select u.id from "user" u join member m on m.user_id=u.id where m.organization_id=$1 order by u.created_at limit 1`, [org])).rows[0].id as string;
        await first.stop();

        const w = await mkWorld({...shared, db: drizzle({client: shared.pool}) as unknown as ForkDb}, {existing: {orgId: org, userId: admin}, schedule: {preset: "monthly", timezone: "UTC", minute: 0, hour: 3, weekday: 0, monthday: 28}});
        await q("update fork_stack_policy set activated_at = now() where stack_id=$1", [w.stackId]); // no due/missed slot, no dead-man alert at boot
        await q("update agents set last_contact = (now() at time zone 'utc') where id=$1", [w.agent]); // fixture contact is T0 (fixed past): keep the agent fresh vs the REAL clock
        await q("update databases set last_contact = (now() at time zone 'utc') where agent_id=$1", [w.agent]); // same for the member sources (W10 readability probe TTL is minutes)
        await q("update fork_stack_source set last_probe_at = now() where stack_id=$1", [w.stackId]); // seeded probes are stamped T0; PROBE_TTL_MS is 10 min vs the REAL clock
        await q("update fork_stack set display_name = 'shop /srv/secret' where id=$1", [w.stackId]);
        const run = (await q(`insert into fork_stack_run (stack_id, trigger, state, reason, started_at, finished_at, steps) values ($1,'manual','failed','agent_did_not_start', now() - interval '2 hours', now() - interval '110 minutes', $2) returning id`,
            [w.stackId, JSON.stringify([{name: "refresh_inventory", status: "done", attempts: 1, errors: 0}, {name: "track", status: "failed", attempts: 30, errors: 0, code: "agent_did_not_start"}])])).rows[0].id as string;
        await q("insert into fork_stack_run_item (run_id, source_name, dbms, state, reason, required) values ($1,'db','postgresql','failed','agent_did_not_start',true)", [run]);
        const okRun = (await q(`insert into fork_stack_run (stack_id, trigger, state, started_at, finished_at) values ($1,'schedule','succeeded', now() - interval '1 hour', now() - interval '58 minutes') returning id`, [w.stackId])).rows[0].id as string;
        const rp = (await q(`insert into fork_recovery_point (stack_id, stack_name, run_id, sequence, status, consistency_level, required_artifact_count, present_artifact_count, total_size_bytes, created_at, finalized_at)
            values ($1,'s',$2,1,'pending_verification','mixed',1,1,2048, now() - interval '1 hour', now() - interval '58 minutes') returning id`, [w.stackId, okRun])).rows[0].id as string;
        await q(`insert into fork_recovery_point_artifact (rp_id, source_name, engine, archive_kind, encrypted, channel_id, path_or_snapshot_id, size_bytes, ciphertext_sha256, presence, required) values ($1,'db','archive','archive_enc',true,$2,'/srv/CANARYPATH/db.enc',2048,$3,'present',true)`, [rp, w.channels[0], "cd".repeat(32)]);

        const s = await startSink();
        sink = s.server;
        const ch = (await q("insert into notification_channel (provider, name, config, enabled) values ('webhook','w13-sink',$1,true) returning id", [JSON.stringify({webhookUrl: s.url})])).rows[0].id as string;
        await q("insert into settings (name, default_notification_channel_id) values ('system',$1) on conflict (name) do update set default_notification_channel_id = excluded.default_notification_channel_id", [ch]);

        // ---- healthy boot
        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false", FORK_NOTIFY_TICK_SECONDS: "5", FORK_RUN_TICK_SECONDS: "300"}, [], shared, true);
        expect(app.logs()).toMatch(/"mode":"on"/);
        const cookie = await signIn(app.base);
        const page = async (p: string) => { const r = await get(app!.base, p, cookie); expect(r.status, p).toBe(200); return r.text(); };

        const backups = await page(`/dashboard/stacks/${w.stackId}?tab=backups`);
        for (const t of ["Recovery points", "Backed up · verifying", "Not verified yet — waiting for the verify job", "Offsite", "Back up now", "Verify", "Restore"]) expect(backups, t).toContain(t === "Offsite" ? "s3-" : t);
        expect(backups).not.toMatch(/Verified [A-Z0-9]/);
        expect(backups).not.toContain("CANARYPATH");
        const detail = await page(`/dashboard/stacks/${w.stackId}?tab=backups&rp=1`);
        for (const t of ["Recovery point #1", "Integrity checks", "Signed manifest and restore verification: not available yet", "cdcdcdcdcdcd…"]) expect(detail, t).toContain(t);
        expect(detail).not.toContain("CANARYPATH");

        const act1 = await page(`/dashboard/stacks/${w.stackId}?tab=activity`);
        const act2 = await page(`/dashboard/stacks/${w.stackId}?tab=activity`); // "reload"
        for (const t of ["Backup activity", "Agent did not start the backup within 10 min", "Verify: not available yet", run, okRun.slice(0, 8)]) {
            if (t === okRun.slice(0, 8)) continue;
            expect(act1, t).toContain(t);
            expect(act2, t).toContain(t);
        }
        expect(visible(act1)).not.toMatch(/agent_did_not_start|postgresql</);
        expect(act1).not.toContain("CANARY");

        const sched = await page(`/dashboard/stacks/${w.stackId}?tab=schedule`);
        expect(sched).toContain("Edit schedule");
        expect(sched).not.toContain("Only a system administrator can change the schedule.");

        const list = await page("/dashboard/stacks");
        for (const t of ["Am I safe?", "Safe", "Needs attention", "Not protected"]) expect(list, t).toContain(t);
        expect(list).not.toMatch(/data-testid="strip-count-safe">[1-9]/); // nothing can be Safe before W14 (kit + verified RPs): honest
        expect(list).toContain("shop srvsecret".slice(0, 4)); // the stack is listed (the name is data, not a status)

        // ---- notifications: every §4.7 kind once, sanitised
        const rows: [string, string, Record<string, unknown>][] = [
            ["run.failed", "k-failed", {state: "failed", reason: "member_timeout", error: CANARY}],
            ["run.blocked", "k-blocked", {state: "incomplete", reason: "validator_blocked", path: CANARY}],
            ["run.skipped", "k-skipped", {state: "skipped", reason: "overlap"}],
            ["run.policy_paused", "k-paused", {state: "paused", reason: "capability_lost", key: CANARY}],
            ["stack.partial", "k-partial", {state: "partial"}],
            ["stack.no_good_backup", "k-deadman", {state: "no_good_backup", hours: 49}],
        ];
        for (const [kind, key, extra] of rows) await q("insert into fork_notification_outbox (kind, dedupe_key, payload) values ($1,$2,$3)", [kind, key, JSON.stringify({stackId: w.stackId, link: "https://evil.example/x", ...extra})]);
        await q("insert into fork_notification_outbox (kind, dedupe_key, payload) values ('discovery.circuit_open','k-circuit','{}')");
        const mine = () => s.got.filter((m) => m.message.includes("shop srvsecret"));
        await until(() => mine().length >= rows.length);
        await new Promise((r) => setTimeout(r, 12_000)); // no duplicate may follow
        expect(mine(), JSON.stringify(mine().map((m) => `${m.title} | ${m.message.split("\n")[1] ?? ""}`))).toHaveLength(rows.length);
        for (const m of mine()) {
            const text = `${m.title}\n${m.message}`;
            for (const bad of ["CANARY", "/srv", "AKIA", "hunter2", "evil.example", "validator_blocked", "member_timeout"]) expect(text, bad).not.toContain(bad);
            expect(m.message).toContain(`${app.base}/dashboard/stacks/${w.stackId}`);
            expect(["critical", "warning"]).toContain(m.level);
        }
        expect(mine().map((m) => m.title).sort()).toEqual([
            "Portabase · Backup failed", "Portabase · Backup incomplete", "Portabase · Backup no longer covers everything", "Portabase · Backups paused", "Portabase · No good backup", "Portabase · Scheduled backup skipped",
        ].sort());
        const states = Object.fromEntries((await q("select dedupe_key, state from fork_notification_outbox where dedupe_key like 'k-%'")).rows.map((r) => [r.dedupe_key, r.state]));
        expect(states).toEqual({"k-failed": "delivered", "k-blocked": "delivered", "k-skipped": "delivered", "k-paused": "delivered", "k-partial": "delivered", "k-deadman": "delivered", "k-circuit": "suppressed"});
        const shared1 = app.db;
        await app.stop();

        // ---- locked boot: the single-organization check fails, configuration is locked, notifications STILL flow, editing is refused with the reason
        s.got.length = 0;
        app = await boot({FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "true", FORK_NOTIFY_TICK_SECONDS: "5", FORK_RUN_TICK_SECONDS: "300"}, [], shared1, true);
        expect(app.logs()).toMatch(/"mode":"locked"/);
        expect(app.logs()).toMatch(/"started":\[[^\]]*"fork-notifications"/);
        await q("insert into fork_notification_outbox (kind, dedupe_key, payload) values ('run.failed','k-locked',$1)", [JSON.stringify({stackId: w.stackId, state: "failed", reason: "member_timeout"})]);
        await until(() => s.got.find((m) => m.message.includes("shop srvsecret") && m.title.includes("Backup failed")));
        expect((await q("select state from fork_notification_outbox where dedupe_key='k-locked'")).rows[0].state).toBe("delivered");
        const cookie2 = await signIn(app.base);
        const lockedSched = await (await get(app.base, `/dashboard/stacks/${w.stackId}?tab=schedule`, cookie2)).text();
        expect(lockedSched).toContain("Configuration is locked until the single-organization check passes.");
        expect(lockedSched).toMatch(/data-testid="schedule-edit-open"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*data-testid="schedule-edit-open"/);
        const lockedList = await (await get(app.base, "/dashboard/stacks", cookie2)).text();
        expect(lockedList).toContain("Am I safe?");
        expect(app.logs()).not.toMatch(/Notifications tick failed/);
    }, 600_000);
});
