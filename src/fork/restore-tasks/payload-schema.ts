import {z} from "zod";

/**
 * Strict payload schemas of the W17-i restore tasks (plan-W17 §4.0). The agent has a Rust mirror (`deny_unknown_fields`); the cross-language vectors
 * pin both sides. Pure module (no I/O). Payloads travel only inside `payload_enc`; nothing here is ever persisted in clear or audited.
 */
const uuid = z.uuid();
/** control characters, `$` and `~` (a function, not a regex: biome forbids control characters in regex literals) */
const bad = (p: string) => [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "$" || c === "~");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** Absolute path in the agent's canonical grammar: no `$`, `~`, control chars, `//`, `.`/`..` segments, trailing `/`; ≤ 1024 (the agent re-checks, D-2 `canon`). */
export const absPath = z.string().min(2).max(1024).refine((p) => p.startsWith("/") && !p.endsWith("/") && !p.includes("//") && !bad(p)
    && !p.split("/").slice(1).some((s) => s === "." || s === ".."), "path");
const relPath = z.string().min(1).max(1024).refine((p) => !p.startsWith("/") && !p.endsWith("/") && !p.includes("//") && !bad(p)
    && !p.split("/").some((s) => s === "." || s === ".."), "relative path");
const volumeName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/);
const project = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const service = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const index = z.number().int().min(0).max(1999);

export const RestoreHeader = z.strictObject({
    v: z.literal(1),
    restore_id: uuid, plan_id: uuid, plan_hash: hex64, stack_id: uuid, rp_id: uuid,
    purpose: z.enum(["restore", "test_restore"]),
    mode: z.enum(["new_stack", "selective"]),
    host_role: z.enum(["production", "test"]),
    approvals: z.array(z.enum(["production_target", "destructive_replace"])).max(2),
    workspace: absPath,
    project,
});
export type RestoreHeader = z.infer<typeof RestoreHeader>;

export const ProbePayload = z.strictObject({v: z.literal(1), workspace: absPath.optional()});

export const StagePayload = RestoreHeader.extend({
    manifest: z.strictObject({json_b64: z.string().min(4).max(2_800_000), sig_b64: z.string().min(4).max(2048), sha256: hex64, min_sequence: z.number().int().min(0).optional()}),
    artifacts: z.array(z.strictObject({index, source: z.literal("archive"), url: z.url().max(4096)})).max(200),
    paths: z.array(z.strictObject({index, dest: absPath})).max(200),
});

export const ApplyPayload = RestoreHeader.extend({
    /** Hash of the manifest verified at `restore_stage`: the agent re-reads its staged copy and refuses a different one (`manifest_mismatch`). */
    manifest_sha256: hex64,
    volumes: z.array(z.strictObject({index, name: volumeName, compose_volume: volumeName})).max(100),
    sqlite: z.array(z.strictObject({index, volume: volumeName, relative_path: relPath})).max(100),
    networks: z.array(z.strictObject({name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)})).max(50),
    unpack: z.array(z.strictObject({index, service})).max(100),
});

export const CleanupPayload = RestoreHeader.extend({workspace_remove: z.boolean(), volumes: z.boolean(), networks: z.boolean(), containers: z.boolean()});

// --- W17-ii compose types (ADR-007 A14) ---
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
    .refine((k) => !/^(COMPOSE_|DOCKER_|BUILDKIT_)/.test(k) && !["PATH", "HOME", "HOSTNAME"].includes(k), "reserved");
const envVal = z.string().max(4096).refine((v) => !/[\0\r\n]/.test(v), "control");
/** Compose reference of a restore workspace: the agent derives the compose files itself (E2); `env` + `override_yml` are secret-bearing (payload_enc only). */
export const ComposeRef = z.strictObject({
    dir: absPath, override_yml: z.string().max(64 * 1024).nullable(),
    env: z.record(envKey, envVal).refine((r) => Object.keys(r).length <= 200, "too many"),
    path_map: z.array(z.strictObject({from: absPath, to: absPath})).max(200),
});
export type ComposeRef = z.infer<typeof ComposeRef>;
export const RenderPayload = RestoreHeader.extend({manifest_sha256: hex64, compose: ComposeRef});
export const DbPayload = RestoreHeader.extend({
    manifest_sha256: hex64, compose: ComposeRef, compose_sha256: hex64, approval: z.unknown().nullable(),
    dbs: z.array(z.strictObject({index, service})).min(1).max(20),
});
export const UpPayload = RestoreHeader.extend({
    manifest_sha256: hex64, compose: ComposeRef, compose_sha256: hex64, approval: z.unknown().nullable(), volumes: z.array(volumeName).max(100),
});
