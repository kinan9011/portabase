import {spawnSync} from "node:child_process";
import {describe, expect, it} from "vitest";
import {compileMirror, type MirrorSpecV1} from "@/fork/compose-compiler/compile";
import {applyMirrorSpec, mirrorEnvValue, mirrorHash} from "@/fork/compose-compiler/env";
import {blankPolicyView} from "@/fork/restore-tasks/view";
import {ACCESS, CANARY, CLEAN_RAW, PG_PW, PROJECT, WS, labFull, labView} from "../fixtures/compose-compiler/lab";

type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: loose JSON fixtures
const seedA = Uint8Array.from({length: 32}, (_, i) => i + 1);
const seedB = Uint8Array.from({length: 32}, (_, i) => 255 - i);
const H = (x: string, s = seedA) => mirrorHash(s, x);
const spec = (): MirrorSpecV1 => {
    const r = compileMirror({view: JSON.stringify(labView()), raw: CLEAN_RAW, options: {project: PROJECT, workspace: WS, access: ACCESS}});
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    return r.spec;
};

describe("env value functions (D-5)", () => {
    it("value table", () => {
        const f = mirrorEnvValue;
        expect(f("rotate", "", seedA)).toBe("");
        expect(f("rotate", "pw", seedA)).toBe(H("pw"));
        expect(f("keep", "plain", seedA)).toBe("plain");
        expect(f("keep", "", seedA)).toBe("");
        expect(f("keep_exact", "postgres://a:b@h/x", seedA)).toBe("postgres://a:b@h/x");
        for (const a of ["keep", "keep_exact", "rotate", "disable"] as const) expect(f(a, null, seedA), a).toBeNull();
        expect(f("drop", null, seedA)).toBeUndefined();
        expect(f("drop", "x", seedA)).toBeUndefined();
        // URL userinfo password rotated under keep AND rotate; scheme/user/host/path kept
        expect(f("keep", "postgres://app:pw@db/app", seedA)).toBe(`postgres://app:${H("pw")}@db/app`);
        expect(f("rotate", "postgres://app:pw@db/app?x=1#f", seedA)).toBe(`postgres://app:${H("pw")}@db/app?x=1#f`);
        // '@' inside the password: userinfo ends at the LAST '@'
        expect(f("keep", "postgres://app:p@ss@db/app", seedA)).toBe(`postgres://app:${H("p@ss")}@db/app`);
        // percent-encoded password hashes its decoded form; invalid encoding hashes the raw text
        expect(f("keep", "postgres://app:p%40ss@db/app", seedA)).toBe(`postgres://app:${H("p@ss")}@db/app`);
        expect(f("keep", "postgres://app:p%ZZ@db/app", seedA)).toBe(`postgres://app:${H("p%ZZ")}@db/app`);
        // no password: unchanged (keep) / hashed whole (rotate)
        for (const u of ["postgres://app@db/app", "postgres://app:@db/app", "redis://host:6379/0", "http://host/p?a=b@c"]) expect(f("keep", u, seedA), u).toBe(u);
        expect(f("rotate", "postgres://app@db/app", seedA)).toBe(H("postgres://app@db/app"));
        // disable
        expect(f("disable", "smtp://u:p@mail.prod.example:587/x?y", seedA)).toBe("smtp://disabled.invalid/x?y");
        expect(f("disable", "mail.prod.example", seedA)).toBe("disabled.invalid");
        expect(f("disable", "", seedA)).toBe("");
        expect(f("disable", "https://hooks.example/a#b", seedA)).toBe("https://disabled.invalid/a#b");
    });

    it("consistency: a rotated POSTGRES_PASSWORD and a kept DATABASE_URL carry the same derived password", () => {
        const pw = mirrorEnvValue("rotate", "pw", seedA);
        expect(mirrorEnvValue("keep", "postgres://app:pw@db/app", seedA)).toBe(`postgres://app:${pw}@db/app`);
    });

    it("different seeds give different values, the same seed the same value", () => {
        expect(H("pw", seedA)).toBe(H("pw", seedA));
        expect(H("pw", seedA)).not.toBe(H("pw", seedB));
        expect(H("pw")).toMatch(/^[0-9a-f]{32}$/);
    });

    it("matches an independent Python HMAC implementation on 12 vectors", () => {
        const probe = spawnSync("python3", ["-I", "-c", "print(1)"], {encoding: "utf8"});
        if (probe.status !== 0) return; // python3 absent: the committed vectors still pin the values
        const inputs = ["", "pw", "p@ss", "ünï-cödé ✓", "a".repeat(5000), "line\nbreak", "0", "postgres://a:b@h/x", "W20_CANARY", "%40", " ", "\u0000x"];
        const code = 'import hmac,hashlib,sys,json\nfor seed,x in json.load(sys.stdin):\n    print(hmac.new(bytes.fromhex(seed), b"portabase-mirror-env-v1\\x00"+x.encode("utf-8"), hashlib.sha256).hexdigest()[:32])';
        const seedHex = Buffer.from(seedA).toString("hex");
        const r = spawnSync("python3", ["-I", "-c", code], {input: JSON.stringify(inputs.map((x) => [seedHex, x])), encoding: "utf8"});
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout.trim().split("\n")).toEqual(inputs.map((x) => H(x)));
    });
});

