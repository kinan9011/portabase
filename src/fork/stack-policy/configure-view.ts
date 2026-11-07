import {sql} from "drizzle-orm";
import {z} from "zod";
import type {ForkDb} from "@/fork/db/handle";
import {safeAbsPath} from "@/fork/inventory/labels";
import {type StackInventoryV1, parseInventoryStrict} from "@/fork/inventory/schema";
import {SelectionSchema, DUMP_ENGINES, DUMP_REQUIRED} from "@/fork/materialize/types";
import {DEFAULT_RETENTION, RetentionPolicySchema} from "@/fork/recovery/retention-policy";
import {DEFAULT_SCHEDULE, ScheduleSchema, SCHEDULE_PRESETS} from "@/fork/schedule/schedule";
import {encryptionEnabled, listAvailableChannels} from "@/fork/upstream";
import {deletableFacet} from "./channels";
import {computePreview, PreviewViewSchema} from "./preview";

/**
 * Browser DTO of the Configure Backup form (W11). STRICT and built field by field: names, hints, statuses and the stack's own saved
 * (non-secret) configuration. It carries NO storage-channel `config`, no environment value, no password (a password is never stored),
 * and not the stored inventory (W08 wall) — the form asks the server for previews instead.
 */
export const ConfigureViewSchema = z.strictObject({
    stack: z.strictObject({id: z.uuid(), name: z.string().max(255), composeProject: z.string().max(128), environmentName: z.string().max(255), runtime: z.string().max(32)}),
    encryptionOn: z.boolean(),
    /** `fork_arcane_environment.allowed_path_roots` configured? (manual paths need one, D19.) */
    rootsConfigured: z.boolean(),
    composeDir: z.string().max(1100).nullable(),
    volumes: z.array(z.strictObject({name: z.string().max(256), sizeBytes: z.number().int().min(0).nullable()})).max(2000),
    databases: z.array(z.strictObject({
        service: z.string().max(128), engine: z.string().max(32), basis: z.enum(["image", "port", "mount"]),
        /** `dump` engines need connection fields + (some) a password; `sqlite` needs the agent-visible file path; anything else = file copy only. */
        mode: z.enum(["dump", "sqlite", "unsupported"]), fields: z.array(z.enum(["host", "port", "username", "database"])).max(4), secret: z.boolean(),
    })).max(500),
    channels: z.array(z.strictObject({id: z.uuid(), name: z.string().max(255), provider: z.string().max(32), local: z.boolean(), deletable: z.enum(["yes", "no", "not_checked"])})).max(200),
    existing: z.strictObject({
        active: z.boolean(),
        selection: SelectionSchema,
        schedule: ScheduleSchema,
        retention: RetentionPolicySchema,
        channelIds: z.array(z.uuid()).max(20),
        accepted: z.array(z.string().max(1200)).max(500),
    }),
    preview: PreviewViewSchema,
});
export type ConfigureView = z.infer<typeof ConfigureViewSchema>;
export const SCHEDULE_PRESET_LIST = SCHEDULE_PRESETS;

