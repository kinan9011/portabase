import {describe, expect, it} from "vitest";
import type {RestorePlanView} from "@/fork/restore/service";
import {ACTION_KIND_TEXT, ACTION_OP_TEXT, COPY_DECK_KEYS, copyByKey, FAILURE_GROUPS, PLAN_REASON_TEXT, PLAN_REFUSAL_TEXT, PRECONDITION_TEXT, RULE_TEXT, STEP_TEXT, STATE_CHIP, VOCABULARIES} from "@/fork/ui/recovery/labels";
import {blockingItems, defaultRestoreFolder, elapsed, failureSentence, goState, isPolling, orderRuns, relative, runHeadline, stepStatus, toneOf, toPlanUi, formatInstant, newPlanHref, type RunUi} from "@/fork/ui/recovery/model";

const now = new Date();
const DAY = 86_400_000;
const CANARY_PATH = "/srv/CANARY_PATH_ABC/data";

const view = (over: Partial<RestorePlanView> = {}): RestorePlanView => ({
    id: "p1", planHash: "h".repeat(64), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + DAY).toISOString(), freshness: "fresh", outcome: "ready", purpose: "restore", mode: "new_stack",
    stackId: "s1", targetAgentId: "a1", totals: {artifacts: 3, actions: 4, plaintextBytes: 2048},
    rp: {id: "r1", sequence: 7, verifiedAt: now.toISOString()},
    target: {agentName: "clean-host", hostRole: "production", hostRoleSource: "default", project: "notes", restoreRoot: "/srv/restore"},
    actions: [{id: "a0123456789ab", order: 1, phase: "data", kind: "restore_volume", op: "create", risk: "safe", destructive: false, resource_key: "volume:data", artifact_ids: ["00000000-0000-4000-8000-000000000001"],
        expect: {plaintext_sha256: "c".repeat(64), plaintext_size: 10}, source: {role: "volume", dbms: "docker-volume", member: "volume_data", original_path: CANARY_PATH, service: null},
        destination: {kind: "volume", name: "notes_data", path: `${CANARY_PATH}/dest`, relative_path: "notes/data"}, reasons: []}],
    preconditions: [], approvalsRequired: [{kind: "production_target", capability: "restore.production.approve"}], approvalsGiven: [], secrets: [{service: "web", key: "SMTP_PASSWORD", origin: "env_file", class: "require_input", reason: null}],
    decisions: [], composeFindings: [{rule_id: "docker_sock", service: "traefik", informational: true}], composeFindingsBasis: "inventory", blockers: [], ...over,
} as RestorePlanView);

const run = (over: Partial<RunUi> = {}): RunUi => ({
    id: "11111111-2222-4333-8444-555555555555", state: "running", reason: null, failedStep: null, verification: null, steps: [], services: [], cleanup: null, cancelRequested: false,
    createdAt: new Date(now.getTime() - 2 * DAY).toISOString(), finishedAt: null, deadlineAt: new Date(now.getTime() + DAY).toISOString(), targetAgentName: "clean-host", ...over,
});
const step = (over: Partial<RunUi["steps"][number]> = {}): RunUi["steps"][number] => ({name: "stage", status: "pending", startedAt: null, finishedAt: null, code: null, attempts: 0, task: null, ...over});

const RAW_CODE = /[a-z]+_[a-z_]+/;

describe("W18b copy: every backend code has a sentence, never a raw code", () => {
    it("exhaustive over the closed vocabularies at runtime (types cover the type-only unions)", () => {
        const ctx = {machine: "clean-host", name: "notes", subject: "8080", roots: "/srv"};
        for (const r of VOCABULARIES.REASONS) { const t = PLAN_REASON_TEXT[r](ctx); expect(t.length, r).toBeGreaterThan(8); expect(t, r).not.toMatch(RAW_CODE); }
        for (const r of VOCABULARIES.REFUSALS) { const t = PLAN_REFUSAL_TEXT[r]; expect(t.length, r).toBeGreaterThan(8); expect(t, r).not.toMatch(RAW_CODE); }
        for (const r of VOCABULARIES.DENY_RULE_IDS) { const t = RULE_TEXT[r]("traefik"); expect(t, r).toContain("traefik"); expect(t, r).not.toMatch(RAW_CODE); }
        for (const p of VOCABULARIES.PRECONDITIONS) expect(PRECONDITION_TEXT[p].length, p).toBeGreaterThan(5);
        for (const k of VOCABULARIES.ACTION_KINDS) expect(ACTION_KIND_TEXT[k]("x").length, k).toBeGreaterThan(5);
        for (const o of VOCABULARIES.ACTION_OPS) expect(ACTION_OP_TEXT[o].length, o).toBeGreaterThan(3);
        for (const s of VOCABULARIES.RESTORE_STEPS) { expect(STEP_TEXT[s].length, s).toBeGreaterThan(5); expect(STEP_TEXT[s], s).not.toMatch(RAW_CODE); }
        for (const s of VOCABULARIES.RESTORE_RUN_STATES) expect(STATE_CHIP[s].length, s).toBeGreaterThan(5);
        for (const code of [...VOCABULARIES.ORCH_REASONS, ...VOCABULARIES.RESTORE_REASONS]) {
            const f = failureSentence(code, "clean-host");
            expect(f.text.length, code).toBeGreaterThan(8);
            expect(f.text, code).not.toMatch(RAW_CODE);
            expect(FAILURE_GROUPS.some((g) => (g.codes as readonly string[]).includes(code)), `${code} has a group`).toBe(true);
        }
    });
    it("an unknown code ⇒ the generic sentence + a Reference; a malformed code ⇒ no reference", () => {
        const u = failureSentence("brand_new_code", "clean-host");
        expect(u.text).toContain("clean-host"); expect(u.reference).toBe("brand_new_code");
        expect(failureSentence("x y", "clean-host").reference).toBeNull();
        expect(failureSentence(null, "clean-host").reference).toBeNull();
        expect(failureSentence("execution_error", "clean-host").reference).toBe("execution_error");
        expect(failureSentence("manifest_mismatch", "clean-host").reference).toBeNull();
    });
    it("the copy deck has the 39 W18-D key labels, every one a non-empty English string", () => {
        expect(COPY_DECK_KEYS.length).toBe(39);
        for (const k of COPY_DECK_KEYS) expect(copyByKey(k).length, k).toBeGreaterThan(2);
        expect(copyByKey("nav")).toBe("Recovery");
        expect(copyByKey("rp.verifying")).toBe("Backed up · verifying");
    });
});

