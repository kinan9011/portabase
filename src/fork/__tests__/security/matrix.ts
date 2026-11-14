/**
 * W27a SEC-09 permission matrix (plan D-1/D-2): ONE explicit row per fork server action, route handler and page. `allow` is the ORACLE, written by hand from
 * 05-Security-Model — never computed from `forkCan`. `src/fork/__tests__/unit/security/sec-surface.test.ts` fails when the code has an item without a row (or a
 * row without an item); `integration/security/sec-action-matrix.test.ts` runs every action row for every role through the REAL exported action.
 */
import type {ForkCapability, ForkResourceKind} from "@/fork/acl";
import {DEFAULT_RETENTION} from "@/fork/recovery/retention-policy";
import {DEFAULT_SCHEDULE} from "@/fork/schedule/schedule";
import {R, type Role} from "./roles";
import type {SecWorld} from "./world";

export type ActionRow = {
    /** the primary capability the service must check (D-6: asserted against the recorded `forkCan`/`assertForkCapability`/`assertForkResource` calls) */
    capability: ForkCapability;
    allow: readonly Role[];
    /** "system" = no client resource id (IDOR columns skipped) */
    resource: ForkResourceKind | "system";
    /** which world id the input carries (the IDOR columns swap it for a foreign / missing one) */
    idKey: keyof SecWorld["ids"];
    mutates: boolean;
    /** D21 column: `refused` = the action returns `locked` while the self-check is red and a policy is active; `allowed` needs `lockedWhy` (a cited decision) */
    whileLocked: "refused" | "allowed";
    lockedWhy?: string;
    /** D-2: "service" = the row cannot run through the real action in-test; flagged and covered by the static wrapper check only */
    via?: "action" | "service";
    /** schema-valid input with real ids from the world, so a service that validates BEFORE authorising cannot mask a denial */
    input: (w: SecWorld, id: string) => unknown;
};

const A = R.sysAdminOnly, V = R.memberPlus, X = R.adminPlus;
const row = (capability: ForkCapability, allow: readonly Role[], resource: ActionRow["resource"], idKey: ActionRow["idKey"], mutates: boolean, input: ActionRow["input"], extra: Partial<ActionRow> = {}): ActionRow =>
    ({capability, allow, resource, idKey, mutates, whileLocked: mutates ? "refused" : "allowed", input, ...extra});
const READ = (why: string) => ({whileLocked: "allowed" as const, lockedWhy: why});
const pw = {password: "not-the-password"};
const KID = "0123456789ab";

