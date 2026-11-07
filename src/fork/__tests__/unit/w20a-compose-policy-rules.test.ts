import {createHash} from "node:crypto";
import {readFileSync, readdirSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {canonicalJson} from "@/fork/canonical";
import denyRules from "@/fork/policy/compose-deny.json";
import {HARD_IDS, RULES, RULES_SHA256, RULE_IDS, RulesV2, isCanonPath, isSocketPath, isUnderRoots, plainOf} from "@/fork/policy/rules";

const ROOT = process.cwd();
const policyFiles = readdirSync(path.join(ROOT, "src/fork/policy")).filter((f) => f.endsWith(".ts"));
const clone = () => JSON.parse(JSON.stringify(denyRules)) as Record<string, unknown> & {rules: {id: string; plain?: string}[]};

describe("compose rule file v2 (W20a)", () => {
    it("loads, validates and exposes ids in file order", () => {
        expect(RULES.version).toBe(2);
        expect(RULES.rules.map((r) => r.id)).toEqual([...RULE_IDS]);
        expect(RULES.hard_refusals.map((r) => r.id)).toEqual([...HARD_IDS]);
        for (const id of [...RULE_IDS, ...HARD_IDS]) expect(plainOf(id).length, id).toBeGreaterThan(20);
    });
    it("RULES_SHA256 equals the W16 DENY_RULES_SHA256 formula (sha256 of canonical JSON of the file)", () => {
        expect(RULES_SHA256).toBe(createHash("sha256").update(canonicalJson(denyRules)).digest("hex"));
        const load = readFileSync(path.join(ROOT, "src/fork/restore/load.ts"), "utf8");
        expect(load).toContain('createHash("sha256").update(canonicalJson(denyRules)).digest("hex")');
    });
    it("rejects mutated rule files (fail closed)", () => {
        const bad: Record<string, (j: ReturnType<typeof clone>) => void> = {
            "version 1": (j) => { j.version = 1; },
            "unknown rule id": (j) => { j.rules[0]!.id = "root_please"; },
            "duplicate rule id": (j) => { j.rules[1]!.id = j.rules[0]!.id; },
            "missing plain": (j) => { delete j.rules[0]!.plain; },
            "short plain": (j) => { j.rules[0]!.plain = "x"; },
            "extra key": (j) => { j.extra = true; },
            "dropped hard refusal": (j) => { (j.hard_refusals as unknown[]).pop(); },
            "bad socket basename": (j) => { j.docker_socket_basename = "x.sock"; },
            "lowercase cap": (j) => { (j.cap_add_allowlist as string[]).push("sys_admin"); },
        };
        for (const [name, mutate] of Object.entries(bad)) {
            const j = clone();
            mutate(j);
            expect(RulesV2.safeParse(j).success, name).toBe(false);
        }
        expect(RulesV2.safeParse(clone()).success).toBe(true);
    });
    it("cap_add allow-list never contains the dangerous capabilities", () => {
        for (const c of ["ALL", "SYS_ADMIN", "SYS_PTRACE", "NET_ADMIN", "SYS_MODULE", "DAC_READ_SEARCH", "SYS_RAWIO", "BPF"]) expect(RULES.cap_add_allowlist, c).not.toContain(c);
    });
    it("path predicates: canonical paths, roots, docker socket and its parents", () => {
        for (const p of ["/", "/restore", "/restore/a/b", "/a.b/c-d", "/é"]) expect(isCanonPath(p), p).toBe(true);
        for (const p of ["", "a", "./a", "/a/", "/a//b", "/a/./b", "/a/../b", "/..", "/a/b/..", "/a$b", "/a\nb", "/a\u0000b", "/a\u007fb", `/${"a".repeat(1024)}`, 5, null]) expect(isCanonPath(p), String(p)).toBe(false);
        expect(isUnderRoots("/restore", ["/restore"])).toBe(true);
        expect(isUnderRoots("/restore/x", ["/restore"])).toBe(true);
        expect(isUnderRoots("/restore-evil", ["/restore"])).toBe(false);
        expect(isUnderRoots("/b/x", ["/a", "/b"])).toBe(true);
        for (const p of ["/var/run/docker.sock", "/run/docker.sock", "/var/run", "/run", "/var", "/", "/x/docker.sock"]) expect(isSocketPath(p), p).toBe(true);
        for (const p of ["/restore", "/etc", "/var/lib", "/runner"]) expect(isSocketPath(p), p).toBe(false);
    });
});

describe("purity and boundaries of src/fork/policy (D-11, D-12)", () => {
    const FORBIDDEN = [/node:fs/, /child_process/, /node:net\b/, /node:https?/, /\bfetch\(/, /process\.env/, /\bDate\b/, /Math\.random/, /\bconsole\./, /@\/fork\/db/];
    it("every policy module is pure: no fs, process spawning, network, env, clock, randomness, logging or DB", () => {
        expect(policyFiles.sort()).toEqual(["approval.ts", "engine.ts", "raw.ts", "rules.ts"]);
        for (const f of policyFiles) {
            const src = readFileSync(path.join(ROOT, "src/fork/policy", f), "utf8");
            for (const re of FORBIDDEN) expect(re.test(src), `${f} matches ${re}`).toBe(false);
        }
    });
    it("the dashboard never runs compose: the only non-test child_process importers are the pg_dump and restic runners", () => {
        const found: string[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(path.join(ROOT, dir), {withFileTypes: true})) {
                const rel = `${dir}/${e.name}`;
                if (e.isDirectory()) { if (e.name !== "__tests__") walk(rel); } else if (/\.tsx?$/.test(e.name) && /child_process/.test(readFileSync(path.join(ROOT, rel), "utf8"))) found.push(rel);
            }
        };
        walk("src/fork");
        expect(found.sort()).toEqual(["src/fork/db/predump.ts", "src/fork/manifest/restic-runner.ts"]);
        for (const f of found) expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/compose/i);
    });
    it("signature and checksum failures are not policy inputs: no rule or hard id mentions them, the approval API takes no manifest result", () => {
        for (const id of [...RULE_IDS, ...HARD_IDS]) expect(id).not.toMatch(/signature|checksum/i);
        const approval = readFileSync(path.join(ROOT, "src/fork/policy/approval.ts"), "utf8");
        const exported = [...approval.matchAll(/export (?:const|function|type) (\w+)/g)].map((m) => m[1]);
        for (const name of exported) expect(name, name).not.toMatch(/manifest|signature|checksum/i);
        expect(approval.replace(/\/\*\*[\s\S]*?\*\//g, "")).not.toMatch(/manifest/i);
    });
});
