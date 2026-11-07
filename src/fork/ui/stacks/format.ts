/** Timestamps are shown in UTC with the zone spelled out (server and browser render the same text: no hydration drift, no guessing). */
export const fmtUtc = (iso: string | null | undefined, fallback: string): string =>
    iso ? `${new Date(iso).toLocaleString("en-US", {dateStyle: "medium", timeStyle: "short", timeZone: "UTC"})} UTC` : fallback;

/** `host→container/proto` when published, `container/proto (container only)` when the port is not published on the host. */
export const fmtPort = (p: {published?: number; target: number; protocol: string}): string => (p.published !== undefined ? `${p.published}→${p.target}/${p.protocol}` : `${p.target}/${p.protocol} (container only)`);

export const fmtBytes = (n: number | null): string | null => {
    if (n === null) return null;
    if (n < 1024) return `${n} B`;
    const u = ["KiB", "MiB", "GiB", "TiB"];
    let v = n / 1024; let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
};

export const STACKS_HREF = "/dashboard/stacks";
export const stackHref = (id: string, tab?: string) => `${STACKS_HREF}/${id}${tab && tab !== "overview" ? `?tab=${tab}` : ""}`;

/** A moment in the given IANA zone with the zone spelled out; falls back to UTC for an unknown zone (never throws). */
export const fmtZoned = (iso: string | null | undefined, tz: string, fallback = "—"): string => {
    if (!iso) return fallback;
    try { return `${new Intl.DateTimeFormat("en-GB", {timeZone: tz, dateStyle: "medium", timeStyle: "short"}).format(new Date(iso))} (${tz})`; } catch { return fmtUtc(iso, fallback); }
};

export const fmtDuration = (seconds: number | null | undefined): string | null => {
    if (seconds === null || seconds === undefined) return null;
    if (seconds < 60) return `${seconds} s`;
    const m = Math.floor(seconds / 60); const s = seconds % 60;
    if (m < 60) return s === 0 ? `${m} min` : `${m} min ${s} s`;
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
};