describe("W18b model: honesty and safety rules (each test fails if the rule is broken)", () => {
    it("m1: incomplete / failed / cancelled / awaiting never get the success tone; only succeeded does", () => {
        for (const s of ["running", "awaiting_approval", "incomplete", "failed", "cancelled"]) expect(toneOf(s), s).not.toBe("success");
        expect(toneOf("succeeded")).toBe("success");
        expect(runHeadline(run({state: "incomplete", services: [{service: "web", state: "running"}, {service: "migrate", state: "exited"}]})).tone).toBe("warning");
        expect(runHeadline(run({state: "incomplete", services: [{service: "migrate", state: "exited"}]})).text).toContain("migrate");
        expect(runHeadline(run({state: "failed", failedStep: "stage", reason: "artifact_unavailable"})).tone).toBe("danger");
        expect(runHeadline(run({state: "failed", failedStep: "stage", reason: "artifact_unavailable"})).text).toContain("Download the backup");
        expect(runHeadline(run({state: "succeeded", verification: "started"})).text).toContain("the app was started");
        expect(runHeadline(run({state: "succeeded", verification: "data_only"})).text).toContain("The app was not started");
    });
    it("m2: Go is disabled while the plan is blocked / stale / expired / the actor cannot execute", () => {
        const base = {plan: toPlanUi(view({approvalsRequired: []})), overrides: {missingRequired: 0}, canExecute: true, canApproveProduction: true, acceptMissing: false};
        expect(goState(base).enabled).toBe(true);
        expect(goState({...base, plan: toPlanUi(view({approvalsRequired: [], outcome: "blocked"}))}).enabled).toBe(false);
        expect(goState({...base, plan: toPlanUi(view({approvalsRequired: [], freshness: "stale"}))}).reason).toContain("Something changed");
        expect(goState({...base, plan: toPlanUi(view({approvalsRequired: [], freshness: "expired"}))}).reason).toContain("expired");
        expect(goState({...base, canExecute: false}).reason).toContain("organization admins");
        expect(goState({...base, locked: true}).enabled).toBe(false);
    });
    it("m4: a production plan needs the typed phrase 'RESTORE <project>'; only the owner/sysadmin can; missing values need the tick", () => {
        const p = toPlanUi(view());
        const i = {plan: p, overrides: {missingRequired: 1}, canExecute: true, canApproveProduction: true, acceptMissing: false};
        expect(goState(i).typed).toBe("RESTORE notes");
        expect(goState(i).enabled).toBe(false);
        expect(goState({...i, acceptMissing: true}).enabled).toBe(true);
        expect(goState({...i, canApproveProduction: false, acceptMissing: true}).reason).toContain("organization owner or a system administrator");
        expect(goState({...i, plan: toPlanUi(view({approvalsRequired: []}))}).typed).toBeNull();
    });
    it("DD-5 items: blocked, needs confirmation → approved, one will-ask per service, values missing", () => {
        const p = toPlanUi(view({blockers: ["project_name_conflict"]}));
        const items = blockingItems(p, {missingRequired: 2});
        expect(items.map((x) => x.kind)).toEqual(["blocked", "needs_confirmation", "will_ask", "values_missing"]);
        expect(blockingItems(toPlanUi(view({approvalsGiven: [{kind: "production_target", approvedAt: now.toISOString()}]})), null).map((x) => x.kind)).toEqual(["approved", "will_ask"]);
        const blockedAction = toPlanUi(view({actions: [{...view().actions[0]!, risk: "blocked", reasons: ["volume_exists"]}]}));
        expect(blockingItems(blockedAction, null)[0]).toMatchObject({kind: "blocked", reasons: ["volume_exists"]});
    });
    it("m5: steps after a failure (failed WITHOUT a code) or pending in a terminal run are 'Not run', never 'Failed'", () => {
        expect(stepStatus(step({status: "failed", code: null}), "failed", "m")).toMatchObject({kind: "not_run", text: "Not run"});
        expect(stepStatus(step({status: "pending"}), "failed", "m").kind).toBe("not_run");
        expect(stepStatus(step({status: "pending"}), "cancelled", "m").kind).toBe("not_run");
        expect(stepStatus(step({status: "pending"}), "running", "m").kind).toBe("waiting");
        const f = stepStatus(step({status: "failed", code: "checksum_mismatch"}), "failed", "m");
        expect(f.kind).toBe("failed"); expect(f.reason).toContain("damaged");
    });
    it("DD-9 running steps: queued ⇒ waiting for the machine, leased ⇒ in progress, re-enqueued after expiry ⇒ retry text with the attempt number", () => {
        expect(stepStatus(step({status: "running", attempts: 1, task: {status: "queued", reason: null}}), "running", "clean-host").text).toBe("Waiting for clean-host to pick this up");
        expect(stepStatus(step({status: "running", attempts: 1, task: {status: "leased", reason: null}}), "running", "m").text).toBe("In progress");
        expect(stepStatus(step({status: "running", attempts: 2, task: {status: "queued", reason: null}}), "running", "m").text).toBe("The machine did not respond. Trying again (attempt 2 of 3)");
        expect(stepStatus(step({status: "done"}), "running", "m").kind).toBe("done");
    });
    it("m6: polling stops for every terminal state with no active cleanup, continues while a cleanup is in flight", () => {
        for (const s of ["running", "awaiting_approval"]) expect(isPolling({state: s, cleanup: null}), s).toBe(true);
        for (const s of ["succeeded", "incomplete", "failed", "cancelled"]) {
            expect(isPolling({state: s, cleanup: null}), s).toBe(false);
            expect(isPolling({state: s, cleanup: {status: "succeeded", reason: null, attempts: 1}}), s).toBe(false);
            expect(isPolling({state: s, cleanup: {status: "running", reason: null, attempts: 1}}), s).toBe(true);
            expect(isPolling({state: s, cleanup: {status: "queued", reason: null, attempts: 0}}), s).toBe(true);
        }
    });
    it("m7: toPlanUi has no original_path / path / artifact_ids / expect / resource_key at any depth, and no host path value", () => {
        const ui = toPlanUi(view());
        const keys: string[] = [];
        const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) { keys.push(k); walk(y); } };
        walk(ui);
        for (const bad of ["original_path", "path", "artifact_ids", "expect", "resource_key"]) expect(keys, bad).not.toContain(bad);
        expect(JSON.stringify(ui)).not.toContain("CANARY_PATH");
        expect(ui.actions[0]!.destination.relativePath).toBe("notes/data");
        expect(ui.secrets).toEqual([{service: "web", key: "SMTP_PASSWORD"}]);
    });
});

