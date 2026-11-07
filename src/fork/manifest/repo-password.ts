import {hkdfSync} from "node:crypto";

/**
 * Manifest repo password (D24, ADR-013 K-2): hex(HKDF-SHA256(master, salt = "", info = "portabase-fork/manifest/v1/<stackId>", 32)). Same
 * construction as the artifact repos (`portabase/restic/v1/<generatedId>`), so the offline CLI derives it with `openssl kdf` from the kit's master key.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MANIFEST_HKDF_INFO_PREFIX = "portabase-fork/manifest/v1/";

export function manifestRepoPassword(masterKey: Buffer, stackId: string): string {
    if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
    if (!UUID.test(stackId)) throw new Error("stack id must be a uuid");
    return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), `${MANIFEST_HKDF_INFO_PREFIX}${stackId.toLowerCase()}`, 32)).toString("hex");
}

/** Relative repo location inside a channel: `<folder>/fork-manifest/<stackId>` (the artifact repos live under `<folder>/restic/…`). */
export const manifestRepoRel = (folder: string, stackId: string): string => `${folder.trim().replace(/^\/+|\/+$/g, "") || "backups"}/fork-manifest/${stackId.toLowerCase()}`;
