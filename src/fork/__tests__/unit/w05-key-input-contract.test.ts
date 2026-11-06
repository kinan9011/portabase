import {describe, expect, it} from "vitest";
import {ARCANE_KEY_FIELD_COPY, ARCANE_KEY_FIELD_RULES, ARCANE_KEY_INPUT_PROPS} from "@/fork/arcane/key-input-contract";
import {ENV_MINIMUM, GLOBAL_MINIMUM} from "@/fork/arcane/endpoints";
import {ApiKeyInput} from "@/fork/arcane/connection-service";

describe("E5 UX-07 Arcane key field contract (for W06)", () => {
    it("input controls match REVISED-PLAN §8.2 exactly", () => {
        expect(ARCANE_KEY_INPUT_PROPS).toMatchObject({type: "password", spellCheck: false, autoComplete: "off", "data-gramm": "false", "data-1p-ignore": true});
        expect(ARCANE_KEY_INPUT_PROPS.maxLength).toBe(512);
    });
    it("storage rules: never in URL / React Query / RSC payload / browser storage; cleared after submit; never prefilled", () => {
        expect(ARCANE_KEY_FIELD_RULES).toEqual({clearAfterSubmit: true, clearOnClose: true, prefillStoredValue: false, revealable: false, inUrl: false, inReactQuery: false, inRscPayload: false, inBrowserStorage: false, requiredOnEndpointChange: true});
    });
    it("copy lists the exact minimum permissions and never says read-only", () => {
        const all = JSON.stringify(ARCANE_KEY_FIELD_COPY).toLowerCase();
        const {forbiddenWords, ...rest} = ARCANE_KEY_FIELD_COPY;
        for (const w of forbiddenWords) expect(JSON.stringify(rest).toLowerCase()).not.toContain(w);
        for (const p of [...GLOBAL_MINIMUM, ...ENV_MINIMUM]) expect(all).toContain(p);
        expect(ARCANE_KEY_FIELD_COPY.requiredPermissions.perEnvironment).toEqual([...ENV_MINIMUM]);
    });
    it("server input rule agrees with the input's min/max length and rejects whitespace/control characters", () => {
        expect(ApiKeyInput.safeParse("a".repeat(ARCANE_KEY_INPUT_PROPS.minLength)).success).toBe(true);
        expect(ApiKeyInput.safeParse("a".repeat(ARCANE_KEY_INPUT_PROPS.minLength - 1)).success).toBe(false);
        expect(ApiKeyInput.safeParse("a".repeat(ARCANE_KEY_INPUT_PROPS.maxLength + 1)).success).toBe(false);
        for (const bad of ["arc key 12345", "arc_key\n12345", "arc_key\t12345", "arc_kéy_12345"]) expect(ApiKeyInput.safeParse(bad).success, bad).toBe(false);
    });
});
