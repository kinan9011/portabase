import {describe, expect, it} from "vitest";
import {contentHash, INVENTORY_MAX_BYTES, InventoryRejectedError, parseInventoryStrict, sanitizeIngest, type StackInventoryV1} from "@/fork/inventory/schema";

const good = (): StackInventoryV1 => ({
    schema_version: 1,
    captured_at: "2026-11-06T22:00:00Z",
    source: {arcane_version: "v2.17.3", openapi_sha256: `sha256:${"a".repeat(64)}`, connection_id: "11111111-1111-4111-8111-111111111111", environment_id: "0"},
    stack: {compose_project: "demo-stack", display_name: "demo-stack", compose_read: "none", config_files_hint: []},
    services: [{
        name: "web", state: "running", container_id: "abcdef123456", image: {ref: "nginx:1.27", pinned: false, built_locally: false},
        ports: [{target: 80, published: 8080, protocol: "tcp"}], networks: ["default"], mounts: ["m:0123456789abcdef"], env_keys: ["POSTGRES_USER"],
    }],
    mounts: [{id: "m:0123456789abcdef", kind: "named_volume", volume_name: "demo_data", destination: "/data", rw: true, consumers: ["web"], ownership: "stack_owned"}],
    volumes: [{name: "demo_data", driver: "local", in_use_by: ["web"], ownership: "stack_owned"}],
    networks: [{name: "default", driver: "bridge", internal: false, external: false, members: ["web"]}],
    env_files: [], external_dependencies: [], provenance: {"/services/0/state": "arcane_list"}, warnings: [],
});
const mut = (f: (x: any) => void) => { const x = structuredClone(good()); f(x); return x; };
const reason = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as InventoryRejectedError).reason; } return "accepted"; };

describe("inventory v1 — strict parse (write path)", () => {
    it("accepts a good inventory", () => expect(parseInventoryStrict(good()).stack.compose_project).toBe("demo-stack"));
    it.each<[string, (x: any) => void]>([
        ["unknown top-level key", (x) => { x.extra = 1; }],
        ["unknown nested key (service)", (x) => { x.services[0].labels = {a: "b"}; }],
        ["env VALUES field smuggled into a service", (x) => { x.services[0].env = {DB_PASSWORD: "canary-secret-value"}; }],
        ["command line smuggled", (x) => { x.services[0].command = "run --token abc"; }],
        ["bad compose_project (uppercase)", (x) => { x.stack.compose_project = "Demo"; }],
        ["bad compose_project (path traversal)", (x) => { x.stack.compose_project = "../etc"; }],
        ["bad env key name", (x) => { x.services[0].env_keys = ["1BAD"]; }],
        ["bad service state", (x) => { x.services[0].state = "weird"; }],
        ["non-UTC timestamp", (x) => { x.captured_at = "2026-11-06T22:00:00+02:00"; }],
        ["bad openapi digest", (x) => { x.source.openapi_sha256 = "nothex"; }],
        ["bad mount id", (x) => { x.mounts[0].id = "mount-1"; }],
        [">500 services", (x) => { x.services = Array.from({length: 501}, (_, i) => ({...good().services[0], name: `s${i}`})); }],
        ["string over limit", (x) => { x.stack.display_name = "x".repeat(129); }],
    ])("rejects: %s", (_n, f) => expect(reason(() => parseInventoryStrict(mut(f)))).toBe("invalid"));

    it("rejects an unknown major and a non-object", () => {
        expect(reason(() => parseInventoryStrict(mut((x) => { x.schema_version = 2; })))).toBe("unknown-major");
        expect(reason(() => parseInventoryStrict(null))).toBe("unknown-major");
    });
    it("rejects (does not truncate) oversize canonical JSON", () => {
        const big = mut((x) => { x.mounts = Array.from({length: 2000}, (_, i) => ({id: `m:${String(i).padStart(16, "0")}`, kind: "bind", destination: "/d".repeat(500), host_path_hint: "/h".repeat(500), rw: true, consumers: [], ownership: "unknown"})); });
        expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(INVENTORY_MAX_BYTES);
        expect(reason(() => parseInventoryStrict(big))).toBe("too-large");
    });
    it("error text carries paths/codes, never submitted values", () => {
        try { parseInventoryStrict(mut((x) => { x.services[0].env = {K: "canary-secret-value"}; })); } catch (e) { expect(String((e as Error).message)).not.toContain("canary-secret-value"); return; }
        throw new Error("should have thrown");
    });
});

describe("inventory v1 — Arcane ingest drops unknown keys, then validates strictly", () => {
    it("drops nested unknown keys (labels, env values, cmd) and keeps known data", () => {
        const raw = mut((x) => {
            x.services[0].labels = {"traefik.secret": "canary-secret-value"};
            x.services[0].env = {DB_PASSWORD: "canary-secret-value"};
            x.services[0].image.config = {cmd: ["x"]};
            x.mounts[0].raw = {};
            x.extra = true;
        });
        const out = sanitizeIngest(raw);
        expect(JSON.stringify(out)).not.toContain("canary-secret-value");
        expect(out.services[0].name).toBe("web");
        expect(Object.keys(out.services[0])).not.toContain("env");
    });
    it("still rejects wrong types after stripping", () => expect(reason(() => sanitizeIngest(mut((x) => { x.services[0].state = "nope"; })))).toBe("invalid"));
});

describe("inventory v1 — content hash", () => {
    it("ignores captured_at and warnings, changes with content, is key-order independent", () => {
        const a = good();
        const b = {...good(), captured_at: "2030-01-01T00:00:00Z", warnings: [{code: "w", severity: "warn" as const, message_key: "k"}]};
        expect(contentHash(b)).toBe(contentHash(a));
        const rev = (v: unknown): unknown => Array.isArray(v) ? v.map(rev) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, rev(x)])) : v;
        const reordered = rev(a) as StackInventoryV1;
        expect(contentHash(reordered)).toBe(contentHash(a));
        expect(contentHash(mut((x) => { x.services[0].state = "exited"; }))).not.toBe(contentHash(a));
        expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    });
});
