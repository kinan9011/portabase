import {randomUUID} from "node:crypto";
import {describe, expect, it} from "vitest";
import {DUMMY_HASH, generateCredential, matchCredential, sha256Hex} from "@/fork/agent-channel/credential";
import {sanitizePinned, validatePayload} from "@/fork/agent-channel/tasks";
import {KNOWN_CAPABILITIES, MAINT_CAPABILITY, MAINT_TASK_TYPES, PUBLIC_TASK_TYPES, TASK_REQUIRES, TASK_TYPES} from "@/fork/agent-channel/vocab";
import {enqueueTask} from "@/fork/agent-channel/tasks";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

const AGENT = randomUUID();

describe("matchCredential: three slots (A12)", () => {
    const [a, b, c] = [generateCredential(AGENT), generateCredential(AGENT), generateCredential(AGENT)];
    const secret = (x: {bearer: string}) => x.bearer.split(".")[2];
    it("names the slot that matched, in a fixed precedence, and null for none", () => {
        expect(matchCredential(secret(a), a.hash, b.hash, c.hash)).toBe("current");
        expect(matchCredential(secret(b), a.hash, b.hash, c.hash)).toBe("previous");
        expect(matchCredential(secret(c), a.hash, b.hash, c.hash)).toBe("pending");
        expect(matchCredential("x".repeat(43), a.hash, b.hash, c.hash)).toBeNull();
        expect(matchCredential(secret(c), a.hash, null, null)).toBeNull();
        expect(matchCredential(secret(c), a.hash, undefined)).toBeNull(); // W15 two-argument callers still work
        expect(matchCredential(secret(a), a.hash, null)).toBe("current");
    });
    it("an empty slot is the dummy hash: nobody's secret matches it", () => {
        expect(sha256Hex("x")).not.toBe(DUMMY_HASH);
        expect(matchCredential("", DUMMY_HASH, DUMMY_HASH, DUMMY_HASH)).toBeNull();
    });
});

describe("maintenance vocabulary", () => {
    it("the three maint types exist, need channel-maint.v1, and are not public", () => {
        expect([...MAINT_TASK_TYPES].sort()).toEqual(["pin_add", "pin_revoke", "rotate_credential"]);
        for (const t of MAINT_TASK_TYPES) { expect(TASK_REQUIRES[t]).toEqual([MAINT_CAPABILITY]); expect(TASK_TYPES).toContain(t); expect(PUBLIC_TASK_TYPES).not.toContain(t as never); }
        expect([...PUBLIC_TASK_TYPES]).toEqual(["noop"]);
        expect(KNOWN_CAPABILITIES).toContain(MAINT_CAPABILITY);
    });
    it("payload schemas are closed", () => {
        const k = testKeypair();
        expect(validatePayload("pin_add", {kid: k.kid, pem: k.publicKey})).toBeNull();
        expect(validatePayload("pin_add", {kid: k.kid, pem: k.publicKey, extra: 1})).toBe("payload_invalid");
        expect(validatePayload("pin_add", {kid: "XYZ", pem: k.publicKey})).toBe("payload_invalid");
        expect(validatePayload("pin_add", {kid: k.kid, pem: "x".repeat(5000)})).toBe("payload_invalid");
        expect(validatePayload("pin_revoke", {kid: k.kid})).toBeNull();
        expect(validatePayload("pin_revoke", {kid: k.kid, pem: "x"})).toBe("payload_invalid");
        expect(validatePayload("rotate_credential", {credential: generateCredential(AGENT).bearer})).toBeNull();
        for (const bad of ["fork.x.y", `fork.${AGENT}.short`, `Bearer fork.${AGENT}.${"A".repeat(43)}`, ""]) expect(validatePayload("rotate_credential", {credential: bad})).toBe("payload_invalid");
        expect(validatePayload("noop", {echo: "ok"})).toBeNull();
    });
});

describe("sanitizePinned (agent-reported, untrusted)", () => {
    it("accepts 1..8 distinct kids, sorted; everything else is null", () => {
        expect(sanitizePinned(["bbbbbbbbbbbb", "aaaaaaaaaaaa"])).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
        for (const bad of [null, "x", [], ["not-a-kid"], [7], ["aaaaaaaaaaaa", "aaaaaaaaaaaa"], Array.from({length: 9}, (_, i) => `00000000000${i}`.slice(-12)), ["AAAAAAAAAAAA"], {pinned: 1}]) expect(sanitizePinned(bad), JSON.stringify(bad)).toBeNull();
    });
});

describe("public enqueue", () => {
    it("refuses maintenance types before touching anything (zod enum = PUBLIC_TASK_TYPES)", async () => {
        const throwingDeps = new Proxy({}, {get() { throw new Error("must not be reached"); }}) as never;
        for (const type of MAINT_TASK_TYPES) expect(await enqueueTask(throwingDeps, {agentId: AGENT, type, payload: {}})).toMatchObject({ok: false, code: "invalid_input"});
    });
});
