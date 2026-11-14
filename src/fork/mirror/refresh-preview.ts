import {z} from "zod";

/**
 * W25 read-only refresh preview contract (plan-W25 DD-2). A strict allowlist: numbers, ids, codes, booleans and timestamps only — NO path, URL, spec, env, task result or manifest text.
 * `lastCapacity` is the newest SUCCEEDED probe's free disk / memory, with its age: a last-known fact, never a live value (the runner preflight at step `probe` is authoritative).
 */
export const PreviewRefreshRequest = z.strictObject({mirrorId: z.uuid(), rpId: z.uuid().nullable()});
export const REFRESH_CANDIDATES_MAX = 20;
export const RefreshPreview = z.strictObject({
    mirror: z.strictObject({name: z.string(), status: z.string(), activeSeq: z.number().int(), activeRpSequence: z.number().int(), activeRpAt: z.string().nullable(), activeSince: z.string().nullable()}),
    candidates: z.array(z.strictObject({id: z.uuid(), sequence: z.number().int(), createdAt: z.string(), verifiedAt: z.string().nullable()})).max(REFRESH_CANDIDATES_MAX),
    selected: z.strictObject({
        rpId: z.uuid(), sequence: z.number().int(), outcome: z.string(), blockers: z.array(z.string()).max(20),
        requiredDiskBytes: z.number().int(), sizeUnknown: z.boolean(), memNeedBytes: z.number().int(), appChanged: z.boolean().nullable(),
    }).nullable(),
    lastCapacity: z.strictObject({freeDiskBytes: z.number().nullable(), memAvailableBytes: z.number().nullable(), at: z.string()}).nullable(),
    containsPersonalData: z.boolean().nullable(),
});
export type RefreshPreview = z.infer<typeof RefreshPreview>;
