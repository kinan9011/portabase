import {readFile} from "node:fs/promises";
import path from "node:path";
import {publicKeyPemOf} from "@/fork/manifest/sign";

/**
 * Key custody boundary (ADR-013). Everything that needs the instance master key or the dashboard signing key goes through a `KeyProvider`, so
 * (a) key bytes are read at the last moment and never cached in a module variable, (b) tests inject throw-away TEST-ONLY keys, (c) one static test pins
 * that only this file, `kek.ts` and `upstream/master-key.ts` read key files. Nothing here logs or returns key material in an error.
 */
export type SigningKey = {privateKeyPem: string; publicKeyPem: string};
export type KeyProvider = {
    master(): Promise<Buffer>;
    signing(): Promise<SigningKey>;
};

export class KeyUnavailableError extends Error {
    constructor(readonly which: "master" | "signing") { super(`${which} key unavailable`); }
}

const keysDir = () => {
    const p = process.env.PRIVATE_PATH;
    if (!p) throw new KeyUnavailableError("signing");
    return path.join(p, "keys");
};

/** Production provider: master via the upstream adapter (same file/derivation as the agents), signing key from `server_private.pem` (upstream `generateRSAKeys`). */
export const fileKeyProvider: KeyProvider = {
    async master() {
        try {
            const {upstreamMasterKey} = await import("@/fork/upstream/master-key");
            const k = await upstreamMasterKey();
            if (k.length !== 32) throw new Error("length");
            return k;
        } catch { throw new KeyUnavailableError("master"); }
    },
    async signing() {
        try {
            const privateKeyPem = await readFile(path.join(keysDir(), "server_private.pem"), "utf8");
            return {privateKeyPem, publicKeyPem: publicKeyPemOf(privateKeyPem)};
        } catch { throw new KeyUnavailableError("signing"); }
    },
};
