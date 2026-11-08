/** W17b browser DTO: strict, service names + container id prefixes only — no agent credential, no task payload, no full ids. */
import type {PlanBlockerCode, QuiesceReason, QuiesceSkipReason, QuiesceState} from "./vocab";

export type QuiesceAvailability =
    | {state: "available"}
    | {state: "unavailable"; reason: QuiesceSkipReason | "no_policy" | "no_inventory" | "no_agent" | "plan_blocked"};

export type QuiesceViewDto = {
    stackId: string;
    stackName: string;
    flagOn: boolean;
    hostRole: "production" | "test" | null;
    availability: QuiesceAvailability;
    enabled: boolean;
    enabledAt: string | null;
    services: string[];
    maxStopSeconds: number;
    defaults: string[];
    allServices: {name: string; running: boolean}[];
    plan: {ok: true; stopOrder: string[]; startOrder: string[]; windowMembers: string[]; preMembers: string[]; notRunning: string[]} | {ok: false; blockers: {code: PlanBlockerCode; service?: string; member?: string}[]} | null;
    last: null | {
        runId: string; state: QuiesceState | null; reason: QuiesceReason | null; releasedBy: string | null; windowIntact: boolean | null; downtimeMs: number | null;
        stoppedAt: string | null; startedAt: string; containers: {service: string; outcome: string}[];
    };
    alert: {active: boolean; since: string | null; canStartNow: boolean};
};
