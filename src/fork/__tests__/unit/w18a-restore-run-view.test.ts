import {randomUUID} from "node:crypto";
import {describe, expect, it} from "vitest";
import {RestoreRunView, toRestoreRunView, type JournalView, type RunRow} from "@/fork/restore-run/view";

const CANARY = `CANARY_VIEW_${randomUUID()}`;
const T = new Date();
const run = (over: Partial<RunRow> = {}): RunRow => ({
    id: randomUUID(), organizationId: randomUUID(), stackId: randomUUID(), planId: randomUUID(), planHash: "a".repeat(64), rpId: randomUUID(), rpSequence: 3, targetAgentId: randomUUID(), targetAgentName: "restore-host",
    purpose: "restore", mode: "new_stack", state: "succeeded", reason: null, failedStep: null, verification: "started",
    steps: [{name: "verify_manifest", status: "done", attempts: 1, errors: 0}, {name: "probe", status: "done", attempts: 2, errors: 0, startedAt: T.toISOString(), finishedAt: T.toISOString()}, {name: "check_services", status: "done", attempts: 1, errors: 0}],
    confirmation: "typed", acceptMissingInputs: false,
    policyApproval: {v: 1, canary: CANARY}, policyApprovalSha256: "b".repeat(64), policyApprovedBy: `user-${CANARY}`, policyApprovedAt: T,
    services: [{service: "web", state: "running"}, {service: "db", state: "exited"}],
    cancelRequestedAt: null, cancelRequestedBy: `user-${CANARY}`, startedBy: `user-${CANARY}`, createdAt: T, deadlineAt: T, finishedAt: T, updatedAt: T, ...over,
});
const J = (step: string, status: string | null, reason: string | null = null, attempt = 1): JournalView => ({step, attempt, status, reason, attempts: 1});
const EXTRA = {awaiting: null, overrides: {applicable: true, missingRequired: 0, frozen: false}};

describe("W18a RestoreRunView (the allow-list the wizard reads)", () => {
    it("is strict: an extra key anywhere is rejected", () => {
        const v = toRestoreRunView(run(), [J("probe", "succeeded")], EXTRA);
        expect(RestoreRunView.safeParse(v).success).toBe(true);
        expect(RestoreRunView.safeParse({...v, extra: 1}).success).toBe(false);
        expect(RestoreRunView.safeParse({...v, steps: [{...v.steps[0], payload: "x"}]}).success).toBe(false);
        expect(RestoreRunView.safeParse({...v, overrides: {...v.overrides, values: "x"}}).success).toBe(false);
    });
    it("canaries in the approval token, user ids, hashes of users and unknown fields never reach the view; no key looks like url/path/payload/manifest/env/user", () => {
        const v = toRestoreRunView(run(), [J("probe", "succeeded")], EXTRA);
        expect(JSON.stringify(v)).not.toContain(CANARY);
        const keys: string[] = [];
        const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) { keys.push(k); walk(y); } };
        walk(v);
        expect(keys.filter((k) => /url|path|payload|manifest|env|user/i.test(k))).toEqual([]);
    });
    it("a task reason that is not a closed code is dropped; a service the agent reported with a hostile name is dropped; steps carry the newest journal row", () => {
        const bad = run({services: [{service: `web ${CANARY}`, state: "running"}]});
        const v = toRestoreRunView(bad, [J("probe", "failed", "Not A Code"), J("probe", "expired", null, 0)], EXTRA);
        expect(v.services).toEqual([]);
        expect(v.steps.find((s) => s.name === "probe")?.task).toEqual({status: "failed", reason: "Not A Code"}); // reasons are filtered when the journal is READ (journalOfRun); the view never invents one
    });
    it("what the operator still has to do: only a succeeded restore points at re-attaching backups (Adopt is deferred)", () => {
        expect(toRestoreRunView(run(), [], EXTRA).nextSteps).toEqual(["reattach_backups"]);
        for (const state of ["failed", "incomplete", "cancelled", "running", "awaiting_approval"]) expect(toRestoreRunView(run({state, verification: null, reason: state === "failed" || state === "incomplete" ? "stale" : null}), [], EXTRA).nextSteps).toEqual([]);
    });
    it("cleanup status comes from the newest cleanup journal row; no cleanup row ⇒ null; never a claim of 'tested' or 'verified'", () => {
        expect(toRestoreRunView(run({state: "failed", reason: "stale", verification: null}), [J("cleanup", "queued", null, 2), J("cleanup", "succeeded", null, 1)], EXTRA).cleanup).toEqual({status: "queued", reason: null, attempts: 1});
        expect(toRestoreRunView(run(), [], EXTRA).cleanup).toBeNull();
        expect(JSON.stringify(toRestoreRunView(run(), [], EXTRA))).not.toMatch(/tested|verified/i);
    });
});
