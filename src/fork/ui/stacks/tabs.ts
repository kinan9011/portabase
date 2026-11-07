/** Tab ids of the stack details page. Plain module (NOT "use client"): the server page parses `?tab=` with it. */
export const TABS = ["overview", "resources", "configuration", "backups", "schedule", "activity"] as const;
export type StackTab = (typeof TABS)[number];
export const parseTab = (raw: string | string[] | undefined): StackTab => {
    const v = Array.isArray(raw) ? raw[0] : raw;
    return (TABS as readonly string[]).includes(v ?? "") ? (v as StackTab) : "overview";
};
/** `?rp=<sequence>` selects a recovery point in the Backups tab; anything that is not a positive safe integer is ignored. */
export const parseRp = (raw: string | string[] | undefined): number | null => {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (!v || !/^[0-9]{1,15}$/.test(v)) return null;
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
};
