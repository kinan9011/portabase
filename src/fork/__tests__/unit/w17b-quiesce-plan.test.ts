import {describe, expect, it} from "vitest";
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {defaultQuiesceServices, isManagerImage, planQuiesce, type QuiesceMember} from "@/fork/quiesce/plan";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";

const svc = (name: string, over: Partial<StackInventoryV1["services"][number]> = {}): StackInventoryV1["services"][number] => ({
    name, state: "running", container_id: `${name.padEnd(12, "a").replace(/[^0-9a-f]/g, "b").slice(0, 12)}`, image: {ref: `acme/${name}:1`, pinned: false, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: [], ...over,
});
/** web → db (web depends on db), plus a worker that depends on both */
const inv = (over: Partial<StackInventoryV1> = {}): StackInventoryV1 => cleanInventory({
    services: [svc("web", {depends_on: ["db"]}), svc("db"), svc("worker", {depends_on: ["db", "web"]})],
    mounts: [{id: "m:00000000000000a1", kind: "named_volume", volume_name: "app_data", destination: "/data", rw: true, consumers: ["web", "worker"], ownership: "stack_owned"},
        {id: "m:00000000000000a2", kind: "named_volume", volume_name: "ro_data", destination: "/ro", rw: false, consumers: ["worker"], ownership: "stack_owned"}],
    volumes: [{name: "app_data", driver: "local", in_use_by: ["web", "worker"], ownership: "stack_owned"}, {name: "ro_data", driver: "local", in_use_by: ["worker"], ownership: "stack_owned"}],
    ...over,
});
const members: QuiesceMember[] = [{name: "volume-app_data", dbms: "docker-volume", mountIds: ["m:00000000000000a1"], active: true}, {name: "db-dump", dbms: "postgresql", mountIds: [], active: true}];
const ok = (p: ReturnType<typeof planQuiesce>) => { if (!p.ok) throw new Error(JSON.stringify(p.blockers)); return p; };

describe("W17b planner", () => {
    it("stop order = dependents first, start order = exact reverse; ties by name", () => {
        const p = ok(planQuiesce(inv(), ["db", "web", "worker"], members));
        expect(p.startOrder).toEqual(["db", "web", "worker"]);
        expect(p.stopOrder.map((t) => t.service)).toEqual(["worker", "web", "db"]); // (m2) a flipped order fails here
        const two = ok(planQuiesce(inv({services: [svc("web"), svc("db"), svc("cache")]}), ["web", "db", "cache"], members));
        expect(two.startOrder).toEqual(["cache", "db", "web"]); // no edges: name ascending
    });
    it("edges outside the selection are ignored and the window / pre partition follows the dbms", () => {
        const p = ok(planQuiesce(inv(), ["web", "worker"], members));
        expect(p.startOrder).toEqual(["web", "worker"]);
        expect(p.windowMembers).toEqual(["volume-app_data"]);
        expect(p.preMembers).toEqual(["db-dump"]);
        expect(p.stopOrder[0]).toMatchObject({service: "worker"});
    });
    it("blockers: none / unknown / cycle / too many / no container id / no window member", () => {
        expect(planQuiesce(inv(), [], members)).toEqual({ok: false, blockers: [{code: "no_services"}]});
        expect(planQuiesce(inv(), ["web", "nope"], members)).toMatchObject({ok: false, blockers: expect.arrayContaining([{code: "service_unknown", service: "nope"}])});
        const cyc = inv({services: [svc("a", {depends_on: ["b"]}), svc("b", {depends_on: ["a"]})]});
        expect(planQuiesce(cyc, ["a", "b"], members)).toMatchObject({ok: false, blockers: expect.arrayContaining([{code: "dependency_cycle"}])});
        const many = inv({services: Array.from({length: 33}, (_, i) => svc(`s${i}`))});
        expect((planQuiesce(many, many.services.map((s) => s.name), members) as {blockers: {code: string}[]}).blockers.map((b) => b.code)).toContain("too_many");
        const noid = inv({services: [{...svc("web"), container_id: undefined}, svc("db")]});
        expect(planQuiesce(noid, ["web"], members)).toMatchObject({ok: false, blockers: [{code: "no_container_id", service: "web"}]});
        expect(planQuiesce(inv(), ["web"], [{name: "db-dump", dbms: "postgresql", mountIds: [], active: true}])).toMatchObject({ok: false, blockers: [{code: "no_window_members"}]});
        expect(planQuiesce(inv(), ["web"], [{...members[0], active: false}])).toMatchObject({ok: false});
    });
    it("a not-running selected service is left alone, never targeted", () => {
        const p = ok(planQuiesce(inv({services: [svc("web"), svc("db", {state: "exited"})]}), ["web", "db"], members));
        expect(p.notRunning).toEqual(["db"]);
        expect(p.stopOrder.map((t) => t.service)).toEqual(["web"]);
    });
    it("writer_not_stopped: an unselected RW consumer of a copied mount blocks; a read-only consumer does not", () => {
        const p = planQuiesce(inv(), ["web"], members); // worker also writes app_data and is running
        expect(p).toEqual({ok: false, blockers: [{code: "writer_not_stopped", service: "worker", member: "volume-app_data"}]});
        const ro = [{name: "volume-ro", dbms: "docker-volume", mountIds: ["m:00000000000000a2"], active: true}];
        ok(planQuiesce(inv(), ["web"], ro)); // worker reads ro_data only
    });
    it("manager images anywhere in the stack block (mirror of the agent's guard)", () => {
        for (const ref of ["ghcr.io/portabase/portabase:1.35.2", "portabase/agent:latest", "ghcr.io/getarcaneapp/arcane:v1", "registry.example/portabase-agent-fork:x", "docker.io/library/arcane"]) {
            expect(isManagerImage(ref), ref).toBe(true);
            const p = planQuiesce(inv({services: [svc("web"), svc("mgr", {image: {ref, pinned: false, built_locally: false}})]}), ["web"], members); // (m1) dropping the rule fails here
            expect(p).toMatchObject({ok: false, blockers: expect.arrayContaining([{code: "manager_in_stack", service: "mgr"}])});
        }
        expect(isManagerImage("postgres:17-alpine")).toBe(false);
        expect(isManagerImage("acme/portabase-notes:1")).toBe(false);
    });
    it("labels are PREFILL only: defaults = selection.stop ∪ backup_hints.stop, the explicit list is returned unchanged", () => {
        const i = inv({services: [svc("web", {backup_hints: {stop: true}}), svc("db"), svc("cache", {backup_hints: {stop: false}})]});
        expect(defaultQuiesceServices(i, ["db", "ghost"])).toEqual(["db", "web"]);
        expect(ok(planQuiesce(i, ["cache"], [{name: "v", dbms: "files", mountIds: [], active: true}])).stopOrder.map((t) => t.service)).toEqual(["cache"]);
    });
});
