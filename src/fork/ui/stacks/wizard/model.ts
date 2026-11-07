import type {ActivateInput} from "@/fork/stack-policy/input";
import {checkChannelRule} from "@/fork/stack-policy/channels";
import type {ConfigureView} from "@/fork/stack-policy/configure-view";
import type {PreviewView} from "@/fork/stack-policy/preview";
import {isAcceptableDbHost, isAdoptableVolumeName, VOLUME_NAME_RE, type Selection} from "@/fork/materialize/types";
import {RetentionPolicySchema, type RetentionPolicy} from "@/fork/recovery/retention-policy";
import {ScheduleSchema, type Schedule} from "@/fork/schedule/schedule";

/**
 * Client-side model of the Configure Backup form (W11): plain data + pure functions (NOT a "use client" module, so the server page and the
 * tests can use it). UX-04: this state is the ONLY copy of the operator's choices until Activate; no password is part of it (passwords live
 * in uncontrolled inputs and are read once at submit).
 */
export type DbForm = {mode: "dump" | "sqlite" | "files"; host: string; port: string; username: string; database: string; path: string};
export type ManualForm = {path: string; covers: string[]};
export type WizardState = {
    excluded: string[]; includedVolumes: string[]; databases: Record<string, DbForm>; manual: ManualForm[]; accepted: string[];
    channelIds: string[]; schedule: Schedule; retention: RetentionPolicy; confirmDocker: boolean;
};

export const composeKey = (view: Pick<ConfigureView, "composeDir">) => (view.composeDir ? `dir:${view.composeDir}` : null);

export function initialState(view: ConfigureView): WizardState {
    const s = view.existing.selection;
    const databases: Record<string, DbForm> = {};
    for (const d of view.databases) {
        const cur = s.databases[d.service];
        databases[d.service] = {
            mode: cur?.kind === "dump" ? "dump" : cur?.kind === "sqlite" ? "sqlite" : view.existing.active || d.mode === "unsupported" ? "files" : d.mode === "dump" ? "dump" : "files",
            host: cur?.kind === "dump" ? cur.host : "", port: cur?.kind === "dump" && cur.port ? String(cur.port) : "", username: cur?.kind === "dump" ? cur.username ?? "" : "",
            database: cur?.kind === "dump" ? cur.database ?? "" : "", path: cur?.kind === "sqlite" ? cur.path : "",
        };
    }
    return {
        excluded: [...s.excludeKeys], includedVolumes: s.includeKeys.filter((k) => k.startsWith("volume:")), databases, manual: s.manual.map((m) => ({path: m.path, covers: [...m.covers]})),
        accepted: [...view.existing.accepted], channelIds: [...view.existing.channelIds], schedule: view.existing.schedule, retention: view.existing.retention, confirmDocker: false,
    };
}

const optional = (v: string) => (v.trim() === "" ? undefined : v.trim());
/** The strict `Selection` the server validates again; DB inputs only for services set to dump/sqlite. */
export function toSelection(st: WizardState, view: ConfigureView): Selection {
    const databases: Selection["databases"] = {};
    for (const d of view.databases) {
        const f = st.databases[d.service];
        if (!f) continue;
        if (f.mode === "dump" && d.mode === "dump") {
            const port = optional(f.port);
            databases[d.service] = {kind: "dump", host: f.host.trim(), ...(port ? {port: Number(port)} : {}), ...(optional(f.username) ? {username: f.username.trim()} : {}), ...(optional(f.database) ? {database: f.database.trim()} : {})};
        } else if (f.mode === "sqlite" && d.mode === "sqlite") databases[d.service] = {kind: "sqlite", path: f.path.trim()};
    }
    return {
        includeKeys: [...st.includedVolumes], excludeKeys: [...st.excluded], composeMethod: "snapshot", bindMethod: "archive", databases,
        manual: st.manual.map((m) => ({path: m.path.trim(), covers: m.covers})), stop: [],
    };
}

