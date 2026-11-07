import type * as React from "react";

/**
 * A table wider than the viewport scrolls INSIDE this box (never the page: 375 px check). A scrollable area must be reachable
 * by keyboard (WCAG 2.1.1, axe `scrollable-region-focusable`), hence the tab stop on a labelled region.
 */
export function ScrollRegion({label, children}: {label: string; children: React.ReactNode}) {
    return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll an overflowing table
        <section aria-label={label} tabIndex={0} className="overflow-x-auto rounded-lg border">{children}</section>
    );
}
