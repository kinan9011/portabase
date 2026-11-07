import {z} from "zod";
import {RetentionPolicySchema} from "@/fork/recovery/retention-policy";
import {ScheduleSchema} from "@/fork/schedule/schedule";

/**
 * The ACTIVATED policy as the stack's Schedule tab shows it (W11 placeholder, W13 builds the real tab). Names and settings only: no
 * selection, no channel config, no authorization record details beyond "who/when".
 */
export const PolicyViewSchema = z.strictObject({
    activatedAt: z.string(),
    schedule: ScheduleSchema,
    cron: z.string().max(100),
    nextRuns: z.array(z.string()).max(3),
    retention: RetentionPolicySchema,
    channels: z.array(z.strictObject({name: z.string().max(255), provider: z.string().max(32), local: z.boolean()})).max(20),
    consistency: z.enum(["crash", "dump", "stop"]),
    sourceCount: z.number().int().min(0),
});
export type PolicyView = z.infer<typeof PolicyViewSchema>;