export const ACTION_MATRIX: Record<`${string}#${string}`, ActionRow> = {
    // ---- agent task channel (W15, ADR-007): system admin only; no client resource id (agents are not a FORK_RESOURCE_KIND)
    "agent-channel.action.ts#enrolAgentAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, ...pw})),
    "agent-channel.action.ts#rotateAgentCredentialAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, ...pw})),
    "agent-channel.action.ts#revokeAgentEnrollmentAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id})),
    "agent-channel.action.ts#setAgentChannelEnabledAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, enabled: true})),
    // ---- test mirrors (W22a, ADR-008/009): resource-scoped mirrors.manage / mirrors.view (org admin+ / member+); the opt-in also needs host_role.manage (system admin who is also an org admin), behind FORK_MIRRORS_ENABLED
    "mirror.action.ts#setStackMirrorOptInAction": row("mirrors.manage", ["superOwner"], "stack", "stack", true, (_w, id) => ({stackId: id, enabled: true})),
    "mirror.action.ts#previewMirrorPlanAction": row("mirrors.manage", X, "stack", "stack", false, (w, id) => ({stackId: id, rpId: w.ids.rp, runnerAgentId: w.ids.agent}), READ("read-only preview, writes nothing")),
    "mirror.action.ts#createMirrorAction": row("mirrors.manage", X, "stack", "stack", true, (w, id) => ({stackId: id, rpId: w.ids.rp, runnerAgentId: w.ids.agent, name: "sec-new", policy: {v: 1, access: {service: "web", target: 8080}, http_path: null, env: {}}, keepConfirmations: {}, acknowledgePrivacy: true})),
    "mirror.action.ts#cancelMirrorRevisionAction": row("mirrors.manage", X, "mirror", "mirrorRevision", true, (_w, id) => ({revisionId: id})),
    "mirror.action.ts#retryMirrorWipeAction": row("mirrors.manage", X, "mirror", "mirrorRevision", true, (_w, id) => ({revisionId: id})),
    "mirror.action.ts#deleteMirrorAction": row("mirrors.manage", X, "mirror", "mirror", true, (_w, id) => ({mirrorId: id, confirmName: "sec-mirror"}), {whileLocked: "allowed", lockedWhy: "OD-W23-2 / D51: removing a production-data copy is always allowed (like the wipe); it only marks the mirror deleting, the tick does the verified wipe"}),
    "mirror.action.ts#getMirrorViewAction": row("mirrors.view", V, "mirror", "mirror", false, (_w, id) => ({mirrorId: id}), READ("read-only view, writes nothing")),
    "mirror.action.ts#getMirrorAccessAction": row("mirrors.view", V, "mirror", "mirror", false, (_w, id) => ({mirrorId: id}), READ("read-only; one audit row per read")),
    // ---- mirror runner (W21, ADR-008): system admin only (agents.channel.manage + host_role.manage), behind FORK_MIRRORS_ENABLED
    "runner.action.ts#designateRunnerAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, ...pw})),
    "runner.action.ts#undesignateRunnerAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id})),
    "runner.action.ts#setRunnerTargetsAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, targets: []})),
    "runner.action.ts#requestRunnerProbeAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id})),
    "agent-channel.action.ts#enqueueAgentTaskAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, type: "noop", payload: {echo: "w27a"}})),
    "agent-channel.action.ts#requestAgentCredentialRotationAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, ...pw})),
    "agent-channel.action.ts#pinDashboardKeyAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, ...pw, pem: "not-a-pem"})),
    "agent-channel.action.ts#unpinDashboardKeyAction": row("agents.channel.manage", A, "system", "agent", true, (_w, id) => ({agentId: id, ...pw, kid: KID})),
    // ---- Arcane connection / environment / sync (W05–W07): arcane.manage = system admin
    "arcane-connection.action.ts#saveArcaneConnectionAction": row("arcane.manage", A, "connection", "connection", true, (_w, id) => ({connectionId: id, name: "arcane-sec", baseUrl: "http://127.0.0.1:9", apiKey: "arcane_sec_not_a_real_key_0123456789"})),
    "arcane-connection.action.ts#testArcaneConnectionAction": row("arcane.manage", A, "connection", "connection", false, (_w, id) => ({connectionId: id}), {whileLocked: "refused"}),
    "arcane-connection.action.ts#rotateArcaneKeyAction": row("arcane.manage", A, "connection", "connection", true, (_w, id) => ({connectionId: id, apiKey: "arcane_sec_not_a_real_key_0123456789"})),
    "arcane-connection.action.ts#disconnectArcaneAction": row("arcane.manage", A, "connection", "connection", true, (_w, id) => ({connectionId: id})),
    "arcane-environment.action.ts#updateArcaneEnvironmentAction": row("arcane.manage", A, "environment", "environment", true, (_w, id) => ({environmentId: id, enabled: true})),
    "sync.action.ts#syncArcaneNowAction": row("arcane.manage", A, "connection", "connection", true, (_w, id) => ({connectionId: id}), {whileLocked: "refused"}),
    // ---- recovery kit (W14)
    "dashboard-db.action.ts#declareDashboardDbSourceAction": row("recovery.kit.manage", A, "system", "stack", true, () => ({databaseId: null})),
    "kit.action.ts#beginKitGenerationAction": row("recovery.kit.manage", A, "system", "stack", true, () => ({types: ["digital"], ...pw})),
    "kit.action.ts#confirmKitFingerprintAction": row("recovery.kit.manage", A, "system", "stack", true, () => ({fingerprint: "AAAA-BBBB", type: "digital"})),
    "kit.action.ts#rotateKekAction": row("recovery.kit.manage", A, "system", "stack", true, () => ({...pw})),
    // ---- stacks: policy / schedule / materialize / quiesce / runs (W09–W13, W17b)
    "materialize.action.ts#materializeStackAction": row("stacks.backup.manage", A, "stack", "stack", true, (_w, id) => ({stackId: id})),
    "materialize.action.ts#removeStackSourcesAction": row("stacks.backup.manage", A, "stack", "stack", true, (w, id) => ({stackId: id, sourceIds: [w.ids.source], confirm: true})),
    "stack-policy.action.ts#activateStackPolicyAction": row("stacks.backup.manage", A, "stack", "stack", true, (_w, id) => ({stackId: id})),
    "stack-policy.action.ts#previewStackPolicyAction": row("stacks.backup.manage", A, "stack", "stack", false, (_w, id) => ({stackId: id}), READ("preview writes nothing")),
    "stack-schedule.action.ts#updateStackScheduleAction": row("stacks.backup.manage", A, "stack", "stack", true, (_w, id) => ({stackId: id, schedule: DEFAULT_SCHEDULE, retention: DEFAULT_RETENTION})),
    "stack-quiesce.action.ts#previewQuiesceAction": row("stacks.view", V, "stack", "stack", false, (_w, id) => ({stackId: id}), READ("preview writes nothing")),
    "stack-quiesce.action.ts#enableQuiesceAction": row("stacks.backup.manage", A, "stack", "stack", true, (_w, id) => ({stackId: id, services: ["web"], maxStopSeconds: 300})),
    "stack-quiesce.action.ts#disableQuiesceAction": row("stacks.backup.manage", A, "stack", "stack", true, (_w, id) => ({stackId: id})),
    "stack-quiesce.action.ts#startQuiesceNowAction": row("stacks.backup.manage", A, "stack", "stack", true, (_w, id) => ({stackId: id})),
    "stack-run.action.ts#startStackRunAction": row("backup.run", X, "stack", "stack", true, (_w, id) => ({stackId: id}), READ("W12 decision: a manual backup run is allowed while config is locked (a backup is never blocked by the lock)")),
    "stack-run.action.ts#cancelStackRunAction": row("backup.run", X, "stack_run", "stackRun", true, (_w, id) => ({runId: id}), READ("W12 decision: cancelling a run is allowed while locked")),
    // ---- restore plans / overrides / runs (W16–W18)
    "restore-plan.action.ts#createRestorePlanAction": row("restore.plan", X, "recovery_point", "rp", true, (w, id) => ({rpId: id, targetAgentId: w.ids.agent, purpose: "restore", mode: "new_stack", mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: null, sqlite: null}})),
    "restore-plan.action.ts#approveRestorePlanAction": row("restore.execute", X, "restore_plan", "restorePlan", true, (w, id) => ({planId: id, planHash: w.ids.planHash, kind: "destructive_replace"})),
    "restore-plan.action.ts#getRestorePlanViewAction": row("restore.plan", X, "restore_plan", "restorePlan", false, (_w, id) => ({planId: id}), READ("read-only view, writes nothing")),
    "restore-plan.action.ts#setStackPrivacyAction": row("stacks.backup.manage", A, "stack", "stack", true, (_w, id) => ({stackId: id, containsPersonalData: false, testRestoreOptIn: false})),
    "stack-config.action.ts#setRestoreOverridesAction": row("restore.plan", X, "restore_plan", "restorePlan", true, (w, id) => ({planId: id, planHash: w.ids.planHash, set: [], unset: []})),
    "stack-config.action.ts#clearRestoreOverridesAction": row("restore.plan", X, "restore_plan", "restorePlan", true, (w, id) => ({planId: id, planHash: w.ids.planHash})),
    "stack-config.action.ts#getRestoreOverridesViewAction": row("restore.plan", X, "restore_plan", "restorePlan", false, (w, id) => ({planId: id, planHash: w.ids.planHash}), {whileLocked: "refused"}),
    "restore-run.action.ts#startRestoreRunAction": row("restore.execute", X, "restore_plan", "restorePlan", true, (w, id) => ({planId: id, planHash: w.ids.planHash, confirm: "RESTORE x"})),
    "restore-run.action.ts#approveRestorePolicyAction": row("restore.production.approve", R.ownerOrSysAdmin, "restore_run", "restoreRun", true, (_w, id) => ({runId: id, confirmations: {}})),
    "restore-run.action.ts#cancelRestoreRunAction": row("restore.execute", X, "restore_run", "restoreRun", true, (_w, id) => ({runId: id}), {whileLocked: "refused"}),
    "restore-run.action.ts#cleanupRestoreRunAction": row("restore.execute", X, "restore_run", "restoreRun", true, (_w, id) => ({runId: id}), {whileLocked: "refused"}),
    "restore-run.action.ts#getRestoreRunViewAction": row("restore.plan", X, "restore_run", "restoreRun", false, (_w, id) => ({runId: id}), READ("read-only view, writes nothing")),
    "restore-run.action.ts#listRestoreRunsAction": row("restore.plan", X, "stack", "stack", false, (_w, id) => ({stackId: id}), READ("read-only view, writes nothing")),
    // ---- test restore (W-TR)
    // needs BOTH stacks.backup.manage and restore.execute (service.ts: two gates); a membership-less system admin holds only the first ⇒ only superOwner passes (pinned)
    "test-restore.action.ts#setTestRestoreScheduleAction": row("stacks.backup.manage", ["superOwner"], "stack", "stack", true, (w, id) => ({stackId: id, enabled: false, schedule: DEFAULT_SCHEDULE, targetAgentId: w.ids.agent, restoreRoot: "/srv/restore", staleAfterDays: 7})),
    "test-restore.action.ts#runTestRestoreNowAction": row("restore.execute", X, "stack", "stack", true, (_w, id) => ({stackId: id})),
    "test-restore.action.ts#wipeTestRestoreNowAction": row("restore.execute", X, "restore_run", "restoreRun", true, (_w, id) => ({runId: id}), {whileLocked: "refused"}),
    "test-restore.action.ts#getTestRestoreViewAction": row("stacks.view", V, "stack", "stack", false, (_w, id) => ({stackId: id}), READ("read-only view, writes nothing")),
};

