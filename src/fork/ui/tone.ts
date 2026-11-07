/**
 * The ONE fork tone map (REVISED-PLAN §8.2 rule 11, CH-28): status colours that pass WCAG AA (≥ 4.5:1 text on its own
 * background) in BOTH themes. Colours are never the only signal: every consumer renders an icon + text next to it
 * (`iconKey` is resolved to a lucide icon by the component; this module stays free of React so labels/tests can import it).
 *
 * Tailwind needs the class strings spelled out in full, so each tone carries its classes AND the hex pairs they encode;
 * `fork-tone.test.ts` computes the contrast of the pairs and checks the classes contain exactly those hexes.
 */
export const TONES = ["neutral", "success", "warning", "danger", "active"] as const;
export type Tone = (typeof TONES)[number];
export type ToneIconKey = "circle-dashed" | "circle-check" | "triangle-alert" | "circle-x" | "loader-circle" | "info";

type Pair = {fg: string; bg: string; border: string; body: string};
export type ToneDef = {iconKey: ToneIconKey; badge: string; panel: string; title: string; body: string; light: Pair; dark: Pair};

export const TONE_MAP: Record<Tone, ToneDef> = {
    neutral: {
        iconKey: "circle-dashed",
        badge: "text-[#525252] bg-[#f5f5f5] border-[#d4d4d4] dark:text-[#d4d4d4] dark:bg-[#262626] dark:border-[#525252]",
        panel: "bg-[#f5f5f5] border-[#d4d4d4] dark:bg-[#262626] dark:border-[#525252]",
        title: "text-[#525252] dark:text-[#d4d4d4]",
        body: "text-[#404040] dark:text-[#e5e5e5]",
        light: {fg: "#525252", bg: "#f5f5f5", border: "#d4d4d4", body: "#404040"},
        dark: {fg: "#d4d4d4", bg: "#262626", border: "#525252", body: "#e5e5e5"},
    },
    success: {
        iconKey: "circle-check",
        badge: "text-[#15803d] bg-[#f0fdf4] border-[#86efac] dark:text-[#86efac] dark:bg-[#052e16] dark:border-[#166534]",
        panel: "bg-[#f0fdf4] border-[#86efac] dark:bg-[#052e16] dark:border-[#166534]",
        title: "text-[#15803d] dark:text-[#86efac]",
        body: "text-[#14532d] dark:text-[#dcfce7]",
        light: {fg: "#15803d", bg: "#f0fdf4", border: "#86efac", body: "#14532d"},
        dark: {fg: "#86efac", bg: "#052e16", border: "#166534", body: "#dcfce7"},
    },
    warning: {
        iconKey: "triangle-alert",
        badge: "text-[#b45309] bg-[#fffbeb] border-[#fcd34d] dark:text-[#fcd34d] dark:bg-[#451a03] dark:border-[#92400e]",
        panel: "bg-[#fffbeb] border-[#fcd34d] dark:bg-[#451a03] dark:border-[#92400e]",
        title: "text-[#b45309] dark:text-[#fcd34d]",
        body: "text-[#451a03] dark:text-[#fef3c7]",
        light: {fg: "#b45309", bg: "#fffbeb", border: "#fcd34d", body: "#451a03"},
        dark: {fg: "#fcd34d", bg: "#451a03", border: "#92400e", body: "#fef3c7"},
    },
    danger: {
        iconKey: "circle-x",
        badge: "text-[#b91c1c] bg-[#fef2f2] border-[#fca5a5] dark:text-[#fca5a5] dark:bg-[#450a0a] dark:border-[#991b1b]",
        panel: "bg-[#fef2f2] border-[#fca5a5] dark:bg-[#450a0a] dark:border-[#991b1b]",
        title: "text-[#b91c1c] dark:text-[#fca5a5]",
        body: "text-[#450a0a] dark:text-[#fee2e2]",
        light: {fg: "#b91c1c", bg: "#fef2f2", border: "#fca5a5", body: "#450a0a"},
        dark: {fg: "#fca5a5", bg: "#450a0a", border: "#991b1b", body: "#fee2e2"},
    },
    active: {
        iconKey: "loader-circle",
        badge: "text-[#9a3412] bg-[#fff7ed] border-[#fdba74] dark:text-[#fdba74] dark:bg-[#431407] dark:border-[#9a3412]",
        panel: "bg-[#fff7ed] border-[#fdba74] dark:bg-[#431407] dark:border-[#9a3412]",
        title: "text-[#9a3412] dark:text-[#fdba74]",
        body: "text-[#431407] dark:text-[#ffedd5]",
        light: {fg: "#9a3412", bg: "#fff7ed", border: "#fdba74", body: "#431407"},
        dark: {fg: "#fdba74", bg: "#431407", border: "#9a3412", body: "#ffedd5"},
    },
};
