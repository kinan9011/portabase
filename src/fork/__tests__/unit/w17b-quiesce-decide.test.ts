import {describe, expect, it} from "vitest";
import {decideQuiesce, type QuiesceDecisionInput} from "@/fork/quiesce/decide";
import {quiesceAlert} from "@/fork/quiesce/alert";
import type {OkPlan} from "@/fork/quiesce/plan";

const PLAN: OkPlan = {ok: true, stopOrder: [{service: "web", container_id: "aaaaaaaaaaaa"}], startOrder: ["web"], windowMembers: ["v"], preMembers: [], notRunning: []};
const base = (): QuiesceDecisionInput => ({flagOn: true, mode: "on", policy: {enabled: true, services: ["web"], maxStopSeconds: 600, enabledBy: "u1"}, enablerHasRight: true, agentEnrolled: true,
    agentCapabilities: ["channel.v1", "quiesce.v1"], activeRestoreOnAgent: false, plan: PLAN});

describe("W17b decideQuiesce precedence", () => {
    it("uses the composite task when everything holds", () => expect(decideQuiesce(base())).toEqual({use: true, plan: PLAN}));
    it("policy off / missing ⇒ no quiesce and NO notice (reason null), even with the flag off", () => {
        expect(decideQuiesce({...base(), policy: null})).toEqual({use: false, reason: null});
        expect(decideQuiesce({...base(), flagOn: false, policy: {...base().policy!, enabled: false}})).toEqual({use: false, reason: null});
    });
    it("every skip reason, in the documented order (each earlier one hides the later ones)", () => {
        const steps: [Partial<QuiesceDecisionInput>, string][] = [
            [{flagOn: false}, "flag_off"], [{mode: "locked"}, "locked"], [{mode: "off"}, "locked"], [{agentEnrolled: false}, "agent_unenrolled"], [{agentCapabilities: ["channel.v1"]}, "capability_missing"],
            [{enablerHasRight: false}, "enabler_lost"], [{policy: {...base().policy!, enabledBy: null}}, "enabler_lost"], [{activeRestoreOnAgent: true}, "restore_busy"],
            [{plan: null}, "plan_blocked"], [{plan: {ok: false, blockers: [{code: "no_services"}]}}, "plan_blocked"],
        ];
        for (const [over, reason] of steps) expect(decideQuiesce({...base(), ...over}), reason).toEqual({use: false, reason});
        const all: Partial<QuiesceDecisionInput> = {flagOn: false, mode: "locked", agentEnrolled: false, agentCapabilities: [], enablerHasRight: false, activeRestoreOnAgent: true, plan: null};
        const order = ["flag_off", "locked", "agent_unenrolled", "capability_missing", "enabler_lost", "restore_busy", "plan_blocked"];
        let cur = {...base(), ...all};
        for (const want of order) {
            expect((decideQuiesce(cur) as {reason: string}).reason).toBe(want);
            if (want === "flag_off") cur = {...cur, flagOn: true}; else if (want === "locked") cur = {...cur, mode: "on"}; else if (want === "agent_unenrolled") cur = {...cur, agentEnrolled: true};
            else if (want === "capability_missing") cur = {...cur, agentCapabilities: ["quiesce.v1"]}; else if (want === "enabler_lost") cur = {...cur, enablerHasRight: true}; else if (want === "restore_busy") cur = {...cur, activeRestoreOnAgent: false};
        }
    });
});

describe("W17b alert condition (relative clocks)", () => {
    const now = new Date(Date.now() + 5 * 3600_000);
    const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000);
    it("restart_failed and unconfirmed are always active; restarted / skipped / refused never", () => {
        expect(quiesceAlert({state: "restart_failed", stoppedAt: at(1), maxStopSeconds: 600}, now).active).toBe(true);
        expect(quiesceAlert({state: "unconfirmed", stoppedAt: null, maxStopSeconds: 600}, now).active).toBe(true);
        for (const s of ["restarted", "skipped", "refused", "not_started", "requested", "stop_failed"] as const) expect(quiesceAlert({state: s, stoppedAt: at(500), maxStopSeconds: 600}, now).active, s).toBe(false);
        expect(quiesceAlert(null, now).active).toBe(false);
    });
    it("stopped: active only past max_stop + 10 min grace", () => {
        expect(quiesceAlert({state: "stopped", stoppedAt: at(10 + 9), maxStopSeconds: 600}, now).active).toBe(false);
        const a = quiesceAlert({state: "stopped", stoppedAt: at(10 + 11), maxStopSeconds: 600}, now);
        expect(a.active).toBe(true);
        expect(a.since?.getTime()).toBe(at(21).getTime());
        expect(quiesceAlert({state: "stopped", stoppedAt: null, maxStopSeconds: 600}, now).active).toBe(false);
    });
});
