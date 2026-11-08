import {RetentionPolicySchema} from "@/fork/recovery/retention-policy";
import {A11Y_COPY} from "./labels";

export type RetentionKey = keyof typeof RetentionPolicySchema.shape;

/** WCAG 3.3.1 / 3.3.3: one message per invalid retention field, naming the field and the allowed range (bounds come from the schema). */
export function retentionFieldErrors(ret: Record<RetentionKey, unknown>, label: (k: RetentionKey) => string): Partial<Record<RetentionKey, string>> {
    const out: Partial<Record<RetentionKey, string>> = {};
    for (const k of Object.keys(RetentionPolicySchema.shape) as RetentionKey[]) {
        const field = RetentionPolicySchema.shape[k];
        if (field.safeParse(ret[k]).success) continue;
        out[k] = A11Y_COPY.retentionRange(label(k), field.minValue ?? 0, field.maxValue ?? 0);
    }
    return out;
}
