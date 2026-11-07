import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterAll, describe, expect, it} from "vitest";
import {evaluateRenderedCompose} from "@/fork/policy/engine";
import {type RawResult, type RawKind, checkRawCompose} from "@/fork/policy/raw";
import {HARD_IDS, RULES, RULE_IDS, isCanonPath} from "@/fork/policy/rules";

/**
 * W20a shared-corpus parity: ONE hand-written oracle (src/fork/policy/compose-policy-vectors.json) is evaluated by the TS engine, by the
 * bare-host CLI's jq program (`evaluate_deny`, sourced) and by `kit-tool compose-scan` (raw YAML). The agent (W17, Rust) copies the same file.
 * A missing `jq` / PyYAML FAILS the suite (never silently skipped): that would hollow out the parity guarantee.
 */
type Pair = [string | null, string];
type RenderedVector = {name: string; roots: string[]; compose: unknown; expect: {verdict: string; findings: Pair[]; hard: Pair[]}; skip?: {cli?: string}};
type RawVector = {name: string; root: string; entry: string[]; files: {path: string; text: string}[]; text_gen?: {pad_comment_bytes: number}; expect: RawResult; skip?: {cli?: string}};
const CORPUS = JSON.parse(readFileSync(path.join(process.cwd(), "src/fork/policy/compose-policy-vectors.json"), "utf8")) as {rendered: RenderedVector[]; raw: RawVector[]};
const CLI = path.join(process.cwd(), "scripts/fork/recover/portabase-recover");
const KIT = path.join(process.cwd(), "scripts/fork/recover/kit-tool");
const RULES_PATH = path.join(process.cwd(), "src/fork/policy/compose-deny.json");
const CLEAN: RawResult = {refused: false, violations: [], reason: null};
const HARD = new Set<string>(HARD_IDS);

const tools = {
    jq: spawnSync("jq", ["--version"], {encoding: "utf8"}).status === 0,
    yaml: spawnSync("python3", ["-I", "-c", "import yaml"], {encoding: "utf8"}).status === 0,
};
const key = (p: Pair) => `${p[0] ?? "-"}|${p[1]}`;
const sorted = (ps: Pair[]) => ps.map(key).sort();
const rawText = (v: RawVector, i: number, text: string) => (i === 0 && v.text_gen ? `${text}\n#${"x".repeat(v.text_gen.pad_comment_bytes)}\n` : text);

function verdictOfLines(lines: {service: string | null; rule: string}[]): {verdict: string; pairs: Pair[]} {
    const pairs = lines.map((l): Pair => [l.service, l.rule]);
    return {verdict: pairs.some((p) => HARD.has(p[1])) ? "deny" : pairs.length ? "needs-explicit-override" : "allow", pairs};
}

describe("parity prerequisites", () => {
    it("jq is installed (apt install jq)", () => expect(tools.jq, "jq missing: sudo apt install jq").toBe(true));
    it("PyYAML is installed (apt install python3-yaml)", () => expect(tools.yaml, "python3 yaml missing: sudo apt install python3-yaml").toBe(true));
});

describe("shared corpus: TS engine", () => {
    for (const v of CORPUS.rendered) {
        it(`rendered/${v.name}`, () => {
            const r = evaluateRenderedCompose({rendered: JSON.stringify(v.compose), roots: v.roots, raw: CLEAN, drift: null});
            expect(r.verdict).toBe(v.expect.verdict);
            expect(sorted(r.hard.map((h): Pair => [h.service, h.code]))).toEqual(sorted(v.expect.hard));
            if (v.expect.verdict !== "deny") expect(sorted(r.findings.map((f): Pair => [f.service, f.rule]))).toEqual(sorted(v.expect.findings));
        });
    }
    for (const v of CORPUS.raw) {
        it(`raw/${v.name}`, () => {
            const files = v.files.map((f, i) => ({path: f.path, text: rawText(v, i, f.text)}));
            const r = checkRawCompose({root: v.root, entry: v.entry, files});
            expect(r).toEqual(v.expect);
        });
    }
});

describe("shared corpus: CLI jq (portabase-recover evaluate_deny, sourced)", () => {
    for (const v of CORPUS.rendered.filter((x) => !x.skip?.cli)) {
        it(`rendered/${v.name}`, () => {
            const r = spawnSync("bash", ["-c", 'source "$1"; DENY="$2"; RESTORE_ROOT="$3"; evaluate_deny', "_", CLI, RULES_PATH, v.roots[0] as string], {input: JSON.stringify(v.compose), encoding: "utf8"});
            if (r.status !== 0) { // jq stopped with an error on odd input: the CLI treats that as a refusal (die 4)
                expect(v.expect.verdict, `jq failed: ${r.stderr.slice(0, 200)}`).toBe("deny");
                return;
            }
            const lines = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as {service: string | null; rule: string});
            const got = verdictOfLines(lines);
            expect(got.verdict).toBe(v.expect.verdict);
            expect(sorted(got.pairs)).toEqual(sorted(v.expect.verdict === "deny" ? v.expect.hard : v.expect.findings));
        });
    }
});

