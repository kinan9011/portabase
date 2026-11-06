import {describe, expect, it} from "vitest";
import {isSensitiveKey, MAX_DETAILS_BYTES, redactDetails, REDACTED} from "@/fork/audit";

const CANARY = "canary-SECRET-value-9f3a";
const flat = (x: unknown) => JSON.stringify(x);

describe("audit redaction (SEC-07 denylist: key, token, secret, password, authorization, env values)", () => {
    it.each(["apiKey", "api_key", "x-api-key", "accessToken", "refresh_token", "secret", "clientSecret", "password", "PASSWD", "Authorization", "cookie", "set-cookie", "sessionId", "privateKey", "credentials", "env", "environment", "ENV_VALUES"])(
        "key %s ⇒ value redacted", (k) => {
            const out = redactDetails({[k]: CANARY, nested: {[k]: CANARY}});
            expect(flat(out)).not.toContain(CANARY);
            expect(out[k]).toBe(REDACTED);
        });
    it.each(["env_keys", "key_names", "kid", "action", "count", "host_role", "codes"])("benign/safe name %s keeps its value", (k) => {
        expect(redactDetails({[k]: "visible"})[k]).toBe("visible");
    });
    it("isSensitiveKey normalises separators and case", () => {
        expect(isSensitiveKey("X-Api-Key")).toBe(true);
        expect(isSensitiveKey("env_keys")).toBe(false);
    });
    it("scrubs secrets inside VALUES: bearer/basic, URL userinfo, query secrets, PEM", () => {
        const out = redactDetails({
            msg: `failed with Bearer ${CANARY}abcdefgh`,
            url: `https://admin:${CANARY}@arcane.lab:3552/api?apiKey=${CANARY}&x=1`,
            basic: `Basic ${CANARY}Zm9v`,
            pem: `-----BEGIN RSA PRIVATE KEY-----\n${CANARY}\n-----END RSA PRIVATE KEY-----`,
        });
        expect(flat(out)).not.toContain(CANARY);
        expect(String(out.url)).toContain("arcane.lab:3552");
    });
    it("canary inside arrays, nested objects and Error objects never survives; Error keeps only its class", () => {
        const out = redactDetails({list: [{token: CANARY}, `Bearer ${CANARY}xxxxxxx`], deep: {a: {b: {c: {password: CANARY}}}}, err: new Error(`boom ${CANARY}`)});
        expect(flat(out)).not.toContain(CANARY);
        expect((out.err as {name: string}).name).toBe("Error");
    });
    it("caps: long strings truncated, depth limited, oversized details replaced", () => {
        expect(String(redactDetails({s: "x".repeat(5000)}).s).length).toBeLessThan(600);
        let deep: any = "leaf"; for (let i = 0; i < 20; i++) deep = {n: deep};
        expect(flat(redactDetails(deep))).toContain("depth-limit");
        const big = Object.fromEntries(Array.from({length: 50}, (_, i) => [`k${i}`, "y".repeat(500)]));
        expect(Buffer.byteLength(flat(redactDetails(big)))).toBeLessThanOrEqual(MAX_DETAILS_BYTES);
    });
    it("non-object input is wrapped, never throws", () => {
        expect(redactDetails("plain")).toEqual({value: "plain"});
        expect(redactDetails(null)).toEqual({});
        expect(redactDetails(undefined)).toEqual({});
        expect(() => redactDetails({f: () => 1, s: Symbol("x"), b: 10n})).not.toThrow();
    });
});
