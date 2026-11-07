import {describe, expect, it} from "vitest";
import {SCHEDULE_PRESETS} from "@/fork/schedule/schedule";
import {PLAN_VERDICTS} from "@/fork/stack-policy/preview";
import {SELECTION_ISSUE_CODES} from "@/fork/stack-policy/validate-selection";
import type {ActivateReason} from "@/fork/stack-policy/activate";
import {CONFIGURE, SCHEDULE_TAB} from "@/fork/ui/labels";

describe("W11 labels: every closed vocabulary has copy", () => {
    it("selection issue codes, plan verdicts, presets, blockers", () => {
        for (const c of SELECTION_ISSUE_CODES) expect(CONFIGURE.fieldErrors[c], c).toMatch(/\S/);
        for (const v of PLAN_VERDICTS) expect(CONFIGURE.resources.plan[v], v).toMatch(/\S/);
        for (const p of SCHEDULE_PRESETS) expect(CONFIGURE.schedule.presets[p], p).toMatch(/\S/);
        for (const b of ["locked", "encryption_off", "no_channel_selected", "local_only_channels", "invalid_schedule", "invalid_retention", "selection_issues"] as const) expect(CONFIGURE.review.blockers[b], b).toMatch(/\S/);
    });
    it("every activation refusal reason the server can return has its own sentence", () => {
        const reasons: ActivateReason[] = ["no_agent", "agent_unavailable", "agent_version", "environment_disabled", "channels_unavailable", "secret_required", "project_name_taken", "method_change", "no_inventory", "stack_gone",
            "encryption_required", "no_channel_selected", "local_only_channels", "selection_invalid", "activation_failed"];
        for (const r of reasons) expect(CONFIGURE.review.failure[r], r).toMatch(/\S/);
        for (const c of ["forbidden", "not_found", "locked", "rate_limited", "invalid_input", "refused"]) expect(CONFIGURE.review.failure[c], c).toMatch(/\S/);
    });
    it("the two sentences the wave file quotes are verbatim", () => {
        expect(CONFIGURE.storage.rule.local_only_channels).toBe("Local storage lives on the dashboard host and is lost with it; add an off-host channel.");
        expect(CONFIGURE.consistency.stopLabel).toContain("not available until release R2");
        expect(SCHEDULE_TAB.consistency.crash).toBeTruthy();
    });
    it("no copy claims protection that does not exist yet", () => {
        const all = JSON.stringify([CONFIGURE, SCHEDULE_TAB]);
        expect(all).not.toMatch(/all good|fully protected|you are safe|backup complete/i);
    });
});
