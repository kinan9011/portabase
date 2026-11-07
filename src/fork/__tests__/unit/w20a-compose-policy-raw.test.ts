import {describe, expect, it} from "vitest";
import {RESTORE_YAML_LIMITS, checkRawCompose} from "@/fork/policy/raw";

const C = "/restore/app/compose.yml";
const run = (text: string, extra: Record<string, string> = {}, entry = [C]) =>
    checkRawCompose({root: "/restore", entry, files: [{path: C, text}, ...Object.entries(extra).map(([p, t]) => ({path: p, text: t}))]});
const SVC = "services:\n  app:\n    image: x\n";

describe("raw (pre-render) compose check: limits (SEC-17)", () => {
    it("W07 limits except the alias count (D-10)", () => {
        expect(RESTORE_YAML_LIMITS).toEqual({maxBytes: 256 * 1024, maxNodes: 20_000, maxDepth: 24, maxAliasCount: 100, maxIndent: 200});
    });
    it("256 KiB is accepted, one byte more is refused as limits", () => {
        const pad = (n: number) => `${SVC}#${"x".repeat(n - SVC.length - 2)}\n`;
        expect(Buffer.byteLength(pad(256 * 1024))).toBe(256 * 1024);
        expect(run(pad(256 * 1024)).refused).toBe(false);
        expect(run(pad(256 * 1024 + 1))).toEqual({refused: true, violations: [], reason: "limits"});
    });
    it("depth 24 is accepted, depth 25 is refused (flow nesting)", () => {
        const nest = (d: number) => `services:\n  app:\n    x-a: ${"[".repeat(d)}${"]".repeat(d)}\n`;
        expect(run(nest(20)).refused).toBe(false);
        expect(run(nest(30)).reason).toBe("limits");
    });
    it("20 001 nodes are refused", () => {
        const many = `services:\n  app:\n    image: x\n    x-list: [${Array.from({length: 20_001}, () => "1").join(",")}]\n`;
        expect(run(many).reason).toBe("limits");
    });
    it("alias bomb is refused: 99 trivial aliases pass, 100 do not (yaml counts alias × anchor size; kit-tool only has a heuristic limit, hence no CLI vector)", () => {
        const withAliases = (n: number) => `x-a: &a [1]\nservices:\n  app:\n    image: x\n    x-b: [${Array.from({length: n}, () => "*a").join(",")}]\n`;
        expect(run(withAliases(99)).refused).toBe(false);
        expect(run(withAliases(100)).reason).toBe("limits");
        const bomb = `a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\nservices: {}\n`;
        expect(run(bomb).reason).toBe("limits");
    });
    it("custom tag, duplicate key, second document, non-mapping are yaml_invalid", () => {
        expect(run("services:\n  app:\n    image: !!python/object/apply:os.system ['id']\n").reason).toBe("yaml_invalid");
        expect(run("services:\n  app:\n    image: a\n    image: b\n").reason).toBe("yaml_invalid");
        expect(run("services: {}\n---\nservices: {}\n").reason).toBe("yaml_invalid");
        expect(run("- a\n- b\n").reason).toBe("yaml_invalid");
        expect(run("services: [unterminated\n").reason).toBe("yaml_invalid");
    });
    it("include chain: depth 8 passes, depth 9 is refused as limits; 65 files are refused", () => {
        const chain = (n: number) => Object.fromEntries(Array.from({length: n}, (_, i) => [`/restore/app/c${i + 1}.yml`, `${i < n - 1 ? `include: [./c${i + 2}.yml]\n` : ""}services: {}\n`]));
        expect(run("include: [./c1.yml]\nservices: {}\n", chain(8)).refused).toBe(false);
        expect(run("include: [./c1.yml]\nservices: {}\n", chain(9)).reason).toBe("limits");
        const wide = {...Object.fromEntries(Array.from({length: 65}, (_, i) => [`/restore/app/w${i}.yml`, "services: {}\n"]))};
        expect(run(`include: [${Object.keys(wide).map((p) => `./${p.split("/").pop()}`).join(", ")}]\nservices: {}\n`, wide).reason).toBe("limits");
    });
});