export function toActivateInput(st: WizardState, view: ConfigureView, secrets: Record<string, string>): ActivateInput {
    return {
        stackId: view.stack.id, selection: toSelection(st, view), storageChannelIds: st.channelIds, secrets, confirmDockerAccess: st.confirmDocker,
        schedule: st.schedule, retention: st.retention, acceptedExclusions: st.accepted,
    };
}

/** SEC-24 at the field, before the server is asked (the server re-checks). */
export function volumeNameError(name: string, view: Pick<ConfigureView, "volumes">, included: readonly string[], excluded: readonly string[] = []): "volume_name_path_like" | "volume_name_anonymous" | "volume_not_in_inventory" | "already" | null {
    const n = name.trim();
    if (!VOLUME_NAME_RE.test(n) || n.length > 255) return "volume_name_path_like";
    if (!isAdoptableVolumeName(n)) return "volume_name_anonymous";
    if (!view.volumes.some((v) => v.name === n)) return "volume_not_in_inventory";
    // every discovered volume is part of the backup unless it was left out: adding one that is already in is a no-op, adding a left-out one puts it back
    return included.includes(`volume:${n}`) || !excluded.includes(`volume:${n}`) ? "already" : null;
}

export type DbFieldError = {service: string; field: "host" | "port" | "username" | "database" | "path"};
/** Missing/unacceptable connection fields of the databases set to dump/sqlite (names only). */
export function dbFieldErrors(st: WizardState, view: ConfigureView): DbFieldError[] {
    const out: DbFieldError[] = [];
    for (const d of view.databases) {
        const f = st.databases[d.service];
        if (!f) continue;
        if (f.mode === "dump" && d.mode === "dump") {
            for (const field of d.fields) {
                const v = (field === "port" ? f.port : f[field]).trim();
                if (v === "") out.push({service: d.service, field});
            }
            if (f.host.trim() !== "" && !isAcceptableDbHost(f.host.trim())) out.push({service: d.service, field: "host"});
            if (f.port.trim() !== "" && !(Number.isInteger(Number(f.port)) && Number(f.port) >= 1 && Number(f.port) <= 65535)) out.push({service: d.service, field: "port"});
        } else if (f.mode === "sqlite" && d.mode === "sqlite" && !f.path.trim().startsWith("/")) out.push({service: d.service, field: "path"});
    }
    return out.filter((e, i, a) => a.findIndex((x) => x.service === e.service && x.field === e.field) === i);
}

export type BlockerCode = "locked" | "encryption_off" | "no_channel_selected" | "local_only_channels" | "invalid_schedule" | "invalid_retention" | "selection_issues";
/** Everything that stops Activate, in the order shown. The SERVER is the authority; these only explain before a round trip. */
export function blockers(o: {view: ConfigureView; state: WizardState; preview: PreviewView; locked: boolean; dbErrors: readonly DbFieldError[]; cronInvalid: boolean}): BlockerCode[] {
    const out: BlockerCode[] = [];
    if (o.locked) out.push("locked");
    if (!o.view.encryptionOn) out.push("encryption_off");
    const chosen = o.view.channels.filter((c) => o.state.channelIds.includes(c.id));
    const rule = checkChannelRule(chosen);
    if (!rule.ok) out.push(rule.reason);
    if (o.cronInvalid || !ScheduleSchema.safeParse(o.state.schedule).success) out.push("invalid_schedule");
    if (!RetentionPolicySchema.safeParse(o.state.retention).success) out.push("invalid_retention");
    if (o.preview.issues.length > 0) out.push("selection_issues");
    return out;
}

/** Group items for display (stable order). */
export const KIND_ORDER = ["compose_file", "env_file", "bind", "volume", "database", "anonymous_volume", "image", "network", "dependency"] as const;
export const REQUIRED_KINDS: ReadonlySet<string> = new Set(["compose_file", "env_file", "bind", "volume", "database"]);
export const itemToggleKey = (item: {key: string; kind: string}, view: Pick<ConfigureView, "composeDir">): string | null => {
    if (item.kind === "bind" || item.kind === "volume" || item.kind === "database") return item.key;
    if (item.kind === "compose_file" || item.kind === "env_file") return composeKey(view);
    return null;
};
