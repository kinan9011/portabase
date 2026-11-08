import {describe, expect, it} from "vitest";
import {buildOverridePayload, SetOverridesRequest, type StoredOverridesV1} from "@/fork/config/override";
import {checkRawCompose} from "@/fork/policy/raw";

const W = "/srv/restore/app";
const raw = (text: string) => { const f = `${W}/.portabase/secret/override.yml`; return checkRawCompose({root: W, entry: [f], files: [{path: f, text}]}); };
const mk = (env: StoredOverridesV1["env"], yml: string | null = null): StoredOverridesV1 => ({v: 1, env, yml});
const ok = (s: StoredOverridesV1) => { const r = buildOverridePayload(s); if (!r.ok) throw new Error(r.code); return {env: r.env, yml: r.overrideYml === null ? null : JSON.parse(r.overrideYml)}; };
const req = (over: Record<string, unknown> = {}) => SetOverridesRequest.safeParse({planId: crypto.randomUUID(), planHash: "a".repeat(64), ...over});

describe("W16b buildOverridePayload (pure merge)", () => {
    it("a service key becomes services.<svc>.environment.<KEY>; a service-less key goes only to the process env", () => {
        expect(ok(mk([{service: "db", key: "POSTGRES_PASSWORD", value: "s3cret"}]))).toEqual({env: {}, yml: {services: {db: {environment: {POSTGRES_PASSWORD: "s3cret"}}}}});
        expect(ok(mk([{service: "", key: "TAG", value: "v2"}]))).toEqual({env: {TAG: "v2"}, yml: null});
    });

    it("escapes every $ in the override file (Compose would interpolate it) and leaves the process-env value alone", () => {
        const r = buildOverridePayload(mk([{service: "web", key: "A", value: "a$b$$c"}, {service: "", key: "B", value: "x$y"}]));
        expect(r.ok && JSON.parse(r.overrideYml ?? "").services.web.environment.A).toBe("a$$b$$$$c");
        expect(r.ok && r.env).toEqual({B: "x$y"});
    });

    it("merges with the operator's file: list-form environment becomes a map, other keys survive", () => {
        const r = ok(mk([{service: "web", key: "A", value: "v"}], "services:\n  web:\n    environment:\n      - X=1\n      - Y\n    restart: always\n"));
        expect(r.yml).toEqual({services: {web: {restart: "always", environment: {X: "1", Y: null, A: "v"}}}});
    });

    it("the same (service, key) in a field and in the operator file is refused, not silently merged", () => {
        expect(buildOverridePayload(mk([{service: "web", key: "A", value: "v"}], "services:\n  web:\n    environment:\n      A: other\n"))).toMatchObject({ok: false, code: "override_duplicate_key"});
        expect(buildOverridePayload(mk([{service: "web", key: "A", value: "v"}], "services:\n  web:\n    environment:\n      - A=other\n"))).toMatchObject({ok: false, code: "override_duplicate_key"});
    });

    it("tags are refused (R-k: tag-free overrides), also !!binary-style and unknown ones", () => {
        for (const y of ["services:\n  web:\n    ports: !reset []\n", "services:\n  web:\n    image: !override nginx\n", "a: !custom x\n"]) expect(buildOverridePayload(mk([], y)), y).toMatchObject({ok: false, code: "override_yaml_invalid"});
    });

    it("anchors and merge keys are expanded; broken YAML and non-mappings are refused", () => {
        const r = ok(mk([], "x-base: &b\n  restart: always\nservices:\n  web:\n    <<: *b\n    image: nginx\n"));
        expect(r.yml).toMatchObject({services: {web: {restart: "always", image: "nginx"}}});
        expect(buildOverridePayload(mk([], "a: [\n"))).toMatchObject({ok: false, code: "override_yaml_invalid"});
        expect(buildOverridePayload(mk([], "- a\n- b\n"))).toMatchObject({ok: false, code: "override_not_mapping"});
        expect(buildOverridePayload(mk([{service: "web", key: "A", value: "v"}], "services:\n  - web\n"))).toMatchObject({ok: false, code: "override_not_mapping"});
        expect(buildOverridePayload(mk([{service: "web", key: "A", value: "v"}], "services:\n  web: nginx\n"))).toMatchObject({ok: false, code: "override_not_mapping"});
    });

    it("a result over 64 KiB is refused", () => {
        const big = mk(Array.from({length: 30}, (_, i) => ({service: "web", key: `K${i}`, value: "v".repeat(4000)})));
        expect(buildOverridePayload(big)).toMatchObject({ok: false, code: "override_too_large"});
    });

    it("a stored set that no longer satisfies the schema fails closed (single code path at enqueue)", () => {
        expect(buildOverridePayload(mk([{service: "web", key: "COMPOSE_FILE", value: "x"}]))).toMatchObject({ok: false, code: "override_field_invalid"});
        expect(buildOverridePayload(mk([{service: "bad name!", key: "A", value: "x"}]))).toMatchObject({ok: false, code: "override_field_invalid"});
    });

    it("__proto__ as a key cannot poison the tree", () => {
        const r = buildOverridePayload(mk([{service: "web", key: "__proto__", value: "x"}]));
        expect(r.ok && Object.getPrototypeOf(JSON.parse(r.overrideYml ?? "").services.web.environment)).toBe(Object.prototype);
        expect(r.ok && Object.keys(JSON.parse(r.overrideYml ?? "").services.web.environment)).toEqual(["__proto__"]);
    });

    it("round trip with the raw check: clean override passes, env_file outside the root is refused", () => {
        const clean = buildOverridePayload(mk([{service: "web", key: "A", value: "v"}], "services:\n  web:\n    restart: always\n"));
        expect(clean.ok && raw(clean.overrideYml ?? "").refused).toBe(false);
        const bad = buildOverridePayload(mk([], "services:\n  web:\n    env_file: /etc/passwd\n"));
        const r = bad.ok ? raw(bad.overrideYml ?? "") : null;
        expect(r?.refused).toBe(true);
        expect(r?.violations.map((v) => v.kind)).toContain("env_file");
    });
});

describe("W16b SetOverridesRequest (schema)", () => {
    it("accepts a clean request", () => { expect(req({set: [{service: "web", key: "A", value: "x\ty"}], unset: [], overrideYml: null}).success).toBe(true); });
    it("refuses reserved keys, C0 / CR / LF / NUL values (tab is fine) and unknown fields", () => {
        for (const key of ["COMPOSE_FILE", "DOCKER_HOST", "PATH", "HOME", "HOSTNAME", "BUILDKIT_X", "1BAD", "a-b"]) expect(req({set: [{service: "web", key, value: "x"}]}).success, key).toBe(false);
        for (const value of ["a\rb", "a\nb", "a\0b", "a\u0001b", "a\u007fb", "x".repeat(4097)]) expect(req({set: [{service: "web", key: "A", value}]}).success, JSON.stringify(value).slice(0, 12)).toBe(false);
        expect(req({set: [{service: "web", key: "A", value: "x", extra: 1}]}).success).toBe(false);
        expect(req({extra: 1}).success).toBe(false);
        expect(req({set: [{service: "bad name", key: "A", value: "x"}]}).success).toBe(false);
    });
    it("limits: 200 fields ok, 201 refused; YAML ≤ 64 KiB", () => {
        const f = (n: number) => Array.from({length: n}, (_, i) => ({service: "web", key: `K${i}`, value: "x"}));
        expect(req({set: f(200)}).success).toBe(true);
        expect(req({set: f(201)}).success).toBe(false);
        expect(req({overrideYml: "x".repeat(64 * 1024 + 1)}).success).toBe(false);
    });
});