// ---- route handlers (D-7): auth kind + where the behavioural proof lives
export type RouteRow = {auth: "agent-bearer" | "session-sysadmin-csrf" | "session-sysadmin-get"; coveredBy: string[]};
const AG = (...f: string[]): RouteRow => ({auth: "agent-bearer", coveredBy: ["integration/security/sec-route-matrix.test.ts", ...f]});
export const ROUTE_MATRIX: Record<string, RouteRow> = {
    "POST /api/fork/agent/[agentId]/lease": AG("integration/w15-agent-channel-service.test.ts"),
    "POST /api/fork/agent/[agentId]/hash-report": AG("integration/w15-agent-channel-service.test.ts"),
    "POST /api/fork/agent/[agentId]/tasks/[taskId]/heartbeat": AG("integration/w15-agent-channel-service.test.ts"),
    "POST /api/fork/agent/[agentId]/tasks/[taskId]/result": AG("integration/w15-agent-channel-service.test.ts"),
    "POST /api/fork/agent/[agentId]/tasks/[taskId]/render": AG("integration/w17-restore-render.test.ts"),
    "POST /api/fork/agent/[agentId]/tasks/[taskId]/quiesce": AG("integration/w17b-quiesce-run.test.ts"),
    "POST /api/fork/kit/[kind]": {auth: "session-sysadmin-csrf", coveredBy: ["integration/security/sec-route-matrix.test.ts", "unit/w14-kit-route.test.ts"]},
    "GET /api/fork/status": {auth: "session-sysadmin-get", coveredBy: ["integration/security/sec-route-matrix.test.ts", "unit/status-route.test.ts"]},
};

