import Link from "next/link";
import {RUNTIME_LABELS, PROTECTION_LABELS, STACKS_PAGE} from "@/fork/ui/labels";
import {isFiltered, SORTS, type StackListParams} from "@/fork/stacks/params";
import {STACKS_HREF} from "@/fork/ui/stacks/format";

const FIELD = "border-input bg-background h-9 w-full rounded-md border px-3 text-sm";

/**
 * Filters are a plain GET form: it works before hydration, every state is a shareable URL, and the URL carries only the filter
 * values (never anything secret). Native controls keep the keyboard and screen-reader behaviour of the platform; each has a label.
 */
export function StackFilters({params, environments}: {params: StackListParams; environments: string[]}) {
    return (
        <form method="get" action={STACKS_HREF} aria-label="Filter stacks" className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto]">
            <div className="flex flex-col gap-1">
                <label htmlFor="stack-q" className="text-sm font-medium">{STACKS_PAGE.searchLabel}</label>
                <input id="stack-q" name="q" type="search" maxLength={100} defaultValue={params.q} placeholder={STACKS_PAGE.searchPlaceholder} autoComplete="off" className={FIELD}/>
            </div>
            <div className="flex flex-col gap-1">
                <label htmlFor="stack-env" className="text-sm font-medium">{STACKS_PAGE.environmentLabel}</label>
                <select id="stack-env" name="environment" defaultValue={params.environment ?? ""} className={FIELD}>
                    <option value="">{STACKS_PAGE.allEnvironments}</option>
                    {environments.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
            </div>
            <div className="flex flex-col gap-1">
                <label htmlFor="stack-runtime" className="text-sm font-medium">{STACKS_PAGE.runtimeLabel}</label>
                <select id="stack-runtime" name="runtime" defaultValue={params.runtime ?? ""} className={FIELD}>
                    <option value="">{STACKS_PAGE.allRuntime}</option>
                    {Object.entries(RUNTIME_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
            </div>
            <div className="flex flex-col gap-1">
                <label htmlFor="stack-protection" className="text-sm font-medium">{STACKS_PAGE.protectionLabel}</label>
                <select id="stack-protection" name="protection" defaultValue={params.protection ?? ""} className={FIELD}>
                    <option value="">{STACKS_PAGE.allProtection}</option>
                    {Object.entries(PROTECTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
            </div>
            <div className="flex flex-col gap-1">
                <label htmlFor="stack-sort" className="text-sm font-medium">{STACKS_PAGE.sortLabel}</label>
                <select id="stack-sort" name="sort" defaultValue={params.sort} className={FIELD}>
                    {SORTS.map((s) => <option key={s} value={s}>{STACKS_PAGE.sortOptions[s]}</option>)}
                </select>
            </div>
            <div className="flex items-center gap-3">
                <button type="submit" className="bg-primary text-primary-foreground h-9 rounded-md px-4 text-sm font-medium">{STACKS_PAGE.apply}</button>
                {isFiltered(params) && <Link href={STACKS_HREF} className="text-sm font-medium underline underline-offset-4">{STACKS_PAGE.clear}</Link>}
            </div>
        </form>
    );
}
