"use client";

import * as React from "react";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {ARCANE_KEY_FIELD_COPY, ARCANE_KEY_INPUT_PROPS} from "@/fork/arcane/key-input-contract";

/**
 * The Arcane key field (UX-07, §8.2 rule 13). UNCONTROLLED on purpose: the value lives only in the DOM node, is read once by
 * `takeKey()` at submit time (which also clears it — "cleared after EVERY submit, success or failure"), and never enters React
 * state, props, a React Query variable/cache, a URL or storage. Never prefilled, never revealable. The contract constants
 * come from `src/fork/arcane/key-input-contract.ts` (spread, not copied).
 */
export type SecretKeyHandle = {take: () => string | undefined; clear: () => void; hasValue: () => boolean};

export const SecretKeyInput = React.forwardRef<SecretKeyHandle, {stored?: boolean; required?: boolean; describedBy?: string; label?: string; id?: string}>(
    function SecretKeyInput({stored, required, describedBy, label = ARCANE_KEY_FIELD_COPY.label, id}, ref) {
        const auto = React.useId();
        const inputId = id ?? auto;
        const el = React.useRef<HTMLInputElement>(null);
        React.useImperativeHandle(ref, () => ({
            take: () => {
                const v = el.current?.value;
                if (el.current) el.current.value = "";
                return v ? v : undefined;
            },
            clear: () => { if (el.current) el.current.value = ""; },
            hasValue: () => !!el.current?.value,
        }), []);
        return (
            <div className="flex flex-col gap-1.5">
                <Label htmlFor={inputId}>{label}{required ? <span aria-hidden="true"> *</span> : null}</Label>
                <Input
                    {...ARCANE_KEY_INPUT_PROPS}
                    id={inputId}
                    ref={el}
                    defaultValue=""
                    required={required}
                    aria-describedby={describedBy}
                    placeholder={stored ? ARCANE_KEY_FIELD_COPY.storedPlaceholder : "arc_…"}
                    className="font-mono"
                />
            </div>
        );
    },
);
