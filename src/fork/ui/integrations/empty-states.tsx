import {Info} from "lucide-react";
import {NON_ADMIN_EXPLANATION, SETUP_PATH} from "@/fork/ui/labels";

/** Role-aware empty state (D35, CH-20): a signed-in user who is not a system administrator gets a plain explanation, no data. */
export function NonAdminExplanation() {
    return (
        <section aria-labelledby="non-admin-heading" className="flex gap-3 rounded-xl border p-6">
            <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground"/>
            <div><h2 id="non-admin-heading" className="text-lg font-semibold">{NON_ADMIN_EXPLANATION.title}</h2><p className="mt-1 max-w-prose text-sm text-muted-foreground">{NON_ADMIN_EXPLANATION.body}</p></div>
        </section>
    );
}

/** System admin, nothing connected yet: the setup path (shown above the connect form). */
export function SetupPath() {
    return (
        <div className="border-b p-6">
            <h2 id="arcane-heading" className="text-lg font-semibold">{SETUP_PATH.title}</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">{SETUP_PATH.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </div>
    );
}
