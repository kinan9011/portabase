"use client";

import * as React from "react";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";

/**
 * Generic write-only secret field (W11; CONTROLLED COPY of the W06 `SecretKeyInput` pattern, §8.2 rule 13, UX-07). UNCONTROLLED on purpose:
 * the value lives only in the DOM node, is read once by `take()` at submit time (which also clears it) and never enters React state, props,
 * a React Query variable/cache, a URL or storage. Never prefilled, never revealable. The attributes switch off spell-check, autofill and the
 * common password-manager / grammar extensions.
 */
export const SECRET_INPUT_PROPS = {
    type: "password", autoComplete: "off", spellCheck: false, autoCapitalize: "off", autoCorrect: "off",
    "data-gramm": "false", "data-1p-ignore": true, "data-lpignore": "true", "data-form-type": "other", maxLength: 512,
} as const;

export type SecretHandle = {take: () => string | undefined; clear: () => void; hasValue: () => boolean};

export const SecretInput = React.forwardRef<SecretHandle, {label: string; name: string; required?: boolean; describedBy?: string; onPresenceChange?: (has: boolean) => void}>(
    function SecretInput({label, name, required, describedBy, onPresenceChange}, ref) {
        const id = React.useId();
        const el = React.useRef<HTMLInputElement>(null);
        React.useImperativeHandle(ref, () => ({
            take: () => { const v = el.current?.value; if (el.current) el.current.value = ""; onPresenceChange?.(false); return v ? v : undefined; },
            clear: () => { if (el.current) el.current.value = ""; onPresenceChange?.(false); },
            hasValue: () => !!el.current?.value,
        }), [onPresenceChange]);
        return (
            <div className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</Label>
                <Input {...SECRET_INPUT_PROPS} id={id} name={name} ref={el} defaultValue="" required={required} aria-describedby={describedBy} className="font-mono" onChange={(e) => onPresenceChange?.(e.currentTarget.value.length > 0)}/>
            </div>
        );
    },
);
