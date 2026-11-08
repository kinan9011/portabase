import type * as React from "react";
import {FOCUS_RING_AA} from "@/fork/ui/a11y/focus";

/**
 * A table wider than the viewport scrolls INSIDE this box (never the page: 375 px check). A scrollable area must be reachable
 * by keyboard (WCAG 2.1.1, axe `scrollable-region-focusable`), hence the tab stop on a labelled region.
 * `w-0 min-w-full`: a scroll container still feeds its content width into the (upstream, min-width:auto) flex ancestors, which made the whole page
 * scroll sideways at desktop widths (W27b FD-4, 1.4.10); the percentage min-width keeps it exactly as wide as its parent.
 */
export function ScrollRegion({label, children}: {label: string; children: React.ReactNode}) {
    return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll an overflowing table
        <section aria-label={label} tabIndex={0} className={`w-0 min-w-full overflow-x-auto rounded-lg border ${FOCUS_RING_AA} [&_[data-slot=table-container]]:overflow-visible`}>{children}</section>
    );
}
