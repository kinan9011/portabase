import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {enqueueTask, validatePayload} from "@/fork/agent-channel/tasks";
import {COMPOSE_TASK_TYPES, PUBLIC_TASK_TYPES, RESTORE_TASK_TYPES, TARGETED_TASK_TYPES, TASK_REQUIRES, TASK_TYPES, QUIESCE_TASK_TYPES} from "@/fork/agent-channel/vocab";
import {planRestore} from "@/fork/restore/plan";
import {BuildError, artifactIndexes, buildApplyPayload, buildCleanupPayload, buildHeader, buildProbePayload, buildStagePayload, type BuildInput} from "@/fork/restore-tasks/build";
import {RESTORE_REASONS} from "@/fork/restore-tasks/codes";
import {planInput, u} from "@/fork/__tests__/w16-fixtures";

const ROOT = process.cwd();
const RID = u(900), PLAN = u(901);
const planOf = (mut?: Parameters<typeof planInput>[0]) => planRestore(planInput((i) => { i.mappings = {...i.mappings, restore_root: "/srv/restore"}; mut?.(i); }));
const bi = (plan: ReturnType<typeof planOf>["plan"], approvals: BuildInput["approvals"] = ["production_target"]): BuildInput => {
    const indexOf = new Map<string, number>();
    plan.actions.filter((a) => a.op !== "skip" && a.artifact_ids[0]).forEach((a, ix) => { indexOf.set(a.artifact_ids[0], ix); });
    return {restoreId: RID, planId: PLAN, planHash: "a".repeat(64), plan, approvals, indexOf};
};

describe("W17-i vocabulary", () => {
    it("restore types are targeted, require restore.target.v1 and are never public", () => {
        expect([...RESTORE_TASK_TYPES]).toEqual(["restore_probe", "restore_stage", "restore_apply", "restore_cleanup"]);
        expect([...TARGETED_TASK_TYPES]).toEqual([...RESTORE_TASK_TYPES, ...COMPOSE_TASK_TYPES, ...QUIESCE_TASK_TYPES]); // W17b appends the two quiesce types
        for (const t of COMPOSE_TASK_TYPES) { expect(TASK_REQUIRES[t]).toEqual(["restore.target.v1", "compose.render.v1"]); expect(PUBLIC_TASK_TYPES as readonly string[]).not.toContain(t); }
        for (const t of RESTORE_TASK_TYPES) { expect(TASK_REQUIRES[t]).toEqual(["restore.target.v1"]); expect(TASK_TYPES).toContain(t); expect(PUBLIC_TASK_TYPES as readonly string[]).not.toContain(t); }
        // envelope type grammar has no dots (ADR-007 A13)
        for (const t of TASK_TYPES) expect(t).toMatch(/^[a-z][a-z0-9_]{1,47}$/);
    });
    it("the closed code list has no duplicates and none collides with a channel code", () => {
        expect(new Set(RESTORE_REASONS).size).toBe(RESTORE_REASONS.length);
        for (const c of ["bad_signature", "target_mismatch", "payload_invalid", "execution_error"]) expect(RESTORE_REASONS as readonly string[]).not.toContain(c);
    });
    it("the generic enqueue refuses every restore type (static: input enum is PUBLIC_TASK_TYPES)", async () => {
        for (const type of [...RESTORE_TASK_TYPES, ...COMPOSE_TASK_TYPES]) expect(await enqueueTask({principal: null} as never, {agentId: u(1), type, payload: {}})).toMatchObject({ok: false});
    });
});

