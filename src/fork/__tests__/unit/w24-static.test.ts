import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** W24 static guards (plan A11): who may move the active pointer, and that every status / route change is bounded to the lifecycle code. */
const DIR = path.join(process.cwd(), "src/fork/mirror");
const read = (f: string) => readFileSync(path.join(DIR, f), "utf8");

describe("W24 static guards", () => {
    it("`activeRevisionId:` is assigned ONLY in the two commit functions of lifecycle.ts, in the READY transaction of tick.ts and in the create path of service.ts", () => {
        const life = read("lifecycle.ts");
        expect([...life.matchAll(/activeRevisionId:\s*(?:next|target)\.id/g)]).toHaveLength(2); // commitRefreshSwitch + commitRollback
        expect([...life.matchAll(/\.set\(\{[^}]*activeRevisionId:/g)]).toHaveLength(2);
        const tick = read("tick.ts");
        expect([...tick.matchAll(/\.set\(\{[^}]*activeRevisionId:/g)]).toHaveLength(1);
        for (const f of ["service.ts", "steps.ts", "wipe.ts", "enqueue.ts", "view.ts"]) expect(read(f), f).not.toMatch(/\.set\(\{[^}]*activeRevisionId:/);
    });
    it("`route_revision_id` follows only a runner-confirmed outcome: set in the two commits and the two re-assert paths, never by a service", () => {
        for (const f of ["service.ts", "tick.ts", "steps.ts", "wipe.ts"]) expect(read(f), f).not.toMatch(/routeRevisionId:\s*(?!null)/);
        const life = read("lifecycle.ts");
        const sets = [...life.matchAll(/routeRevisionId:\s*([^,}]+)/g)].map((m) => (m[1] as string).trim());
        expect(sets.sort()).toEqual(["active.id", "c.active.id", "next.id", "null", "target.id"].sort());
    });
    it("the route REMOVE is enqueued without a principal; only `switch` carries one (safety vs forward step)", () => {
        const life = read("lifecycle.ts");
        expect(life).toMatch(/principal: action === "remove" \? null : principal/);
        expect(read("enqueue.ts")).toMatch(/step === "route" && a\.route\?\.action === "remove"/);
    });
    it("lock order: runner before mirror — services never take the runner lock inside a mirror lock", () => {
        const svc = read("service.ts");
        for (const m of svc.matchAll(/withForkLock\(d\.db, `mirror:\$\{[^}]+\}`, async \(tx\) => \{([\s\S]*?)\n    \}\);/g)) expect(m[1], "mirror lock body").not.toMatch(/runner:/);
    });
});
