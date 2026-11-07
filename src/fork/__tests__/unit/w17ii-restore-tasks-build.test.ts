import {describe, expect, it} from "vitest";
import {validatePayload} from "@/fork/agent-channel/tasks";
import {planRestore} from "@/fork/restore/plan";
import {BuildError, buildComposeRef, buildDbPayload, buildRenderPayload, buildUpPayload, type BuildInput} from "@/fork/restore-tasks/build";
import {blankPolicyView, isPolicyView} from "@/fork/restore-tasks/view";
import {planInput, u} from "@/fork/__tests__/w16-fixtures";

const planOf = (mut?: Parameters<typeof planInput>[0]) => planRestore(planInput((i) => { i.mappings = {...i.mappings, restore_root: "/srv/restore"}; mut?.(i); }));
const bi = (plan: ReturnType<typeof planOf>["plan"]): BuildInput => {
    const indexOf = new Map<string, number>();
    plan.actions.filter((a) => a.op !== "skip" && a.artifact_ids[0]).forEach((a, ix) => { indexOf.set(a.artifact_ids[0], ix); });
    return {restoreId: u(900), planId: u(901), planHash: "a".repeat(64), plan, approvals: ["production_target"], indexOf};
};
const SHA = "b".repeat(64), CSHA = "c".repeat(64);

describe("W17-ii payload builders", () => {
    it("compose ref: dir under the workspace, sorted de-duplicated path_map, overrides carried; render/db/up payloads pass the strict schemas", () => {
        const {plan} = planOf();
        const i = bi(plan);
        const ref = buildComposeRef(i, {env: {A: "1"}, overrideYml: "services: {}\n"});
        expect(ref.dir.startsWith("/srv/restore/app/")).toBe(true);
        expect(ref.env).toEqual({A: "1"});
        const froms = ref.path_map.map((m) => m.from);
        expect(froms).toEqual([...froms].sort());
        expect(new Set(ref.path_map.map((m) => `${m.from}|${m.to}`)).size).toBe(ref.path_map.length);
        expect(ref.path_map.every((m) => m.to.startsWith("/srv/restore/app/"))).toBe(true);
        expect(validatePayload("compose_render", buildRenderPayload(i, SHA, ref) as never)).toBeNull();
        const db = buildDbPayload(i, SHA, ref, CSHA, null);
        expect(db.dbs.length).toBeGreaterThan(0);
        expect(validatePayload("restore_db", db as never)).toBeNull();
        const up = buildUpPayload(i, SHA, ref, CSHA, {v: 1});
        expect(up.compose_sha256).toBe(CSHA);
        expect(validatePayload("compose_up", up as never)).toBeNull();
    });
    it("no overrides ⇒ empty env, null yml; existing_stack mode and a plan without a compose dir are mode_unsupported", () => {
        const {plan} = planOf();
        const ref = buildComposeRef(bi(plan), null);
        expect(ref).toMatchObject({env: {}, override_yml: null});
        const noDir = {...plan, actions: plan.actions.filter((a) => a.kind !== "restore_compose_dir")};
        expect(() => buildComposeRef(bi(noDir), null)).toThrow(BuildError);
        const noUp = {...plan, actions: plan.actions.filter((a) => a.kind !== "compose_up")};
        expect(() => buildRenderPayload(bi(noUp), SHA, ref)).toThrow(BuildError);
        expect(() => buildUpPayload(bi(noUp), SHA, ref, CSHA, null)).toThrow(BuildError);
        const noPg = {...plan, actions: plan.actions.filter((a) => !(a.kind === "restore_db_dump" && a.source.dbms === "postgresql"))};
        expect(() => buildDbPayload(bi(noPg), SHA, ref, CSHA, null)).toThrow(BuildError);
    });
});

describe("policy view helpers (E4)", () => {
    const full = {
        name: "app", "x-secret": {token: "abc", n: 1},
        services: {
            web: {image: "nginx:1", environment: {A: "secret", B: null}, labels: ["a=b"], command: ["sh", "-c", "echo $X"], healthcheck: {test: ["CMD", "x"], interval: "5s"}, ports: [{target: 80, published: "8080"}], "x-note": "hidden"},
            db: {image: "postgres:17", environment: ["POSTGRES_PASSWORD=zzz"], secrets: [{source: "s", target: "t"}]},
        },
        secrets: {s: {content: "c", file: "/etc/x"}}, configs: {c: {environment: "VAR"}},
    };
    it("blanks every scalar of the listed fields, keeps keys / nulls / structure / the rest", () => {
        const v = blankPolicyView(full) as typeof full;
        expect(v.services.web.environment).toEqual({A: "", B: null});
        expect(v.services.web.labels).toEqual([""]);
        expect(v.services.web.command).toEqual(["", "", ""]);
        expect(v.services.web.healthcheck).toEqual({test: ["", ""], interval: ""});
        expect(v.services.web.image).toBe("nginx:1");
        expect(v.services.web.ports).toEqual([{target: 80, published: "8080"}]);
        expect(v.services.web["x-note"]).toBe("");
        expect(v["x-secret"]).toEqual({token: "", n: ""});
        expect(v.services.db.environment).toEqual([""]);
        expect(v.secrets.s).toEqual({content: "", file: "/etc/x"});
        expect(v.configs.c).toEqual({environment: ""});
        expect(JSON.stringify(v)).not.toMatch(/abc|zzz|echo|"secret"/);
    });
    it("isPolicyView: true on a blanked doc (key order irrelevant), false when one env value survives; idempotent", () => {
        const v = blankPolicyView(full);
        expect(isPolicyView(v)).toBe(true);
        expect(isPolicyView(JSON.parse(JSON.stringify(v, Object.keys(v as object).sort())))).toBe(true);
        expect(blankPolicyView(v)).toEqual(v);
        expect(isPolicyView(full)).toBe(false);
        const one = JSON.parse(JSON.stringify(v));
        one.services.web.environment.A = "x";
        expect(isPolicyView(one)).toBe(false);
        expect(isPolicyView({services: {a: {image: "x"}}})).toBe(true);
    });
});
