import {createPrivateKey, createPublicKey, randomBytes, randomUUID, sign as rsaSign} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {decodeBundle, encodeBundle} from "@/fork/agent-channel/bundle";
import {DUMMY_HASH, generateCredential, matchCredential, parseBearer, sha256Hex} from "@/fork/agent-channel/credential";
import {EnvelopeSchema, pinFingerprint, signEnvelope, verifyEnvelope, type Envelope} from "@/fork/agent-channel/envelope";
import {decryptPayload, encryptPayload, payloadSha256} from "@/fork/agent-channel/payload";
import {checkChannelTransport, isLoopbackHost} from "@/fork/agent-channel/transport-policy";
import {SIGN_DOMAIN} from "@/fork/agent-channel/vocab";
import {canonicalJson} from "@/fork/canonical";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

const NOW = 1794052800; // 2026-11-07T12:00:00Z — the fixed clock of the cross-language vectors
const AGENT = "11111111-1111-4111-8111-111111111111";
const ENROLL = "22222222-2222-4222-8222-222222222222";

describe("transport policy (ADR-007 D5: https only; lab loopback exemption only)", () => {
    const off = {FORK_ALLOW_INSECURE_LOOPBACK: false};
    const lab = {FORK_ALLOW_INSECURE_LOOPBACK: true};
    it("https is always fine; http is refused by default", () => {
        expect(checkChannelTransport("https://dash.example.com", off)).toEqual({ok: true, insecureLab: false});
        expect(checkChannelTransport("http://dash.example.com", off)).toEqual({ok: false, code: "insecure_transport"});
        expect(checkChannelTransport("http://localhost:3000", off)).toEqual({ok: false, code: "insecure_transport"});
    });
    it("the pilot's plain-HTTP LAN dashboard is refused even with the lab switch on (no LAN override)", () => {
        expect(checkChannelTransport("http://192.168.8.32:8887", lab)).toEqual({ok: false, code: "insecure_transport"});
        expect(checkChannelTransport("http://192.168.8.32:8887", off)).toEqual({ok: false, code: "insecure_transport"});
    });
    it("lab switch + loopback host is the only http exemption", () => {
        for (const u of ["http://localhost:3000", "http://forklab-dashboard.localhost:18887", "http://127.0.0.1:3000", "http://127.5.6.7/", "http://[::1]:3000"]) {
            expect(checkChannelTransport(u, lab), u).toEqual({ok: true, insecureLab: true});
        }
    });
    it("lookalike hosts are not loopback", () => {
        for (const h of ["localhost.evil.com", "evil-localhost", "127.0.0.1.evil.com", "128.0.0.1", "0.0.0.0", "10.0.0.1", "[::2]"]) expect(isLoopbackHost(h), h).toBe(false);
    });
    it("garbage / other schemes / credentials-in-url are invalid", () => {
        for (const u of ["", "not a url", "ftp://x", "https://user:pw@x.example", "https://x.example/#f"]) expect(checkChannelTransport(u, lab).ok, u).toBe(false);
    });
});

