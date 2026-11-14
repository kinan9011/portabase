import * as nodeCrypto from "node:crypto";
import {createPrivateKey, randomBytes, sign as rsaSign} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {verifyEnvelope, type Envelope} from "@/fork/agent-channel/envelope";
import {encryptPayload, payloadSha256} from "@/fork/agent-channel/payload";
import {validatePayload} from "@/fork/agent-channel/tasks";
import {COMPOSE_TASK_TYPES, QUIESCE_TASK_TYPES, RESTORE_TASK_TYPES, RUNNER_CAPABILITY, RUNNER_TASK_TYPES, SIGN_DOMAIN, TEST_RESTORE_TASK_TYPES, TASK_REQUIRES, TARGETED_TASK_TYPES} from "@/fork/agent-channel/vocab";
import {canonicalJson} from "@/fork/canonical";
import {buildManifest} from "@/fork/manifest/build";
import {signManifest} from "@/fork/manifest/sign";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {RESTORE_REASONS} from "@/fork/restore-tasks/codes";
import {RunnerProbePayload} from "@/fork/runner/payload-schema";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";

/**
 * Cross-language vectors of the W17-i restore tasks (plan-W17 i-3) + the W17-ii compose tasks (plan-W17-ii ii-1). The dashboard code signs / builds them; the Rust agent (`src/fork/tests/restore_vectors.json`)
 * must decide exactly as recorded. Fixed clock inside the file, injected on both sides; TEST-ONLY keys; no secrets.
 * Generator: `W17_VECTORS_OUT=<agent>/src/fork/tests/restore_vectors.json pnpm exec vitest run --project unit w17-restore-task-vectors`.
 */
const NOW = 1794052800; // 2026-11-07T12:00:00Z
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";
const ENROLL = "22222222-2222-4222-8222-222222222222";
const STACK = "44444444-4444-4444-8444-444444444444";
const RP = "55555555-5555-4555-8555-555555555555";
const OTHER_RP = "66666666-6666-4666-8666-666666666666";
const RESTORE = "77777777-7777-4777-8777-777777777777";
const PLAN = "88888888-8888-4888-8888-888888888888";
const HEX = (c: string) => c.repeat(64);

const header = (o: Record<string, unknown> = {}) => ({v: 1, restore_id: RESTORE, plan_id: PLAN, plan_hash: HEX("a"), stack_id: STACK, rp_id: RP, purpose: "restore", mode: "selective", host_role: "test", approvals: [], workspace: "/srv/restore/app", project: "app", ...o});
function composeRef(o: Record<string, unknown> = {}) { return {dir: "/srv/restore/app/compose", override_yml: null, env: {}, path_map: [{from: "/opt/stack/www", to: "/srv/restore/app/files/www"}], ...o}; }
const samples = {
    restore_probe: {v: 1},
    restore_stage: {...header(), manifest: {json_b64: "e30=", sig_b64: "AAAA", sha256: HEX("b")}, artifacts: [{index: 0, source: "archive", url: "https://minio.example.test/b/o?X-Amz-Signature=x"}], paths: [{index: 0, dest: "/srv/restore/app/files/app"}]},
    restore_apply: {...header(), manifest_sha256: HEX("b"), volumes: [{index: 1, name: "app_appdata", compose_volume: "appdata"}], sqlite: [], networks: [{name: "app_default"}], unpack: []},
    restore_cleanup: {...header(), workspace_remove: true, volumes: true, networks: true, containers: false},
    compose_render: {...header(), manifest_sha256: HEX("b"), compose: composeRef()},
    restore_db: {...header(), manifest_sha256: HEX("b"), compose: composeRef(), compose_sha256: HEX("c"), approval: null, dbs: [{index: 1, service: "db"}]},
    compose_up: {...header(), manifest_sha256: HEX("b"), compose: composeRef(), compose_sha256: HEX("c"), approval: null, volumes: ["app_appdata"]},
    // W-TR (ADR-007 A16): engine integrity checks of a data-only TEST restore
    restore_verify: {...header({purpose: "test_restore", mode: "new_stack"}), manifest_sha256: HEX("b"), checks: [{index: 0, engine: "sqlite"}, {index: 1, engine: "postgresql"}]},
    // W21 (ADR-008): runner isolation probe
    runner_probe: {v: 1, probe_id: "99999999-9999-4999-8999-999999999999", targets_sha256: HEX("d"), timeout_ms: 1500, targets: [{id: "t01", kind: "tcp", host: "10.20.30.40", port: 25}, {id: "t02", kind: "dns_tcp", host: "10.20.30.53", port: 53}, {id: "t03", kind: "dns_name", host: "example.com"}]},
} as const;
const ALL_TYPES = [...RESTORE_TASK_TYPES, ...COMPOSE_TASK_TYPES, ...TEST_RESTORE_TASK_TYPES] as const;

