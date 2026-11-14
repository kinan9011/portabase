import {describe, expect, it} from "vitest";
import {ACCESS, PROJECT, WS} from "@/fork/__tests__/fixtures/compose-compiler/lab";
import {compiledLab, finalViewOf, LIMITS} from "@/fork/__tests__/w22a-final-view";
import {allocatePort, checkDbStep, checkFinalView, checkHealth, checkKept, checkSmoke} from "@/fork/mirror/derive";

type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: compose JSON
const RID = "77777777-7777-4777-8777-777777777777";
const {spec, sourceText} = compiledLab();
const ctx = {project: PROJECT, workspace: WS, access: ACCESS, sourceViewText: sourceText, limits: LIMITS};
const check = (over?: (v: Doc) => void, limits = LIMITS) => checkFinalView(JSON.stringify(finalViewOf(spec, RID, over)), {...ctx, limits});
const firstSvc = (v: Doc) => Object.keys(v.services)[0] as string;
const webOf = (v: Doc) => v.services[ACCESS.service] as Doc;

describe("W22a checkFinalView", () => {
    it("the emulated runner output passes", () => { expect(check()).toEqual({ok: true}); });

    const forged: [string, (v: Doc) => void, string][] = [
        ["extra published port", (v) => { const s = firstSvc(v) === ACCESS.service ? Object.keys(v.services)[1] as string : firstSvc(v); v.services[s].ports = [{target: 5432, published: "5432", host_ip: "127.0.0.1", protocol: "tcp"}]; }, "final_view_invalid"],
        ["0.0.0.0 host_ip", (v) => { webOf(v).ports = [{target: ACCESS.target, published: String(ACCESS.host_port), host_ip: "0.0.0.0", protocol: "tcp"}]; }, "final_view_invalid"],
        ["missing owner label on a service", (v) => { delete v.services[firstSvc(v)].labels["com.portabase.fork.restore_id"]; }, "final_view_invalid"],
        ["missing owner label on a network", (v) => { const n = Object.keys(v.networks)[0] as string; v.networks[n].labels = {}; }, "final_view_invalid"],
        ["an external network", (v) => { const n = Object.keys(v.networks)[0] as string; v.networks[n].external = true; }, "final_view_invalid"],
        ["container_name", (v) => { webOf(v).container_name = "x"; }, "final_view_invalid"],
        ["bind outside the workspace", (v) => { webOf(v).volumes = [{type: "bind", source: "/etc", target: "/x"}]; }, "final_view_invalid"],
        ["network_mode host", (v) => { webOf(v).network_mode = "host"; }, "final_view_invalid"],
        ["image changed vs source", (v) => { webOf(v).image = "evil:latest"; }, "final_view_invalid"],
        ["unredacted env value", (v) => { webOf(v).environment = {SECRET: "plaintext-value"}; }, "final_view_invalid"],
        ["project name changed", (v) => { v.name = "other"; }, "final_view_invalid"],
        ["mem_limit missing", (v) => { delete webOf(v).mem_limit; }, "limits_invalid"],
        ["mem_limit above the policy", (v) => { webOf(v).mem_limit = LIMITS.mem_bytes + 1; }, "limits_invalid"],
        ["mem_limit zero", (v) => { webOf(v).mem_limit = 0; }, "limits_invalid"],
        ["pids_limit missing", (v) => { delete webOf(v).pids_limit; }, "limits_invalid"],
        ["pids_limit above the policy", (v) => { webOf(v).pids_limit = LIMITS.pids + 1; }, "limits_invalid"],
        ["cpus missing", (v) => { delete webOf(v).cpus; }, "limits_invalid"],
        ["cpus above the policy", (v) => { webOf(v).cpus = 2; }, "limits_invalid"],
        ["cpus zero", (v) => { webOf(v).cpus = 0; }, "limits_invalid"],
        ["cpus not numeric", (v) => { webOf(v).cpus = "lots"; }, "limits_invalid"],
    ];
    it.each(forged)("refuses: %s", (_n, mut, code) => {
        const r = check(mut);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe(code);
    });
    it("numeric strings (older compose) are accepted", () => { expect(check((v) => { webOf(v).cpus = "1.000"; webOf(v).mem_limit = String(LIMITS.mem_bytes); }).ok).toBe(true); });
    it("not JSON / not an object", () => {
        expect(checkFinalView("not json", ctx)).toMatchObject({ok: false, code: "final_view_invalid"});
        expect(checkFinalView("[]", ctx)).toMatchObject({ok: false, code: "final_view_invalid"});
    });
});

