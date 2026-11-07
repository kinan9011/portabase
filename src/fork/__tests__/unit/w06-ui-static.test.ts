import {readFileSync, readdirSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** Structural guards for the W06 UI (the key can only live in the uncontrolled input; no storage, no raw HTML). */
const ROOT = path.resolve(__dirname, "../../..");
const dirs = ["fork/ui"].map((d) => path.join(ROOT, d));
const files = (d: string): string[] => readdirSync(d, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => /\.tsx?$/.test(f));
const ui = dirs.flatMap(files);
const page = path.join(ROOT, "../app/(customer)/dashboard/(admin)/integrations/page.tsx");
const read = (f: string) => readFileSync(f, "utf8");

describe("W06 UI static guards", () => {
    it("finds the UI files", () => expect(ui.length).toBeGreaterThanOrEqual(10));
    it("no raw HTML injection, no browser storage, no URL/search-param state, no console output", () => {
        for (const f of [...ui, page]) {
            const s = read(f);
            expect(s, f).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|indexedDB|document\.cookie|useSearchParams|console\./);
        }
    });
    it("UI never imports the key reader, the encrypted-key column or the DB DTO module", () => {
        for (const f of ui) expect(read(f), f).not.toMatch(/readConnectionApiKey|apiKeyEnc|api_key_enc|@\/fork\/db\/dto/);
    });
    it("`apiKey` appears only where the contract allows: the mutation hook (read from the input at call time) and the secret input", () => {
        const withKey = ui.filter((f) => /apiKey/.test(read(f))).map((f) => path.basename(f)).sort();
        expect(withKey).toEqual(["use-integrations-actions.ts"]);
    });
    it("the key is never a mutation variable: save/rotate variable types have no key field", () => {
        const s = read(path.join(ROOT, "fork/ui/integrations/use-integrations-actions.ts"));
        expect(s).toMatch(/type SaveVars = \{connectionId\?: string; name: string; baseUrl: string; tlsInsecure: boolean; allowProjectsRead: boolean\}/);
        expect(s).toContain("const key = () => keyField.current?.take()");
    });
    it("the secret input spreads the W05 contract (not a copy) and is uncontrolled", () => {
        const s = read(path.join(ROOT, "fork/ui/integrations/secret-key-input.tsx"));
        expect(s).toContain("{...ARCANE_KEY_INPUT_PROPS}");
        expect(s).toContain('defaultValue=""');
        expect(s).not.toMatch(/useState|onChange|value=\{/);
    });
    it("every form posts (never GET) so a key can not reach a URL before hydration", () => {
        for (const f of ui) for (const m of read(f).matchAll(/<form\b[^>]*>/g)) expect(m[0], f).toContain('method="post"');
    });
    it("hard-coded colours only in the one tone map", () => {
        for (const f of ui.filter((x) => !x.endsWith("tone.ts"))) expect(read(f), f).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    });
});
