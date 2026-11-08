/**
 * W17b pure planner (D2/D3): selection + inventory dependency order + window partition → stop / start order or a list of blockers. UX and request
 * building only — the AGENT re-validates everything by full container id (D8); this mirror may only be stricter or equal, never the authority.
 * Pure: no db / react / node imports (static test).
 */
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {isWindowDbms, MAX_TARGETS, type PlanBlockerCode} from "./vocab";

export type QuiesceTarget = {service: string; container_id: string};
export type QuiesceMember = {name: string; dbms: string; mountIds: readonly string[]; active: boolean};
export type PlanBlocker = {code: PlanBlockerCode; service?: string; member?: string};
export type OkPlan = {ok: true; stopOrder: QuiesceTarget[]; startOrder: string[]; windowMembers: string[]; preMembers: string[]; notRunning: string[]};
export type QuiescePlan = OkPlan | {ok: false; blockers: PlanBlocker[]};

function repoOf(image: string): string {
    const noDigest = image.split("@")[0] ?? "";
    const tailStart = noDigest.lastIndexOf("/") + 1;
    const colon = noDigest.slice(tailStart).indexOf(":");
    const repo = colon >= 0 ? noDigest.slice(0, tailStart + colon) : noDigest;
    return repo.replace(/^docker\.io\//, "").replace(/^library\//, "").toLowerCase();
}
/** TS mirror of the agent's `guard::is_manager_image` (the agent stays authoritative). */
export function isManagerImage(ref: string): boolean {
    const r = repoOf(ref);
    const last = r.split("/").pop() ?? "";
    return r === "portabase/portabase" || r === "portabase/agent" || r.startsWith("ghcr.io/portabase/") || r.endsWith("/portabase/portabase") || r.endsWith("/portabase/agent")
        || r.includes("portabase-agent-fork") || r.includes("getarcaneapp/arcane") || last === "arcane";
}

/** Prefill ONLY (D18: labels are untrusted defaults): `selection.stop` ∪ services with `backup_hints.stop === true`, sorted. The stored explicit choice is what runs use. */
export function defaultQuiesceServices(inv: StackInventoryV1, selectionStop: readonly string[]): string[] {
    const names = new Set(inv.services.map((s) => s.name));
    const out = new Set<string>(selectionStop.filter((s) => names.has(s)));
    for (const s of inv.services) if (s.backup_hints?.stop === true) out.add(s.name);
    return [...out].sort();
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planQuiesce(inv: StackInventoryV1, services: readonly string[], members: readonly QuiesceMember[]): QuiescePlan {
    const blockers: PlanBlocker[] = [];
    const picked = [...new Set(services)];
    if (picked.length === 0) return {ok: false, blockers: [{code: "no_services"}]};
    if (picked.length > MAX_TARGETS) blockers.push({code: "too_many"});
    const byName = new Map(inv.services.map((s) => [s.name, s]));
    for (const n of picked) if (!byName.has(n)) blockers.push({code: "service_unknown", service: n});
    // a manager (Portabase / agent / Arcane) anywhere in the stack refuses the whole task on the agent (OD-W17b-7): say so before the admin enables it
    for (const s of inv.services) if (isManagerImage(s.image.ref)) blockers.push({code: "manager_in_stack", service: s.name});
    const known = picked.filter((n) => byName.has(n));
    const running = known.filter((n) => byName.get(n)?.state === "running");
    const notRunning = known.filter((n) => !running.includes(n)).sort(cmp);
    for (const n of running) if (!byName.get(n)?.container_id) blockers.push({code: "no_container_id", service: n});
    if (running.length === 0 && known.length > 0 && !blockers.some((b) => b.code === "no_services")) blockers.push({code: "no_services"});

    // dependency order over the SELECTED running services (edges outside the selection are ignored): start = dependencies first
    const sel = new Set(running);
    const indeg = new Map<string, number>(running.map((n) => [n, 0]));
    const dependents = new Map<string, string[]>(running.map((n) => [n, []]));
    for (const n of running) {
        for (const d of new Set(byName.get(n)?.depends_on ?? [])) {
            if (d === n || !sel.has(d)) continue;
            indeg.set(n, (indeg.get(n) ?? 0) + 1);
            dependents.get(d)?.push(n);
        }
    }
    const startOrder: string[] = [];
    const ready = running.filter((n) => indeg.get(n) === 0).sort(cmp);
    while (ready.length) {
        const n = ready.shift() as string;
        startOrder.push(n);
        for (const m of dependents.get(n) ?? []) {
            indeg.set(m, (indeg.get(m) ?? 0) - 1);
            if (indeg.get(m) === 0) {
                ready.push(m);
                ready.sort(cmp);
            }
        }
    }
    if (startOrder.length !== running.length) blockers.push({code: "dependency_cycle"});

    const active = members.filter((m) => m.active);
    const windowMembers = active.filter((m) => isWindowDbms(m.dbms));
    if (windowMembers.length === 0) blockers.push({code: "no_window_members"});
    // every RW consumer (that runs) of a mount a window member copies must be stopped, or the copy is not quiesced
    const mountById = new Map(inv.mounts.map((m) => [m.id, m]));
    for (const m of windowMembers) {
        for (const id of m.mountIds) {
            const mount = mountById.get(id);
            if (!mount?.rw) continue;
            for (const c of mount.consumers) {
                if (byName.get(c)?.state === "running" && !sel.has(c)) blockers.push({code: "writer_not_stopped", service: c, member: m.name});
            }
        }
    }
    if (blockers.length) return {ok: false, blockers};
    const stopOrder = [...startOrder].reverse().map((service) => ({service, container_id: byName.get(service)?.container_id as string}));
    return {ok: true, stopOrder, startOrder, windowMembers: windowMembers.map((m) => m.name).sort(cmp), preMembers: active.filter((m) => !isWindowDbms(m.dbms)).map((m) => m.name).sort(cmp), notRunning};
}