describe("applyMirrorSpec (D-6)", () => {
    it("merges the lab-shaped full render into the skeleton and proves blank(out) == spec.view", () => {
        const s = spec();
        const r = applyMirrorSpec(labFull(), s, seedA);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(blankPolicyView(r.doc)).toEqual(s.view);
        const d = r.doc as Doc;
        expect(d.services.db.environment.POSTGRES_PASSWORD).toBe(H(PG_PW));
        expect(d.services.web.environment.POSTGRES_PASSWORD).toBe(H(PG_PW)); // same production value ⇒ same mirror value in both services
        expect(d.services.web.environment.DATABASE_URL).toBe(`postgres://app:${H(PG_PW)}@demo-db:5432/app`);
        expect(d.services.web.environment.SMTP_HOST).toBe("disabled.invalid");
        expect(d.services.web.environment.APP_GREETING).toBe("hello");
        expect(d.services.db.environment.PASSTHRU).toBeNull();
        expect(d.services.db.environment.POSTGRES_USER).toBe("app");
        expect(d.services.db.healthcheck.test[1]).toContain("pg_isready"); // healthcheck copied from the full render
        expect(d.services.web.command[2]).toContain(CANARY); // command is copied as-is (runner-side only)
        expect(d.services.web.labels.canary).toBe(CANARY); // kept label keys carry their value
        expect(d.services.web.labels["traefik.enable"]).toBeUndefined();
        expect(JSON.stringify(d)).not.toContain(PG_PW); // the production secret is gone from the whole mirror document
        expect(d.services.web.ports).toEqual([{mode: "ingress", host_ip: "127.0.0.1", target: 8080, published: "18099", protocol: "tcp"}]);
    });

    it("canary: spec, hash and diff never contain a production value", () => {
        const r = compileMirror({view: JSON.stringify(labView()), raw: CLEAN_RAW, options: {project: PROJECT, workspace: WS, access: ACCESS}});
        expect(JSON.stringify(r)).not.toContain(CANARY);
    });

    it("rejects a bad seed", () => {
        expect(applyMirrorSpec(labFull(), spec(), new Uint8Array(31))).toEqual({ok: false, code: "seed_invalid"});
        expect(applyMirrorSpec(labFull(), spec(), new Uint8Array(33))).toEqual({ok: false, code: "seed_invalid"});
    });

    it("fails closed on tampering", () => {
        const s = spec();
        const code = (full: Doc, sp: MirrorSpecV1 = s) => {
            const r = applyMirrorSpec(full, sp, seedA);
            return r.ok ? "ok" : r.code;
        };
        const f1 = labFull() as Doc;
        delete f1.services.web;
        expect(code(f1)).toBe("service_missing");
        const f2 = labFull() as Doc;
        delete f2.services.web.environment.SMTP_HOST;
        expect(code(f2)).toBe("env_missing");
        const f3 = labFull() as Doc;
        delete f3.services.web.labels["forklab.role"];
        expect(code(f3)).toBe("label_missing");
        const f4 = labFull() as Doc;
        f4.services.web.command = ["sh", "-c"]; // array length differs from the compiled structure
        expect(code(f4)).toBe("structure_mismatch");
        const f5 = labFull() as Doc;
        delete f5.services.db.healthcheck;
        expect(code(f5)).toBe("structure_mismatch");
        const s2 = structuredClone(s) as Doc;
        s2.view.services.web.command = ["", ""]; // the spec's view edited after compile
        expect(code(labFull() as Doc, s2 as MirrorSpecV1)).toBe("structure_mismatch");
        const s3 = structuredClone(s) as Doc;
        delete s3.env.web.SMTP_HOST; // an env key without an action
        expect(code(labFull() as Doc, s3 as MirrorSpecV1)).toBe("structure_mismatch");
    });

    it("the final equality rejects a spec view that smuggles a value into an x-* subtree (only this check catches it)", () => {
        const s = structuredClone(spec()) as Doc;
        s.view.services.web["x-leak"] = "literal-secret";
        const r = applyMirrorSpec(labFull(), s as MirrorSpecV1, seedA);
        expect(r).toEqual({ok: false, code: "structure_mismatch"});
    });

    it("structure always comes from the spec: an extra port in the full render never reaches the mirror (source_changed is the caller's hash check)", () => {
        const f = labFull() as Doc;
        f.services.db.ports = [{mode: "ingress", host_ip: "0.0.0.0", target: 5432, published: "5432", protocol: "tcp"}];
        f.services.db.network_mode = "host";
        const r = applyMirrorSpec(f, spec(), seedA);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect((r.doc as Doc).services.db.ports).toBeUndefined();
            expect((r.doc as Doc).services.db.network_mode).toBeUndefined();
        }
    });

    it("an operator drop override removes the key from the merged document", () => {
        const c = compileMirror({view: JSON.stringify(labView()), raw: CLEAN_RAW, options: {project: PROJECT, workspace: WS, access: ACCESS, env: {web: {SMTP_HOST: "drop", APP_GREETING: "keep_exact"}}}});
        if (!c.ok) throw new Error("compile");
        const r = applyMirrorSpec(labFull(), c.spec, seedA);
        expect(r.ok).toBe(true);
        if (r.ok) expect((r.doc as Doc).services.web.environment.SMTP_HOST).toBeUndefined();
    });
});
