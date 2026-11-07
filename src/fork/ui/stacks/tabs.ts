/** Tab ids of the stack details page. Plain module (NOT "use client"): the server page parses `?tab=` with it. */
export const TABS = ["overview", "resources", "configuration", "schedule"] as const;
export type StackTab = (typeof TABS)[number];
export const parseTab = (raw: string | string[] | undefined): StackTab => {
    const v = Array.isArray(raw) ? raw[0] : raw;
    return (TABS as readonly string[]).includes(v ?? "") ? (v as StackTab) : "overview";
};