describe("shared corpus: kit-tool compose-scan (raw YAML)", () => {
    const dirs: string[] = [];
    afterAll(() => { for (const d of dirs) rmSync(d, {recursive: true, force: true}); });
    for (const v of CORPUS.raw.filter((x) => !x.skip?.cli)) {
        it(`raw/${v.name}`, () => {
            const tmp = mkdtempSync(path.join(tmpdir(), "w20a-raw-"));
            dirs.push(tmp);
            const map = (s: string) => s.split("/restore").join(tmp);
            v.files.forEach((f, i) => { const p = map(f.path); mkdirSync(path.dirname(p), {recursive: true}); writeFileSync(p, map(rawText(v, i, f.text))); });
            const r = spawnSync("python3", ["-I", KIT, "compose-scan", "--root", map(v.root), "--", ...v.entry.map(map)], {encoding: "utf8"});
            expect(r.status, `kit-tool: ${r.stderr.slice(0, 200)}`).toBe(v.expect.refused ? 1 : 0);
            const got = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as {kind: RawKind; service: string | null; target: string}).map((x) => `${x.kind}|${x.service ?? "-"}|${x.target.split(tmp).join("/restore")}`).sort();
            expect(got).toEqual(v.expect.violations.map((x) => `${x.kind}|${x.service ?? "-"}|${x.target}`).sort());
        });
    }
});

describe("corpus completeness and path-predicate parity", () => {
    it("every rule id, hard id and raw kind appears in at least one expected result", () => {
        const rules = new Set<string>();
        const hard = new Set<string>();
        const kinds = new Set<string>();
        for (const v of CORPUS.rendered) { for (const f of v.expect.findings) rules.add(f[1]); for (const h of v.expect.hard) hard.add(h[1]); }
        for (const v of CORPUS.raw) {
            if (v.expect.reason) hard.add(v.expect.reason);
            for (const x of v.expect.violations) { kinds.add(x.kind); hard.add(x.kind === "missing" ? "raw_incomplete" : "read_outside_root"); }
        }
        expect([...rules].sort()).toEqual([...RULE_IDS].sort());
        expect([...hard].sort()).toEqual([...HARD_IDS].sort());
        expect([...kinds].sort()).toEqual(["config_file", "env_file", "extends", "include", "include_env_file", "include_project_directory", "label_file", "missing", "secret_file"]);
    });
    it("every skip carries a reason", () => {
        for (const v of [...CORPUS.rendered, ...CORPUS.raw]) if (v.skip) for (const [k, why] of Object.entries(v.skip)) expect(why, `${v.name}.${k}`).toMatch(/\S{8}/);
    });
    it("rules_version of the corpus equals the rule file version", () => expect((CORPUS as unknown as {rules_version: number}).rules_version).toBe(RULES.version));
    it("300 generated paths: TS isCanonPath == the jq `canon` predicate inside evaluate_deny (seeded PRNG)", () => {
        let seed = 20260711;
        const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
        const alphabet = ["/", "/", "/", ".", "..", "a", "b", "$", "~", " ", "\n", "\u0000", "\u001f", "\u007f", "é", "😀", "-", "_"];
        const paths = ["/", "", "/restore", "/restore/", "/restore/a/./b", "/restore/a/../b", "/..", "/.", "/a//b", "/a/b/", "a/b", "/a$b", "/a\u0000b", "/é/😀", `/${"a".repeat(1023)}`, `/${"a".repeat(1024)}`, `/${"é".repeat(1023)}`, `/${"é".repeat(1024)}`];
        while (paths.length < 300) paths.push(Array.from({length: 1 + rnd(9)}, () => alphabet[rnd(alphabet.length)]).join(""));
        const services = Object.fromEntries(paths.map((p, i) => [`s${i}`, {image: "x", volumes: [{type: "bind", source: p, target: "/x", bind: {}}]}]));
        const compose = {name: "r", services, networks: {default: {name: "d"}}};
        const r = spawnSync("bash", ["-c", 'source "$1"; DENY="$2"; RESTORE_ROOT="/restore"; evaluate_deny', "_", CLI, RULES_PATH], {input: JSON.stringify(compose), encoding: "utf8"});
        expect(r.status, r.stderr.slice(0, 200)).toBe(0);
        const ambiguous = new Set(r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as {service: string; rule: string}).filter((l) => l.rule === "path_ambiguous").map((l) => l.service));
        const mismatches = paths.map((p, i) => ({p, i})).filter(({p, i}) => isCanonPath(p) === ambiguous.has(`s${i}`));
        expect(mismatches.map((m) => JSON.stringify(m.p))).toEqual([]);
    });
});
