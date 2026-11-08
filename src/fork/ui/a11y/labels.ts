/** W27b WCAG copy. Lives in its own file so it never conflicts with the owner's edits of `src/fork/ui/labels.ts`. */
export const A11Y_COPY = {
    retentionRange: (field: string, min: number, max: number) => `${field}: enter a whole number from ${min} to ${max}.`,
    optInConfirmHint: "Ticking this box asks you to confirm first.",
} as const;
