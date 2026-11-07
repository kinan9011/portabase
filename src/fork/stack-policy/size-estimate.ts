import type {StackInventoryV1} from "@/fork/inventory/schema";
import type {Plan} from "@/fork/materialize/types";

/**
 * Steady-state size estimate (EU-08, "Should"): the sum of the SIZES ARCANE REPORTED for the volumes/binds the plan would back up,
 * one full copy, before compression and deduplication. Never invents a number: sources without a reported size are counted as
 * `unknown`, and with nothing reported `bytes` is null ("not known until the first backup").
 */
export type SizeEstimate = {bytes: number | null; counted: number; unknown: number};

export function estimateSize(inv: StackInventoryV1, plan: Pick<Plan, "sources">): SizeEstimate {
    const vol = new Map(inv.volumes.map((v) => [v.name, v.size_bytes]));
    const mnt = new Map(inv.mounts.map((m) => [`mount:${m.id}`, m.size_bytes]));
    let bytes = 0;
    let counted = 0;
    let unknown = 0;
    for (const s of plan.sources) {
        if (s.role !== "volume" && s.role !== "bind") continue; // compose dir / env / DB dumps are small or unmeasurable here
        const size = s.role === "volume" ? vol.get(s.resourceKey.slice("volume:".length)) : mnt.get(s.resourceKey);
        if (size === undefined) unknown++;
        else { bytes += size; counted++; }
    }
    return {bytes: counted > 0 ? bytes : null, counted, unknown};
}
