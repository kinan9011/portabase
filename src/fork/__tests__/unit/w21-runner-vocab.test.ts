import {describe, expect, it} from "vitest";
import {REASONS} from "@/fork/agent-channel/tasks";
import {isTargetedType, KNOWN_CAPABILITIES, PUBLIC_TASK_TYPES, RUNNER_CAPABILITY, RUNNER_TASK_TYPES, TASK_REQUIRES, TASK_TYPES, MAINT_TASK_TYPES} from "@/fork/agent-channel/vocab";
import {PROBE_KINDS} from "@/fork/runner/payload-schema";

/** Agent `Reject::code()` strings (src/fork/verify.rs) + the runner `Code::as_str()` strings (src/fork/runner/mod.rs), copied here on purpose: an unknown reason is a 400 and the task would hang. */
const AGENT_REJECT_CODES = ["bad_signature", "unknown_kid", "bad_envelope", "agent_mismatch", "enroll_mismatch", "target_mismatch", "expired", "not_yet_valid", "seq_rollback", "unsupported_type", "capability_missing", "role_forbidden", "payload_hash", "payload_invalid", "channel_disabled", "state_unavailable"];
const AGENT_RUNNER_CODES = ["payload_invalid", "docker_unavailable", "helper_failed", "wipe_incomplete", "deadline_exceeded"];

describe("W21 runner vocabulary", () => {
    it("runner_probe is targeted, requires exactly runner.v1, and is neither public nor maintenance", () => {
        expect(RUNNER_TASK_TYPES).toEqual(["runner_probe"]);
        expect(TASK_TYPES).toContain("runner_probe");
        expect(isTargetedType("runner_probe")).toBe(true);
        expect(TASK_REQUIRES.runner_probe).toEqual(["runner.v1"]);
        expect(RUNNER_CAPABILITY).toBe("runner.v1");
        expect((PUBLIC_TASK_TYPES as readonly string[]).includes("runner_probe")).toBe(false);
        expect((MAINT_TASK_TYPES as readonly string[]).includes("runner_probe")).toBe(false);
        expect(KNOWN_CAPABILITIES).toContain("runner.v1");
    });
    it("the dashboard accepts every reason the agent can report (role_forbidden, helper_failed, wipe_incomplete included)", () => {
        const accepted = new Set<string>(REASONS);
        for (const c of [...AGENT_REJECT_CODES, ...AGENT_RUNNER_CODES]) expect(accepted.has(c), c).toBe(true);
    });
    it("probe kinds are the closed three", () => {
        expect([...PROBE_KINDS]).toEqual(["tcp", "dns_tcp", "dns_name"]);
    });
});
