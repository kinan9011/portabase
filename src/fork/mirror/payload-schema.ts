/**
 * Strict payload and result schemas of the nine mirror tasks (W22a, plan-W22a §3.3). The agent has a Rust mirror (`deny_unknown_fields`); the
 * cross-language vectors pin both sides. Pure module (no I/O). Payloads travel only inside `payload_enc`; nothing here is ever persisted in clear.
 * Mirror mode has NO overrides (W20 D-2): `override_yml` is null and `env` is empty, always.
 */
import {z} from "zod";
import {PROJECT_RE} from "@/fork/compose-compiler/rules";
import {ApplyPayload, ComposeRef, ProbePayload, RestoreHeader, StagePayload, absPath} from "@/fork/restore-tasks/payload-schema";
import {LIMIT_CAPS, LIMIT_FLOORS, PORT_RANGE} from "./vocab";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const service = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const volumeName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/);
const index = z.number().int().min(0).max(1999);
export const HTTP_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,127}$/;

/** The W17 header shape (the agent reuses its `Header` parser) narrowed to a mirror: runner host, no approvals, `pbm-` project, workspace = `<mirror root>/<project>`. */
export const MirrorHeader = RestoreHeader.extend({
    purpose: z.literal("mirror"),
    mode: z.literal("new_stack"),
    host_role: z.literal("runner"),
    approvals: z.array(z.never()).max(0),
    project: z.string().regex(PROJECT_RE),
});
export type MirrorHeader = z.infer<typeof MirrorHeader>;
const withWorkspace = <T extends z.ZodType<{workspace: string; project: string}>>(s: T) =>
    s.refine((h) => h.workspace.endsWith(`/${h.project}`), {message: "workspace must end with /<project>"});

export const MirrorLimits = z.strictObject({
    mem_bytes: z.number().int().min(LIMIT_FLOORS.mem_bytes).max(LIMIT_CAPS.mem_bytes),
    pids: z.number().int().min(LIMIT_FLOORS.pids).max(LIMIT_CAPS.pids),
    nano_cpus: z.number().int().min(LIMIT_FLOORS.nano_cpus).max(LIMIT_CAPS.nano_cpus),
});
export type MirrorLimits = z.infer<typeof MirrorLimits>;

const EnvAction = z.enum(["keep", "keep_exact", "rotate", "disable", "drop"]);
export const CredentialResetWire = z.strictObject({service, engine: z.enum(["postgresql", "mysql"]), user_key: z.string().max(256).nullable(), password_key: z.string().max(256)});
export type CredentialResetWire = z.infer<typeof CredentialResetWire>;
/** `MirrorSpecV1` on the wire (value-free; W20). `view` is the engine-checked skeleton: bounded by the 256 KiB payload cap, not re-modelled here. */
export const MirrorSpecWire = z.strictObject({
    v: z.literal(1),
    compiler: z.literal(1),
    project: z.string().regex(PROJECT_RE),
    workspace: absPath,
    source_view_sha256: hex64,
    rules_sha256: hex64,
    access: z.strictObject({service, target: z.number().int().min(1).max(65535), host_port: z.number().int().min(1024).max(65535)}).nullable(),
    view: z.record(z.string(), z.unknown()),
    env: z.record(z.string().max(128), z.record(z.string().max(256), EnvAction)),
    credential_resets: z.array(CredentialResetWire).max(20),
    kept_production_secrets: z.array(z.string().max(512)).max(100),
});

/** `ComposeRef` of a mirror: no override, no env (mirror mode has no overrides). */
export const MirrorComposeRef = ComposeRef.extend({override_yml: z.null(), env: z.record(z.string(), z.never()).refine((r) => Object.keys(r).length === 0, "env must be empty")});

