import {describe, expect, it} from "vitest";
import {PRIMARY_STATES} from "@/fork/completeness/types";
import type {ProtectionView} from "@/fork/completeness/view";
import {classifyStack, fixHref, groupAgentIssues, STRIP_REASONS, type StripBucket} from "@/fork/stacks/safety";

const SID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";
const view = (primary: ProtectionView["primary"], f: Partial<ProtectionView["facets"]> = {}): ProtectionView => ({
    primary, complete: true,
    counts: {total: 1, captured: 1, gaps: 0, blockers: 0, warnings: 0, external: 0, excluded: 0, accepted: 0},
    recoveryPoints: {verified: 0, pending: 0},
    facets: {
        lastGoodBackup: {hoursAgo: null, verifying: false}, testRestore: {daysAgo: null}, deletable: "no", hostCompromise: false, consistency: [],
        pausedAfterReauthorization: false, inventoryStale: false, configLocked: false, ...f,
    },
});

describe("§4.6 'Am I safe?' mapping — every primary state", () => {
    const EXPECT: Record<string, StripBucket> = {
        protected: "safe", failed: "needs_attention", partial: "needs_attention", stale: "needs_attention", kit_not_verified: "needs_attention",
        unprotected: "not_protected", awaiting_first_backup: "not_protected",
    };
    it("covers all primary states of the precedence table", () => expect(Object.keys(EXPECT).sort()).toEqual([...PRIMARY_STATES].sort()));
    it.each(Object.entries(EXPECT))("%s (no warning facet) → %s", (primary, bucket) => {
        expect(classifyStack(view(primary as ProtectionView["primary"])).bucket).toBe(bucket);
    });
    it("Protected with no warning is Safe and has no reason", () => expect(classifyStack(view("protected"))).toEqual({bucket: "safe", reasons: []}));
});

describe("warning facets (3/4, 6, 7, configuration locked) move ONLY a Protected stack to Needs attention", () => {
    const FACETS: [string, Partial<ProtectionView["facets"]>, string][] = [
        ["facet 3/4 deletable from the source host (yes / not checked on an active policy)", {deletable: "yes", hostCompromise: true}, "host_compromise"],
        ["facet 3/4 not checked (fails closed)", {deletable: "not_checked", hostCompromise: true}, "host_compromise"],
        ["facet 6 paused after re-authorization", {pausedAfterReauthorization: true}, "paused"],
        ["facet 7 inventory stale", {inventoryStale: true}, "inventory_stale"],
        ["configuration locked", {configLocked: true}, "config_locked"],
    ];
    it.each(FACETS)("%s", (_n, f, reason) => {
        expect(classifyStack(view("protected", f))).toEqual({bucket: "needs_attention", reasons: [reason]});
        // an unprotected / awaiting stack stays Not protected whatever the facets say (spec list is literal)
        expect(classifyStack(view("unprotected", f)).bucket).toBe("not_protected");
        expect(classifyStack(view("awaiting_first_backup", f)).bucket).toBe("not_protected");
        // an already-attention stack keeps its primary reason first and adds the warning
        expect(classifyStack(view("partial", f)).reasons).toEqual(["partial", reason]);
    });
    it("informational facets never move a stack: consistency (5), last good (1), test restore (2), deletable 'no'", () => {
        const v = view("protected", {consistency: [{member: "db", level: "files_copied_running"}], lastGoodBackup: {hoursAgo: 3, verifying: true}, testRestore: {daysAgo: 400}, deletable: "no"});
        expect(classifyStack(v).bucket).toBe("safe");
    });
    it("all warnings together are all listed, in a stable order", () => {
        expect(classifyStack(view("protected", {hostCompromise: true, pausedAfterReauthorization: true, inventoryStale: true, configLocked: true}), true).reasons)
            .toEqual(["host_compromise", "paused", "inventory_stale", "config_locked", "agent_poll_failing"]);
    });
});

describe("agent poll failing", () => {
    it("maps a Protected stack to Needs attention and is added to an already-attention stack", () => {
        expect(classifyStack(view("protected"), true)).toEqual({bucket: "needs_attention", reasons: ["agent_poll_failing"]});
        expect(classifyStack(view("failed"), true).reasons).toEqual(["failed", "agent_poll_failing"]);
        expect(classifyStack(view("unprotected"), true).bucket).toBe("not_protected");
    });
    it("is reported ONCE per agent listing every affected stack — never N duplicates (two stacks, one agent ⇒ one item)", () => {
        const rows = [
            {agentId: "a1", agentName: "host-1", stackId: "s1", stackName: "shop"},
            {agentId: "a1", agentName: "host-1", stackId: "s2", stackName: "blog"},
            {agentId: "a1", agentName: "host-1", stackId: "s2", stackName: "blog"}, // same stack, second member
            {agentId: "a2", agentName: "host-2", stackId: "s3", stackName: "wiki"},
        ];
        expect(groupAgentIssues(rows)).toEqual([
            {agentName: "host-1", stacks: [{id: "s2", name: "blog"}, {id: "s1", name: "shop"}]},
            {agentName: "host-2", stacks: [{id: "s3", name: "wiki"}]},
        ]);
    });
});

describe("no readable inventory", () => {
    it("is Not protected with an honest reason (nothing is known to be backed up)", () => expect(classifyStack(null)).toEqual({bucket: "not_protected", reasons: ["no_inventory"]}));
});

describe("fix links (EU-15): every reason has one", () => {
    it.each(STRIP_REASONS)("%s → a dashboard path", (r) => {
        const href = fixHref(r, SID);
        expect(href.startsWith("/dashboard/")).toBe(true);
        expect(href).not.toMatch(/\/\/|\.\./);
    });
    it("targets", () => {
        expect(fixHref("failed", SID)).toBe(`/dashboard/stacks/${SID}?tab=activity`);
        expect(fixHref("partial", SID)).toBe(`/dashboard/stacks/${SID}?tab=configuration`);
        expect(fixHref("unprotected", SID)).toBe(`/dashboard/stacks/${SID}/configure`);
        expect(fixHref("inventory_stale", SID)).toBe("/dashboard/integrations");
    });
});