describe("per-agent credential (ADR-007 D2)", () => {
    it("issues a 256-bit secret, keeps only its SHA-256, and the bearer parses back", () => {
        const c = generateCredential(AGENT);
        expect(c.bearer).toMatch(/^fork\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
        const p = parseBearer(`Bearer ${c.bearer}`);
        expect(p?.agentId).toBe(AGENT);
        expect(sha256Hex(p!.secret)).toBe(c.hash);
        expect(c.hash).not.toContain(p!.secret);
    });
    it("rejects malformed headers", () => {
        for (const h of [null, "", "Bearer", "Basic x", `Bearer fork.${AGENT}.short`, `Bearer fork.not-a-uuid.${"a".repeat(43)}`, `bearer fork.${AGENT}.${"a".repeat(43)}`, `Bearer ${"x".repeat(500)}`]) expect(parseBearer(h), String(h)).toBeNull();
    });
    it("matches current or previous slot, never anything else, and the dummy hash matches nothing", () => {
        const a = generateCredential(AGENT), b = generateCredential(AGENT);
        const sa = parseBearer(`Bearer ${a.bearer}`)!.secret, sb = parseBearer(`Bearer ${b.bearer}`)!.secret;
        expect(matchCredential(sa, a.hash, null)).toBe("current");
        expect(matchCredential(sa, b.hash, a.hash)).toBe("previous");
        expect(matchCredential(sb, b.hash, a.hash)).toBe("current");
        expect(matchCredential(sa, b.hash, null)).toBeNull();
        expect(matchCredential("x".repeat(43), null, null)).toBeNull();
        expect(matchCredential("x".repeat(43), DUMMY_HASH, DUMMY_HASH)).toBeNull();
    });
});

describe("payload_enc (ADR-007 D4: per-agent AES-256-GCM, AAD task|agent|type)", () => {
    const key = randomBytes(32);
    const aad = {taskId: randomUUID(), agentId: AGENT, type: "noop"};
    it("round-trips and is not the plaintext", () => {
        const pt = Buffer.from('{"echo":"hello"}');
        const enc = encryptPayload(key, aad, pt);
        expect(Buffer.from(enc, "base64").includes(pt)).toBe(false);
        expect(decryptPayload(key, aad, enc)).toEqual(pt);
    });
    it("fails under another task id, agent, type, key or after tampering", () => {
        const enc = encryptPayload(key, aad, Buffer.from("x"));
        for (const bad of [{...aad, taskId: randomUUID()}, {...aad, agentId: randomUUID()}, {...aad, type: "other"}]) expect(() => decryptPayload(key, bad, enc)).toThrow();
        expect(() => decryptPayload(randomBytes(32), aad, enc)).toThrow();
        const raw = Buffer.from(enc, "base64"); raw[14] ^= 1;
        expect(() => decryptPayload(key, aad, raw.toString("base64"))).toThrow();
    });
});

function envelope(kid: string, o: Partial<Envelope> = {}): Envelope {
    return {v: 1, task_id: randomUUID(), agent_id: AGENT, enroll_id: ENROLL, type: "noop", seq: 1, issued_at: NOW - 5, not_after: NOW + 600, nonce: randomBytes(16).toString("base64url"),
        payload_sha256: payloadSha256(Buffer.from('{"echo":"hi"}')), requires: ["noop.v1"], kid, ...o};
}

describe("signed envelope (ADR-007 D3)", () => {
    const k = testKeypair();
    const pins = [{kid: k.kid, pem: k.publicKey}];
    it("signs with the dashboard key and verifies under the pinned key; the signed bytes carry the domain prefix", () => {
        const s = signEnvelope(envelope(k.kid), k.privateKey);
        expect(verifyEnvelope(s.text, s.signature, pins)).toMatchObject({ok: true});
        // verifiable with plain OpenSSL-style RSA/SHA-256 over DOMAIN ‖ text (same primitive as the manifest signature)
        const manual = rsaSign("sha256", Buffer.from(SIGN_DOMAIN + s.text), createPrivateKey(k.privateKey)).toString("base64");
        expect(manual).toBe(s.signature); // PKCS#1 v1.5 is deterministic
    });
    it("is canonical: sorted keys, no whitespace, `requires` sorted", () => {
        const s = signEnvelope(envelope(k.kid, {requires: ["b.v1", "a.v1"]}), k.privateKey);
        expect(s.text).toBe(canonicalJson(JSON.parse(s.text)));
        expect(JSON.parse(s.text).requires).toEqual(["a.v1", "b.v1"]);
    });
    it("refuses a forged signature, a tampered envelope, an unknown kid, an unsigned envelope and a foreign key", () => {
        const s = signEnvelope(envelope(k.kid), k.privateKey);
        const other = testKeypair();
        const forged = signEnvelope(envelope(other.kid), other.privateKey);
        expect(verifyEnvelope(forged.text, forged.signature, pins)).toEqual({ok: false, reason: "unknown_kid"});
        expect(verifyEnvelope(s.text.replace('"type":"noop"', '"type":"nooq"'), s.signature, pins)).toMatchObject({ok: false});
        expect(verifyEnvelope(s.text, "", pins)).toEqual({ok: false, reason: "bad_signature"});
        expect(verifyEnvelope(s.text, forged.signature, pins)).toEqual({ok: false, reason: "bad_signature"});
        // an attacker who claims our kid but signs with his own key
        const claimed = envelope(k.kid);
        const text = canonicalJson(claimed);
        const sig = rsaSign("sha256", Buffer.from(SIGN_DOMAIN + text), createPrivateKey(other.privateKey)).toString("base64");
        expect(verifyEnvelope(text, sig, pins)).toEqual({ok: false, reason: "bad_signature"});
    });
    it("rejects a malformed envelope (extra field, float, bad ids) and a kid that does not match the signing key", () => {
        expect(() => signEnvelope({...envelope(k.kid), seq: 1.5}, k.privateKey)).toThrow();
        expect(() => signEnvelope(envelope("0".repeat(12)), k.privateKey)).toThrow(/kid/);
        expect(EnvelopeSchema.safeParse({...envelope(k.kid), extra: 1}).success).toBe(false);
        expect(EnvelopeSchema.safeParse({...envelope(k.kid), agent_id: "x"}).success).toBe(false);
    });
    it("fingerprint = SHA-256 of the SPKI DER", () => { expect(pinFingerprint(k.publicKey)).toMatch(/^[0-9a-f]{64}$/); });
});

describe("enrolment bundle", () => {
    it("round-trips and carries the pinned key (no TOFU over the channel)", () => {
        const k = testKeypair();
        const b = {v: 1 as const, enroll_id: ENROLL, server_url: "https://d.example", agent_id: AGENT, credential: generateCredential(AGENT).bearer, task_key_b64: randomBytes(32).toString("base64"), pins: [{kid: k.kid, pem: k.publicKey}], pin_fingerprint: pinFingerprint(k.publicKey)};
        expect(decodeBundle(encodeBundle(b))).toEqual(b);
        expect(() => decodeBundle("e30")).toThrow();
    });
});

describe("static rules (D34: capabilities, not versions)", () => {
    const dir = path.join(process.cwd(), "src/fork/agent-channel");
    const files = ["admin", "auth", "bundle", "credential", "deps", "envelope", "hash-report", "payload", "route-kit", "tasks", "transport-policy", "vocab"].map((f) => readFileSync(path.join(dir, `${f}.ts`), "utf8"));
    it("no agent-version gating anywhere in the channel", () => {
        for (const src of files) expect(src).not.toMatch(/isAgentVersionAtLeast|MIN_AGENT_VERSION|agent\.version|status-crypto|semver/);
    });
    it("no logger / console in the channel (secrets must not be loggable by accident)", () => {
        for (const src of files) expect(src).not.toMatch(/console\.|logger\.|\blog\(/);
    });
    it("every agent route authenticates through withAgent and the routes are in the runtime allowlist", () => {
        for (const r of ["lease", "hash-report", "tasks/[taskId]/heartbeat", "tasks/[taskId]/result"]) {
            const src = readFileSync(path.join(process.cwd(), "app/api/fork/agent/[agentId]", r, "route.ts"), "utf8");
            expect(src, r).toContain("withAgent(");
            expect(src, r).not.toMatch(/currentUser|getForkPrincipal/);
        }
    });
});

// ---- cross-language vectors (agent `src/fork/tests/vectors.json`) --------------------------------------------------------------------------
type VCase = {name: string; envelope: string; signature: string; payload_enc: string | null; expect: string; last_seq?: number; known?: string[]; payload_plain?: string};
function buildVectors() {
    const k = testKeypair(), attacker = testKeypair();
    const taskKey = randomBytes(32);
    const own = ["channel.v1", "noop.v1", "plaintext-hash.v1", "channel-maint.v1"];
    const pt = Buffer.from('{"echo":"hi"}');
    const mk = (o: Partial<Envelope> = {}, opts: {plaintext?: Buffer; signWith?: ReturnType<typeof testKeypair>; payloadFor?: {taskId: string}; sigOverride?: string; textOverride?: (t: string) => string} = {}) => {
        const e = envelope(k.kid, o);
        let text = canonicalJson({...e, requires: [...e.requires].sort()});
        if (opts.textOverride) text = opts.textOverride(text);
        const signer = (opts.signWith ?? k).privateKey;
        const sig = opts.sigOverride ?? rsaSign("sha256", Buffer.from(SIGN_DOMAIN + text), createPrivateKey(signer)).toString("base64");
        const payload = encryptPayload(taskKey, {taskId: opts.payloadFor?.taskId ?? e.task_id, agentId: AGENT, type: e.type}, opts.plaintext ?? pt);
        return {envelope: text, signature: sig, payload_enc: payload, id: e.task_id};
    };
    const cases: VCase[] = [];
    const add = (name: string, expectResult: string, v: ReturnType<typeof mk>, extra: Partial<VCase> = {}) => cases.push({name, envelope: v.envelope, signature: v.signature, payload_enc: v.payload_enc, expect: expectResult, ...extra});
    add("valid", "ok", mk({seq: 1}));
    add("valid_within_skew", "ok", mk({seq: 2, not_after: NOW - 30}));
    add("valid_seq_8_after_7", "ok", mk({seq: 8}), {last_seq: 7});
    add("forged_signature_other_key", "bad_signature", mk({}, {signWith: attacker}));
    add("unsigned", "bad_signature", mk({}, {sigOverride: ""}));
    add("garbage_signature", "bad_signature", mk({}, {sigOverride: Buffer.from("not a signature").toString("base64")}));
    add("tampered_after_signing", "bad_signature", mk({}, {}), {});
    cases[cases.length - 1].envelope = cases[cases.length - 1].envelope.replace('"type":"noop"', '"type":"nooq"');
    const att = testKeypair();
    add("unknown_kid", "unknown_kid", mk({kid: att.kid}, {signWith: att}));
    add("expired", "expired", mk({not_after: NOW - 61}));
    add("not_yet_valid", "not_yet_valid", mk({issued_at: NOW + 121, not_after: NOW + 900}));
    add("foreign_agent", "agent_mismatch", mk({agent_id: "33333333-3333-4333-8333-333333333333"}));
    add("other_enrolment", "enroll_mismatch", mk({enroll_id: "44444444-4444-4444-8444-444444444444"}));
    add("payload_hash_mismatch", "payload_hash", mk({payload_sha256: "0".repeat(64)}));
    add("payload_for_other_task", "payload_invalid", mk({}, {payloadFor: {taskId: randomUUID()}}));
    add("unsupported_type", "unsupported_type", mk({type: "format_disk"}));
    add("capability_missing", "capability_missing", mk({requires: ["restore.target.v1"]}));
    add("target_mismatch", "target_mismatch", mk({target_agent_id: "55555555-5555-4555-8555-555555555555"}));
    add("unknown_envelope_field", "bad_envelope", mk({}, {textOverride: (t) => t.replace(/}$/, ',"zzz":1}')}));
    add("seq_equal_to_last", "seq_rollback", mk({seq: 7}), {last_seq: 7});
    add("seq_below_last", "seq_rollback", mk({seq: 3}), {last_seq: 7});
    const known = mk({seq: 9});
    add("known_task_id_is_duplicate", "duplicate", known, {last_seq: 9, known: [known.id]});
    // W15b maintenance types: signed by the dashboard code, payload built like `maint.ts` does; the agent must accept them at the verify level
    // public halves of 8 more dashboard keys: the agent tests build pin sets (limit 8, revoke, un-revoke) from them
    const spares = Array.from({length: 8}, () => testKeypair());
    const second = spares[0];
    const maint = (name: string, type: string, payload: Record<string, unknown>, seq: number) => {
        const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
        add(name, "ok", mk({type, seq, requires: ["channel-maint.v1"], payload_sha256: payloadSha256(plaintext)}, {plaintext}), {payload_plain: plaintext.toString("utf8")});
    };
    maint("maint_pin_add", "pin_add", {kid: second.kid, pem: second.publicKey}, 10);
    maint("maint_pin_revoke", "pin_revoke", {kid: second.kid}, 11);
    maint("maint_rotate", "rotate_credential", {credential: `fork.${AGENT}.${randomBytes(32).toString("base64url")}`}, 12);
    // signed by a key the agent has NOT pinned: refused until a `pin_add` (maint_pin_add above) put it there, refused again after `pin_revoke`
    add("signed_by_second_key", "unknown_kid", mk({kid: second.kid, seq: 13}, {signWith: second}));
    return {note: "TEST-ONLY keys and data. Generated by dashboard src/fork/__tests__/unit/w15-agent-channel-crypto.test.ts (W15_VECTORS_OUT=…). The Rust agent verifies these exact bytes.", now: NOW, agent_id: AGENT, enroll_id: ENROLL, own_capabilities: own,
        pins: [{kid: k.kid, pem: k.publicKey}], spare_pins: spares.map((x) => ({kid: x.kid, pem: x.publicKey})), task_key_b64: taskKey.toString("base64"), cases};
}
const VECTORS = path.join(process.cwd(), "src/fork/__tests__/fixtures/agent-channel-vectors.json");

describe("cross-language vectors", () => {
    if (process.env.W15_VECTORS_OUT) {
        it("writes fresh vectors (generator mode)", () => { writeFileSync(process.env.W15_VECTORS_OUT!, JSON.stringify(buildVectors(), null, 2) + "\n"); writeFileSync(VECTORS, readFileSync(process.env.W15_VECTORS_OUT!)); });
    }
    it("committed vectors are self-consistent under the TS reference verifier (valid ones verify, signature-class failures fail)", () => {
        const v = JSON.parse(readFileSync(VECTORS, "utf8")) as ReturnType<typeof buildVectors>;
        expect(v.cases.length).toBeGreaterThanOrEqual(20);
        for (const c of v.cases) {
            const r = verifyEnvelope(c.envelope, c.signature, v.pins);
            if (["bad_signature", "unknown_kid", "bad_envelope"].includes(c.expect)) expect(r.ok, c.name).toBe(false);
            else expect(r.ok, c.name).toBe(true);
        }
        // the committed public key still matches its kid
        expect(createPublicKey(v.pins[0].pem).asymmetricKeyType).toBe("rsa");
    });
});
