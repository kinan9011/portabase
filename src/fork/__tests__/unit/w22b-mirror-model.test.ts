import {describe, expect, it} from "vitest";
import {CreateMirrorRequest} from "@/fork/mirror/service";
import {HTTP_PATH_RE} from "@/fork/mirror/payload-schema";
import {GATES, MIRROR_REASONS, MIRROR_STEPS, keepConfirmPhrase} from "@/fork/mirror/vocab";
import type {MirrorView} from "@/fork/mirror/view";
import {MIRROR_AGENT_CODES} from "@/fork/restore-tasks/codes";
import {STACK_DETAILS} from "@/fork/ui/labels";
import {mirrorEntry} from "@/fork/ui/mirrors/entry";
import {BANNER, ENV_ACTION_TEXT, GATE_TEXT, MIRROR_REFUSAL_TEXT, MIRRORS, REASON_TEXT, RUNNER_REASON_TEXT, STEP_TEXT, reasonText, refusalText, retryText} from "@/fork/ui/mirrors/labels";
import {HTTP_PATH_RE_LOCAL, NAME_RE, buildCreateInput, changedCount, createBlockReason, defaultAccess, defaultMirrorName, keepPending, settled, type ServiceFacts} from "@/fork/ui/mirrors/wizard/model";

const ID = "11111111-1111-4111-8111-111111111111";
const web: ServiceFacts = {name: "web", ports: [{target: 8080, protocol: "tcp", published: true}], database: null, env: [{key: "APP_NAME", recommended: "keep"}, {key: "DB_PASSWORD", recommended: "rotate"}, {key: "SMTP_URL", recommended: "disable"}]};
const db: ServiceFacts = {name: "db", ports: [{target: 5432, protocol: "tcp", published: false}], database: "postgresql", env: [{key: "POSTGRES_PASSWORD", recommended: "rotate"}]};

describe("mirrorEntry (DD-3 precedence)", () => {
    const ok = {enabled: true, canManage: true, locked: false, verifiedCount: 1, runnerCount: 1, stackId: ID};
    it("returns the link when every precondition holds", () => expect(mirrorEntry(ok)).toEqual({href: `/dashboard/mirrors/new?stack=${ID}`}));
    it("1 flag off ⇒ the stack label reason (never the old stub)", () => {
        const r = mirrorEntry({...ok, enabled: false, canManage: false, locked: true, verifiedCount: 0, runnerCount: 0});
        expect(r).toEqual({reason: STACK_DETAILS.actions.mirror.reason});
        expect(JSON.stringify(r)).not.toContain("not part of this release");
    });
    it("2 role", () => expect(mirrorEntry({...ok, canManage: false, locked: true, verifiedCount: 0, runnerCount: 0})).toEqual({reason: MIRRORS.entry.role}));
    it("3 locked", () => expect(mirrorEntry({...ok, locked: true, verifiedCount: 0, runnerCount: 0})).toEqual({reason: MIRRORS.entry.locked}));
    it("4 no verified recovery point", () => expect(mirrorEntry({...ok, verifiedCount: 0, runnerCount: 0})).toEqual({reason: MIRRORS.entry.noVerified}));
    it("5 no runner", () => expect(mirrorEntry({...ok, runnerCount: 0})).toEqual({reason: MIRRORS.entry.noRunner}));
});

describe("defaultAccess", () => {
    it("prefers a published TCP port of a non-database service", () => expect(defaultAccess([db, web])).toEqual({service: "web", target: 8080}));
    it("falls back to the first non-database TCP port", () => expect(defaultAccess([db, {...web, ports: [{target: 3000, protocol: "tcp", published: false}]}])).toEqual({service: "web", target: 3000}));
    it("database-only ⇒ the database port", () => expect(defaultAccess([db])).toEqual({service: "db", target: 5432}));
    it("udp-only / no ports ⇒ null", () => {
        expect(defaultAccess([{...web, ports: [{target: 53, protocol: "udp", published: true}]}])).toBeNull();
        expect(defaultAccess([{...web, ports: []}])).toBeNull();
        expect(defaultAccess([])).toBeNull();
    });
});

