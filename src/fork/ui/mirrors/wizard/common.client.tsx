"use client";

import Link from "next/link";
import * as React from "react";
import {MIRRORS} from "@/fork/ui/mirrors/labels";

export const STEPS = ["source", "runner", "access", "data", "review"] as const;
export const CARD = "flex items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:ring-2 has-[[data-state=checked]]:border-primary";
export const BTN = "w-full sm:w-auto";
export const newHref = (q: {step?: string; stack?: string | null; point?: number | null; runner?: string | null}) => {
    const p = new URLSearchParams();
    for (const k of ["step", "stack", "point", "runner"] as const) { const v = q[k]; if (v !== undefined && v !== null) p.set(k, String(v)); }
    return `/dashboard/mirrors/new?${p.toString()}`;
};

/** Back-only links: earlier steps are links, later steps plain text. 375 px shows the short "Step n of 5" form (the full list stays for screen readers). */
export function MirrorStepIndicator({current, links}: {current: 1 | 2 | 3 | 4 | 5; links: Partial<Record<(typeof STEPS)[number], string>>}) {
    return (
        <nav aria-label={MIRRORS.steps.indicator} className="mb-4">
            <p className="text-muted-foreground text-sm sm:hidden" data-testid="step-short">{MIRRORS.steps.of(current, MIRRORS.steps.short[STEPS[current - 1]!])}</p>
            <ol className="hidden items-center gap-3 text-sm sm:flex">
                {STEPS.map((s, i) => {
                    const n = i + 1; const isCur = n === current; const link = n < current ? links[s] : undefined;
                    return (
                        <li key={s} aria-current={isCur ? "step" : undefined} className={isCur ? "font-semibold" : "text-muted-foreground"}>
                            {link ? <Link href={link} className="underline underline-offset-4">{n}. {MIRRORS.steps.short[s]}</Link> : <span>{n}. {MIRRORS.steps.short[s]}</span>}
                        </li>
                    );
                })}
            </ol>
            <ol className="sr-only sm:hidden">{STEPS.map((s, i) => <li key={s} aria-current={i + 1 === current ? "step" : undefined}>{MIRRORS.steps.short[s]}</li>)}</ol>
        </nav>
    );
}
export const useHeadingFocus = () => {
    const ref = React.useRef<HTMLHeadingElement>(null);
    React.useEffect(() => { ref.current?.focus(); }, []);
    return ref;
};
export const Dropped = () => <p role="note" data-testid="choice-gone" className="mb-3 rounded-md border p-3 text-sm">{MIRRORS.gone}</p>;