type PCase = {type: string; name: string; payload: unknown; schema_valid: boolean; agent: string};
function payloadCases(): PCase[] {
    const out: PCase[] = [];
    for (const type of ALL_TYPES) out.push({type, name: `${type}_valid`, payload: samples[type], schema_valid: true, agent: "ok"});
    const bad = (type: keyof typeof samples, name: string, payload: unknown, schema_valid = false, agent = "payload_invalid") => out.push({type, name, payload, schema_valid, agent});
    const s = samples;
    bad("restore_probe", "probe_unknown_key", {...s.restore_probe, x: 1});
    bad("restore_probe", "probe_relative_workspace", {v: 1, workspace: "srv/x"});
    bad("restore_stage", "stage_unknown_key", {...s.restore_stage, extra: true});
    bad("restore_stage", "stage_missing_header_field", (({restore_id: _r, ...rest}) => rest)(s.restore_stage));
    bad("restore_stage", "stage_relative_dest", {...s.restore_stage, paths: [{index: 0, dest: "srv/restore/app/x"}]});
    bad("restore_stage", "stage_dotdot_dest", {...s.restore_stage, paths: [{index: 0, dest: "/srv/restore/app/../../etc"}]});
    bad("restore_stage", "stage_dollar_dest", {...s.restore_stage, paths: [{index: 0, dest: "/srv/restore/app/$HOME"}]});
    bad("restore_stage", "stage_tilde_dest", {...s.restore_stage, paths: [{index: 0, dest: "/srv/restore/app/~root"}]});
    bad("restore_stage", "stage_trailing_slash_dest", {...s.restore_stage, paths: [{index: 0, dest: "/srv/restore/app/x/"}]});
    bad("restore_stage", "stage_double_slash_dest", {...s.restore_stage, paths: [{index: 0, dest: "/srv/restore//app/x"}]});
    bad("restore_stage", "stage_control_char_dest", {...s.restore_stage, paths: [{index: 0, dest: "/srv/restore/app/a\u0007b"}]});
    bad("restore_stage", "stage_bad_source", {...s.restore_stage, artifacts: [{index: 0, source: "restic", url: "https://x.example/"}]});
    bad("restore_stage", "stage_bad_purpose", {...s.restore_stage, purpose: "drill"});
    bad("restore_stage", "stage_bad_mode_existing_stack", {...s.restore_stage, mode: "existing_stack"});
    bad("restore_apply", "apply_volume_name_with_slash", {...s.restore_apply, volumes: [{index: 1, name: "a/b", compose_volume: "b"}]});
    bad("restore_apply", "apply_sqlite_absolute", {...s.restore_apply, sqlite: [{index: 2, volume: "app_appdata", relative_path: "/etc/x.db"}]});
    bad("restore_apply", "apply_sqlite_dotdot", {...s.restore_apply, sqlite: [{index: 2, volume: "app_appdata", relative_path: "../x.db"}]});
    bad("restore_apply", "apply_missing_manifest_sha", (({manifest_sha256: _m, ...rest}) => rest)(s.restore_apply));
    bad("restore_cleanup", "cleanup_flag_not_bool", {...s.restore_cleanup, volumes: "yes"});
    bad("restore_cleanup", "cleanup_unknown_key", {...s.restore_cleanup, wipe: true});
    // schema-valid but semantically refused by the agent (header rules, DD5/DD17)
    bad("restore_apply", "test_restore_with_volume", {...s.restore_apply, purpose: "test_restore"}, true, "mode_unsupported");
    bad("restore_stage", "production_without_approval", {...s.restore_stage, host_role: "production", approvals: []}, true, "approval_missing");
    // ---- W17-ii compose types ----
    const ref = (o: Record<string, unknown>) => composeRef(o);
    bad("compose_render", "render_unknown_key", {...s.compose_render, extra: 1});
    bad("compose_render", "render_env_key_compose_file", {...s.compose_render, compose: ref({env: {COMPOSE_FILE: "x"}})}, false, "override_invalid");
    bad("compose_render", "render_env_key_path", {...s.compose_render, compose: ref({env: {PATH: "/x"}})}, false, "override_invalid");
    bad("compose_render", "render_env_value_newline", {...s.compose_render, compose: ref({env: {A: "x\ny"}})}, false, "override_invalid");
    bad("compose_render", "render_override_too_large", {...s.compose_render, compose: ref({override_yml: "a".repeat(64 * 1024 + 1)})}, false, "override_invalid");
    bad("compose_render", "render_path_map_to_outside_workspace", {...s.compose_render, compose: ref({path_map: [{from: "/opt/stack/www", to: "/etc/www"}]})}, true, "path_not_allowed");
    bad("compose_render", "render_dir_outside_workspace", {...s.compose_render, compose: ref({dir: "/etc"})}, true, "path_not_allowed");
    bad("compose_render", "render_relative_dir", {...s.compose_render, compose: ref({dir: "srv/restore/app/compose"})});
    bad("compose_render", "render_missing_manifest_sha", (({manifest_sha256: _m, ...rest}) => rest)(s.compose_render));
    bad("restore_db", "db_empty_dbs", {...s.restore_db, dbs: []});
    bad("restore_db", "db_unknown_key", {...s.restore_db, extra: 1});
    bad("restore_db", "db_bad_service", {...s.restore_db, dbs: [{index: 1, service: "a b"}]});
    bad("restore_db", "db_missing_compose_sha", (({compose_sha256: _m, ...rest}) => rest)(s.restore_db));
    bad("compose_up", "up_unknown_key", {...s.compose_up, extra: 1});
    bad("compose_up", "up_volume_with_slash", {...s.compose_up, volumes: ["a/b"]});
    // ---- W-TR restore_verify ----
    bad("restore_verify", "verify_unknown_key", {...s.restore_verify, extra: 1});
    bad("restore_verify", "verify_engine_mysql", {...s.restore_verify, checks: [{index: 0, engine: "mysql"}]});
    bad("restore_verify", "verify_empty_checks", {...s.restore_verify, checks: []});
    bad("restore_verify", "verify_check_unknown_key", {...s.restore_verify, checks: [{index: 0, engine: "sqlite", path: "/x"}]});
    bad("restore_verify", "verify_missing_manifest_sha", (({manifest_sha256: _m, ...rest}) => rest)(s.restore_verify));
    bad("restore_verify", "verify_purpose_restore", {...s.restore_verify, purpose: "restore", mode: "selective"}, true, "mode_unsupported");
    bad("restore_verify", "verify_duplicate_index", {...s.restore_verify, checks: [{index: 0, engine: "sqlite"}, {index: 0, engine: "postgresql"}]}, true, "payload_invalid");
    bad("compose_up", "up_missing_approval_key", (({approval: _m, ...rest}) => rest)(s.compose_up));
    return out;
}

