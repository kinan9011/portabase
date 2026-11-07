import {CircleCheck, CircleDashed, CircleX, Info, LoaderCircle, type LucideIcon, TriangleAlert } from "lucide-react";
import {TONE_MAP, type Tone, type ToneIconKey} from "@/fork/ui/tone";
import {cn} from "@/lib/utils";

const ICONS: Record<ToneIconKey, LucideIcon> = {
    "circle-dashed": CircleDashed, "circle-check": CircleCheck, "triangle-alert": TriangleAlert, "circle-x": CircleX, "loader-circle": LoaderCircle, info: Info,
};

export function ToneIcon({tone, busy, className}: {tone: Tone; busy?: boolean; className?: string}) {
    const Icon = ICONS[TONE_MAP[tone].iconKey];
    return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", busy && "animate-spin motion-reduce:animate-none", className)}/>;
}

/** Status pill: ALWAYS icon + text (colour is never the only signal, §8.2 rule 11), colours from the one fork tone map. */
export function ToneBadge({tone, busy, children, className}: {tone: Tone; busy?: boolean; children: React.ReactNode; className?: string}) {
    return (
        <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium", TONE_MAP[tone].badge, className)}>
            <ToneIcon tone={tone} busy={busy}/>
            {children}
        </span>
    );
}
