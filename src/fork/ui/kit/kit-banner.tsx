import Link from "next/link";
import type {KitView} from "@/fork/kit/service";
import {KIT} from "@/fork/ui/labels";

/** Instance-wide banner (§4.2, D41): shown while the kit is not verified and at least one stack has an active policy. Members see the text; the link is for admins (the page re-checks). */
export function KitBanner({view, hasActivePolicy, isAdmin}: {view: KitView; hasActivePolicy: boolean; isAdmin: boolean}) {
    if (!hasActivePolicy || view.state === "verified") return null;
    const b = view.state === "none" ? KIT.banner.none : view.state === "stale" ? KIT.banner.stale : KIT.banner.issued;
    return (
        <section role="region" aria-label={b.title} data-testid="kit-banner" data-kit-state={view.state} className="flex flex-col gap-1 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <h2 className="font-semibold">{b.title}</h2>
            <p>{b.body}</p>
            {isAdmin && <Link href="/dashboard/integrations/recovery-kit" className="w-fit font-medium underline underline-offset-4">{b.cta}</Link>}
        </section>
    );
}