describe("raw (pre-render) compose check: read scope", () => {
    it("caller bugs throw instead of being silently accepted", () => {
        expect(() => checkRawCompose({root: "relative", entry: [C], files: []})).toThrow(TypeError);
        expect(() => checkRawCompose({root: "/", entry: ["/a"], files: []})).toThrow(TypeError);
        expect(() => checkRawCompose({root: "/restore", entry: ["/other/compose.yml"], files: []})).toThrow(TypeError);
        expect(() => checkRawCompose({root: "/restore", entry: [], files: []})).toThrow(TypeError);
        expect(() => checkRawCompose({root: "/restore", entry: ["/restore/../etc/x.yml"], files: []})).toThrow(TypeError);
    });
    it("an entry file the caller did not supply is a `missing` violation", () => {
        expect(checkRawCompose({root: "/restore", entry: [C], files: []})).toEqual({refused: true, violations: [{kind: "missing", service: null, target: C}], reason: null});
    });
    it("outside targets of every kind are violations; inside ones are not", () => {
        const text = `include:\n  - /etc/i.yml\n${SVC}    env_file: [/etc/e, ./ok.env]\n    label_file: ~/l\n    extends: {file: ../../x.yml, service: s}\nsecrets:\n  s: {file: /etc/s}\nconfigs:\n  c: {file: '$HOME/c'}\n`;
        const r = run(text);
        expect(r.violations.map((v) => `${v.kind}|${v.service ?? "-"}|${v.target}`)).toEqual([
            "config_file|c|$HOME/c", "env_file|app|/etc/e", "extends|app|../../x.yml", "include|-|/etc/i.yml", "label_file|app|~/l", "secret_file|s|/etc/s"]);
    });
    it("recursion: poison two levels down is found, cycles terminate", () => {
        const r = run("include: [./a.yml]\nservices: {}\n", {"/restore/app/a.yml": "include: [./b.yml]\nservices: {}\n", "/restore/app/b.yml": "include: [./a.yml]\nservices:\n  deep:\n    env_file: /etc/shadow\n"});
        expect(r.violations).toEqual([{kind: "env_file", service: "deep", target: "/etc/shadow"}]);
    });
    it("relative targets resolve against the declaring file, not the entry file", () => {
        const r = run("include: [./sub/inc.yml]\nservices: {}\n", {"/restore/app/sub/inc.yml": "services:\n  x:\n    env_file: ../../../etc/x\n"});
        expect(r.violations).toEqual([{kind: "env_file", service: "x", target: "../../../etc/x"}]);
        const ok = run("include: [./sub/inc.yml]\nservices: {}\n", {"/restore/app/sub/inc.yml": "services:\n  x:\n    env_file: ../stack.env\n"});
        expect(ok.refused).toBe(false);
    });
    it("a root-prefix trick (/restore-evil) is outside", () => {
        expect(run(`${SVC}    env_file: /restore-evil/x\n`).violations[0]?.kind).toBe("env_file");
    });
    it("include project_directory is always refused; long-form env_file outside is refused", () => {
        const r = run("include:\n  - path: ./s.yml\n    project_directory: ./p\n    env_file: /etc/e\nservices: {}\n", {"/restore/app/s.yml": "services: {}\n"});
        expect(r.violations.map((v) => v.kind)).toEqual(["include_env_file", "include_project_directory"]);
    });
    it("canary: no value of environment/labels/command appears in a result", () => {
        const CAN = `CANARY-w20a-${Math.random().toString(36).slice(2)}`;
        const text = `services:\n  app:\n    image: x\n    environment: {S: ${CAN}}\n    labels: {l: ${CAN}}\n    command: [${CAN}]\n    env_file: /etc/x\n`;
        expect(JSON.stringify(run(text))).not.toContain(CAN);
        expect(JSON.stringify(run(`services: [${CAN}\n`))).not.toContain(CAN);
    });
});