export const MirrorProbePayload = ProbePayload.extend({workspace: absPath});
export const MirrorStagePayload = withWorkspace(MirrorHeader.extend({manifest: StagePayload.shape.manifest, artifacts: StagePayload.shape.artifacts, paths: StagePayload.shape.paths}));
export const MirrorApplyPayload = withWorkspace(MirrorHeader.extend({
    manifest_sha256: hex64, volumes: ApplyPayload.shape.volumes, sqlite: ApplyPayload.shape.sqlite,
    networks: z.array(z.never()).max(0), // the compiler creates the mirror networks; a mirror restore never creates one
    unpack: ApplyPayload.shape.unpack,
}));
export const MirrorRenderPayload = withWorkspace(MirrorHeader.extend({manifest_sha256: hex64, compose: MirrorComposeRef}));
/** W24: a refresh revision reuses the ACTIVE revision's test-credential seed. Copied on the runner (never uploaded); the agent verifies owner + file mode and fails closed (`seed_invalid`). */
export const MirrorSeedFrom = z.strictObject({revision_id: z.uuid(), workspace: absPath});
export const MirrorFinalizePayload = withWorkspace(MirrorHeader.extend({manifest_sha256: hex64, compose: MirrorComposeRef, spec: MirrorSpecWire, spec_sha256: hex64, limits: MirrorLimits, seed_from: MirrorSeedFrom.optional()}));
export const MirrorDbPayload = withWorkspace(MirrorHeader.extend({
    manifest_sha256: hex64, final_sha256: hex64,
    dbs: z.array(z.strictObject({index, service})).max(20),
    resets: z.array(CredentialResetWire).max(20),
})).refine((p) => p.dbs.length + p.resets.length > 0, {message: "nothing to do"});
export const MirrorUpPayload = withWorkspace(MirrorHeader.extend({final_sha256: hex64, volumes: z.array(volumeName).max(100)}));
export const MirrorCheckPayload = withWorkspace(MirrorHeader.extend({
    final_sha256: hex64,
    access: z.strictObject({service, target: z.number().int().min(1).max(65535)}),
    http_path: z.string().regex(HTTP_PATH_RE).nullable(),
    wait_s: z.number().int().min(10).max(300),
}));
export const MirrorWipePayload = withWorkspace(MirrorHeader.extend({}));
/** W23: stop the running containers of this revision (no body fields; the revision, project and workspace are in the header, like the wipe). */
export const MirrorStopPayload = withWorkspace(MirrorHeader.extend({}));

/**
 * W24 (ADR-017): switch / remove the private access route of a MIRROR (a runner-local loopback forwarder, stable port across revisions). The header is the one of the revision the route
 * points to (`switch`) or of the newest revision of the mirror (`remove`, its workspace is NOT opened). `route_port` is the stable per-mirror loopback port.
 */
export const MirrorRoutePayload = withWorkspace(MirrorHeader.extend({
    action: z.enum(["switch", "remove"]),
    mirror_id: z.uuid(),
    route_port: z.number().int().min(PORT_RANGE.min).max(PORT_RANGE.max),
    service,
    target: z.number().int().min(1).max(65535),
    http_path: z.string().regex(HTTP_PATH_RE).nullable(),
}));

// ---- results (strict, size-capped by the channel) ----------------------------------------------------------------------------------------
export const MirrorFinalizeResult = z.strictObject({v: z.literal(1), view_sha256: hex64, services: z.number().int().min(0).max(500)});
export const MirrorDbResult = z.strictObject({
    v: z.literal(1),
    dbs: z.array(z.strictObject({index, service, status: z.literal("restored")})).max(20),
    resets: z.array(z.strictObject({service, status: z.literal("done")})).max(20),
});
export const MirrorUpResult = z.strictObject({v: z.literal(1), services: z.array(z.strictObject({service, state: z.enum(["running", "exited"])})).max(500)});
export const MirrorCheckResult = z.strictObject({
    v: z.literal(1),
    services: z.array(z.strictObject({service, state: z.string().max(32), health: z.enum(["healthy", "unhealthy", "starting", "none"])})).max(500),
    smoke: z.strictObject({status: z.enum(["ok", "failed"]), http_status: z.number().int().min(100).max(599).nullable()}),
});
export const MirrorWipeResult = z.strictObject({
    v: z.literal(1), containers: z.number().int().min(0), networks: z.number().int().min(0), volumes: z.number().int().min(0), workspace_removed: z.boolean(), remaining: z.literal(0),
});
/** W23: what the agent reports after a verified stop (`remaining` is always 0: a leftover is the agent code `stop_incomplete`, never a result). */
export const MirrorStopResult = z.strictObject({v: z.literal(1), stopped: z.number().int().min(0), services: z.array(z.strictObject({service, state: z.string().max(32)})).max(500), remaining: z.literal(0)});
/** W24: `switch` = the route now points to this revision and a smoke THROUGH the forwarder passed; `remove` = forwarder container + route dir gone (`remaining` always 0: a leftover is `route_incomplete`). */
export const MirrorRouteSwitchResult = z.strictObject({v: z.literal(1), route_port: z.number().int().min(PORT_RANGE.min).max(PORT_RANGE.max), switched: z.literal(true),
    smoke: z.strictObject({status: z.enum(["ok", "failed"]), http_status: z.number().int().min(100).max(599).nullable()})});
export const MirrorRouteRemoveResult = z.strictObject({v: z.literal(1), removed: z.strictObject({container: z.number().int().min(0).max(1), dir: z.boolean()}), remaining: z.literal(0)});
export const MirrorRouteResult = z.union([MirrorRouteSwitchResult, MirrorRouteRemoveResult]);