describe("defaultMirrorName", () => {
    it.each([["My Shop", 3, "my-shop-3"], ["--Weird__Name!!", 1, "weird-name-1"], ["Café Ünï", 2, "caf-n-2"], ["日本語", 5, "mirror-5"], ["", 7, "mirror-7"]])("%s", (n, seq, want) => {
        expect(defaultMirrorName(n, seq)).toBe(want);
        expect(NAME_RE.test(defaultMirrorName(n, seq))).toBe(true);
    });
    it("a 60-character name is cut to ≤ 40 characters and stays valid", () => {
        const out = defaultMirrorName("a".repeat(60), 12);
        expect(out.length).toBeLessThanOrEqual(40);
        expect(NAME_RE.test(out)).toBe(true);
        const dashed = defaultMirrorName(`${"a".repeat(32)}-${"b".repeat(20)}`, 4);
        expect(NAME_RE.test(dashed)).toBe(true);
    });
});

describe("buildCreateInput (DD-5)", () => {
    const base = {stackId: ID, rpId: ID, runnerAgentId: ID, name: "my-shop-1", access: {service: "web", target: 8080}, httpPath: "/" as string | null, actions: {}, typed: {}, ack: true};
    it("defaults send NO env overrides and pass the server schema", () => {
        const out = buildCreateInput(base, [web, db]);
        expect(out.policy.env).toEqual({});
        expect(out.keepConfirmations).toEqual({});
        expect(CreateMirrorRequest.safeParse(out).success).toBe(true);
    });
    it("only overrides are sent; keep_exact is always present with its typed phrase", () => {
        const phrase = keepConfirmPhrase("web", "DB_PASSWORD");
        const out = buildCreateInput({...base, actions: {web: {DB_PASSWORD: "keep_exact", SMTP_URL: "disable", APP_NAME: "drop"}}, typed: {"web.DB_PASSWORD": phrase, "web.APP_NAME": "ignored"}}, [web, db]);
        expect(out.policy.env).toEqual({web: {DB_PASSWORD: "keep_exact", APP_NAME: "drop"}});
        expect(out.keepConfirmations).toEqual({"web.DB_PASSWORD": phrase});
        expect(CreateMirrorRequest.safeParse(out).success).toBe(true);
    });
    it("http_path null (no web page) is accepted", () => expect(CreateMirrorRequest.safeParse(buildCreateInput({...base, httpPath: null}, [web])).success).toBe(true));
});

describe("keepPending / changedCount", () => {
    const actions = {web: {DB_PASSWORD: "keep_exact" as const, APP_NAME: "drop" as const}};
    it("a kept key without its exact phrase is pending (case and spaces matter)", () => {
        expect(keepPending(actions, {}, [web])).toEqual(["web.DB_PASSWORD"]);
        expect(keepPending(actions, {"web.DB_PASSWORD": "keep web.db_password"}, [web])).toEqual(["web.DB_PASSWORD"]);
        expect(keepPending(actions, {"web.DB_PASSWORD": "KEEP web.DB_PASSWORD "}, [web])).toEqual(["web.DB_PASSWORD"]);
        expect(keepPending(actions, {"web.DB_PASSWORD": "KEEP web.DB_PASSWORD"}, [web])).toEqual([]);
    });
    it("nothing kept ⇒ nothing pending; changedCount counts departures from the recommendation", () => {
        expect(keepPending({}, {}, [web])).toEqual([]);
        expect(changedCount(actions, [web])).toBe(2);
        expect(changedCount({}, [web, db])).toBe(0);
    });
});