/** W21: shared forged-input corpus of the `runner_probe` payload. The TS schema and the Rust `validate()` must AGREE on every row (`valid`). */
function runnerPayloadCases(): {name: string; payload: unknown; valid: boolean}[] {
    const ok = samples.runner_probe;
    const t = (o: Record<string, unknown>) => ({id: "t01", kind: "tcp", host: "10.20.30.40", port: 25, ...o});
    const withTargets = (targets: unknown[]) => ({...ok, targets});
    const many = (n: number) => Array.from({length: n}, (_, i) => t({id: `t${String(i).padStart(2, "0")}`}));
    const c = (name: string, payload: unknown, valid = false) => ({name, payload, valid});
    return [
        c("valid_full", ok, true),
        c("valid_ipv6_tcp", withTargets([t({host: "2001:db8::1"})]), true),
        c("valid_32_targets", withTargets(many(32)), true),
        c("valid_timeout_min", {...ok, timeout_ms: 500}, true),
        c("valid_timeout_max", {...ok, timeout_ms: 5000}, true),
        c("host_semicolon", withTargets([t({host: "1.2.3.4;id"})])),
        c("host_command_substitution", withTargets([t({host: "$(id)"})])),
        c("host_newline", withTargets([t({host: "1.2.3.4\n5.6.7.8"})])),
        c("hostname_uppercase", withTargets([{id: "t01", kind: "dns_name", host: "Example.com"}])),
        c("hostname_trailing_dot", withTargets([{id: "t01", kind: "dns_name", host: "example.com."}])),
        c("hostname_single_label", withTargets([{id: "t01", kind: "dns_name", host: "localhost"}])),
        c("hostname_underscore", withTargets([{id: "t01", kind: "dns_name", host: "a_b.example.com"}])),
        c("ip_for_dns_name", withTargets([{id: "t01", kind: "dns_name", host: "10.0.0.1"}])),
        c("hostname_for_tcp", withTargets([t({host: "example.com"})])),
        c("tcp_port_zero", withTargets([t({port: 0})])),
        c("tcp_port_65536", withTargets([t({port: 65536})])),
        c("tcp_port_missing", withTargets([{id: "t01", kind: "tcp", host: "10.20.30.40"}])),
        c("dns_name_with_port", withTargets([{id: "t01", kind: "dns_name", host: "example.com", port: 53}])),
        c("loopback_v4", withTargets([t({host: "127.0.0.1"})])),
        c("unspecified_v4", withTargets([t({host: "0.0.0.0"})])),
        c("link_local_v4", withTargets([t({host: "169.254.169.254"})])),
        c("multicast_v4", withTargets([t({host: "224.0.0.1"})])),
        c("loopback_v6", withTargets([t({host: "::1"})])),
        c("link_local_v6", withTargets([t({host: "fe80::1"})])),
        c("mapped_v6", withTargets([t({host: "::ffff:10.0.0.1"})])),
        c("duplicate_id", withTargets([t({id: "t01"}), t({id: "t01", port: 26})])),
        c("id_uppercase", withTargets([t({id: "T01"})])),
        c("id_too_long", withTargets([t({id: "abcdefghi"})])),
        c("too_many_targets", withTargets(many(33))),
        c("no_targets", withTargets([])),
        c("timeout_499", {...ok, timeout_ms: 499}),
        c("timeout_5001", {...ok, timeout_ms: 5001}),
        c("unknown_top_field", {...ok, extra: 1}),
        c("unknown_target_field", withTargets([t({extra: 1})])),
        c("version_2", {...ok, v: 2}),
        c("probe_id_not_uuid", {...ok, probe_id: "nope"}),
        c("sha_not_hex64", {...ok, targets_sha256: "abc"}),
        c("kind_unknown", withTargets([t({kind: "udp"})])),
    ];
}

