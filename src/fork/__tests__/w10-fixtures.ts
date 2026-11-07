import type {StackInventoryV1} from "@/fork/inventory/schema";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";

/**
 * `cleanInventory()` with its bind mount moved OUTSIDE the compose working dir (`/data/uploads`), so the bind gets a `files` source of its
 * own. (The W09 fixture keeps the bind under `/srv/app`: there the materializer covers it through the compose directory source.)
 */
export function w10Inventory(over: Partial<StackInventoryV1> = {}): StackInventoryV1 {
    const inv = cleanInventory(over);
    inv.mounts = inv.mounts.map((m) => (m.kind === "bind" ? {...m, host_path_hint: "/data/uploads"} : m));
    return inv;
}
