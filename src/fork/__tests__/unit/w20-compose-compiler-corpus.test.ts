import {readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {type CompileOptions, type MirrorSpecV1, compileMirror} from "@/fork/compose-compiler/compile";
import {type ApplyError, applyMirrorSpec, mirrorEnvValue} from "@/fork/compose-compiler/env";
import type {EnvAction} from "@/fork/compose-compiler/compile";
import {ACCESS, CLEAN_RAW, PROJECT, WS, labFull, labView} from "../fixtures/compose-compiler/lab";

type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: loose JSON fixtures
const VECTORS = path.join(process.cwd(), "src/fork/compose-compiler/compose-mirror-vectors.json");
const MALICIOUS = path.join(process.cwd(), "src/fork/__tests__/fixtures/compose-compiler/malicious.json");

// ---- malicious corpus -------------------------------------------------------------------------------------------------------------------------
type Row = {name: string; view?: unknown; gen?: string; raw?: unknown; options?: Partial<CompileOptions>; expect: {ok: boolean; codes: string[]; has: string[]}; note?: string};
const rows = JSON.parse(readFileSync(MALICIOUS, "utf8")) as Row[];
const FORGED = "production-secret-value";

function viewBytes(r: Row): string {
    if (r.gen === "depth_bomb") return JSON.stringify({services: {a: {image: "x", "x-deep": JSON.parse(`${"[".repeat(33)}${"]".repeat(33)}`)}}});
    if (r.gen === "size_bomb") return JSON.stringify({services: {a: {image: "x", "x-pad": "a".repeat(2 * 1024 * 1024 + 1)}}});
    if (r.gen === "many_services") return JSON.stringify({services: Object.fromEntries(Array.from({length: 501}, (_, i) => [`s${i}`, {image: "x"}]))});
    return JSON.stringify(r.view);
}

describe("malicious fixture corpus (W20 Step 8)", () => {
    it("has at least 25 rows", () => expect(rows.length).toBeGreaterThanOrEqual(25));
    it.each(rows)("$name", (r) => {
        const res = compileMirror({view: viewBytes(r), raw: (r.raw ?? CLEAN_RAW) as never, options: {project: "pbm-x", workspace: "/srv/mirrors/pbm-x", access: null, ...r.options}});
        expect(res.ok, res.ok ? "" : JSON.stringify(res.refusals)).toBe(r.expect.ok);
        if (res.ok) return;
        expect([...new Set(res.refusals.map((x) => x.code))].sort()).toEqual(r.expect.codes);
        for (const h of r.expect.has) {
            const [code, detail] = h.split("|");
            expect(res.refusals.some((x) => x.code === code && x.detail.startsWith(detail ?? "")), h).toBe(true);
        }
        expect(JSON.stringify(res)).not.toContain(FORGED);
    });
});

// ---- vectors (the Rust port copies this file verbatim) ---------------------------------------------------------------------------------------
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const seedA = Uint8Array.from({length: 32}, (_, i) => i + 1);
const seedB = Uint8Array.from({length: 32}, (_, i) => 255 - i);
const ENV_INPUTS: (string | null)[] = ["", null, "pw", "p@ss", "postgres://app:pw@db/app", "postgres://app:p@ss@db/app", "postgres://app:p%40ss@db/app", "smtp://u:p@mail.prod.example:587/x?y", "mail.prod.example", "redis://host:6379/0", "https://hooks.example/a#b", "ünï-cödé ✓"];
const ACTIONS: EnvAction[] = ["keep", "keep_exact", "rotate", "disable", "drop"];

function compileLab(options: Partial<CompileOptions> = {}): MirrorSpecV1 {
    const r = compileMirror({view: JSON.stringify(labView()), raw: CLEAN_RAW, options: {project: PROJECT, workspace: WS, access: ACCESS, ...options}});
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    return r.spec;
}

function buildVectors() {
    const env: Doc[] = [];
    for (const action of ACTIONS) for (const v of ENV_INPUTS) {
        const out = mirrorEnvValue(action, v, seedA);
        env.push(out === undefined ? {seed_hex: hex(seedA), action, in: v, drop: true} : {seed_hex: hex(seedA), action, in: v, out});
    }
    for (const v of ENV_INPUTS) env.push({seed_hex: hex(seedB), action: "rotate", in: v, out: mirrorEnvValue("rotate", v, seedB)});
    const apply: Doc[] = [];
    const add = (name: string, full: unknown, spec: MirrorSpecV1, seed: Uint8Array) => {
        const r = applyMirrorSpec(full, spec, seed);
        apply.push(r.ok ? {name, full, spec, seed_hex: hex(seed), out: r.doc} : {name, full, spec, seed_hex: hex(seed), error: r.code});
    };
    const spec = compileLab();
    add("lab full render with private access", labFull(), spec, seedA);
    add("lab full render, same spec, other seed", labFull(), spec, seedB);
    add("lab without access", labFull(), compileLab({access: null}), seedA);
    add("operator overrides: keep_exact and drop", labFull(), compileLab({env: {web: {POSTGRES_PASSWORD: "keep_exact", SMTP_HOST: "drop"}}}), seedA);
    const f1 = labFull() as Doc;
    delete f1.services.web;
    add("error service_missing", f1, spec, seedA);
    const f2 = labFull() as Doc;
    delete f2.services.web.environment.SMTP_HOST;
    add("error env_missing", f2, spec, seedA);
    const f3 = labFull() as Doc;
    delete f3.services.web.labels["forklab.role"];
    add("error label_missing", f3, spec, seedA);
    const f4 = labFull() as Doc;
    f4.services.web.command = ["sh", "-c"];
    add("error structure_mismatch (command length)", f4, spec, seedA);
    const f5 = labFull() as Doc;
    delete f5.services.db.healthcheck;
    add("error structure_mismatch (healthcheck missing)", f5, spec, seedA);
    add("error seed_invalid", labFull(), spec, new Uint8Array(16));
    return {v: 1, generated_by: "w20-compose-compiler-corpus.test.ts", env, apply};
}
const render = () => `${JSON.stringify(buildVectors(), null, 1)}\n`;

describe("compose-mirror-vectors.json (oracle for the runner-side Rust port)", () => {
    if (process.env.W20_VECTORS_OUT) it("regenerates the vectors file", () => writeFileSync(process.env.W20_VECTORS_OUT as string, render()));
    const file = JSON.parse(readFileSync(VECTORS, "utf8")) as {v: number; env: Doc[]; apply: Doc[]};

    it("has at least 25 env vectors and 8 apply vectors, one per error code", () => {
        expect(file.env.length).toBeGreaterThanOrEqual(25);
        expect(file.apply.length).toBeGreaterThanOrEqual(8);
        const errs = file.apply.map((a) => a.error).filter(Boolean).sort();
        expect(errs).toEqual(["env_missing", "label_missing", "seed_invalid", "service_missing", "structure_mismatch", "structure_mismatch"]);
    });
    it("drift guard: the committed file equals a fresh regeneration", () => {
        expect(readFileSync(VECTORS, "utf8")).toBe(render());
    });
    it("every committed env vector reproduces", () => {
        for (const e of file.env) {
            const out = mirrorEnvValue(e.action, e.in, unhex(e.seed_hex));
            if (e.drop) expect(out).toBeUndefined();
            else expect(out).toBe(e.out);
        }
    });
    it("every committed apply vector reproduces", () => {
        for (const a of file.apply) {
            const r = applyMirrorSpec(a.full, a.spec, unhex(a.seed_hex));
            if (a.error) expect(r.ok ? "ok" : (r.code as ApplyError), a.name).toBe(a.error);
            else expect(r.ok ? r.doc : r, a.name).toEqual(a.out);
        }
    });
});