describe("createBlockReason (first failing reason)", () => {
    const ok = {preview: {outcome: "ready", blockers: [], actions: 3, containsPersonalData: true, optIn: true, runnerIsolation: "isolated"}, ack: true, needsAck: true, name: "shop-1", locked: false, keepPending: 0};
    const R = MIRRORS.review.reasons;
    it("enabled when everything holds", () => expect(createBlockReason(ok)).toBeNull());
    it("order: busy, locked, preview, blocked, isolation, name, keep, ack", () => {
        expect(createBlockReason({...ok, busy: true})).toBe(MIRRORS.review.creating);
        expect(createBlockReason({...ok, locked: true, preview: null})).toBe(R.locked);
        expect(createBlockReason({...ok, preview: null})).toBe(R.preview);
        expect(createBlockReason({...ok, preview: {...ok.preview, outcome: "blocked"}, ack: false})).toBe(R.blocked);
        expect(createBlockReason({...ok, preview: {...ok.preview, runnerIsolation: "unknown"}, name: "!"})).toBe(R.isolation);
        expect(createBlockReason({...ok, name: "Bad Name", keepPending: 1})).toBe(R.name);
        expect(createBlockReason({...ok, keepPending: 2, ack: false})).toBe(R.keep);
        expect(createBlockReason({...ok, ack: false})).toBe(R.ack);
        expect(createBlockReason({...ok, ack: false, needsAck: false})).toBeNull();
    });
});

describe("settled (progress poll stops)", () => {
    const view = (state: string, wipeState: string | null): MirrorView => ({mirror: {id: ID, name: "m", status: "creating", runnerName: "r", stackId: ID, activeRevisionId: null, createdAt: ""}, privacy: {containsPersonalData: null, optIn: false},
        revisions: [{id: ID, seq: 1, state, reason: null, failedStep: null, steps: [], gates: {expected_data: null, db_health: null, app_smoke: null, isolation: null, side_effects: null}, refusals: [], services: [], hostPort: 41000, rpSequence: 1, readiedAt: null, wipeState, deadlineAt: "", createdAt: ""}]});
    it("ready ⇒ settled; active ⇒ not", () => {
        expect(settled(view("ready", null))).toBe(true);
        for (const s of ["requested", "validating", "staging", "starting", "healthchecking"]) expect(settled(view(s, null))).toBe(false);
    });
    it("terminal ⇒ settled only once the wipe is over (verified / not_needed / failed)", () => {
        for (const s of ["blocked", "failed", "cancelled"]) {
            expect(settled(view(s, null))).toBe(false);
            expect(settled(view(s, "running"))).toBe(false);
            for (const w of ["verified", "not_needed", "failed"]) expect(settled(view(s, w))).toBe(true);
        }
    });
    it("no revision ⇒ settled", () => expect(settled({...view("ready", null), revisions: []})).toBe(true));
});

describe("pins and exhaustiveness", () => {
    it("the local HTTP path regex equals the server's", () => expect(String(HTTP_PATH_RE_LOCAL)).toBe(String(HTTP_PATH_RE)));
    it("every refusal / reason / agent code / step / gate / env action has a non-empty sentence", () => {
        for (const t of [...Object.values(MIRROR_REFUSAL_TEXT), ...Object.values(REASON_TEXT), ...Object.values(STEP_TEXT), ...Object.values(GATE_TEXT), ...Object.values(ENV_ACTION_TEXT), ...Object.values(RUNNER_REASON_TEXT)]) expect(t.length).toBeGreaterThan(3);
        for (const c of MIRROR_REASONS) expect(REASON_TEXT[c]).toBeTruthy();
        for (const c of MIRROR_AGENT_CODES) expect(REASON_TEXT[c]).toBeTruthy();
        for (const s of MIRROR_STEPS) expect(STEP_TEXT[s]).toBeTruthy();
        for (const g of GATES) expect(GATE_TEXT[g]).toBeTruthy();
    });
    it("unknown codes fall back to a generic sentence (never undefined, never the raw code)", () => {
        expect(refusalText("totally_new")).toMatch(/could not be created/);
        expect(reasonText("totally_new")).not.toContain("totally_new");
        expect(reasonText(null)).toBeTruthy();
        expect(retryText("rate_limited", 12)).toContain("12 s");
    });
    it("the ADR-009 §4 banner is exact", () => expect(BANNER("lab-runner")).toBe("This mirror contains a copy of real production data, including personal data. It lives only on the runner `lab-runner`. Do not share access."));
    it("the Ready headline never says verified or restore-tested", () => expect(MIRRORS.progress.ready("r1")).not.toMatch(/verified|restore-tested/i));
});
