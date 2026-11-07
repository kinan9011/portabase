import {describe, expect, it} from "vitest";
import {RAW} from "@/fork/__tests__/discovered-fixtures";
import {COMPOSE_YAML_LIMITS, parseComposeYaml} from "@/fork/inventory/compose-yaml";

const reject = (text: string, reason: string, override?: string) => expect(parseComposeYaml(text, override)).toEqual({ok: false, reason});

describe("compose YAML → names and paths only (SEC-17)", () => {
    it("happy path: the lab compose + override (fixture) yields service names, image, env KEY names, env_file paths — never values", () => {
        const r = parseComposeYaml(RAW.compose.data.composeContent, RAW.compose.data.overrideContent);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.compose.services.map((s) => s.name)).toEqual(expect.arrayContaining(["db", "web"]));
        const db = r.compose.services.find((s) => s.name === "db")!;
        expect(db.envFiles).toEqual(["stack.env"]);
        expect(db.image).toMatch(/^postgres:17-alpine/);
        expect(r.compose.externalNetworks).toContain("lab_proxy");
        expect(r.compose.services.find((s) => s.name === "sqlite-writer")?.profiles).toEqual(["sqlite"]);
        expect(JSON.stringify(r)).not.toMatch(/POSTGRES_PASSWORD=|password":/i);
    });
    it("values are never returned: map form, list form, interpolation, literals that look like secrets", () => {
        const CANARY = "CANARY-yaml-secret-91bc";
        const y = `services:\n  a:\n    image: x:1\n    environment:\n      TOKEN: ${CANARY}\n      OTHER: \${HOST_${CANARY}}\n    command: ["run", "--password=${CANARY}"]\n    labels: {secret: ${CANARY}}\n  b:\n    environment: ["DB_URL=postgres://u:${CANARY}@h/d", "PLAIN"]\n    env_file: [ ./a.env, {path: /abs/b.env, required: false} ]\n`;
        const r = parseComposeYaml(y);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(JSON.stringify(r)).not.toContain(CANARY);
        expect(r.compose.services.find((s) => s.name === "a")!.envNames).toEqual(["OTHER", "TOKEN"]);
        expect(r.compose.services.find((s) => s.name === "b")).toMatchObject({envNames: ["DB_URL", "PLAIN"], envFiles: ["./a.env", "/abs/b.env"]});
    });
    it("invalid names / env keys / escaping env_file paths are dropped, not trusted", () => {
        const r = parseComposeYaml(`services:\n  "../bad":\n    image: x\n  ok:\n    environment: ["1BAD=x", "GOOD=y", "has space=z"]\n    env_file: ["../../etc/passwd", "ok.env", "a\\u0000b"]\n    depends_on: [ok2, "bad name"]\n    profiles: [dev, "no way!"]\n`);
        expect(r.ok && r.compose.services).toEqual([{name: "ok", hasBuild: false, envNames: ["GOOD"], envFiles: ["ok.env"], profiles: ["dev"], dependsOn: ["ok2"]}]);
    });
    it("override file is unioned by service name", () => {
        const r = parseComposeYaml("services:\n  a:\n    image: x:1\n    environment: [A]\n", "services:\n  a:\n    environment: [B]\n  c:\n    build: .\n");
        expect(r.ok && r.compose.services.map((s) => [s.name, s.envNames, s.hasBuild])).toEqual([["a", ["A", "B"], false], ["c", [], true]]);
    });
    it("merge keys / anchors within the limit work (common x-defaults pattern)", () => {
        const r = parseComposeYaml("x-d: &d\n  environment: [SHARED]\nservices:\n  a:\n    <<: *d\n    image: x\n");
        expect(r.ok && r.compose.services[0].envNames).toEqual(["SHARED"]);
    });
});

describe("hostile YAML is rejected before anything is extracted", () => {
    it("oversized", () => reject(`services:\n  a:\n    image: ${"x".repeat(COMPOSE_YAML_LIMITS.maxBytes)}\n`, "too_large"));
    it("oversized override file is rejected too", () => reject("services: {}\n", "too_large", "#".repeat(COMPOSE_YAML_LIMITS.maxBytes + 1)));
    it("deeply nested flow collections", () => reject(`services: ${"[".repeat(200)}${"]".repeat(200)}`, "too_deep"));
    it("deeply indented block nesting", () => reject(`${Array.from({length: 120}, (_, i) => `${" ".repeat(i * 2)}k${i}:`).join("\n")}\n`, "too_deep"));
    it("too many nodes", () => reject(`services:\n  a:\n    environment: [${Array.from({length: COMPOSE_YAML_LIMITS.maxNodes + 10}, (_, i) => `K${i}`).join(", ")}]\n`, "too_many_nodes"));
    it("alias bomb (billion laughs)", () => {
        const lines = ['l0: &l0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
        for (let i = 1; i < 9; i++) lines.push(`l${i}: &l${i} [${Array(9).fill(`*l${i - 1}`).join(",")}]`);
        reject(`${lines.join("\n")}\nservices: {}\n`, "alias_limit");
    });
    it("alias flood", () => reject(`x: &x v\nservices:\n  a:\n    environment: [${Array(50).fill("*x").join(", ")}]\n`, "alias_limit"));
    it("custom / language-specific tags", () => reject("services:\n  a:\n    image: !!python/object/apply:os.system [id]\n", "unsupported"));
    it("duplicate keys", () => reject("services:\n  a:\n    image: x\n  a:\n    image: y\n", "duplicate_key"));
    it("multiple documents / syntax errors / non-mapping root", () => {
        reject("services: {}\n---\nservices: {}\n", "syntax");
        reject("services: [unclosed\n", "syntax");
        reject("- just\n- a list\n", "not_a_mapping");
    });
    it("never throws on garbage", () => {
        for (const g of ["", "\u0000\u0001", "{{{{", "&a *a", "!!binary x", "a: |\n\t\tbad"]) expect(() => parseComposeYaml(g)).not.toThrow();
    });
});
