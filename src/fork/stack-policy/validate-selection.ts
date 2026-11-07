import {validateCompleteness} from "@/fork/completeness";
import {EMPTY_CONTEXT} from "@/fork/completeness/types";
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {safeAbsPath} from "@/fork/inventory/labels";
import {planStack} from "@/fork/materialize/plan";
import {isAdoptableVolumeName, VOLUME_NAME_RE, type Plan, type Selection} from "@/fork/materialize/types";

/**
 * Operator-facing validation of a selection against the stored inventory (W11). Pure: the browser runs it for field-level errors,
 * the server runs it again before anything is written (never trust the client). The planner silently skips what it cannot back up
 * (W10); here every key/value the OPERATOR typed or picked that cannot be honoured is reported with a stable code, so the form can
 * say it in plain words at the field (SEC-24, confirm2-uiux item 3) and activation refuses instead of pretending.
 */
export const SELECTION_ISSUE_CODES = [
    "volume_name_path_like", "volume_name_anonymous", "volume_not_in_inventory", "key_unknown",
    "manual_invalid", "manual_roots_missing", "manual_key_unknown", "db_input_invalid", "db_service_unknown",
] as const;
export type SelectionIssueCode = (typeof SELECTION_ISSUE_CODES)[number];
/** `field` is a stable form location: `volumes`, `keys`, `manual:<index>`, `databases:<service>`. */
export type SelectionIssue = {field: string; key: string; code: SelectionIssueCode};

export function knownKeys(inv: StackInventoryV1): Set<string> {
    const wd = safeAbsPath(inv.stack.working_dir_hint);
    const keys = new Set(validateCompleteness(inv, EMPTY_CONTEXT).items.map((i) => i.key));
    keys.add("env:implicit");
    if (wd) keys.add(`dir:${wd}`);
    return keys;
}

export function validateSelection(inv: StackInventoryV1, sel: Selection, allowedRoots: readonly string[], plan: Plan = planStack(inv, sel, allowedRoots)): SelectionIssue[] {
    const out: SelectionIssue[] = [];
    const known = knownKeys(inv);
    const volumes = new Set(inv.volumes.map((v) => v.name));
    for (const key of [...sel.includeKeys, ...sel.excludeKeys]) {
        if (key.startsWith("volume:")) {
            const name = key.slice("volume:".length);
            if (!VOLUME_NAME_RE.test(name) || name.length > 255) out.push({field: "volumes", key, code: "volume_name_path_like"});
            else if (!isAdoptableVolumeName(name)) out.push({field: "volumes", key, code: "volume_name_anonymous"});
            else if (!volumes.has(name)) out.push({field: "volumes", key, code: "volume_not_in_inventory"});
        } else if (!known.has(key)) out.push({field: "keys", key, code: "key_unknown"});
    }
    const manualKeys = sel.manual.map((m) => `manual:${safeAbsPath(m.path) ?? m.path.slice(0, 64)}`);
    sel.manual.forEach((m, i) => {
        const skip = plan.skipped.find((s) => s.key === manualKeys[i]);
        if (!skip) return;
        if (skip.reason === "manual_key_unknown") out.push({field: `manual:${i}`, key: manualKeys[i], code: "manual_key_unknown"});
        else if (allowedRoots.length === 0) out.push({field: `manual:${i}`, key: manualKeys[i], code: "manual_roots_missing"});
        else out.push({field: `manual:${i}`, key: manualKeys[i], code: "manual_invalid"});
    });
    const services = new Set(inv.services.filter((s) => s.database_hint).map((s) => s.name));
    for (const name of Object.keys(sel.databases)) {
        if (!services.has(name)) out.push({field: `databases:${name}`, key: `db:${name}`, code: "db_service_unknown"});
        else if (plan.skipped.some((s) => s.key === `db:${name}` && s.reason === "db_input_invalid")) out.push({field: `databases:${name}`, key: `db:${name}`, code: "db_input_invalid"});
    }
    return out;
}
