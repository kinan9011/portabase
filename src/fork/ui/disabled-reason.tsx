"use client";

import * as React from "react";
import {Button} from "@/components/ui/button";

/**
 * "Disabled with reason" (§8.2 rule 10, UI plan §0.7): the button stays focusable and is `aria-disabled`; its click does
 * nothing; the reason is VISIBLE text linked with `aria-describedby` (never a tooltip only). When `reason` is empty the
 * button is a normal one.
 */
export function ReasonButton({reason, onClick, children, ...props}: Omit<React.ComponentProps<typeof Button>, "disabled"> & {reason?: string | null}) {
    const id = React.useId();
    const blocked = !!reason;
    return (
        <span className="inline-flex flex-col items-start gap-1">
            <Button
                {...props}
                aria-disabled={blocked || props["aria-disabled"] ? true : undefined}
                aria-describedby={blocked ? id : props["aria-describedby"]}
                className={`${props.className ?? ""} ${blocked ? "cursor-not-allowed opacity-60" : ""}`}
                onClick={(e) => {
                    if (blocked) { e.preventDefault(); return; }
                    onClick?.(e);
                }}
            >
                {children}
            </Button>
            {blocked && <span id={id} className="text-muted-foreground max-w-64 text-xs">{reason}</span>}
        </span>
    );
}
