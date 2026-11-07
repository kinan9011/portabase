import type {StackInventoryV1} from "@/fork/inventory/schema";
import {ConfigureViewSchema, type ConfigureView} from "@/fork/stack-policy/configure-view";
import {computePreview} from "@/fork/stack-policy/preview";
import {SelectionSchema} from "@/fork/materialize/types";
import {DEFAULT_RETENTION} from "@/fork/recovery/retention-policy";
import {DEFAULT_SCHEDULE, ScheduleSchema} from "@/fork/schedule/schedule";
import {w10Inventory} from "@/fork/__tests__/w10-fixtures";

export const STACK_ID = "0b7e1c1e-7f3a-4b6e-9a40-222222222222";
export const CH_S3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const CH_LOCAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

/** The W10 clean inventory plus a postgres service (data in a named volume) and a service carrying a stop label. */
export function w11Inventory(opts: {db?: boolean; stop?: boolean} = {}): StackInventoryV1 {
    const inv = w10Inventory();
    if (opts.db) {
        inv.services.push({name: "db", state: "running", image: {ref: "postgres:16", pinned: false, built_locally: false}, ports: [], networks: [], mounts: ["m:00000000000000a1"], env_keys: [], database_hint: {engine: "postgresql", basis: "image"}});
        inv.mounts.push({id: "m:00000000000000a1", kind: "named_volume", volume_name: "app_pgdata", destination: "/var/lib/postgresql/data", rw: true, consumers: ["db"], ownership: "stack_owned"});
        inv.volumes.push({name: "app_pgdata", driver: "local", in_use_by: ["db"], ownership: "stack_owned", size_bytes: 2_147_483_648});
    }
    if (opts.stop) inv.services[0] = {...inv.services[0], backup_hints: {stop: true}};
    return inv;
}

export function w11View(o: {db?: boolean; stop?: boolean; roots?: boolean; encryption?: boolean; active?: boolean; channels?: ConfigureView["channels"]} = {}): ConfigureView {
    const inv = w11Inventory(o);
    const sel = SelectionSchema.parse({});
    return ConfigureViewSchema.parse({
        stack: {id: STACK_ID, name: "forklab-demo", composeProject: "forklab-demo", environmentName: "local", runtime: "running"},
        encryptionOn: o.encryption ?? true,
        rootsConfigured: o.roots ?? false,
        composeDir: inv.stack.working_dir_hint,
        volumes: inv.volumes.map((v) => ({name: v.name, sizeBytes: v.size_bytes ?? null})),
        databases: o.db ? [{service: "db", engine: "postgresql", basis: "image", mode: "dump", fields: ["host", "port", "username", "database"], secret: true}] : [],
        channels: o.channels ?? [
            {id: CH_S3, name: "offsite", provider: "s3", local: false, deletable: "not_checked"},
            {id: CH_LOCAL, name: "dashboard-local", provider: "local", local: true, deletable: "not_checked"},
        ],
        existing: {active: o.active ?? false, selection: sel, schedule: ScheduleSchema.parse(DEFAULT_SCHEDULE), retention: DEFAULT_RETENTION, channelIds: [], accepted: []},
        preview: computePreview(inv, sel, [], o.roots ? ["/srv"] : []),
    });
}
export {w11Inventory as inventory};