describe("payload builders (pure mapping of a verified plan)", () => {
    it("header: workspace = restore_root/project; approvals sorted; schema valid", () => {
        const {plan} = planOf();
        const h = buildHeader(bi(plan, ["production_target", "destructive_replace"]));
        expect(h).toMatchObject({workspace: "/srv/restore/app", project: "app", approvals: ["destructive_replace", "production_target"], host_role: "production"});
        expect(validatePayload("restore_cleanup", {...h, workspace_remove: true, volumes: true, networks: true, containers: false})).toBeNull();
    });
    it("stage: every live artifact once (manifest order), URLs only for them, dests under the workspace, PG dumps staged but not extracted", () => {
        const {plan} = planOf();
        const i = bi(plan);
        const ix = artifactIndexes(i);
        expect(ix).toEqual([...new Set(ix)].sort((a, b) => a - b));
        const urls = new Map(ix.map((n) => [n, `https://s.example/${n}`]));
        const p = buildStagePayload(i, {manifest: {jsonB64: "e30=", sigB64: "AAAA", sha256: "b".repeat(64)}, urls});
        expect(p.artifacts.map((a) => a.index)).toEqual(ix);
        expect(p.paths.every((x) => x.dest.startsWith("/srv/restore/app/"))).toBe(true);
        const pgIndex = i.indexOf.get(plan.actions.find((a) => a.kind === "restore_db_dump")!.artifact_ids[0])!;
        expect(p.paths.map((x) => x.index)).not.toContain(pgIndex);
        expect(validatePayload("restore_stage", p as never)).toBeNull();
        expect(() => buildStagePayload(i, {manifest: {jsonB64: "e30=", sigB64: "AAAA", sha256: "b".repeat(64)}, urls: new Map()})).toThrow(BuildError);
    });
    it("apply: volumes with compose_volume (project prefix stripped), networks, manifest hash bound", () => {
        const {plan} = planOf();
        const p = buildApplyPayload(bi(plan), "c".repeat(64));
        expect(p.manifest_sha256).toBe("c".repeat(64));
        expect(p.volumes).toEqual([expect.objectContaining({name: "app_data", compose_volume: "data"})]);
        expect(validatePayload("restore_apply", p as never)).toBeNull();
    });
    it("existing_stack is never built (OD-W17-5), a plan without a restore root is invalid", () => {
        const {plan} = planOf();
        expect(() => buildHeader(bi({...plan, mode: "existing_stack"}))).toThrow(BuildError);
        expect(() => buildHeader(bi({...plan, target: {...plan.target, restore_root: null}}))).toThrow(BuildError);
    });
    it("cleanup and probe payloads validate; probe workspace is optional", () => {
        const {plan} = planOf();
        expect(validatePayload("restore_cleanup", buildCleanupPayload(bi(plan), {workspace: true, volumes: true, networks: false, containers: false}) as never)).toBeNull();
        expect(buildProbePayload()).toEqual({v: 1});
        expect(validatePayload("restore_probe", buildProbePayload("/srv/restore/app") as never)).toBeNull();
        expect(validatePayload("restore_probe", {v: 1, workspace: "rel"})).not.toBeNull();
    });
});

describe("static guards", () => {
    const dir = path.join(ROOT, "src/fork/restore-tasks");
    const code = (f: string) => readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    it("the scope is exactly build / codes / enqueue / payload-schema / render / view", () => { expect(readdirSync(dir).sort()).toEqual(["build.ts", "codes.ts", "enqueue.ts", "payload-schema.ts", "render.ts", "view.ts"]); });
    it("pure modules (build, codes, payload-schema) import no I/O, DB, env, clock or crypto", () => {
        for (const f of ["build.ts", "codes.ts", "payload-schema.ts", "view.ts"]) {
            const c = code(f);
            for (const m of c.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)) expect(m[1], `${f} imports ${m[1]}`).toMatch(/^(zod|@\/fork\/restore\/(schema|vocab)|@\/fork\/quiesce\/vocab|\.\/(build|codes|payload-schema|view))$/);
            expect(c, f).not.toMatch(/\bfetch\(|process\.env|new Date\(|Date\.now\(|console\./);
        }
    });
    it("no agent-version gating, no logger / console, no URL or payload in audit details", () => {
        for (const f of readdirSync(dir)) {
            const c = code(f);
            expect(c, f).not.toMatch(/isAgentVersionAtLeast|MIN_AGENT_VERSION|agent\.version|semver|console\.|logger\./);
        }
        const e = code("enqueue.ts");
        // audit detail keys are an explicit allowlist: ids, hashes, codes, counts
        for (const m of e.matchAll(/audit\("(?:success|denied)",\s*\{([^}]*)\}/g)) expect(m[1]).not.toMatch(/\burl|payload|manifest\b|dest|workspace/i);
    });
});
