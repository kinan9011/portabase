import {readFileSync, readdirSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((n) => { const rel = join(dir, n); return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel]; });

describe("W23 static guards", () => {
    it("list-view never selects a task result, a sealed payload, a lease or event details for output", () => {
        const src = read("src/fork/mirror/list-view.ts");
        for (const bad of [/payloadEnc/, /forkAgentTask\.result/, /\.leaseId/, /forkMirrorEvent\.details/, /\.select\(\)/, /payload_enc/]) expect(src, String(bad)).not.toMatch(bad);
        expect(src).toMatch(/details->>'scope'/); // the one key read from event details, as a code
    });
    it("no mirror UI file contains the tunnel command (the hint only comes from the click-only, audited access action)", () => {
        for (const f of walk("src/fork/ui/mirrors").filter((x) => /\.(ts|tsx)$/.test(x))) expect(read(f), f).not.toMatch(/ssh -L/);
    });
    it("lifecycle buttons live only in src/fork/ui/mirrors/lifecycle (the list and detail import them)", () => {
        for (const f of walk("src/fork/ui/mirrors").filter((x) => /\.(ts|tsx)$/.test(x) && !x.includes("/lifecycle/"))) expect(read(f), f).not.toMatch(/deleteMirrorAction|stopMirrorAction|startMirrorAction/);
    });
    it("every W23 UI file is free of Tooltip / title= / EventSource (also enforced by w22b-static over the same folder)", () => {
        for (const f of walk("src/fork/ui/mirrors").filter((x) => /\.(ts|tsx)$/.test(x))) expect(read(f), f).not.toMatch(/Tooltip|EventSource|\btitle=\{?["`]/);
    });
});