// ---- pages (D-8): capability asserted from source (+ notFound) and the behavioural tests that already exercise them
export type PageRow = {capability: ForkCapability | "mode-only"; coveredBy: string[]};
const PG = "app/(customer)/dashboard/";
export const PAGE_MATRIX: Record<string, PageRow> = {
    [`${PG}(admin)/integrations/page.tsx`]: {capability: "arcane.manage", coveredBy: ["unit/w06-integrations-page.test.tsx"]},
    [`${PG}(admin)/integrations/agent-channel/page.tsx`]: {capability: "agents.channel.manage", coveredBy: ["e2e/w15-agent-channel-lab.test.ts"]},
    [`${PG}(admin)/integrations/recovery-kit/page.tsx`]: {capability: "recovery.kit.manage", coveredBy: ["e2e/w14-kit.test.ts"]},
    [`${PG}(organization)/stacks/page.tsx`]: {capability: "stacks.view", coveredBy: ["unit/w08-stacks-pages.test.tsx", "e2e/w08-stacks.test.ts"]},
    [`${PG}(organization)/stacks/[stackId]/page.tsx`]: {capability: "stacks.view", coveredBy: ["unit/w08-stacks-pages.test.tsx", "e2e/wtr-panel-pages.test.ts"]},
    [`${PG}(organization)/stacks/[stackId]/configure/page.tsx`]: {capability: "stacks.backup.manage", coveredBy: ["e2e/w11-configure.test.ts"]},
    [`${PG}(organization)/recovery/page.tsx`]: {capability: "recovery.view", coveredBy: ["e2e/w18b-recovery-pages.test.ts"]},
    [`${PG}(organization)/recovery/new/page.tsx`]: {capability: "recovery.view", coveredBy: ["e2e/w18b-recovery-pages.test.ts"]},
    [`${PG}(organization)/recovery/plans/[planId]/page.tsx`]: {capability: "restore.plan", coveredBy: ["e2e/w18b-recovery-pages.test.ts"]},
    [`${PG}(organization)/recovery/runs/[runId]/page.tsx`]: {capability: "restore.plan", coveredBy: ["e2e/w18b-recovery-pages.test.ts"]},
    [`${PG}(organization)/mirrors/page.tsx`]: {capability: "mirrors.view", coveredBy: ["unit/w23-mirrors-list.test.tsx", "e2e/w23-mirror-pages.test.ts"]},
    [`${PG}(organization)/mirrors/new/page.tsx`]: {capability: "mirrors.manage", coveredBy: ["unit/w22b-mirror-wizard.test.tsx", "e2e/w22b-mirror-pages.test.ts"]},
    [`${PG}(organization)/mirrors/[mirrorId]/page.tsx`]: {capability: "mirrors.view", coveredBy: ["unit/w22b-mirror-progress.test.tsx", "e2e/w22b-mirror-pages.test.ts"]},
    [`${PG}(organization)/recovery/plans/page.tsx`]: {capability: "mode-only", coveredBy: ["unit/w27a-recovery-index.test.ts", "e2e/w18b-recovery-pages.test.ts"]},
    [`${PG}(organization)/recovery/runs/page.tsx`]: {capability: "mode-only", coveredBy: ["unit/w27a-recovery-index.test.ts", "e2e/w18b-recovery-pages.test.ts"]},
};
