import {createHash} from "node:crypto";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {hashUrl} from "@/fork/recovery-point/hash";

const BODY = Buffer.from("ciphertext-bytes-".repeat(5000));
const SHA = createHash("sha256").update(BODY).digest("hex");
let server: Server; let base = "";
beforeAll(async () => {
    server = createServer((req, res) => {
        if (req.url === "/ok") { res.writeHead(200, {"content-length": BODY.length}); res.end(BODY); }
        else if (req.url === "/trunc") { res.writeHead(200, {"content-length": 10}); res.end(BODY.subarray(0, 10)); }
        else if (req.url === "/empty") { res.writeHead(200, {"content-length": 0}); res.end(); }
        else if (req.url === "/slow") { res.writeHead(200); res.write("x"); /* never ends */ }
        else if (req.url === "/redirect") { res.writeHead(302, {location: "http://127.0.0.1:1/x"}); res.end(); }
        else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });
const req = (o: Partial<{expectedSize: number | null; maxBytes: number; timeoutMs: number}> = {}) => ({expectedSize: BODY.length - 122, maxBytes: 1 << 20, timeoutMs: 5000, ...o});

describe("runs: ciphertext hashing (the agent reports no checksum)", () => {
    it("streams and hashes the stored object; size ≥ the pre-encryption size the agent reported is accepted (lab: +122 bytes of header and tags)", async () => {
        expect(await hashUrl(`${base}/ok`, req())).toEqual({sha256: SHA, bytes: BODY.length});
        expect(await hashUrl(`${base}/ok`, req({expectedSize: null}))).toEqual({sha256: SHA, bytes: BODY.length});
        expect(await hashUrl(`${base}/ok`, req({expectedSize: BODY.length}))).toEqual({sha256: SHA, bytes: BODY.length});
    });
    it("a TRUNCATED object (smaller than reported) or an empty one never gets a checksum", async () => {
        expect(await hashUrl(`${base}/trunc`, req())).toBeNull();
        expect(await hashUrl(`${base}/empty`, req({expectedSize: null}))).toBeNull();
    });
    it("over the size cap, a non-200, a redirect and a stalled stream (timeout) all give null — never a made-up checksum", async () => {
        expect(await hashUrl(`${base}/ok`, req({maxBytes: 1000}))).toBeNull();
        expect(await hashUrl(`${base}/missing`, req())).toBeNull();
        expect(await hashUrl(`${base}/redirect`, req())).toBeNull();
        expect(await hashUrl(`${base}/slow`, req({timeoutMs: 300}))).toBeNull();
        expect(await hashUrl("http://127.0.0.1:1/never", req({timeoutMs: 300}))).toBeNull();
    });
});
