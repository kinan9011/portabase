import {describe, expect, it} from "vitest";
import {parseMirrorIR} from "@/fork/compose-compiler/ir";
import {CANARY, labView} from "../fixtures/compose-compiler/lab";

const withSvc = (patch: Record<string, unknown>) => {
    const v = labView() as {services: Record<string, Record<string, unknown>>};
    Object.assign(v.services.web, patch);
    return v;
};

describe("mirror IR (W20 Step 4)", () => {
    it("parses the lab-shaped view", () => {
        const r = parseMirrorIR(labView());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const web = r.ir.services.web;
        expect(web.containerName).toBe("lab-web");
        expect(web.ports).toEqual([{host_ip: "127.0.0.1", published: "18080", target: 8080, protocol: "tcp"}]);
        expect(Object.keys(web.environment).sort()).toEqual(["APP_GREETING", "DATABASE_URL", "POSTGRES_PASSWORD", "SMTP_HOST"]);
        expect(web.removed).toEqual({extra_hosts: 1});
        expect(r.ir.services.db.networks).toEqual({internal: {aliases: ["demo-db"], hadStaticIp: false}});
        expect(r.ir.services.db.environment.PASSTHRU).toBeNull();
        expect(r.ir.networks.lab_proxy.external).toBe(true);
        expect(r.ir.networks.internal.external).toBe(false);
        expect(Object.keys(web.passthrough)).toContain("entrypoint");
        expect(Object.keys(web.passthrough)).not.toContain("ports");
    });

    it("ignores unknown nested attachment keys (only aliases are read, nothing is copied)", () => {
        const r = parseMirrorIR(withSvc({networks: {internal: {aliases: ["a"], evil: "x", ipv4_address: "10.0.0.5"}}}));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.ir.services.web.networks).toEqual({internal: {aliases: ["a"], hadStaticIp: true}});
    });

    it("refuses a forged list-form environment / labels with values as view_invalid, never echoing them", () => {
        for (const patch of [{environment: [`A=${CANARY}`]}, {labels: {k: CANARY}}, {environment: {A: CANARY}}]) {
            const r = parseMirrorIR(withSvc(patch));
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.refusals.some((x) => x.code === "view_invalid")).toBe(true);
                expect(JSON.stringify(r.refusals)).not.toContain(CANARY);
            }
        }
    });

    it("refuses build / provider / extends / env_file / unknown keys / bad env key / missing image / external secret / volume driver opts", () => {
        const codes = (patch: Record<string, unknown>) => {
            const r = parseMirrorIR(withSvc(patch));
            return r.ok ? [] : r.refusals.map((x) => x.code);
        };
        expect(codes({build: {context: ""}})).toContain("build");
        expect(codes({provider: {type: ""}})).toContain("provider");
        expect(codes({extends: {service: "x"}})).toContain("unsupported_key");
        expect(codes({env_file: ["/x"]})).toContain("unsupported_key");
        expect(codes({totally_new: 1})).toContain("unsupported_key");
        expect(codes({environment: {"A=B": ""}})).toContain("env_key_invalid");
        expect(codes({image: undefined})).toContain("image_missing");
        expect(codes({privileged: false, devices: []})).toEqual([]); // empty values of refused keys are harmless and dropped
        const v = labView() as Record<string, unknown>;
        v.secrets = {s: {external: true}};
        v.volumes = {pgdata: {driver_opts: {o: "bind", device: "/etc"}}};
        const r = parseMirrorIR(v);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.refusals.map((x) => x.code).sort()).toEqual(["external_secret", "volume_driver_opts"]);
    });

    it("keeps tmpfs volume driver_opts and rejects non-view shapes", () => {
        const v = labView() as Record<string, unknown>;
        v.volumes = {t: {driver_opts: {type: "tmpfs", device: "tmpfs"}}};
        const r = parseMirrorIR(v);
        expect(r.ok && r.ir.volumes.t.tmpfsOpts).toEqual({type: "tmpfs", device: "tmpfs"});
        expect(parseMirrorIR(null).ok).toBe(false);
        expect(parseMirrorIR({services: []}).ok).toBe(false);
    });
});
