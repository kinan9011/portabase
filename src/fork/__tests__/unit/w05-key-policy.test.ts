import {describe, expect, it} from "vitest";
import {evaluateKeyPermissions, findOwnKey} from "@/fork/arcane/key-policy";
import type {ApiKeyRowT} from "@/fork/arcane/schemas";

const KEY = "arc_abcd1234_SECRETREST";
const row = (perms: [string, string?][], o: Partial<ApiKeyRowT> = {}): ApiKeyRowT => ({id: "k-own", name: "fork", keyPrefix: "arc_abcd1234", kind: "scoped", permissions: perms.map(([permission, environmentId]) => ({permission, environmentId: environmentId ?? null})), ...o});
const MIN = (env: string): [string, string][] => ["projects:list", "containers:list", "volumes:list", "networks:list", "images:list"].map((p) => [p, env]);
const other = row([["apikeys:create"], ["containers:read", "0"]], {id: "k-other", keyPrefix: "arc_zzzz9999"});

describe("own-row discovery", () => {
    it("finds the own key by non-secret prefix among the owner's keys and ignores the others", () => {
        expect(findOwnKey([other, row([])], KEY)?.id).toBe("k-own");
        expect(findOwnKey([other], KEY)).toBeNull();
        expect(findOwnKey([row([], {keyPrefix: ""})], KEY)).toBeNull();
        expect(findOwnKey([row([], {keyPrefix: "ar"})], KEY)).toBeNull(); // too short to identify
    });
    it("two equally long matching prefixes are ambiguous → no own key", () => {
        expect(findOwnKey([row([], {id: "a"}), row([], {id: "b"})], KEY)).toBeNull();
        expect(findOwnKey([row([], {id: "a", keyPrefix: "arc_abcd"}), row([], {id: "b", keyPrefix: "arc_abcd1234"})], KEY)?.id).toBe("b");
    });
    it("no own row → key_unverifiable (refused, never probed)", () => {
        expect(evaluateKeyPermissions([other], KEY, {allowProjectsRead: false})).toMatchObject({ok: false, errorClass: "key_unverifiable"});
    });
});

describe("minimum = list permissions only, environment-scoped", () => {
    it("exact minimum on one environment → ok, not partial", () => {
        const r = evaluateKeyPermissions([other, row([["environments:list"], ...MIN("0")])], KEY, {allowProjectsRead: false});
        expect(r).toEqual({ok: true, keyId: "k-own", environmentIds: ["0"], missing: {}, missingGlobal: [], partial: false});
    });
    it("two environments", () => {
        const r = evaluateKeyPermissions([row([["environments:list"], ...MIN("0"), ...MIN("e2")])], KEY, {allowProjectsRead: false});
        expect(r).toMatchObject({ok: true, environmentIds: ["0", "e2"], partial: false});
    });
    it("a missing list permission on an environment → ok but partial, names the gap", () => {
        const r = evaluateKeyPermissions([row([["environments:list"], ...MIN("0").filter(([p]) => p !== "images:list")])], KEY, {allowProjectsRead: false});
        expect(r).toMatchObject({ok: true, partial: true, missing: {"0": ["images:list"]}});
    });
    it("no environment grants / no environments:list → partial", () => {
        expect(evaluateKeyPermissions([row([["environments:list"]])], KEY, {allowProjectsRead: false})).toMatchObject({ok: true, partial: true, environmentIds: []});
        expect(evaluateKeyPermissions([row(MIN("0"))], KEY, {allowProjectsRead: false})).toMatchObject({ok: true, partial: true, missingGlobal: ["environments:list"]});
    });
});

describe("refusals (key_too_broad) list the exact extra permissions", () => {
    it.each([
        ["containers:read", [["containers:read", "0"]], ["containers:read"]],
        ["volumes:read", [["volumes:read", "0"]], ["volumes:read"]],
        ["projects:read without opt-in", [["projects:read", "0"]], ["projects:read (tier 2 is not enabled for this connection)"]],
        ["write class", [["projects:deploy", "0"], ["containers:exec", "0"]], ["containers:exec", "projects:deploy"]],
        ["apikeys", [["apikeys:create"]], ["apikeys:create"]],
        ["global grant of an env-scoped list perm", [["containers:list"]], ["containers:list (global grant — must be scoped to an environment)"]],
        ["global projects:read", [["projects:read"]], ["projects:read (global grant — must be scoped to an environment)"]],
        ["environments:read (POST /test class)", [["environments:read"]], ["environments:read"]],
    ] as const)("%s", (_n, extraPerms, expected) => {
        const r = evaluateKeyPermissions([row([["environments:list"], ...MIN("0"), ...(extraPerms as unknown as [string, string?][])])], KEY, {allowProjectsRead: false});
        expect(r).toMatchObject({ok: false, errorClass: "key_too_broad", extra: expected, keyId: "k-own"});
    });
    it("tier 2 opt-in allows ONLY env-scoped projects:read", () => {
        expect(evaluateKeyPermissions([row([["environments:list"], ...MIN("0"), ["projects:read", "0"]])], KEY, {allowProjectsRead: true})).toMatchObject({ok: true, partial: false});
        expect(evaluateKeyPermissions([row([["environments:list"], ...MIN("0"), ["projects:read"]])], KEY, {allowProjectsRead: true})).toMatchObject({ok: false, errorClass: "key_too_broad"});
        expect(evaluateKeyPermissions([row([["environments:list"], ...MIN("0"), ["projects:read", "0"], ["volumes:read", "0"]])], KEY, {allowProjectsRead: true})).toMatchObject({ok: false, extra: ["volumes:read"]});
    });
    it("other keys of the owner are never judged (only the own row counts)", () => {
        expect(evaluateKeyPermissions([other, row([["environments:list"], ...MIN("0")])], KEY, {allowProjectsRead: false}).ok).toBe(true);
    });
});
