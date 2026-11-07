import {z} from "zod";
import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {ARCHIVE_KINDS, ARTIFACT_PRESENCE, CONSISTENCY_LEVELS} from "@/fork/db/enums";
import {RP_DOWNGRADE_REASONS, RpStatusSchema} from "@/fork/recovery/status";

/**
 * Read model of the Backups tab (W13): the stack's recovery points and, for ONE selected point, its artifacts. Strict DTO, org-scoped in SQL:
 * statuses, codes, sizes, times, destination NAMES (never channel config), source names — no upstream row id, no path, no snapshot id, no key,
 * no raw error. `pending_verification` stays `pending_verification` here; the UI says "Backed up · verifying" (D43) — nothing in this model can
 * say "verified" unless the RP row is `verified` (only the W14 job writes that).
 */
export const BACKUPS_LIMIT = 50;

export const BackupRowSchema = z.strictObject({
    sequence: z.number().int(),
    createdAt: z.string(),
    status: RpStatusSchema,
    reason: z.enum(RP_DOWNGRADE_REASONS).nullable(),
    consistency: z.enum(CONSISTENCY_LEVELS),
    destinations: z.array(z.string().max(255)).max(50),
    sizeBytes: z.number().int().min(0).nullable(),
    durationSeconds: z.number().int().min(0).nullable(),
    required: z.number().int().min(0),
    present: z.number().int().min(0),
    inventoryVersion: z.number().int().nullable(),
    trigger: z.enum(["schedule", "manual"]).nullable(),
    verifiedAt: z.string().nullable(),
});
export type BackupRow = z.infer<typeof BackupRowSchema>;

export const ArtifactViewSchema = z.strictObject({
    source: z.string().max(255),
    engine: z.string().max(64),
    kind: z.enum(ARCHIVE_KINDS),
    encrypted: z.boolean(),
    destination: z.string().max(255).nullable(),
    sizeBytes: z.number().int().min(0).nullable(),
    /** Whether a ciphertext checksum is recorded, plus its first 12 hex digits (a hash is not a secret; the full value stays server-side). */
    checksum: z.strictObject({recorded: z.boolean(), short: z.string().regex(/^[0-9a-f]{12}$/).nullable()}),
    presence: z.enum(ARTIFACT_PRESENCE),
    required: z.boolean(),
});
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const BackupsViewSchema = z.strictObject({
    total: z.number().int().min(0),
    shown: z.number().int().min(0),
    timezone: z.string().max(100),
    rows: z.array(BackupRowSchema).max(BACKUPS_LIMIT),
    /** The selected recovery point (by sequence) with its artifacts, or null. */
    detail: z.strictObject({row: BackupRowSchema, artifacts: z.array(ArtifactViewSchema).max(500)}).nullable(),
});
export type BackupsView = z.infer<typeof BackupsViewSchema>;

