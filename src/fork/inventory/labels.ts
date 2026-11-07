import path from "node:path";
import type {BACKUP_CONSISTENCY} from "@/fork/inventory/schema";

/**
 * Label + path handling for the normaliser (W07). EVERYTHING here treats its input as attacker-controlled (SEC-22): a
 * container author controls every label. Only the compose keys below and the D18 hint keys are ever read; the grammar of
 * a hint value is a boolean or a three-value enum, so a hint can never carry free text (or a secret) into the inventory.
 */
export const COMPOSE_LABEL = {
    project: "com.docker.compose.project",
    service: "com.docker.compose.service",
    workingDir: "com.docker.compose.project.working_dir",
    configFiles: "com.docker.compose.project.config_files",
    oneoff: "com.docker.compose.oneoff",
    containerNumber: "com.docker.compose.container-number",
    dependsOn: "com.docker.compose.depends_on",
} as const;

/** Same shapes as the inventory schema / `fork_stack` CHECK. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
export const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** true for NUL / C0 control characters / DEL (written as a loop: a control-character regex trips the linter and hides intent). */
export const hasControl = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; }
    return false;
};
export const MAX_PATH = 1024;

/** Absolute POSIX path, normalised; `null` for anything else (relative, NUL/control chars, `..` segment, too long). Never throws. */
export function safeAbsPath(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH || hasControl(raw) || !raw.startsWith("/")) return null;
    if (raw.split("/").includes("..")) return null; // reject, never resolve: an escape attempt is not "fixed"
    const n = path.posix.normalize(raw);
    return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** Relative or absolute path HINT (env_file names): no NUL/control chars, no `..` segment, bounded. Never opened by the fork. */
export function safePathHint(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH || hasControl(raw)) return null;
    if (raw.split(/[\\/]/).includes("..")) return null;
    return raw;
}

export type BackupHints = {stop?: boolean; exclude?: boolean; consistency?: (typeof BACKUP_CONSISTENCY)[number]};

const OFFEN_STOP = "docker-volume-backup.stop-during-backup";
const bool = (v: string): boolean | null => {
    const t = v.trim().toLowerCase();
    return t === "true" ? true : t === "false" ? false : null;
};

/**
 * D18: `portabase.backup.{stop,exclude,consistency}` + the Offen alias. Invalid values are IGNORED (counted, never echoed).
 * The `portabase.*` key wins over the alias. `stop` is recorded, never executed in R1 (D29): nothing in the fork can act on it.
 */
export function parseBackupHints(labels: Record<string, string>): {hints: BackupHints | undefined; ignored: number} {
    const hints: BackupHints = {};
    let ignored = 0;
    const get = (k: string) => (Object.hasOwn(labels, k) && typeof labels[k] === "string" && labels[k].length <= 256 ? labels[k] : undefined);
    const raw = (k: string) => Object.hasOwn(labels, k);
    for (const key of ["stop", "exclude"] as const) {
        const k = `portabase.backup.${key}`;
        if (!raw(k)) continue;
        const v = get(k);
        const b = v === undefined ? null : bool(v);
        if (b === null) ignored++;
        else hints[key] = b;
    }
    if (raw("portabase.backup.consistency")) {
        const v = get("portabase.backup.consistency")?.trim().toLowerCase();
        if (v === "dump" || v === "stop" || v === "crash") hints.consistency = v;
        else ignored++;
    }
    if (hints.stop === undefined && raw(OFFEN_STOP)) {
        // Offen: the value names a stop group; any non-empty value other than "false" means "stop during backup".
        const v = get(OFFEN_STOP)?.trim().toLowerCase();
        if (v === undefined || v === "") ignored++;
        else hints.stop = v !== "false";
    }
    return {hints: Object.keys(hints).length ? hints : undefined, ignored};
}

/** `com.docker.compose.depends_on` = `name:condition:restart,name2:…` — service NAMES only, validated. */
export function parseDependsOnLabel(v: string | undefined): string[] {
    if (!v || v.length > 4096) return [];
    const out = new Set<string>();
    for (const part of v.split(",")) {
        const name = part.split(":")[0]?.trim();
        if (name && SERVICE_NAME.test(name)) out.add(name);
    }
    return [...out].sort();
}

/** `config_files` is a comma separated path list; each entry is validated, rejected entries are counted. */
export function parsePathList(v: string | undefined): {paths: string[]; rejected: number} {
    if (!v) return {paths: [], rejected: 0};
    const paths: string[] = [];
    let rejected = 0;
    for (const part of v.split(",")) {
        const p = part.trim();
        if (!p) continue;
        const ok = safeAbsPath(p);
        if (ok) paths.push(ok);
        else rejected++;
    }
    return {paths: paths.slice(0, 32), rejected: rejected + Math.max(0, paths.length - 32)};
}
