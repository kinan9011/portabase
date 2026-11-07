import Link from "next/link";
import {STACKS_EMPTY, STACKS_PAGE} from "@/fork/ui/labels";
import {TONE_MAP} from "@/fork/ui/tone";

type Kind = "noConnection" | "noEnabledEnvironment" | "noStacks";
const INTEGRATIONS_HREF = "/dashboard/integrations";

/** Role-aware empty state (D35): administrators get the next step and a link, members get a plain explanation and nothing to do. */
export function StacksEmpty({kind, isAdmin}: {kind: Kind; isAdmin: boolean}) {
    const c = STACKS_EMPTY[kind];
    return (
        <section aria-labelledby="stacks-empty-title" data-testid="stacks-empty" data-kind={kind} className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
            <h2 id="stacks-empty-title" className="text-lg font-semibold">{c.title}</h2>
            <p className="text-muted-foreground max-w-prose text-sm">{isAdmin ? c.admin : c.member}</p>
            {isAdmin && <Link href={INTEGRATIONS_HREF} className="bg-primary text-primary-foreground inline-flex h-9 items-center rounded-md px-4 text-sm font-medium">{c.adminAction}</Link>}
        </section>
    );
}

export function FilteredEmpty({clearHref}: {clearHref: string}) {
    return (
        <section aria-labelledby="stacks-filtered-title" data-testid="stacks-filtered-empty" className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center">
            <h2 id="stacks-filtered-title" className="font-semibold">{STACKS_EMPTY.filtered.title}</h2>
            <p className="text-muted-foreground text-sm">{STACKS_EMPTY.filtered.body}</p>
            <Link href={clearHref} className="text-sm font-medium underline underline-offset-4">{STACKS_PAGE.clear}</Link>
        </section>
    );
}

/** Unauthorized / error / unreadable: one honest panel, tone from the map, role="alert" only for real failures. */
export function StateNotice({title, body, tone = "neutral", alert = false, testId}: {title: string; body: string; tone?: "neutral" | "warning" | "danger"; alert?: boolean; testId?: string}) {
    const t = TONE_MAP[tone];
    return (
        <section data-testid={testId} role={alert ? "alert" : undefined} className={`rounded-xl border p-5 ${t.panel}`}>
            <h2 className={`font-semibold ${t.title}`}>{title}</h2>
            <p className={`mt-1 text-sm ${t.body}`}>{body}</p>
        </section>
    );
}