/** One stack of ONE organization, or null (missing / another organization's: no oracle). The caller has already authorised `stacks.backup.manage`. */
export async function loadConfigureView(db: ForkDb, organizationId: string, stackId: string): Promise<ConfigureView | null> {
    const res = await db.execute(sql`
        select s.id, s.display_name, s.compose_project, s.environment_name, s.runtime_state, s.environment_id,
               coalesce(e.allowed_path_roots, '{}'::text[]) as roots,
               (select i.inventory from fork_stack_inventory i where i.stack_id = s.id order by i.version desc limit 1) as inventory,
               p.activated_at, p.deactivated_at, p.selection, p.schedule, p.policy, p.storage_channel_ids, p.accepted_exclusions
          from fork_stack s
          left join fork_arcane_environment e on e.id = s.environment_id
          left join fork_stack_policy p on p.stack_id = s.id
         where s.id = ${stackId} and s.organization_id = ${organizationId}`);
    const r = res.rows[0] as undefined | {
        id: string; display_name: string; compose_project: string; environment_name: string; runtime_state: string; roots: string[]; inventory: unknown;
        activated_at: Date | null; deactivated_at: Date | null; selection: unknown; schedule: unknown; policy: unknown; storage_channel_ids: string[] | null; accepted_exclusions: string[] | null;
    };
    if (!r) return null;
    let inv: StackInventoryV1;
    try { inv = parseInventoryStrict(r.inventory); } catch { return null; }

    const sel = SelectionSchema.safeParse(r.selection);
    const sched = ScheduleSchema.safeParse(r.schedule);
    const ret = RetentionPolicySchema.safeParse(r.policy);
    const active = !!r.activated_at && !r.deactivated_at;
    const selection = sel.success ? sel.data : SelectionSchema.parse({});
    const accepted = active ? (r.accepted_exclusions ?? []) : [];
    const channels = await listAvailableChannels(db, organizationId);
    const wd = safeAbsPath(inv.stack.working_dir_hint);

    return ConfigureViewSchema.parse({
        stack: {id: r.id, name: r.display_name, composeProject: r.compose_project, environmentName: r.environment_name, runtime: r.runtime_state},
        encryptionOn: await encryptionEnabled(db),
        rootsConfigured: (r.roots ?? []).length > 0,
        composeDir: wd,
        volumes: inv.volumes.map((v) => ({name: v.name, sizeBytes: v.size_bytes ?? null})),
        databases: inv.services.filter((s) => s.database_hint).map((s) => {
            const engine = s.database_hint!.engine;
            const dump = (DUMP_ENGINES as readonly string[]).includes(engine);
            return {
                service: s.name, engine, basis: s.database_hint!.basis,
                mode: dump ? "dump" : engine === "sqlite" ? "sqlite" : "unsupported",
                fields: dump ? [...DUMP_REQUIRED[engine as (typeof DUMP_ENGINES)[number]].fields] : [],
                secret: dump ? DUMP_REQUIRED[engine as (typeof DUMP_ENGINES)[number]].secret : false,
            };
        }),
        channels: channels.map((c) => ({id: c.id, name: c.name, provider: c.provider, local: c.provider === "local", deletable: deletableFacet({id: c.id, provider: c.provider})})),
        existing: {
            active, selection,
            schedule: sched.success ? sched.data : ScheduleSchema.parse(DEFAULT_SCHEDULE),
            retention: ret.success ? ret.data : DEFAULT_RETENTION,
            channelIds: r.storage_channel_ids ?? [],
            accepted,
        },
        preview: computePreview(inv, selection, accepted, r.roots ?? []),
    });
}

/** Re-computes the preview for a pending selection of ONE authorised stack (read-only). */
export async function loadPreview(db: ForkDb, organizationId: string, stackId: string, sel: unknown, accepted: readonly string[]): Promise<z.infer<typeof PreviewViewSchema> | null> {
    const res = await db.execute(sql`
        select coalesce(e.allowed_path_roots, '{}'::text[]) as roots,
               (select i.inventory from fork_stack_inventory i where i.stack_id = s.id order by i.version desc limit 1) as inventory
          from fork_stack s left join fork_arcane_environment e on e.id = s.environment_id
         where s.id = ${stackId} and s.organization_id = ${organizationId}`);
    const r = res.rows[0] as undefined | {roots: string[]; inventory: unknown};
    if (!r) return null;
    const parsedSel = SelectionSchema.safeParse(sel);
    if (!parsedSel.success) return null;
    let inv: StackInventoryV1;
    try { inv = parseInventoryStrict(r.inventory); } catch { return null; }
    return computePreview(inv, parsedSel.data, accepted.slice(0, 500), r.roots ?? []);
}