describe("W18b model: ordering, defaults and time helpers (explicit now)", () => {
    it("runs: active first, then newest", () => {
        const at = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
        expect(orderRuns([{id: "old-active", state: "running", createdAt: at(5)}, {id: "new-done", state: "succeeded", createdAt: at(0)}, {id: "mid-done", state: "failed", createdAt: at(2)}]).map((r) => r.id)).toEqual(["old-active", "new-done", "mid-done"]);
    });
    it("default folder: last used, else the first allowed root + /portabase-restore, else empty", () => {
        expect(defaultRestoreFolder({lastRestoreRoot: "/a", environments: []})).toBe("/a");
        expect(defaultRestoreFolder({lastRestoreRoot: null, environments: [{allowedPathRoots: ["/srv/"]}]})).toBe("/srv/portabase-restore");
        expect(defaultRestoreFolder({lastRestoreRoot: null, environments: []})).toBe("");
    });
    it("relative / elapsed / formatInstant use the given clock only", () => {
        expect(relative(new Date(now.getTime() - 2 * DAY), now)).toBe("2 days ago");
        expect(relative(new Date(now.getTime() - 30_000), now)).toBe("just now");
        expect(relative(new Date(now.getTime() - 90 * 60_000), now)).toBe("1 hour ago");
        expect(elapsed(new Date(now.getTime() - 125_000), now)).toBe("2 min 5 s");
        expect(formatInstant(new Date("2026-11-04T03:00:00Z"), "UTC")).toContain("03:00");
        expect(formatInstant(new Date("2026-11-04T03:00:00Z"), "Not/AZone")).toContain("2026");
    });
    it("the plan page's re-plan link carries ids and the sequence only", () => {
        expect(newPlanHref(toPlanUi(view()))).toBe("/dashboard/recovery/new?step=machine&stack=s1&point=7&machine=a1");
    });
});
