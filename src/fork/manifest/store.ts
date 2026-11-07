import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {RESTIC_NO_REPO, type ResticRunner} from "./restic-runner";

/**
 * Manifest snapshot store (D24, ADR-013 K-2): ONE restic snapshot per RP holding `manifest.json`, `manifest.json.sig` (raw bytes) and
 * `signing-key.pub.pem` (a convenience copy: the trust anchor is the kit). Tagged `fork-manifest`, `rp:<id>`, `seq:<n>`. Backend-agnostic: the
 * runner points at an rclone repo in production and at a local path in tests. Repository content is untrusted on read: names are matched exactly.
 */
export type ManifestFiles = {json: string; sig: Buffer; publicKeyPem: string};
export const MANIFEST_FILE = "manifest.json";
export const SIG_FILE = "manifest.json.sig";
export const PUB_FILE = "signing-key.pub.pem";
const FULL_ID = /^[0-9a-f]{64}$/;
export const TAG_ALL = "fork-manifest";
export const rpTag = (rpId: string) => `rp:${rpId.toLowerCase()}`;

export class ManifestStoreError extends Error {
    constructor(readonly code: "init_failed" | "backup_failed" | "list_failed" | "read_failed" | "forget_failed" | "not_found") { super(code); }
}

async function ensureRepo(run: ResticRunner): Promise<void> {
    const cat = await run(["cat", "config"]);
    if (cat.code === 0) return;
    if (cat.code !== RESTIC_NO_REPO) throw new ManifestStoreError("init_failed");
    const init = await run(["init"]);
    if (init.code !== 0) throw new ManifestStoreError("init_failed");
}

export async function listManifestSnapshots(run: ResticRunner, rpId: string): Promise<string[]> {
    const r = await run(["snapshots", "--json", "--tag", rpTag(rpId)]);
    if (r.code === RESTIC_NO_REPO) return [];
    if (r.code !== 0) throw new ManifestStoreError("list_failed");
    try {
        const arr = JSON.parse(r.stdout.toString("utf8") || "[]") as {id?: unknown}[];
        return arr.map((s) => s.id).filter((i): i is string => typeof i === "string" && FULL_ID.test(i));
    } catch { throw new ManifestStoreError("list_failed"); }
}

/** Writes a new snapshot for the RP and returns its FULL id (64 hex). The temp dir holds public + signed data only and is removed at once. */
export async function writeManifestSnapshot(run: ResticRunner, files: ManifestFiles, tags: {rpId: string; sequence: number}): Promise<{snapshotId: string}> {
    await ensureRepo(run);
    const dir = await mkdtemp(path.join(tmpdir(), "fork-manifest-"));
    try {
        await writeFile(path.join(dir, MANIFEST_FILE), files.json, {mode: 0o600});
        await writeFile(path.join(dir, SIG_FILE), files.sig, {mode: 0o600});
        await writeFile(path.join(dir, PUB_FILE), files.publicKeyPem, {mode: 0o600});
        const b = await run(["backup", "--json", "--host", "portabase-fork", "--tag", TAG_ALL, "--tag", rpTag(tags.rpId), "--tag", `seq:${tags.sequence}`, "."], {cwd: dir});
        if (b.code !== 0) throw new ManifestStoreError("backup_failed");
        const ids = await listManifestSnapshots(run, tags.rpId);
        // the newest snapshot of this RP (restic lists oldest → newest)
        const id = ids[ids.length - 1];
        if (!id) throw new ManifestStoreError("backup_failed");
        return {snapshotId: id};
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

/** Reads the three files of one snapshot back, byte-exact. Names are looked up exactly in `ls`, never trusted as paths. */
export async function readManifestSnapshot(run: ResticRunner, snapshotId: string): Promise<ManifestFiles> {
    if (!FULL_ID.test(snapshotId)) throw new ManifestStoreError("not_found");
    const ls = await run(["ls", "--json", snapshotId]);
    if (ls.code !== 0) throw new ManifestStoreError("read_failed");
    const paths = new Map<string, string>();
    for (const line of ls.stdout.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
            const n = JSON.parse(line) as {type?: string; path?: string; name?: string};
            if (n.type === "file" && typeof n.path === "string" && typeof n.name === "string" && [MANIFEST_FILE, SIG_FILE, PUB_FILE].includes(n.name)) paths.set(n.name, n.path);
        } catch { /* snapshot header line */ }
    }
    const get = async (name: string): Promise<Buffer> => {
        const p = paths.get(name);
        if (!p) throw new ManifestStoreError("not_found");
        const d = await run(["dump", snapshotId, p], {maxStdoutBytes: 4 * 1024 * 1024});
        if (d.code !== 0) throw new ManifestStoreError("read_failed");
        return d.stdout;
    };
    return {json: (await get(MANIFEST_FILE)).toString("utf8"), sig: await get(SIG_FILE), publicKeyPem: (await get(PUB_FILE)).toString("utf8")};
}

/** Forgets every manifest snapshot of an expired RP (W12 handoff: the manifest `forget` is W14's). Idempotent: nothing to forget = ok. */
export async function forgetManifestSnapshots(run: ResticRunner, rpId: string): Promise<number> {
    const ids = await listManifestSnapshots(run, rpId);
    if (ids.length === 0) return 0;
    const f = await run(["forget", ...ids]);
    if (f.code !== 0) throw new ManifestStoreError("forget_failed");
    return ids.length;
}