function buildVectors() {
    const k = testKeypair(), other = testKeypair();
    const taskKey = randomBytes(32);
    const own = ["channel.v1", "noop.v1", "plaintext-hash.v1", "channel-maint.v1", "restore.target.v1", "compose.render.v1", "test-restore.v1"];
    let n = 100;
    const mk = (type: string, o: Partial<Envelope> & {omitTarget?: boolean} = {}, plaintext = Buffer.from(JSON.stringify(samples[type as keyof typeof samples] ?? {}))) => {
        const {omitTarget, ...rest} = o;
        const seq = n++;
        const task_id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
        const e: Envelope = {v: 1, task_id, agent_id: AGENT, enroll_id: ENROLL, type, seq, issued_at: NOW - 5, not_after: NOW + 600, nonce: randomBytes(16).toString("base64url"), payload_sha256: payloadSha256(plaintext),
            requires: [...((TASK_REQUIRES as Record<string, readonly string[]>)[type] ?? [])], kid: k.kid, ...(omitTarget ? {} : {target_agent_id: AGENT}), ...rest};
        const text = canonicalJson({...e, requires: [...e.requires].sort()});
        const signature = rsaSign("sha256", Buffer.from(SIGN_DOMAIN + text), createPrivateKey(k.privateKey)).toString("base64");
        return {envelope: text, signature, payload_enc: encryptPayload(taskKey, {taskId: task_id, agentId: AGENT, type}, plaintext), payload_plain: plaintext.toString("utf8")};
    };
    const cases: {name: string; envelope: string; signature: string; payload_enc: string; payload_plain: string; expect: string}[] = [];
    for (const type of RESTORE_TASK_TYPES) cases.push({name: `${type}_targeted_ok`, expect: "ok", ...mk(type)});
    cases.push({name: "restore_probe_without_target", expect: "target_mismatch", ...mk("restore_probe", {omitTarget: true})});
    cases.push({name: "restore_stage_without_target", expect: "target_mismatch", ...mk("restore_stage", {omitTarget: true})});
    cases.push({name: "restore_stage_targeted_at_another_agent", expect: "target_mismatch", ...mk("restore_stage", {target_agent_id: OTHER_AGENT})});
    cases.push({name: "restore_apply_without_target", expect: "target_mismatch", ...mk("restore_apply", {omitTarget: true})});
    cases.push({name: "restore_cleanup_without_target", expect: "target_mismatch", ...mk("restore_cleanup", {omitTarget: true})});
    for (const type of COMPOSE_TASK_TYPES) cases.push({name: `${type}_targeted_ok`, expect: "ok", ...mk(type)});
    cases.push({name: "compose_up_without_target", expect: "target_mismatch", ...mk("compose_up", {omitTarget: true})});
    cases.push({name: "compose_render_without_target", expect: "target_mismatch", ...mk("compose_render", {omitTarget: true})});
    cases.push({name: "compose_up_targeted_at_another_agent", expect: "target_mismatch", ...mk("compose_up", {target_agent_id: OTHER_AGENT})});
    cases.push({name: "restore_verify_targeted_ok", expect: "ok", ...mk("restore_verify")});
    cases.push({name: "restore_verify_without_target", expect: "target_mismatch", ...mk("restore_verify", {omitTarget: true})});
    cases.push({name: "compose_down_unknown_type", expect: "unsupported_type", ...mk("compose_down", {requires: ["compose.render.v1"], target_agent_id: AGENT}, Buffer.from("{}"))});

    // ---- W21 role gating (ADR-008 DD-3): an agent's role comes from its reported capabilities ----
    cases.push({name: "runner_probe_on_non_runner", expect: "role_forbidden", ...mk("runner_probe")});
    const runnerCases = [
        {name: "runner_probe_ok", expect: "ok", ...mk("runner_probe")},
        {name: "runner_probe_without_target", expect: "target_mismatch", ...mk("runner_probe", {omitTarget: true})},
        {name: "noop_on_runner", expect: "ok", ...mk("noop", {}, Buffer.from('{"echo":"hi"}'))},
        {name: "pin_add_on_runner", expect: "ok", ...mk("pin_add", {}, Buffer.from("{}"))},
        {name: "restore_probe_on_runner", expect: "role_forbidden", ...mk("restore_probe")},
        {name: "restore_stage_on_runner", expect: "role_forbidden", ...mk("restore_stage")},
        {name: "compose_up_on_runner", expect: "role_forbidden", ...mk("compose_up")},
        {name: "quiesce_on_runner", expect: "role_forbidden", ...mk("quiesce", {}, Buffer.from("{}"))},
        {name: "restore_verify_on_runner", expect: "role_forbidden", ...mk("restore_verify")},
        {name: "unknown_type_on_runner_is_unsupported", expect: "unsupported_type", ...mk("compose_down", {requires: ["compose.render.v1"], target_agent_id: AGENT}, Buffer.from("{}"))},
    ];

    // ---- manifest cases (RSA PKCS#1 v1.5 / SHA-256 over the RAW bytes, no domain prefix) ----
    const art = {sourceName: "volume_app_data", engine: "docker-volume", archiveKind: "archive_enc", dumpFormat: null, archiveFormatVersion: 1, encrypted: true, channelId: null, channelKind: "s3", pathOrSnapshotId: "backups/a/vol.tar.gz.enc", generatedId: "g1",
        sizeBytes: 1200, ciphertextSha256: HEX("c"), plaintextSha256: HEX("d"), plaintextSize: 1000, required: true};
    const db = {...art, sourceName: "db_db", engine: "postgresql", dumpFormat: "pg_custom" as const, pathOrSnapshotId: "backups/a/db.tar.gz.enc", generatedId: "g2", plaintextSha256: HEX("e"), plaintextSize: 2000};
    const base = buildManifest({id: RP, stackId: STACK, stackName: "app", sequence: 7, createdAt: new Date("2026-11-07T10:00:00Z"), finalizedAt: new Date("2026-11-07T10:05:00Z"), consistencyLevel: "mixed", inventoryVersion: 1, inventoryHash: HEX("f"), requiredArtifactCount: 2},
        [art, db], null, {kid: k.kid, signedAt: new Date("2026-11-07T10:10:00Z"), verifiedAt: new Date("2026-11-07T10:09:00Z")});
    const good = signManifest(base, k.privateKey);
    const sha = (j: string) => nodeCrypto.createHash("sha256").update(j).digest("hex") as string;
    const mcase = (name: string, json: string, sigB64: string, expect: string, o: {rp_id?: string; sequence?: number; manifest_sha256?: string; min_sequence?: number} = {}) =>
        ({name, json, sig_b64: sigB64, expect, rp_id: o.rp_id ?? RP, stack_id: STACK, sequence: o.sequence ?? 7, manifest_sha256: o.manifest_sha256 ?? sha(json), ...(o.min_sequence !== undefined ? {min_sequence: o.min_sequence} : {})});
    const sig = (json: string, key = k) => rsaSign("sha256", Buffer.from(json, "utf8"), createPrivateKey(key.privateKey)).toString("base64");
    const gsig = good.sig.toString("base64");
    const foreign = signManifest({...base, kid: other.kid}, other.privateKey);
    const otherRp = signManifest({...base, rp: {...base.rp, id: OTHER_RP}}, k.privateKey);
    const tampered = good.json.replace('"stack_name":"app"', '"stack_name":"apq"');
    const extraField = canonicalJson({...base, surprise: 1});
    // W17b: a recovery point taken with the app paused carries consistency_level "stopped" (manifest_version stays 1): the agent's verifier must accept it as the same kind of document
    const stopped = signManifest(buildManifest({id: RP, stackId: STACK, stackName: "app", sequence: 7, createdAt: new Date("2026-11-07T10:00:00Z"), finalizedAt: new Date("2026-11-07T10:05:00Z"), consistencyLevel: "stopped", inventoryVersion: 1, inventoryHash: HEX("f"), requiredArtifactCount: 2},
        [art, db], null, {kid: k.kid, signedAt: new Date("2026-11-07T10:10:00Z"), verifiedAt: new Date("2026-11-07T10:09:00Z")}), k.privateKey);
    const manifests = [
        mcase("valid", good.json, gsig, "ok"),
        mcase("valid_consistency_stopped", stopped.json, stopped.sig.toString("base64"), "ok"),
        mcase("wrong_kid_not_pinned", foreign.json, foreign.sig.toString("base64"), "manifest_unknown_kid"),
        mcase("tampered_byte", tampered, gsig, "manifest_signature"),
        mcase("signature_of_other_bytes", good.json, sig(foreign.json), "manifest_signature"),
        mcase("other_rp_id_valid_signature", otherRp.json, otherRp.sig.toString("base64"), "manifest_mismatch"),
        mcase("sequence_below_min", good.json, gsig, "manifest_mismatch", {min_sequence: 8}),
        mcase("sequence_equal_to_min_is_ok", good.json, gsig, "ok", {min_sequence: 7}),
        mcase("sha_differs_from_payload", good.json, gsig, "manifest_mismatch", {manifest_sha256: HEX("0")}),
        mcase("header_sequence_differs", good.json, gsig, "manifest_mismatch", {sequence: 6}),
        mcase("extra_field_signed", extraField, sig(extraField), "manifest_invalid"),
        mcase("not_json", "not json", sig("not json"), "manifest_invalid"),
    ];
    // ---- stage world: a manifest whose artifact hashes are the REAL stock-agent fixtures (scripts/fork/recover/fixtures) so the agent can stage them end to end ----
    const fx = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")) as {fixtures: {name: string; plaintext_sha256: string; plaintext_size: number; ciphertext_sha256: string; ciphertext_size: number}[]};
    const fxOf = (n: string) => fx.fixtures.find((f) => f.name === n)!;
    const vol = fxOf("lab-volume"), pg = fxOf("lab-postgres");
    const real = (name: string, engine: string, f: typeof vol, dump: "pg_custom" | null) => ({...art, sourceName: name, engine, dumpFormat: dump, pathOrSnapshotId: `backups/lab/${name}.tar.gz.enc`, generatedId: name, sizeBytes: f.ciphertext_size - 0, ciphertextSha256: f.ciphertext_sha256, plaintextSha256: f.plaintext_sha256, plaintextSize: f.plaintext_size});
    const sw = signManifest(buildManifest({id: RP, stackId: STACK, stackName: "app", sequence: 7, createdAt: new Date("2026-11-07T10:00:00Z"), finalizedAt: new Date("2026-11-07T10:05:00Z"), consistencyLevel: "mixed", inventoryVersion: 1, inventoryHash: HEX("f"), requiredArtifactCount: 2},
        [real("volume_lab", "docker-volume", vol, null), real("db_lab", "postgresql", pg, "pg_custom")], null, {kid: k.kid, signedAt: new Date("2026-11-07T10:10:00Z"), verifiedAt: new Date("2026-11-07T10:09:00Z")}), k.privateKey);
    const stage_world = {json: sw.json, sig_b64: sw.sig.toString("base64"), sha256: sha(sw.json), rp_id: RP, stack_id: STACK, sequence: 7, volume_index: 0, db_index: 1};
    return {note: "TEST-ONLY keys and data. Generated by dashboard src/fork/__tests__/unit/w17-restore-task-vectors.test.ts (W17_VECTORS_OUT=…). The Rust agent decides exactly like this.",
        now: NOW, agent_id: AGENT, enroll_id: ENROLL, own_capabilities: own, pins: [{kid: k.kid, pem: k.publicKey}], task_key_b64: taskKey.toString("base64"),
        ids: {stack_id: STACK, rp_id: RP, restore_id: RESTORE, plan_id: PLAN},
        codes: [...RESTORE_REASONS], types: Object.fromEntries([...ALL_TYPES, ...QUIESCE_TASK_TYPES, ...RUNNER_TASK_TYPES].map((t) => [t, [...TASK_REQUIRES[t]]])), targeted: [...TARGETED_TASK_TYPES],
        runner: {capabilities: ["channel.v1", "noop.v1", "channel-maint.v1", RUNNER_CAPABILITY], cases: runnerCases, payload_cases: runnerPayloadCases()},
        cases, stage_world, payload_cases: payloadCases(), manifest_artifacts: [art, db].map((a) => ({source_name: a.sourceName, plaintext_sha256: a.plaintextSha256, plaintext_size: a.plaintextSize, dump_format: a.dumpFormat})), manifests};
}
const VECTORS = path.join(process.cwd(), "src/fork/__tests__/fixtures/restore-task-vectors.json");