type RpRow = {
    id: string; sequence: string | number; created_at: Date; finalized_at: Date | null; status: string; downgrade_reason: string | null; consistency_level: string;
    required_artifact_count: number; present_artifact_count: number; total_size_bytes: string | number | null; inventory_version: number | null; trigger: string | null; verified_at: Date | null;
};
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** `sequence` selects the detail (ignored when it does not belong to this stack). Returns `null` for a stack of another organization / missing. */
export async function loadBackupsView(db: ForkDb, organizationId: string, stackId: string, o: {sequence?: number | null} = {}): Promise<BackupsView | null> {
    const own = await db.execute(sql`select p.schedule->>'timezone' as tz from fork_stack s left join fork_stack_policy p on p.stack_id = s.id where s.id = ${stackId} and s.organization_id = ${organizationId}`);
    if (own.rows.length === 0) return null;
    const timezone = (own.rows[0] as {tz: string | null}).tz ?? "UTC";
    const rows = (await db.execute(sql`
        select p.id, p.sequence, p.created_at, p.finalized_at, p.status, p.downgrade_reason, p.consistency_level, p.required_artifact_count, p.present_artifact_count,
               p.total_size_bytes, p.inventory_version, p.verified_at, r.trigger
          from fork_recovery_point p left join fork_stack_run r on r.id = p.run_id
         where p.stack_id = ${stackId} and p.purged_at is null order by p.sequence desc limit ${BACKUPS_LIMIT}`)).rows as RpRow[];
    const total = ((await db.execute(sql`select count(*)::int as n from fork_recovery_point where stack_id = ${stackId} and purged_at is null`)).rows[0] as {n: number}).n;

    const wanted = o.sequence !== null && o.sequence !== undefined ? o.sequence : null;
    let detailRow: RpRow | undefined = wanted === null ? undefined : rows.find((r) => Number(r.sequence) === wanted)
        ?? ((await db.execute(sql`
            select p.id, p.sequence, p.created_at, p.finalized_at, p.status, p.downgrade_reason, p.consistency_level, p.required_artifact_count, p.present_artifact_count,
                   p.total_size_bytes, p.inventory_version, p.verified_at, r.trigger
              from fork_recovery_point p left join fork_stack_run r on r.id = p.run_id
             where p.stack_id = ${stackId} and p.sequence = ${wanted} and p.purged_at is null`)).rows[0] as RpRow | undefined);

    const ids = [...new Set([...rows.map((r) => r.id), ...(detailRow ? [detailRow.id] : [])])];
    const arts = ids.length === 0 ? [] : (await db.execute(sql`
        select a.rp_id, a.source_name, a.engine, a.archive_kind, a.encrypted, a.channel_id, a.size_bytes, a.ciphertext_sha256, a.presence, a.required, c.name as channel_name
          from fork_recovery_point_artifact a left join storage_channel c on c.id = a.channel_id
         where a.rp_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) order by a.source_name, a.archive_kind, a.id`)).rows as {
        rp_id: string; source_name: string; engine: string; archive_kind: string; encrypted: boolean; channel_id: string | null; size_bytes: string | number | null; ciphertext_sha256: string | null; presence: string; required: boolean; channel_name: string | null;
    }[];

    const toRow = (r: RpRow): BackupRow => {
        const mine = arts.filter((a) => a.rp_id === r.id);
        const names = [...new Set(mine.map((a) => (a.channel_id ? (a.channel_name ?? "Removed storage channel") : null)).filter((x): x is string => x !== null))];
        return BackupRowSchema.parse({
            sequence: Number(r.sequence), createdAt: iso(r.created_at), status: r.status, reason: r.downgrade_reason, consistency: r.consistency_level, destinations: names,
            sizeBytes: r.total_size_bytes === null ? null : Number(r.total_size_bytes),
            durationSeconds: r.finalized_at ? Math.max(0, Math.round((new Date(r.finalized_at).getTime() - new Date(r.created_at).getTime()) / 1000)) : null,
            required: r.required_artifact_count, present: r.present_artifact_count, inventoryVersion: r.inventory_version, trigger: r.trigger ?? null, verifiedAt: iso(r.verified_at),
        });
    };
    return BackupsViewSchema.parse({
        total, shown: rows.length, timezone,
        rows: rows.map(toRow),
        detail: detailRow ? {
            row: toRow(detailRow),
            artifacts: arts.filter((a) => a.rp_id === detailRow!.id).map((a) => ({
                source: a.source_name, engine: a.engine, kind: a.archive_kind, encrypted: a.encrypted,
                destination: a.channel_id ? (a.channel_name ?? "Removed storage channel") : null,
                sizeBytes: a.size_bytes === null ? null : Number(a.size_bytes),
                checksum: {recorded: a.ciphertext_sha256 !== null, short: a.ciphertext_sha256 && /^[0-9a-f]{64}$/.test(a.ciphertext_sha256) ? a.ciphertext_sha256.slice(0, 12) : null},
                presence: a.presence, required: a.required,
            })),
        } : null,
    });
}
