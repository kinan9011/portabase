/** Path rules shared by the validator (SEC-15 / SEC-22 / SEC-24). Pure. */

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Absolute POSIX path, no `..` segment, no control characters, ≤ 1024 chars. Everything else is refused (hint data is hostile). */
export function isSafeAbsPath(p: string): boolean {
    if (p.length === 0 || p.length > 1024 || CONTROL.test(p) || !p.startsWith("/")) return false;
    return !p.split("/").includes("..");
}

export const normPath = (p: string): string => {
    const t = p.replace(/\/{2,}/g, "/");
    return t.length > 1 ? t.replace(/\/+$/, "") : t;
};

export const isUnder = (p: string, root: string): boolean => {
    const a = normPath(p), r = normPath(root);
    return r === "/" ? a.startsWith("/") : a === r || a.startsWith(`${r}/`);
};

/** System locations a backup never reads as stack data (05-Security-Model). The Docker socket is reported separately. */
const SYSTEM_ROOTS = ["/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/root"];
export const isDockerSocket = (p: string): boolean => /(^|\/)docker\.sock$/.test(normPath(p));
/** `/` itself, or anything under a system root. */
export const isSystemPath = (p: string): boolean => {
    const n = normPath(p);
    return n === "/" || SYSTEM_ROOTS.some((r) => isUnder(n, r));
};