describe("W17-i cross-language vectors", () => {
    if (process.env.W17_VECTORS_OUT) {
        it("writes fresh vectors (generator mode)", () => { const j = JSON.stringify(buildVectors(), null, 2) + "\n"; writeFileSync(process.env.W17_VECTORS_OUT!, j); writeFileSync(VECTORS, j); });
    }
    const load = () => JSON.parse(readFileSync(VECTORS, "utf8")) as ReturnType<typeof buildVectors>;
    it("envelope cases verify under the TS reference verifier (signatures are valid; target rules are agent-side)", () => {
        const v = load();
        expect(v.cases.length).toBeGreaterThanOrEqual(10);
        for (const c of v.cases) expect(verifyEnvelope(c.envelope, c.signature, v.pins).ok, c.name).toBe(true);
    });
    it("payload cases: the TS schema accepts exactly the schema_valid ones", () => {
        const v = load();
        for (const c of v.payload_cases) expect(validatePayload(c.type as never, c.payload as Record<string, unknown>) === null, c.name).toBe(c.schema_valid);
        expect(v.payload_cases.filter((c) => c.agent === "ok")).toHaveLength(ALL_TYPES.length);
    });
    it("manifest cases: the TS reference verifier accepts only the valid ones", () => {
        const v = load();
        const anchors = [{kid: v.pins[0].kid, publicKeyPem: v.pins[0].pem}];
        for (const c of v.manifests) {
            const r = verifyManifestBundle({json: c.json, sig: Buffer.from(c.sig_b64, "base64")}, anchors, {stackId: c.stack_id, rpId: c.rp_id, sequence: c.sequence, ...(c.min_sequence !== undefined ? {minSequence: c.min_sequence} : {})});
            const shaOk = c.manifest_sha256 === nodeCrypto.createHash("sha256").update(c.json).digest("hex");
            expect(r.ok && shaOk, c.name).toBe(c.expect === "ok");
        }
    });
    it("stage_world: the manifest verifies and its hashes are the committed stock-agent fixtures", () => {
        const v = load();
        const r = verifyManifestBundle({json: v.stage_world.json, sig: Buffer.from(v.stage_world.sig_b64, "base64")}, [{kid: v.pins[0].kid, publicKeyPem: v.pins[0].pem}], {stackId: v.stage_world.stack_id, rpId: v.stage_world.rp_id, sequence: 7});
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.manifest.artifacts.map((a) => a.plaintext_sha256)).toEqual(JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fork/recover/fixtures/fixtures.json"), "utf8")).fixtures.map((f: {plaintext_sha256: string}) => f.plaintext_sha256).reverse());
    });
    it("runner envelopes verify under the TS reference verifier; the runner capability set is exactly the four runner capabilities", () => {
        const v = load();
        expect(v.runner.capabilities).toEqual(["channel.v1", "noop.v1", "channel-maint.v1", "runner.v1"]);
        for (const c of v.runner.cases) expect(verifyEnvelope(c.envelope, c.signature, v.pins).ok, c.name).toBe(true);
    });
    it("runner payload cases: the TS schema accepts exactly the valid ones (the Rust validate() asserts the same rows)", () => {
        const v = load();
        expect(v.runner.payload_cases.length).toBeGreaterThanOrEqual(35);
        for (const c of v.runner.payload_cases) expect(RunnerProbePayload.safeParse(c.payload).success, c.name).toBe(c.valid);
    });
    it("codes and types in the vectors equal the dashboard's lists", () => {
        const v = load();
        expect(v.codes).toEqual([...RESTORE_REASONS]);
        expect(Object.keys(v.types).sort()).toEqual([...ALL_TYPES, ...QUIESCE_TASK_TYPES, ...RUNNER_TASK_TYPES].sort()); // W17b: the agent compares this key set with its `TARGETED` list
        expect(v.targeted).toEqual([...RESTORE_TASK_TYPES, ...COMPOSE_TASK_TYPES, ...QUIESCE_TASK_TYPES, ...TEST_RESTORE_TASK_TYPES, ...RUNNER_TASK_TYPES]);
        expect(v.codes).toHaveLength(47); // 34 + the 11 W17b quiesce codes + the 2 W-TR codes (appended, agent order)
    });
});