describe("W22a gate checks", () => {
    it("checkKept: every kept production secret must be confirmed", () => {
        expect(checkKept({kept_production_secrets: []}, [])).toBe(true);
        expect(checkKept({kept_production_secrets: ["web.KEY"]}, [])).toBe(false);
        expect(checkKept({kept_production_secrets: ["web.KEY", "db.PW"]}, ["web.KEY"])).toBe(false);
        expect(checkKept({kept_production_secrets: ["web.KEY"]}, ["web.KEY", "x.Y"])).toBe(true);
    });
    const svc = (service: string, state: string, health: string) => ({service, state, health});
    const res = (services: unknown[], smoke: unknown = {status: "ok", http_status: null}) => ({v: 1, services, smoke});
    it("checkHealth", () => {
        expect(checkHealth(res([svc("web", "running", "healthy"), svc("db", "running", "none")]), ["web", "db"])).toEqual({ok: true});
        expect(checkHealth(res([svc("web", "exited", "none")]))).toEqual({ok: false, code: "service_not_running"});
        expect(checkHealth(res([svc("web", "running", "unhealthy")]))).toEqual({ok: false, code: "service_unhealthy"});
        expect(checkHealth(res([svc("web", "running", "starting")]))).toEqual({ok: false, code: "service_unhealthy"});
        expect(checkHealth(res([svc("web", "running", "healthy")]), ["web", "db"])).toEqual({ok: false, code: "service_not_running"}); // an expected service is missing
        expect(checkHealth(res([]))).toEqual({ok: false, code: "execution_error"});
        expect(checkHealth({junk: 1})).toEqual({ok: false, code: "execution_error"});
    });
    it("checkSmoke: failed, 5xx and a missing status are failures; http 100–499 passes", () => {
        const ok = (s: number | null) => res([svc("web", "running", "none")], {status: "ok", http_status: s});
        expect(checkSmoke(ok(null), {http_path: null})).toEqual({ok: true});
        expect(checkSmoke(ok(200), {http_path: "/"})).toEqual({ok: true});
        expect(checkSmoke(ok(404), {http_path: "/x"})).toEqual({ok: true});
        expect(checkSmoke(ok(500), {http_path: "/"})).toEqual({ok: false, code: "smoke_failed"});
        expect(checkSmoke(ok(null), {http_path: "/"})).toEqual({ok: false, code: "smoke_failed"});
        expect(checkSmoke(res([svc("web", "running", "none")], {status: "failed", http_status: null}), {http_path: null})).toEqual({ok: false, code: "smoke_failed"});
    });
    it("checkDbStep: exact counts only", () => {
        const r = {v: 1, dbs: [{index: 1, service: "db", status: "restored"}], resets: [{service: "db", status: "done"}]};
        expect(checkDbStep(r, 1, 1)).toEqual({ok: true});
        expect(checkDbStep(r, 2, 1)).toEqual({ok: false, code: "db_restore_failed"});
        expect(checkDbStep(r, 1, 0)).toEqual({ok: false, code: "db_restore_failed"});
        expect(checkDbStep({v: 1, dbs: [{index: 1, service: "db", status: "failed"}], resets: []}, 1, 0)).toEqual({ok: false, code: "db_restore_failed"});
    });
    it("allocatePort: lowest free, null when the range is full", () => {
        expect(allocatePort([])).toBe(41000);
        expect(allocatePort([41000, 41001, 41003])).toBe(41002);
        expect(allocatePort([1, 2], {min: 1, max: 2})).toBeNull();
    });
});
