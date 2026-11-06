import {ENV_MINIMUM, GLOBAL_MINIMUM, TIER2_PERMISSION} from "@/fork/arcane/endpoints";

/**
 * UX-07 / REVISED-PLAN §8.2 — the Arcane API-key field contract that W06 (Integrations UI) must render. Specified here, in
 * code, so the UI cannot drift from the server rules (a unit test pins every value).
 *
 *  - spread `ARCANE_KEY_INPUT_PROPS` on the `<input>` (Radix/shadcn `Input`): it is write-only, never prefilled, never revealed;
 *  - the value lives in uncontrolled/local form state ONLY: not in a URL/search param, not in a React Query key or cache, not in
 *    a server-component prop / RSC payload, not in `localStorage`, not in analytics. It is sent once, as the `apiKey` field of
 *    `saveArcaneConnectionAction` / `rotateArcaneKeyAction`, and the action result never contains it;
 *  - the form clears the field after EVERY submit (success or failure) and when the dialog closes (`ARCANE_KEY_FIELD_RULES`);
 *  - when a key is stored the field shows an empty input with the placeholder below; "key stored" is state, not a value;
 *  - copy never calls the key "read-only" (ADR-002 §6): use `ARCANE_KEY_FIELD_COPY`.
 */
export const ARCANE_KEY_INPUT_PROPS = {
    type: "password",
    name: "arcane-discovery-key",
    autoComplete: "off",
    spellCheck: false,
    autoCapitalize: "off",
    autoCorrect: "off",
    "data-gramm": "false",
    "data-1p-ignore": true,
    "data-lpignore": "true",
    "data-form-type": "other",
    minLength: 8,
    maxLength: 512,
} as const;

export const ARCANE_KEY_FIELD_RULES = {
    clearAfterSubmit: true,
    clearOnClose: true,
    prefillStoredValue: false,
    revealable: false,
    inUrl: false,
    inReactQuery: false,
    inRscPayload: false,
    inBrowserStorage: false,
    requiredOnEndpointChange: true, // SEC-10: host/port/scheme change ⇒ key must be typed again
} as const;

export const ARCANE_KEY_FIELD_COPY = {
    label: "Discovery key (list permissions only)",
    storedPlaceholder: "A key is stored — type a new key to replace it",
    help: `Create the key in Arcane with only these permissions: ${GLOBAL_MINIMUM.join(", ")} (global) and, for each environment to protect, ${ENV_MINIMUM.join(", ")}. Do not grant container, volume or project read access: those permissions return secrets.`,
    requiredPermissions: {global: [...GLOBAL_MINIMUM], perEnvironment: [...ENV_MINIMUM]},
    tier2: {permission: TIER2_PERMISSION, warning: "projects:read lets this key read raw Compose files and the resolved environment values of every project in the allowed environments."},
    tlsWarning: "TLS certificate verification is OFF for this connection. Anyone on the network path can read the Arcane key.",
    endpointChange: "The host, port or scheme changed: enter the API key again. A stored key is never sent to a different endpoint.",
    forbiddenWords: ["read-only", "readonly", "read only"],
} as const;
