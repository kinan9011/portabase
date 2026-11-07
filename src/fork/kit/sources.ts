import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {defaultKekDir, getOrCreateKeyring, type Keyring} from "@/fork/kek";
import type {KeyProvider} from "@/fork/keys";
import {loadTrustAnchors, registerLiveAnchor} from "@/fork/manifest/anchors";
import {spkiSha256} from "@/fork/manifest/sign";
import {kitVerificationCode} from "./fingerprint";
import type {KitChannel, KitSources} from "./material";

/**
 * Gathers what a kit covers, at the last moment: master + signing key (through the `KeyProvider`), the FULL KEK keyring, every trust anchor, and the storage
 * channels the active stack policies (and the D40 dashboard-DB source) use. The live public key is registered as the current anchor first, so a kit always
 * lists the key that signs today. Returns key material to the caller only; callers must not log it.
 */
export type KitSourceDeps = {db: ForkDb; keys: KeyProvider; kekDir?: string; now?: () => Date};

export async function loadKitSources(d: KitSourceDeps): Promise<KitSources & {liveCode: string; signingKid: string}> {
    const now = d.now?.() ?? new Date();
    const master = await d.keys.master();
    const signing = await d.keys.signing();
    const anchor = await registerLiveAnchor(d.db, signing.publicKeyPem, now);
    const anchors = (await loadTrustAnchors(d.db)).map((a) => ({kid: a.kid, publicKeyPem: a.publicKeyPem, spkiSha256: a.fingerprint, retired: a.retired}));
    const kek: Keyring = await getOrCreateKeyring(d.kekDir ?? defaultKekDir());
    const rows = (await d.db.execute(sql`
        select distinct c.name, c.provider::text as provider, c.config
          from storage_channel c
         where c.deleted_at is null
           and (c.id in (select unnest(storage_channel_ids) from fork_stack_policy where activated_at is not null and deactivated_at is null)
                or c.id in (select bs.storage_channel_id from backup_storage bs join fork_dashboard_db_source s on s.database_id is not null
                              join backups b on b.id = bs.backup_id and b.database_id = s.database_id where bs.deleted_at is null))
         order by c.name`)).rows as {name: string; provider: string; config: unknown}[];
    const channels: KitChannel[] = rows.map((r) => ({name: r.name, provider: r.provider, config: r.config}));
    const liveCode = kitVerificationCode({master, kek: kek.keys, spkiSha256Hex: spkiSha256(signing.publicKeyPem)});
    return {master, kek, anchors, channels, now, liveCode, signingKid: anchor.kid};
}

/** The live code only (kit watch): same inputs as the issue, nothing rendered. */
export async function liveKitCode(d: KitSourceDeps): Promise<{code: string; signingKid: string; kekKids: string[]; rotated: boolean}> {
    const master = await d.keys.master();
    const signing = await d.keys.signing();
    const anchor = await registerLiveAnchor(d.db, signing.publicKeyPem, d.now?.() ?? new Date());
    const kek = await getOrCreateKeyring(d.kekDir ?? defaultKekDir());
    return {code: kitVerificationCode({master, kek: kek.keys, spkiSha256Hex: spkiSha256(signing.publicKeyPem)}), signingKid: anchor.kid, kekKids: [...kek.keys.keys()].sort(), rotated: anchor.rotated};
}
